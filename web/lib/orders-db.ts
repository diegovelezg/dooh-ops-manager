import { workflowRows, type WorkflowRows } from "@/lib/order-workflow-reads";
import { commercialState, isAuthorized, materialsCovered, deliveriesCovered, supplierConfirmed } from "@/lib/order-workflow";
// Lecturas de órdenes sobre SurrealDB. La etapa se deriva en JS
// con orderStage: volumen bajo (<200), sin paginación exacta que mentir.
import { getStoreTimeZone } from "@/lib/stores-db";
import { getOrder, listChildrenOf, listChildrenOfOne, listOrderRows } from "@/lib/orders-store";
import { listCompanies, listContactsWithCompany } from "@/lib/crm-store";
import { listScreensBrief } from "@/lib/screens-store";
import { joinHaystack, matchScore, matchTokens, normalizeSearch, tokenizeSearch } from "@/lib/search-text";
import { orderStage, orderTiming, type OrderStageKey } from "@/lib/order-stage";
import { billingStatus, toBillingInvoice, type BillingStatusKey } from "@/lib/billing-status";
import { invoiceMatchesOrder, normalizeCurrency } from "@/lib/currency";

export interface OrderRow {
  id: string;
  io_number: string;
  commercial_state: string;
  brand: string | null;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  advertiser_name: string | null;
  billing_name: string | null;
  lines_count: number;
  gross_minor: number;
  /** Moneda de la IO (las líneas heredan esta moneda; nunca sumar mixto). */
  currency: string;
  stage: OrderStageKey;
  stage_index: number;
  has_om: boolean;
  billing: BillingStatusKey;
  invoiced_minor: number;
  paid_minor: number;
  pending_minor: number;
  isPrepaid: boolean;
}

export { ORDER_STAGES } from "@/lib/order-stage";

const now = () => Date.now();

export async function listOrders(
  storeId: string,
  opts: { q?: string; stage?: OrderStageKey | null; billing?: BillingStatusKey | null } = {},
): Promise<OrderRow[]> {
  const allRows = await listOrderRows(storeId, 200);
  if (allRows.length === 0) return [];

  // Nombres primero: el filtro fuzzy cruza IO + marca + anunciante + facturación.
  const preIds = [
    ...new Set(
      allRows.flatMap((r) => [r.advertiser_company_id, r.billing_company_id].filter(Boolean)).map(String),
    ),
  ];
  const nameByPre = new Map<string, string>();
  if (preIds.length > 0) {
    for (const c of await listCompanies(storeId, preIds)) {
      nameByPre.set(String(c.id), String(c.name ?? ""));
    }
  }
  // Fuzzy en JS (etapa y cobro se derivan aquí): tildes, multi-token y ranking.
  const tokens = tokenizeSearch(opts.q ?? "");
  const qNorm = normalizeSearch(opts.q ?? "");
  const ranked = allRows
    .map((r) => {
      if (tokens.length === 0) return { r, score: 0 };
      const hay = joinHaystack([
        r.io_number,
        r.brand,
        nameByPre.get(String(r.advertiser_company_id ?? "")),
        nameByPre.get(String(r.billing_company_id ?? "")),
      ]);
      if (!matchTokens(hay, tokens)) return { r, score: -1 };
      return { r, score: matchScore(hay, tokens, qNorm) };
    })
    .filter((s) => s.score >= 0);
  if (ranked.length === 0) return [];
  // Con búsqueda: relevancia primero (estable: conserva fecha dentro del score).
  if (tokens.length > 0) ranked.sort((a, b) => b.score - a.score);
  const rows = ranked.map((s) => s.r);
  const ids = rows.map((r) => String(r.id));

  // Hijas: fail-closed — cualquier hija caída lanza (nunca 0 silencioso).
  const { lines, oms, creatives: creas, photos, invoices: invs } = await listChildrenOf(storeId, ids);
  // Nombres ya resueltos arriba para el filtro (mismo mapa).
  const nameBy = nameByPre;
  const linesBy = new Map<string, { n: number; gross: number }>();
  for (const l of lines) {
    const k = String(l.io_id);
    const prev = linesBy.get(k) ?? { n: 0, gross: 0 };
    prev.n += 1;
    prev.gross += Number(l.rate_minor ?? 0);
    linesBy.set(k, prev);
  }
  const workflow = await workflowRows(storeId, ids);
  const invBy = new Map<string, Array<Record<string, unknown>>>();
  for (const v of invs) {
    const k = String(v.io_id);
    const arr = invBy.get(k) ?? [];
    arr.push(v);
    invBy.set(k, arr);
  }

  const tz = await getStoreTimeZone(storeId);
  const t = now();
  const out: OrderRow[] = rows.map((r) => {
    const id = String(r.id);
    const timing = orderTiming(r, (lines).filter((l) => l.io_id === id), t, tz);
    const ownLines = lines.filter(l => l.io_id === id);
    const authorized = isAuthorized(r, oms.filter(d => d.io_id === id));
    const { index, stage } = orderStage({
      status: (r.status as string | null) ?? null,
      signed: r.status === "signed",
      hasOm: authorized,
      materialsOk: materialsCovered(ownLines, creas.filter(c => c.io_id === id)) && ownLines.every(l => supplierConfirmed(l, workflow.purchases)),
      ...timing,
      certified: deliveriesCovered(ownLines, workflow.deliveries, photos),
    });
    const agg = linesBy.get(id) ?? { n: 0, gross: 0 };
    const invRows = invBy.get(id) ?? [];
    // Solo facturas con moneda explícita igual a la IO: null NUNCA hereda
    // (una USD sin moneda no se suma como PEN).
    const orderCurrency = normalizeCurrency(r.currency ?? "PEN", "PEN");
    const invSameCurrency = invRows.filter((v) => invoiceMatchesOrder(v.currency, orderCurrency));
    const bill = billingStatus({
      gross_minor: agg.gross,
      invoices: invSameCurrency.map(toBillingInvoice),
      starts_at: (r.starts_at as string | null) ?? null,
      payment_terms_days:
        typeof r.payment_terms_days === "number" ? (r.payment_terms_days as number) : null,
      now: t,
      tz,
    });
    return {
      id,
      commercial_state: commercialState(r,t),
      io_number: String(r.io_number ?? ""),
      brand: (r.brand as string | null) ?? null,
      status: String(r.status ?? ""),
      starts_at: (r.starts_at as string | null) ?? null,
      ends_at: (r.ends_at as string | null) ?? null,
      advertiser_name: r.advertiser_company_id ? (nameBy.get(String(r.advertiser_company_id)) ?? null) : null,
      billing_name: r.billing_company_id ? (nameBy.get(String(r.billing_company_id)) ?? null) : null,
      lines_count: agg.n,
      gross_minor: agg.gross,
      currency: orderCurrency,
      stage,
      stage_index: index,
      has_om: authorized,
      billing: bill.status,
      invoiced_minor: bill.invoiced_minor,
      paid_minor: bill.paid_minor,
      pending_minor: bill.pending_minor,
      isPrepaid: bill.isPrepaid,
    };
  });
  let filtered = opts.stage ? out.filter((r) => r.stage === opts.stage) : out;
  if (opts.billing) filtered = filtered.filter((r) => r.billing === opts.billing);
  return filtered;
}

export interface OrderContactRef {
  id: string;
  company_id: string | null;
  company_name: string | null;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
}

/** Contacto (+ `company_name` de su empresa) → ref para pickers y PDF. */
export function toContactRef(r: Record<string, unknown>): OrderContactRef {
  const first = typeof r.first_name === "string" ? r.first_name.trim() : "";
  const last = typeof r.last_name === "string" ? r.last_name.trim() : "";
  const email = typeof r.email === "string" && r.email.trim() ? r.email.trim() : null;
  const companyName = typeof r.company_name === "string" && r.company_name.trim() ? r.company_name.trim() : null;
  return {
    id: String(r.id),
    company_id: r.company_id != null ? String(r.company_id) : null,
    company_name: companyName,
    name: [first, last].filter(Boolean).join(" ") || email || "—",
    role: typeof r.job_title === "string" && r.job_title.trim() ? r.job_title.trim() : null,
    email,
    phone: typeof r.phone === "string" && r.phone.trim() ? r.phone.trim() : null,
    is_primary: r.is_primary === true,
  };
}

export interface OrderDetail {
  workflow: WorkflowRows;
  readiness: { authorized: boolean; materials: boolean; certified: boolean };
  order: Record<string, unknown>;
  advertiser_name: string | null;
  /** Contactos vinculados por rol (FK); el texto libre queda como fallback. */
  contacts: {
    billing: OrderContactRef | null;
    signer: OrderContactRef | null;
    payment: OrderContactRef | null;
    manager: OrderContactRef | null;
  };  billing_name: string | null;
  billing_kind: string | null;
  /** ID fiscal (TIN) de la razón social a facturar (crm_companies.tax_id). */
  billing_tax_id: string | null;
  /** % de comisión del facturador cuando es agencia (default del caso agencia cliente). */
  billing_commission_pct: number | null;
  /** Intermediaria vinculada (Opción B); gana al texto libre en PDF y ficha. */
  agency_company_id: string | null;
  agency_name: string | null;
  agency_tax_id: string | null;
  agency_country: string | null;
  agency_commission_pct: number | null;
  /** Ciudad/país/dirección del facturador (crm_companies, solo lectura). */
  advertiser_city: string | null;
  advertiser_country: string | null;
  billing_city: string | null;
  billing_country: string | null;
  billing_company_address: string | null;
  lines: Array<Record<string, unknown>>;
  io_agency_orders: Array<Record<string, unknown>>;
  creatives: Array<Record<string, unknown>>;
  bookings_count: number;
  photos: Array<Record<string, unknown>>;
  photos_count: number;
  invoices: Array<Record<string, unknown>>;
}

export async function getOrderDetail(storeId: string, id: string): Promise<OrderDetail | null> {
  const o = await getOrder(storeId, id);
  if (!o) return null;
  const refIds = ["billing_contact_id", "signer_contact_id", "payment_contact_id", "manager_contact_id"]
    .map((k) => (typeof o[k] === "string" && o[k] ? String(o[k]) : null))
    .filter((x): x is string => x !== null);
  const [cos, children, refs, workflow] = await Promise.all([
    listCompanies(storeId, [o.advertiser_company_id, o.billing_company_id, o.agency_company_id].filter(Boolean).map(String)),
    listChildrenOfOne(storeId, id),
    listContactsWithCompany(storeId, refIds),
    workflowRows(storeId, [id]),
  ]);
  const { lines: lineRows, oms, creatives: creas, photos: photoRows, invoices: invs, bookings } = children;
  const nameBy = new Map(
    cos.map((c) => [String(c.id), String(c.name ?? "")]),
  );
  const kindBy = new Map(
    cos.map((c) => [String(c.id), typeof c.kind === "string" ? c.kind : null]),
  );
  const cityBy = new Map(
    cos.map((c) => [
      String(c.id),
      typeof c.city === "string" && c.city.trim() ? c.city.trim() : null,
    ]),
  );
  const countryBy = new Map(
    cos.map((c) => [
      String(c.id),
      typeof c.country === "string" && c.country.trim() ? c.country.trim() : null,
    ]),
  );
  const addressBy = new Map(
    cos.map((c) => [
      String(c.id),
      typeof c.address === "string" && c.address.trim() ? c.address.trim() : null,
    ]),
  );
  const numOrNull = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const commissionBy = new Map(
    cos.map((c) => [String(c.id), numOrNull(c.agency_commission_pct)]),
  );
  const taxBy = new Map(
    cos.map((c) => [
      String(c.id),
      typeof c.tax_id === "string" && c.tax_id.trim() ? c.tax_id.trim() : null,
    ]),
  );
  const contactBy = new Map(
    refs.map((r) => [String(r.id), toContactRef(r)]),
  );
  const contactRef = (key: string): OrderContactRef | null => {
    const cid = typeof o[key] === "string" && o[key] ? String(o[key]) : null;
    return cid ? (contactBy.get(cid) ?? null) : null;
  };
  const screenIds = [...new Set(lineRows.filter((l) => l.screen_id).map((l) => String(l.screen_id)))];
  interface ScreenInfo {
    name: string;
    detail: string | null;
    /** Código de pantalla (external_ref, p. ej. MI010). */
    code: string | null;
    /** Ubicación / sede (venue). */
    venue: string | null;
    /** Distrito (sede). */
    district: string | null;
    /** Elemento / tecnología (p. ej. Pantalla led). */
    technology: string | null;
  }
  let screenBy = new Map<string, ScreenInfo>();
  if (screenIds.length > 0) {
    const screens = await listScreensBrief(storeId, { ids: screenIds });
    screenBy = new Map(
      screens.map((s) => {
        const venue = typeof s.venue_name === "string" ? s.venue_name : "";
        const venueDistrict = typeof s.district === "string" && s.district.trim() ? s.district.trim() : "";
        const district = venueDistrict || null;
        const w = Number(s.width_px);
        const h = Number(s.height_px);
        const res = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? `${w}×${h}` : "";
        const detail = [s.external_ref, venue, s.technology, res]
          .map((x) => String(x ?? "").trim())
          .filter(Boolean)
          .join(" · ");
        const code = typeof s.external_ref === "string" && s.external_ref.trim() ? s.external_ref.trim() : null;
        const technology = typeof s.technology === "string" && s.technology.trim() ? s.technology.trim() : null;
        return [
          String(s.id),
          {
            name: String(s.name ?? ""),
            detail: detail || null,
            code,
            venue: venue || null,
            district: district || null,
            technology,
          },
        ];
      }),
    );
  }
  const advertiserId = typeof o.advertiser_company_id === "string" ? o.advertiser_company_id : o.advertiser_company_id != null ? String(o.advertiser_company_id) : null;
  const billingId = typeof o.billing_company_id === "string" ? o.billing_company_id : o.billing_company_id != null ? String(o.billing_company_id) : null;
  const agencyId = typeof o.agency_company_id === "string" ? o.agency_company_id : o.agency_company_id != null ? String(o.agency_company_id) : null;
  return {
    order: o,
    workflow,
    readiness: { authorized: isAuthorized(o, oms), materials: materialsCovered(lineRows, creas) && lineRows.every(l => supplierConfirmed(l, workflow.purchases)), certified: deliveriesCovered(lineRows, workflow.deliveries, photoRows) },
    advertiser_name: advertiserId ? (nameBy.get(advertiserId) ?? null) : null,
    contacts: {
      billing: contactRef("billing_contact_id"),
      signer: contactRef("signer_contact_id"),
      payment: contactRef("payment_contact_id"),
      manager: contactRef("manager_contact_id"),
    },
    billing_name: billingId ? (nameBy.get(billingId) ?? null) : null,
    billing_kind: billingId ? (kindBy.get(billingId) ?? null) : null,
    billing_tax_id: billingId ? (taxBy.get(billingId) ?? null) : null,
    billing_commission_pct: billingId ? (commissionBy.get(billingId) ?? null) : null,
    agency_company_id: agencyId,
    agency_name: agencyId ? (nameBy.get(agencyId) ?? null) : null,
    agency_tax_id: agencyId ? (taxBy.get(agencyId) ?? null) : null,
    agency_country: agencyId ? (countryBy.get(agencyId) ?? null) : null,
    agency_commission_pct: agencyId ? (commissionBy.get(agencyId) ?? null) : null,
    advertiser_city: advertiserId ? (cityBy.get(advertiserId) ?? null) : null,
    advertiser_country: advertiserId ? (countryBy.get(advertiserId) ?? null) : null,
    billing_city: billingId ? (cityBy.get(billingId) ?? null) : null,
    billing_country: billingId ? (countryBy.get(billingId) ?? null) : null,
    billing_company_address: billingId ? (addressBy.get(billingId) ?? null) : null,
    lines: lineRows.map((l) => {
      const s = screenBy.get(String(l.screen_id));
      return {
        ...l,
        screen_name: s?.name ?? null,
        screen_detail: s?.detail ?? null,
        screen_code: s?.code ?? null,
        screen_venue: s?.venue ?? null,
        screen_district: s?.district ?? null,
        screen_technology: s?.technology ?? null,
      };
    }),
    io_agency_orders: oms,
    creatives: creas,
    bookings_count: bookings,
    photos: photoRows,
    photos_count: photoRows.length,
    invoices: invs,
  };
}
