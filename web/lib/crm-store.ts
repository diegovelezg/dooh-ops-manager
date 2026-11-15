// Escrituras y lecturas puntuales del CRM sobre SurrealDB. Cada función recibe el
// `storeId` ya resuelto por el caller (tenant) y lo aplica en el `WHERE`/`SET`.
// Las operaciones de varias filas son transacciones (BEGIN/COMMIT): el SDK
// reintenta los conflictos de escritura (OCC) en `collect()`.
import { randomUUID } from "node:crypto";
import { assignments, surql, type LinkMap } from "@/lib/surreal";
import { COMPANY_COLS, CONTACT_COLS, recs } from "@/lib/crm-db";

const CONTACT_LINKS: LinkMap = { company_id: { field: "company", table: "crm_company" } };
const S = "type::record('sys_store', $store)";

export type Row = Record<string, unknown>;

export async function getCompany(storeId: string, id: string): Promise<Row | null> {
  return (
    (await surql<Row[]>(
      `SELECT ${COMPANY_COLS} FROM crm_company WHERE store = ${S} AND id = type::record('crm_company', $id)`,
      { store: storeId, id },
    ))[0] ?? null
  );
}

/** Empresas por id (de la tienda): id → fila. Los ids ajenos no aparecen. */
export async function getCompaniesById(storeId: string, ids: string[]): Promise<Map<string, Row>> {
  if (ids.length === 0) return new Map();
  const rows = await surql<Row[]>(
    `LET $r = ${recs("crm_company", "$ids")};
     SELECT ${COMPANY_COLS} FROM crm_company WHERE store = ${S} AND id IN $r`,
    { store: storeId, ids },
  );
  return new Map(rows.map((r) => [String(r.id), r]));
}

export async function createCompany(storeId: string, fields: Row): Promise<string> {
  // Clave UUID como el resto de las entidades (validaciones y menciones asumen ese formato).
  const id = randomUUID();
  const { sql, vars } = assignments(fields);
  await surql(`CREATE type::record('crm_company', $id) SET store = ${S}, ${sql}`, { id, store: storeId, ...vars });
  return id;
}

export async function patchCompany(storeId: string, id: string, fields: Row): Promise<void> {
  const { sql, vars } = assignments(fields);
  await surql(
    `UPDATE crm_company SET ${sql} WHERE store = ${S} AND id = type::record('crm_company', $id)`,
    { store: storeId, id, ...vars },
  );
}

/** Archiva/restaura (borrado lógico). */
export async function setArchived(table: "crm_company" | "crm_contact", storeId: string, id: string, archived: boolean, actor: string | null): Promise<void> {
  await surql(
    `UPDATE type::record($table, $id) SET deleted_at = ${archived ? "time::now()" : "NONE"}, updated_by = $actor ?? NONE
     WHERE store = ${S}`,
    { table, store: storeId, id, actor },
  );
}

export async function getContact(storeId: string, id: string): Promise<Row | null> {
  return (
    (await surql<Row[]>(
      `SELECT ${CONTACT_COLS} FROM crm_contact WHERE store = ${S} AND id = type::record('crm_contact', $id)`,
      { store: storeId, id },
    ))[0] ?? null
  );
}

export async function getContactsById(storeId: string, ids: string[]): Promise<Map<string, Row>> {
  if (ids.length === 0) return new Map();
  const rows = await surql<Row[]>(
    `LET $r = ${recs("crm_contact", "$ids")};
     SELECT ${CONTACT_COLS} FROM crm_contact WHERE store = ${S} AND id IN $r`,
    { store: storeId, ids },
  );
  return new Map(rows.map((r) => [String(r.id), r]));
}

/** ¿Ya hay un contacto de la empresa con ese email (sin importar mayúsculas) o teléfono? */
export async function contactExists(companyId: string, by: { email?: string | null; phone?: string | null }): Promise<boolean> {
  const rows = await surql<unknown[]>(
    `SELECT VALUE id FROM crm_contact
     WHERE company = type::record('crm_company', $company)
       AND (($email != NONE AND email != NONE AND string::lowercase(email) = string::lowercase($email))
         OR ($phone != NONE AND phone = $phone)) LIMIT 1`,
    { company: companyId, email: by.email ?? undefined, phone: by.phone ?? undefined },
  );
  return rows.length > 0;
}

/** Crea el contacto; si es principal, desmarca antes al principal actual de la empresa (atómico). */
export async function createContact(storeId: string, fields: Row, actor: string | null): Promise<void> {
  const { sql, vars } = assignments(fields, CONTACT_LINKS);
  const demote =
    fields.is_primary && typeof fields.company_id === "string"
      ? `UPDATE crm_contact SET is_primary = false, updated_by = $actor ?? NONE
         WHERE company = type::record('crm_company', $w_company_id) AND is_primary = true;`
      : "";
  await surql(
    `BEGIN; ${demote}
     CREATE type::record('crm_contact', $id) SET store = ${S}, ${sql}, created_by = $actor ?? NONE, updated_by = $actor ?? NONE;
     COMMIT;`,
    { id: randomUUID(), store: storeId, actor, ...vars },
  );
}

/** Actualiza el contacto; si queda principal, desmarca a los demás de su empresa (atómico). */
export async function patchContact(storeId: string, id: string, fields: Row, actor: string | null): Promise<void> {
  const { sql, vars } = assignments(fields, CONTACT_LINKS);
  const demote =
    fields.is_primary && typeof fields.company_id === "string"
      ? `UPDATE crm_contact SET is_primary = false, updated_by = $actor ?? NONE
         WHERE company = type::record('crm_company', $w_company_id) AND is_primary = true AND id != type::record('crm_contact', $id);`
      : "";
  await surql(
    `BEGIN; ${demote}
     UPDATE crm_contact SET ${sql}, updated_by = $actor ?? NONE WHERE store = ${S} AND id = type::record('crm_contact', $id);
     COMMIT;`,
    { store: storeId, id, actor, ...vars },
  );
}

// ── Vínculos agencia → anunciante ─────────────────────────────────────────
export async function linkExists(storeId: string, agencyId: string, advertiserId: string): Promise<boolean> {
  const rows = await surql<unknown[]>(
    `SELECT VALUE id FROM crm_company_link
     WHERE store = ${S} AND in = type::record('crm_company', $a) AND out = type::record('crm_company', $b) LIMIT 1`,
    { store: storeId, a: agencyId, b: advertiserId },
  );
  return rows.length > 0;
}

export async function createLink(storeId: string, agencyId: string, advertiserId: string, actor: string | null, origin: "manual" | "oi" = "manual"): Promise<void> {
  await surql(
    `RELATE (type::record('crm_company', $a))->crm_company_link->(type::record('crm_company', $b))
     SET store = ${S}, origin = $origin, created_by = $actor ?? NONE, updated_by = $actor ?? NONE`,
    { store: storeId, a: agencyId, b: advertiserId, actor, origin },
  );
}

/** Borra el vínculo y las cuentas que colgaban del par (no quedan atendidos huérfanos). */
export async function deleteLinkAndAccounts(storeId: string, agencyId: string, advertiserId: string): Promise<void> {
  await surql(
    `BEGIN;
     DELETE crm_contact_account WHERE store = ${S}
       AND in.company = type::record('crm_company', $a) AND out = type::record('crm_company', $b);
     DELETE crm_company_link WHERE store = ${S}
       AND in = type::record('crm_company', $a) AND out = type::record('crm_company', $b);
     COMMIT;`,
    { store: storeId, a: agencyId, b: advertiserId },
  );
}

/** Anunciantes ya vinculados a la agencia, de entre `advertiserIds`. */
export async function linkedAdvertisers(storeId: string, agencyId: string, advertiserIds: string[]): Promise<Set<string>> {
  if (advertiserIds.length === 0) return new Set();
  const rows = await surql<string[]>(
    `LET $r = ${recs("crm_company", "$ids")};
     SELECT VALUE record::id(out) FROM crm_company_link
     WHERE store = ${S} AND in = type::record('crm_company', $a) AND out IN $r`,
    { store: storeId, a: agencyId, ids: advertiserIds },
  );
  return new Set(rows);
}

// ── Cuentas que atiende cada contacto ─────────────────────────────────────
/** Reemplaza el set de anunciantes que atiende el contacto (atómico, idempotente). */
export async function replaceContactAccounts(storeId: string, contactId: string, advertiserIds: string[], actor: string | null): Promise<void> {
  await surql(
    `BEGIN;
     LET $c = type::record('crm_contact', $contact);
     LET $want = ${recs("crm_company", "$ids")};
     DELETE crm_contact_account WHERE store = ${S} AND in = $c AND out NOT IN $want;
     FOR $o IN $want {
       IF array::len(SELECT id FROM crm_contact_account WHERE in = $c AND out = $o) = 0 {
         RELATE $c->crm_contact_account->$o SET store = ${S}, created_by = $actor ?? NONE, updated_by = $actor ?? NONE;
       } ELSE {
         UPDATE crm_contact_account SET updated_by = $actor ?? NONE WHERE in = $c AND out = $o;
       };
     };
     COMMIT;`,
    { store: storeId, contact: contactId, ids: advertiserIds, actor },
  );
}

/** Reemplaza qué contactos de la agencia atienden a UN anunciante (atómico, idempotente). */
export async function replaceAttendants(storeId: string, agencyId: string, advertiserId: string, contactIds: string[], actor: string | null): Promise<void> {
  await surql(
    `BEGIN;
     LET $adv = type::record('crm_company', $advertiser);
     LET $want = ${recs("crm_contact", "$ids")};
     DELETE crm_contact_account WHERE store = ${S} AND out = $adv
       AND in.company = type::record('crm_company', $agency) AND in NOT IN $want;
     FOR $c IN $want {
       IF array::len(SELECT id FROM crm_contact_account WHERE in = $c AND out = $adv) = 0 {
         RELATE $c->crm_contact_account->$adv SET store = ${S}, created_by = $actor ?? NONE, updated_by = $actor ?? NONE;
       } ELSE {
         UPDATE crm_contact_account SET updated_by = $actor ?? NONE WHERE in = $c AND out = $adv;
       };
     };
     COMMIT;`,
    { store: storeId, agency: agencyId, advertiser: advertiserId, ids: contactIds, actor },
  );
}

// ── Fusión de contactos ───────────────────────────────────────────────────
/** Borra los perdedores y aplica `patch` al sobreviviente en una transacción
 *  (el patch va DESPUÉS del borrado: al absorber email/teléfono de un perdedor de
 *  su misma empresa no choca con los índices únicos). */
export async function mergeContacts(storeId: string, survivorId: string, loserIds: string[], patch: Row, actor: string | null, promote: boolean, survivorCompany: string | null): Promise<void> {
  const { sql, vars } = assignments(patch);
  const demote =
    promote && survivorCompany
      ? `UPDATE crm_contact SET is_primary = false, updated_by = $actor ?? NONE
         WHERE company = type::record('crm_company', $company) AND is_primary = true AND id != $s;`
      : "";
  await surql(
    `BEGIN;
     LET $s = type::record('crm_contact', $survivor);
     ${demote}
     DELETE crm_contact WHERE store = ${S} AND id IN ${recs("crm_contact", "$losers")};
     ${sql ? "UPDATE $s SET " + sql + ", updated_by = $actor ?? NONE;" : ""}
     COMMIT;`,
    { store: storeId, survivor: survivorId, losers: loserIds, company: survivorCompany ?? undefined, actor, ...vars },
  );
}

// ── Lecturas auxiliares para consumidores (pedidos, finanzas, dashboards) ──
/** Empresas de la tienda como DTO (todas si no se pasan `ids`). */
export async function listCompanies(storeId: string, ids?: string[]): Promise<Row[]> {
  if (ids && ids.length === 0) return [];
  return surql<Row[]>(
    `${ids ? `LET $r = ${recs("crm_company", "$ids")};` : ""}
     SELECT ${COMPANY_COLS} FROM crm_company WHERE store = ${S}${ids ? " AND id IN $r" : ""}`,
    { store: storeId, ids },
  );
}

export async function countCompanies(storeId: string): Promise<number> {
  return (await surql<number[]>(`SELECT VALUE count() FROM crm_company WHERE store = ${S} GROUP ALL`, { store: storeId }))[0] ?? 0;
}

/** Contactos por id con el nombre de su empresa (`company_name`). */
export async function listContactsWithCompany(storeId: string, ids: string[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  return surql<Row[]>(
    `LET $r = ${recs("crm_contact", "$ids")};
     SELECT ${CONTACT_COLS}, company.name AS company_name FROM crm_contact WHERE store = ${S} AND id IN $r`,
    { store: storeId, ids },
  );
}

/** Todos los contactos de la tienda (activos y archivados) hasta `cap`, para detectar duplicados. */
export async function listContactsForDuplicates(storeId: string, cap: number): Promise<Row[]> {
  return surql<Row[]>(
    `SELECT ${CONTACT_COLS} FROM crm_contact WHERE store = ${S} ORDER BY id ASC LIMIT $cap`,
    { store: storeId, cap },
  );
}

/** Empresa del contacto cuyo email (sin importar mayúsculas) es `email`, si tiene empresa. */
export async function findContactCompanyByEmail(storeId: string, email: string): Promise<string | null> {
  const rows = await surql<Array<string>>(
    `SELECT VALUE record::id(company) FROM crm_contact
     WHERE store = ${S} AND company != NONE AND email != NONE AND string::lowercase(email) = string::lowercase($email) LIMIT 1`,
    { store: storeId, email },
  );
  return rows[0] ?? null;
}

/** La casa: empresa propia de la tienda (kind NONE; no es contraparte). */
export async function findHouseCompany(storeId: string): Promise<{ id: string; name: string } | null> {
  return (
    (await surql<Array<{ id: string; name: string }>>(
      `SELECT record::id(id) AS id, name FROM crm_company WHERE store = ${S} AND kind = NONE LIMIT 1`,
      { store: storeId },
    ))[0] ?? null
  );
}

/** Agencias de la tienda (pickers de intermediaria), por nombre. */
export async function listAgencies(storeId: string, limit: number): Promise<Row[]> {
  return surql<Row[]>(
    `SELECT ${COMPANY_COLS} FROM crm_company WHERE store = ${S} AND kind = 'agencia' ORDER BY name ASC LIMIT $limit`,
    { store: storeId, limit },
  );
}

/** Contactos de varias empresas (principal primero) con `company_name`. */
export async function listContactsOfCompanies(storeId: string, companyIds: string[], limit: number): Promise<Row[]> {
  if (companyIds.length === 0) return [];
  return surql<Row[]>(
    `LET $r = ${recs("crm_company", "$ids")};
     SELECT ${CONTACT_COLS}, company.name AS company_name FROM crm_contact
     WHERE store = ${S} AND company IN $r
     ORDER BY is_primary DESC, created_at ASC LIMIT $limit`,
    { store: storeId, ids: companyIds, limit },
  );
}

/** Anunciantes que atiende cada contacto (con nombre), para los pickers de pedido. */
export async function listAccountsOfContacts(
  storeId: string,
  contactIds: string[],
): Promise<Array<{ contact_id: string; advertiser_company_id: string; advertiser_name: string }>> {
  if (contactIds.length === 0) return [];
  const rows = await surql<Array<{ contact_id: string; advertiser_company_id: string; advertiser_name: string | null }>>(
    `LET $r = ${recs("crm_contact", "$ids")};
     SELECT record::id(in) AS contact_id, record::id(out) AS advertiser_company_id, out.name AS advertiser_name
     FROM crm_contact_account WHERE store = ${S} AND in IN $r LIMIT 500`,
    { store: storeId, ids: contactIds },
  );
  return rows.map((r) => ({ ...r, advertiser_name: r.advertiser_name ?? "—" }));
}

export async function countContacts(storeId: string): Promise<number> {
  return (await surql<number[]>(`SELECT VALUE count() FROM crm_contact WHERE store = ${S} GROUP ALL`, { store: storeId }))[0] ?? 0;
}
