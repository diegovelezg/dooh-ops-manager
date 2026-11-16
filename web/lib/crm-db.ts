// Lecturas CRM sobre SurrealDB (identidad de servidor; el aislamiento por tienda
// lo enforcea el `WHERE store = $store` de cada query). Escrituras en crm-actions.ts.
import { listCampaignsOfAdvertiser, selectLines, selectOrders } from "@/lib/orders-store";
import { surql } from "@/lib/surreal";
import { normalizeCurrency } from "@/lib/currency";
import { COMPANIES_SORT_ALIASES } from "@/lib/sort";
import { matchAll, matchScore, norm } from "@/lib/search-sql";
import { iso } from "@/lib/surql-cols";
import type { CompanyKind, CrmStatusFilter } from "@/lib/crm";

export interface CrmCompany {
  id: string;
  store_id: string;
  name: string;
  /** Razón social / nombre legal (name = nombre comercial). Null solo en legados. */
  legal_name: string | null;
  kind: CompanyKind | null;
  tax_id: string | null;
  domain: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  external_ref: string | null;
  /** Vertical IAB 2.0 (IAB1–IAB24). SSOT en lib/advertiser-categories. */
  category_iab: string | null;
  /** Subtipo de proveedor (solo kind = 'proveedor'). */
  provider_type: string | null;
  contacts_count: number;
  /** Borrado lógico: null = activa. Listas y pickers muestran activas. */
  deleted_at: string | null;
}

export interface CrmContact {
  id: string;
  store_id: string;
  company_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  is_primary: boolean;
  created_by?: string | null;
  updated_by?: string | null;
  /** Borrado lógico: null = activo. */
  deleted_at?: string | null;
}

export type CompaniesSortKey = "name" | "type" | "contacts" | "tax_id";
export type CompaniesSortDir = "asc" | "desc";

export function parseCompaniesSort(sp: { sort?: string; dir?: string }): {
  key: CompaniesSortKey;
  dir: CompaniesSortDir;
} {
  const key: CompaniesSortKey = COMPANIES_SORT_ALIASES[sp.sort ?? ""] ?? "name";
  if (sp.dir === "asc" || sp.dir === "desc") return { key, dir: sp.dir };
  // Texto ASC primero; conteos DESC primero (lo más relevante).
  return { key, dir: key === "contacts" ? "desc" : "asc" };
}

/** Columnas de empresa como DTO de la app (ids planos, fechas ISO). */
export const COMPANY_COLS = `record::id(id) AS id, record::id(store) AS store_id, name, legal_name, kind,
  tax_id, domain, email, phone, address, city, country, notes, external_ref, agency_commission_pct,
  category_iab, provider_type, created_by, updated_by, ${iso("deleted_at")} AS deleted_at`;

/** Columnas de contacto como DTO de la app. */
export const CONTACT_COLS = `record::id(id) AS id, record::id(store) AS store_id,
  IF company { record::id(company) } ELSE { NONE } AS company_id, first_name, last_name, email, phone,
  job_title, is_primary, created_by, updated_by, ${iso("deleted_at")} AS deleted_at`;

/** `$param` (array de claves) → array de record ids de `table`. */
export const recs = (table: string, param: string): string =>
  `${param}.map(|$i| type::record('${table}', $i))`;

// `id ASC` final: desempate determinista (SurrealDB 4 no garantiza el orden de filas empatadas).
const SORT_ORDER: Record<CompaniesSortKey, (dir: string) => string> = {
  name: (d) => `name_key ${d}, id ASC`,
  type: (d) => `kind ${d}, name_key ASC, id ASC`,
  contacts: (d) => `contacts_count ${d}, name_key ASC, id ASC`,
  tax_id: (d) => `tax_missing ASC, tax_key ${d}, name_key ASC, id ASC`,
};

function toCompany(r: Record<string, unknown>): CrmCompany {
  return {
    id: String(r.id),
    store_id: String(r.store_id),
    name: String(r.name ?? ""),
    legal_name: (r.legal_name as string | null) ?? null,
    kind: (r.kind as CompanyKind | null) ?? null,
    tax_id: (r.tax_id as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    country: (r.country as string | null) ?? null,
    external_ref: (r.external_ref as string | null) ?? null,
    category_iab: (r.category_iab as string | null) ?? null,
    provider_type: (r.provider_type as string | null) ?? null,
    contacts_count: Number(r.contacts_count ?? 0),
    deleted_at: (r.deleted_at as string | null) ?? null,
  };
}

function toContact(c: Record<string, unknown>): CrmContact {
  return {
    id: String(c.id),
    store_id: String(c.store_id),
    company_id: (c.company_id as string | null) ?? null,
    first_name: (c.first_name as string | null) ?? null,
    last_name: (c.last_name as string | null) ?? null,
    email: (c.email as string | null) ?? null,
    phone: (c.phone as string | null) ?? null,
    job_title: (c.job_title as string | null) ?? null,
    is_primary: c.is_primary === true,
    created_by: (c.created_by as string | null) ?? null,
    updated_by: (c.updated_by as string | null) ?? null,
    deleted_at: (c.deleted_at as string | null) ?? null,
  };
}

export async function listCrmCompanies(
  storeId: string,
  opts: { q?: string; kind?: CompanyKind | null; kinds?: readonly CompanyKind[]; sortKey?: CompaniesSortKey; sortDir?: CompaniesSortDir; page?: number; pageSize?: number; status?: CrmStatusFilter } = {},
): Promise<{ rows: CrmCompany[]; total: number }> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(1, opts.page ?? 1);
  const sortKey = opts.sortKey ?? "name";
  const sortDir = opts.sortDir ?? (sortKey === "contacts" ? "desc" : "asc");
  const q = (opts.q ?? "").trim();
  // Multiselect prima sobre el single legacy. [] = ninguno (sin roundtrip).
  const kinds: readonly CompanyKind[] | undefined =
    opts.kinds ?? (opts.kind ? [opts.kind] : undefined);
  if (kinds !== undefined && kinds.length === 0) return { rows: [], total: 0 };
  const status = opts.status ?? "active";
  // La casa (kind NONE, red propia) nunca lista: no es contraparte.
  const dir = sortDir === "desc" ? "DESC" : "ASC";
  // Con texto y orden por nombre asc manda la relevancia (relevancia primero).
  const order = q && sortKey === "name" && dir === "ASC" ? "score DESC, name_key ASC, id ASC" : SORT_ORDER[sortKey](dir);
  // Dos fases (ver `listCrmContacts`): (1) filtrar y ordenar con columnas mínimas — `search` solo si hay texto y
  // únicamente las claves de orden de la columna elegida; (2) proyectar COMPANY_COLS y el conteo SOLO de la página.
  // El orden se reaplica en JS: sin ORDER BY, SurrealDB 4 no garantiza el orden de `FROM $ids`.
  const KEYS: Record<CompaniesSortKey, string> = {
    name: `${norm("name")} AS name_key`,
    type: `kind, ${norm("name")} AS name_key`,
    contacts: `${norm("name")} AS name_key, $cm[<string> id] ?? 0 AS contacts_count`,
    tax_id: `${norm("name")} AS name_key, tax_id = NONE AS tax_missing, ${norm("tax_id")} AS tax_key`,
  };
  const result = await surql<{ total: number; order: string[]; rows: Array<Record<string, unknown>> }>(
    `LET $tokens = fn::tokens($q);
     LET $qn = fn::norm($q);
     -- Conteo agregado una vez (GROUP BY) y buscado por clave: la subconsulta correlacionada
     -- (\`WHERE company = $parent.id\`) no usa índice y escaneaba crm_contact por cada empresa.
     LET $cc = SELECT company, count() AS n FROM crm_contact
       WHERE store = type::record('sys_store', $store) AND deleted_at = NONE AND company != NONE GROUP BY company;
     LET $cm = object::from_entries($cc.map(|$x| [<string> $x.company, $x.n]));
     LET $m = SELECT id, ${KEYS[sortKey]}${q ? `, ${matchScore(norm("name"), "search")} AS score` : ""}
       FROM crm_company
       WHERE store = type::record('sys_store', $store) AND kind != NONE
         AND ($status = 'all' OR ($status = 'active' AND deleted_at = NONE) OR ($status = 'archived' AND deleted_at != NONE))
         AND ($kinds = NONE OR kind IN $kinds)
         ${q ? `AND ${matchAll("search")}` : ""};
     LET $top = SELECT * FROM $m ORDER BY ${order} LIMIT $limit START $offset;
     LET $ids = $top.map(|$x| $x.id);
     RETURN {
       total: array::len($m),
       order: $ids.map(|$i| record::id($i)),
       rows: SELECT ${COMPANY_COLS}, $cm[<string> id] ?? 0 AS contacts_count FROM $ids
     };`,
    { store: storeId, q, status, kinds: kinds ? [...kinds] : undefined, limit: pageSize, offset: (page - 1) * pageSize },
  );
  const at = new Map(result.order.map((id, i) => [id, i]));
  result.rows.sort((a, b) => (at.get(String(a.id)) ?? 0) - (at.get(String(b.id)) ?? 0));
  return { rows: result.rows.map(toCompany), total: result.total };
}

export interface CrmContactListItem extends CrmContact {
  company_name: string | null;
}

/** Cargos distintos ya usados en la tienda (para autocomplete sin repetir). */
export async function listDistinctJobTitles(storeId: string, limit = 200): Promise<string[]> {
  const capped = Math.min(Math.max(limit, 1), 500);
  const rows = await surql<string[]>(
    `SELECT VALUE job_title FROM crm_contact
     WHERE store = type::record('sys_store', $store) AND job_title != NONE LIMIT $limit`,
    { store: storeId, limit: capped },
  );
  const seen = new Map<string, string>();
  for (const v of rows) {
    const raw = typeof v === "string" ? v.trim() : "";
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (!seen.has(key)) seen.set(key, raw);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "es")).slice(0, capped);
}

export async function listCrmContacts(
  storeId: string,
  opts: { q?: string; companyId?: string; limit?: number; status?: CrmStatusFilter; kinds?: readonly CompanyKind[] } = {},
): Promise<{ rows: CrmContactListItem[]; total: number; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const q = (opts.q ?? "").trim();
  const status = opts.status ?? "active";
  // Multiselect igual que empresas ([] = ninguno, sin roundtrip).
  // undefined = todos (sin filtro). El default de la vista
  // (agencia + anunciante) lo pone el caller vía parseCompanyKinds.
  const kinds: readonly CompanyKind[] | undefined = opts.kinds;
  if (kinds !== undefined && kinds.length === 0) return { rows: [], total: 0, truncated: false };
  // Filtros duros (sin texto). En modo activo los contactos de empresas archivadas no operan; los sueltos
  // (sin empresa) se conservan. Con filtro de tipo, los sueltos también se conservan.
  // "Empresa activa" / "tipo" se materializan UNA vez en un LET (`IN $var`), no como join `company.*` por
  // contacto (~115 ms con 8 000 contactos). OJO: no inlinear la subconsulta en el WHERE — si ese WHERE
  // también llama a una `fn::` (match_all), SurrealDB 4.0.1 la reevalúa POR FILA (medido: 39 s vs 36 ms).
  const S = "type::record('sys_store', $store)";
  const sets = `LET $activeCos = IF $status = 'active' { SELECT VALUE id FROM crm_company WHERE store = ${S} AND deleted_at = NONE } ELSE { [] };
       LET $kindCos = IF $kinds != NONE { SELECT VALUE id FROM crm_company WHERE store = ${S} AND kind IN $kinds } ELSE { [] };`;
  const hard = `store = ${S}
         AND ($company = NONE OR company = type::record('crm_company', $company))
         AND ($status = 'all'
              OR ($status = 'archived' AND deleted_at != NONE)
              OR ($status = 'active' AND deleted_at = NONE AND (company = NONE OR company IN $activeCos)))
         AND ($kinds = NONE OR company = NONE OR company IN $kindCos)`;
  // Dos fases: (1) elegir los ids de la página con columnas mínimas — `search` (COMPUTED, caro) solo se evalúa
  // si hay texto, y la relevancia solo sobre los que calzan; (2) proyectar columnas y `company.name` SOLO de
  // esos ids. El orden final se reaplica en JS: sin ORDER BY, SurrealDB 4 no garantiza el orden de `FROM $ids`.
  const pick = q
    ? `LET $matched = SELECT id, created_at, first_name, last_name, search FROM crm_contact
         WHERE ${hard} AND ${matchAll("search")};
       LET $scored = SELECT id, created_at, ${matchScore(norm("string::concat(first_name ?? '', ' ', last_name ?? '')"), "search")} AS score
         FROM $matched;
       LET $top = SELECT id, score, created_at FROM $scored ORDER BY score DESC, created_at ASC, id ASC LIMIT $limit;
       LET $base = 0;`
    : `LET $hard = SELECT id, created_at FROM crm_contact WHERE ${hard};
       LET $base = array::len($hard);
       LET $top = SELECT id, created_at FROM $hard ORDER BY created_at ASC, id ASC LIMIT $limit;`;
  const result = await surql<{ base: number; order: string[]; rows: Array<Record<string, unknown>> }>(
    `LET $tokens = fn::tokens($q);
     LET $qn = fn::norm($q);
     ${sets}
     ${pick}
     LET $ids = $top.map(|$x| $x.id);
     RETURN {
       base: $base,
       order: $ids.map(|$i| record::id($i)),
       rows: SELECT ${CONTACT_COLS}, company.name AS company_name FROM $ids
     };`,
    { store: storeId, q, company: opts.companyId ?? undefined, status, kinds: kinds ? [...kinds] : undefined, limit },
  );
  const at = new Map(result.order.map((id, i) => [id, i]));
  result.rows.sort((a, b) => (at.get(String(a.id)) ?? 0) - (at.get(String(b.id)) ?? 0));
  const rows: CrmContactListItem[] = result.rows.map((c) => ({
    ...toContact(c),
    company_name: (c.company_name as string | null) ?? null,
  }));
  // Sin texto el total es la base exacta; con texto vale sobre la muestra
  // y `truncated` lo declara (la UI pinta parcial, nunca total exacto).
  const truncated = rows.length >= limit;
  return { rows, total: q ? rows.length : result.base, truncated };
}

export interface CrmCampaign {
  id: string;
  name: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  primary_contact_id: string | null;
}

export interface CompanyNetworkBrand {
  brand: string;
  ios: number;
}

export interface CompanyNetworkCompany {
  id: string;
  name: string;
  kind: CompanyKind | null;
  ios: number;
  /** true cuando existe vínculo explícito (pre-OI o sembrado desde OI). */
  explicit: boolean;
  origin: "manual" | "oi" | null;
}

export interface CompanyNetwork {
  brands: CompanyNetworkBrand[];
  agencies: CompanyNetworkCompany[];
  advertisers: CompanyNetworkCompany[];
}

export interface ContactAccount {
  contact_id: string;
  advertiser_company_id: string;
}

/** Un contacto de agencia que atiende a esta empresa (vista anunciante). */
export interface IncomingAccount {
  contact_id: string;
  agency_company_id: string;
}

/** Contacto de una agencia vinculada (para gestionar atendidos). */
export interface AgencyTeamContact {
  id: string;
  agency_company_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  is_primary: boolean;
}

/** Tope por lista del cajón de empresa; si se alcanza se declara (`truncated`), nunca en silencio. */
const DETAIL_CAP = 500;

export async function getCrmCompany(
  storeId: string,
  companyId: string,
): Promise<{ company: Record<string, unknown>; /** Alguna lista del cajón (vínculos, cuentas, órdenes, equipo) pasó el tope de {@link DETAIL_CAP}. */ truncated: boolean; contacts: CrmContact[]; campaigns: CrmCampaign[]; ios: Array<{ id: string; io_number: string; brand: string | null; status: string; advertiser_company_id: string | null; billing_company_id: string | null; gross_minor: number; currency: string }>; network: CompanyNetwork; contact_accounts: ContactAccount[]; incoming_accounts: IncomingAccount[]; agency_team: AgencyTeamContact[] } | null> {
  const [company] = await surql<Array<Record<string, unknown>>>(
    `SELECT ${COMPANY_COLS} FROM crm_company
     WHERE store = type::record('sys_store', $store) AND id = type::record('crm_company', $id)`,
    { store: storeId, id: companyId },
  );
  if (!company) return null;
  const sc = { store: storeId, id: companyId };
  const [contacts, links, accountsAll, incomingAll, campaigns, iosAll] = await Promise.all([
    surql<Array<Record<string, unknown>>>(
      `SELECT ${CONTACT_COLS} FROM crm_contact
       WHERE store = type::record('sys_store', $store) AND company = type::record('crm_company', $id)
       ORDER BY is_primary DESC, created_at ASC`,
      sc,
    ),
    // Vínculos explícitos pre-OI (una dirección por rol; se fusionan abajo).
    surql<Array<Record<string, unknown>>>(
      `SELECT record::id(in) AS agency_company_id, record::id(out) AS advertiser_company_id, origin
       FROM crm_company_link
       WHERE store = type::record('sys_store', $store)
         AND (in = type::record('crm_company', $id) OR out = type::record('crm_company', $id)) LIMIT ${DETAIL_CAP + 1}`,
      sc,
    ),
    // Cuentas que atiende cada contacto de esta empresa (solo agencias declaran).
    surql<Array<Record<string, unknown>>>(
      // Contactos de la empresa primero (indexado) y `in IN $k`: `in.company = …` recorría todas las
      // aristas trayendo el contacto de cada una (557 ms vs 5 ms con 30 000 aristas).
      `LET $k = SELECT VALUE id FROM crm_contact WHERE store = type::record('sys_store', $store) AND company = type::record('crm_company', $id);
       SELECT record::id(in) AS contact_id, record::id(out) AS advertiser_company_id FROM crm_contact_account
       WHERE store = type::record('sys_store', $store) AND in IN $k LIMIT ${DETAIL_CAP + 1}`,
      sc,
    ),
    // Vista anunciante: contactos de agencia que atienden a esta empresa.
    surql<Array<Record<string, unknown>>>(
      `SELECT record::id(in) AS contact_id, record::id(in.company) AS agency_company_id FROM crm_contact_account
       WHERE store = type::record('sys_store', $store) AND out = type::record('crm_company', $id) LIMIT ${DETAIL_CAP + 1}`,
      sc,
    ),
    listCampaignsOfAdvertiser(storeId, companyId, 50),
    // Historial para la red comercial (drawer Vínculos): hasta 500 IOs donde
    // participa (como anunciante o facturación). La marca es metadato del
    // pedido (io_orders.brand), la contraparte se resuelve abajo.
    selectOrders(storeId, { companyId, order: "created_desc", limit: DETAIL_CAP + 1 }),
  ]);
  // Se pide un registro de más para saber si hubo corte; el resto se descarta.
  const cap = <T,>(rows: T[]): T[] => rows.slice(0, DETAIL_CAP);
  let truncated = [links, accountsAll, incomingAll, iosAll].some((r) => r.length > DETAIL_CAP);
  const linksAll = cap(links);
  const iosRows = cap(iosAll).map((o) => ({
    id: String(o.id),
    io_number: String(o.io_number ?? ""),
    brand: (o.brand as string | null) ?? null,
    status: String(o.status ?? ""),
    advertiser_company_id: (o.advertiser_company_id as string | null) ?? null,
    billing_company_id: (o.billing_company_id as string | null) ?? null,
    currency: normalizeCurrency(o.currency as string | null, "PEN"),
  }));
  // Total de cada orden = suma de líneas (misma fuente que orders-db):
  // una sola query para todos los IOs del historial.
  const grossByIo = new Map<string, number>();
  if (iosRows.length > 0) {
    for (const l of await selectLines(storeId, iosRows.map((o) => o.id))) {
      if (typeof l.io_id !== "string") continue;
      grossByIo.set(l.io_id, (grossByIo.get(l.io_id) ?? 0) + Number(l.rate_minor ?? 0));
    }
  }
  const iosWithTotals = iosRows.map((o) => ({
    ...o,
    gross_minor: grossByIo.get(o.id) ?? 0,
  }));
  // Red derivada: marcas (distinct normalizado) + contrapartes por rol.
  // Directa (advertiser=billing) no cuenta como agencia ni anunciante.
  const brandCount = new Map<string, { brand: string; ios: number }>();
  const agencyIds = new Map<string, number>();
  const advertiserIds = new Map<string, number>();
  for (const o of iosRows) {
    const b = (o.brand ?? "").trim();
    if (b) {
      const k = b.toUpperCase();
      const prev = brandCount.get(k);
      if (prev) prev.ios += 1;
      else brandCount.set(k, { brand: b, ios: 1 });
    }
    const adv = o.advertiser_company_id;
    const bill = o.billing_company_id;
    if (adv === companyId && bill && bill !== companyId) {
      agencyIds.set(bill, (agencyIds.get(bill) ?? 0) + 1);
    }
    if (bill === companyId && adv && adv !== companyId) {
      advertiserIds.set(adv, (advertiserIds.get(adv) ?? 0) + 1);
    }
  }
  const counterpartIds = [...new Set([...agencyIds.keys(), ...advertiserIds.keys()])];
  // Explícitos: el rol depende del lado que ocupa la empresa actual.
  const explicitAgencyIds = new Map<string, "manual" | "oi">();
  const explicitAdvertiserIds = new Map<string, "manual" | "oi">();
  for (const l of linksAll) {
    const ag = typeof l.agency_company_id === "string" ? l.agency_company_id : null;
    const adv = typeof l.advertiser_company_id === "string" ? l.advertiser_company_id : null;
    const origin = l.origin === "oi" ? "oi" : "manual";
    if (!ag || !adv) continue;
    if (adv === companyId && ag !== companyId) {
      const prev = explicitAgencyIds.get(ag);
      if (prev !== "manual") explicitAgencyIds.set(ag, origin);
    }
    if (ag === companyId && adv !== companyId) {
      const prev = explicitAdvertiserIds.get(adv);
      if (prev !== "manual") explicitAdvertiserIds.set(adv, origin);
    }
  }
  for (const id of [...explicitAgencyIds.keys(), ...explicitAdvertiserIds.keys()]) {
    if (!counterpartIds.includes(id)) counterpartIds.push(id);
  }
  const nameBy = new Map<string, { name: string; kind: CompanyKind | null }>();
  if (counterpartIds.length > 0) {
    const counterparties = await surql<Array<Record<string, unknown>>>(
      `LET $r = ${recs("crm_company", "$ids")};
       SELECT record::id(id) AS id, name, kind FROM crm_company
       WHERE store = type::record('sys_store', $store) AND id IN $r`,
      { store: storeId, ids: counterpartIds },
    );
    for (const c of counterparties) {
      const id = String(c.id);
      nameBy.set(id, {
        name: String(c.name ?? "—"),
        kind: (c.kind as CompanyKind | null) ?? null,
      });
    }
  }
  const toCompanies = (
    m: Map<string, number>,
    explicit: Map<string, "manual" | "oi">,
  ): CompanyNetworkCompany[] =>
    [...new Set([...m.keys(), ...explicit.keys()])]
      .map((id) => ({
        id,
        name: nameBy.get(id)?.name ?? "—",
        kind: nameBy.get(id)?.kind ?? null,
        ios: m.get(id) ?? 0,
        explicit: explicit.has(id),
        origin: explicit.get(id) ?? null,
      }))
      .sort((a, b) => b.ios - a.ios || a.name.localeCompare(b.name, "es"));
  const network: CompanyNetwork = {
    brands: [...brandCount.values()].sort((a, b) => b.ios - a.ios || a.brand.localeCompare(b.brand, "es")),
    agencies: toCompanies(agencyIds, explicitAgencyIds),
    advertisers: toCompanies(advertiserIds, explicitAdvertiserIds),
  };
  // Ficha: solo las 50 recientes (comportamiento previo intacto).
  const ios = iosWithTotals.slice(0, 50);
  const contact_accounts: ContactAccount[] = cap(accountsAll)
    .filter((a) => typeof a.contact_id === "string" && typeof a.advertiser_company_id === "string")
    .map((a) => ({ contact_id: String(a.contact_id), advertiser_company_id: String(a.advertiser_company_id) }));
  const incoming_accounts: IncomingAccount[] = cap(incomingAll)
    .filter((a) => typeof a.contact_id === "string" && typeof a.agency_company_id === "string")
    .map((a) => ({ contact_id: String(a.contact_id), agency_company_id: String(a.agency_company_id) }));
  // Vista anunciante: equipo de las agencias vinculadas para gestionar
  // quiénes lo atienden (una sola query, hasta 500 contactos).
  let agency_team: AgencyTeamContact[] = [];
  const companyKind = company.kind;
  if (companyKind === "anunciante") {
    const linkedAgencyIds = [...new Set([
      ...explicitAgencyIds.keys(),
      ...incoming_accounts.map((a) => a.agency_company_id),
    ])];
    if (linkedAgencyIds.length > 0) {
      const team = await surql<Array<Record<string, unknown>>>(
        `LET $r = ${recs("crm_company", "$ids")};
         SELECT ${CONTACT_COLS} FROM crm_contact
         WHERE store = type::record('sys_store', $store) AND deleted_at = NONE
           AND company IN $r
         ORDER BY created_at ASC LIMIT ${DETAIL_CAP + 1}`,
        { store: storeId, ids: linkedAgencyIds },
      );
      if (team.length > DETAIL_CAP) truncated = true;
      agency_team = cap(team)
        .filter((c) => typeof c.id === "string" && typeof c.company_id === "string")
        .map((c) => ({
          id: String(c.id),
          agency_company_id: String(c.company_id),
          first_name: (c.first_name as string | null) ?? null,
          last_name: (c.last_name as string | null) ?? null,
          email: (c.email as string | null) ?? null,
          phone: (c.phone as string | null) ?? null,
          job_title: (c.job_title as string | null) ?? null,
          is_primary: c.is_primary === true,
        }));
    }
  }
  return {
    company,
    truncated,
    contacts: contacts.map(toContact),
    campaigns: campaigns.map((m) => ({
      id: String(m.id),
      name: String(m.name ?? ""),
      status: String(m.status ?? ""),
      starts_at: (m.starts_at as string | null) ?? null,
      ends_at: (m.ends_at as string | null) ?? null,
      primary_contact_id: (m.primary_contact_id as string | null) ?? null,
    })),
    ios,
    network,
    contact_accounts,
    incoming_accounts,
    agency_team,
  };
}
