// Órdenes de inserción sobre SurrealDB: lecturas como DTO de la app (ids planos, fechas ISO,
// mismos nombres de campo que consume la UI) y escrituras transaccionales.
// Las reglas que dependen de concurrencia (capacidad, cobros, numeración) viven en la DB como
// funciones (`surreal/migrations/0007`) y se invocan desde aquí; ver 0006 para el porqué.
import { randomUUID } from "node:crypto";
import { assignments, surql, thrownMessage, type LinkMap } from "@/lib/surreal";
import { addDays, dayOf, dayStart, displayEndOf, todayIn } from "@/lib/format";
import { getStoreTimeZone } from "@/lib/stores-db";
import { iso, key } from "@/lib/surql-cols";

const S = "type::record('sys_store', $store)";
export type Row = Record<string, unknown>;

/** Orden como DTO: `io_number`, `*_company_id`, `*_contact_id`, instantes ISO (UTC).
 *  `starts_at`/`ends_at` de la orden se traducen a días del tenant en `withOrderDays`. */
export const ORDER_COLS = `record::id(id) AS id, record::id(store) AS store_id, number AS io_number, status, brand,
  currency, workflow_rev, agreement_revision, authorization_kind, responsible_email,
  ${iso("reservation_expires_at")} AS reservation_expires_at, ${iso("reserved_at")} AS reserved_at, reserved_by, reservation_origin, ${key("advertiser")} AS advertiser_company_id, ${key("billing")} AS billing_company_id,
  ${key("agency")} AS agency_company_id, ${key("billing_contact")} AS billing_contact_id,
  ${key("signer_contact")} AS signer_contact_id, ${key("payment_contact")} AS payment_contact_id,
  ${key("manager_contact")} AS manager_contact_id, ${iso("starts_at")} AS starts_at, ${iso("ends_at")} AS ends_at, payment_terms, payment_terms_days,
  commission_pct, service_clauses, signed_by_agency, signed_by_company, ${iso("signed_at")} AS signed_at, notes,
  doc_orden_medios, doc_orden_compra, doc_contrato, billing_portal_email, billing_detail, invoice_registration,
  snapshot_json, created_by, updated_by, ${iso("created_at")} AS created_at, ${iso("updated_at")} AS updated_at`;

export const LINE_COLS = `record::id(id) AS id, record::id(store) AS store_id, record::id(order) AS io_id,
  record::id(screen) AS screen_id, ${key("slot")} AS slot_id, ${iso("starts_at")} AS starts_at, ${iso("ends_at")} AS ends_at,
  screen.name AS screen_name, rate_minor, tarifa_regular_minor, cant_meses, cant_dias, cant_slots, notes,
  ${key("screen.supplier")} AS supplier_company_id, screen.ownership AS ownership,
  screen.width_px AS screen_width_px, screen.height_px AS screen_height_px, screen.duration_sec AS screen_duration_sec`;

const LINE_BASE = `record::id(id) AS id, record::id(store) AS store_id, record::id(order) AS io_id,
  record::id(screen) AS screen_id, ${key("slot")} AS slot_id, ${iso("starts_at")} AS starts_at, ${iso("ends_at")} AS ends_at,
  rate_minor, tarifa_regular_minor, cant_meses, cant_dias, cant_slots, notes`;

/**
 * Líneas de VARIAS órdenes con los datos de su pantalla, mismas columnas que LINE_COLS. Cada
 * `screen.campo` de LINE_COLS recupera la pantalla otra vez por línea (5 s con 20 000 líneas);
 * aquí las pantallas distintas se leen UNA vez (indexado por id) y se unen en JS (0,5 s).
 * `pre` = sentencias LET previas; `where` ya incluye el filtro de tienda.
 */
async function readLines(where: string, vars: Record<string, unknown>, pre = ""): Promise<Row[]> {
  const { lines, screens } = await surql<{ lines: Array<Row & { screen_key?: string }>; screens: Row[] }>(
    `${pre}
     LET $ln = SELECT ${LINE_BASE}, ${key("screen")} AS screen_key FROM io_line WHERE ${where};
     LET $sids = array::distinct($ln.map(|$l| type::record('inv_screen', $l.screen_key)));
     RETURN {
       lines: $ln,
       screens: SELECT record::id(id) AS screen_key, name, ownership, IF supplier { record::id(supplier) } ELSE { NONE } AS supplier, width_px, height_px, duration_sec
         FROM inv_screen WHERE id IN $sids
     };`,
    vars,
  );
  const byKey = new Map(screens.map((sc) => [String(sc.screen_key), sc]));
  return lines.map(({ screen_key, ...l }) => {
    const sc = byKey.get(String(screen_key));
    return {
      ...l,
      screen_name: sc?.name,
      supplier_company_id: sc?.supplier,
      ownership: sc?.ownership,
      screen_width_px: sc?.width_px,
      screen_height_px: sc?.height_px,
      screen_duration_sec: sc?.duration_sec,
    };
  });
}

const AGENCY_ORDER_COLS = `record::id(id) AS id, record::id(store) AS store_id, record::id(order) AS io_id, kind, code,
  portal, issued_at, document_url, notes, created_by, agreement_revision`;
const CREATIVE_COLS = `record::id(id) AS id, record::id(store) AS store_id, record::id(order) AS io_id, name, qc_status,
  legal_status, file_url, created_by, duration_s, width_px, height_px, aspect,
  lines.map(|$l| record::id($l)) AS line_ids, ${iso("superseded_at")} AS superseded_at,
  ${key("supersedes")} AS supersedes_id, qc_notes, legal_notes, qc_reviewed_by, legal_reviewed_by,
  ${iso("qc_reviewed_at")} AS qc_reviewed_at, ${iso("legal_reviewed_at")} AS legal_reviewed_at`;
const PHOTO_COLS = `record::id(id) AS id, record::id(store) AS store_id, record::id(order) AS io_id,
  ${key("screen")} AS screen_id, ${key("line")} AS line_id, photo_url, video_url, evidence_kind,
  ${iso("coverage_from")} AS coverage_from, ${iso("coverage_to")} AS coverage_to, ${iso("taken_at")} AS taken_at, created_by`;
/** Factura con sus cobros anidados (la arista inversa nativa reemplaza el embed de PostgREST). */
/** `fn::key(order)` sobre io_invoice (tabla con campo COMPUTED) cuesta ~1,3 ms por fila (4,2 s con 3 300
 *  facturas); el IF en línea hace lo mismo en ~0,01 ms. */
const KEY_ORDER = "IF order { record::id(order) } ELSE { NONE }";
export const INVOICE_COLS = `record::id(id) AS id, record::id(store) AS store_id, ${KEY_ORDER} AS io_id, number,
  amount_minor, currency, issue_date, due_date, status, om_ref, pop_report_url, notes, paid_minor,
  (SELECT record::id(id) AS id, record::id(invoice) AS invoice_id, amount_minor, paid_on, reference, source,
          created_by, ${iso("voided_at")} AS voided_at, voided_by, void_reason, ${iso("created_at")} AS created_at
   FROM io_invoice_payment WHERE invoice = $parent.id ORDER BY created_at ASC) AS payments`;

const INVOICE_BASE = `record::id(id) AS id, record::id(store) AS store_id, ${KEY_ORDER} AS io_id, number,
  amount_minor, currency, issue_date, due_date, status, om_ref, pop_report_url, notes`;
const PAYMENT_COLS = `record::id(id) AS id, record::id(invoice) AS invoice_id, amount_minor, paid_on, reference, source,
  created_by, ${iso("voided_at")} AS voided_at, voided_by, void_reason, ${iso("created_at")} AS created_at`;

/**
 * Facturas de VARIAS filas con cobros y `paid_minor`, en un solo viaje: los cobros salen de UNA
 * consulta indexada (`invoice IN $rids`). El `paid_minor` COMPUTED y la subconsulta
 * `WHERE invoice = $parent.id` de INVOICE_COLS corren una vez por factura sin usar el índice
 * (4,2 s con 3 300 facturas); para una sola orden INVOICE_COLS sigue siendo suficiente.
 * `pre` = sentencias LET previas; `where` ya incluye el filtro de tienda.
 */
async function readInvoices(where: string, vars: Record<string, unknown>, pre = "", tail = ""): Promise<Row[]> {
  const { inv, pay } = await surql<{ inv: Row[]; pay: Row[] }>(
    `${pre}
     LET $inv = SELECT ${INVOICE_BASE} FROM io_invoice WHERE ${where} ${tail};
     LET $rids = $inv.map(|$x| type::record('io_invoice', $x.id));
     RETURN { inv: $inv, pay: SELECT ${PAYMENT_COLS} FROM io_invoice_payment WHERE invoice IN $rids ORDER BY created_at ASC };`,
    vars,
  );
  const byInvoice = new Map<string, Row[]>();
  for (const p of pay) {
    const k = String(p.invoice_id);
    const list = byInvoice.get(k);
    if (list) list.push(p);
    else byInvoice.set(k, [p]);
  }
  return inv.map((i) => {
    const payments = byInvoice.get(String(i.id)) ?? [];
    // Mismo cálculo que el campo COMPUTED `paid_minor`: suma de cobros no revertidos.
    const paid_minor = payments.reduce((t, p) => (p.voided_at == null ? t + Number(p.amount_minor) : t), 0);
    return { ...i, paid_minor, payments };
  });
}

const KINDS = {
  io_order: ORDER_COLS,
  io_agency_order: AGENCY_ORDER_COLS,
  io_creative: CREATIVE_COLS,
  io_photo_check: PHOTO_COLS,
  io_invoice: INVOICE_COLS,
} as const;
export type OwnedKind = keyof typeof KINDS;

const ORDER_LINKS: LinkMap = {
  advertiser_company_id: { field: "advertiser", table: "crm_company" },
  billing_company_id: { field: "billing", table: "crm_company" },
  agency_company_id: { field: "agency", table: "crm_company" },
  billing_contact_id: { field: "billing_contact", table: "crm_contact" },
  signer_contact_id: { field: "signer_contact", table: "crm_contact" },
  payment_contact_id: { field: "payment_contact", table: "crm_contact" },
  manager_contact_id: { field: "manager_contact", table: "crm_contact" },
};

// ── Lecturas ──────────────────────────────────────────────────────────────
/** Fila por id SIN conocer la tienda (acciones por id): el caller valida la membresía con `store_id`. */
export async function findOwned(kind: OwnedKind, id: string): Promise<Row | null> {
  if (!id) return null;
  const row = await surql<Row | null>(`SELECT ${KINDS[kind]} FROM ONLY type::record('${kind}', $id)`, { id });
  if (!row) return null;
  return kind === "io_order" ? withOrderDays(row, await getStoreTimeZone(String(row.store_id))) : row;
}

/** Periodo de la orden en DÍAS del tenant: inicio y último día inclusivo ("yyyy-mm-dd"). La BD guarda
 *  instantes UTC (fin exclusivo); el día solo existe en la zona del tenant. */
export function withOrderDays<T extends Row>(row: T, tz: string): T {
  const conv = (v: unknown, end: boolean): string | null => {
    if (typeof v !== "string" || !v) return null;
    return end ? displayEndOf(v, tz) : dayOf(v, tz);
  };
  return { ...row, starts_at: conv(row.starts_at, false), ends_at: conv(row.ends_at, true) };
}

export async function getOrder(storeId: string, id: string): Promise<Row | null> {
  const row = await findOwned("io_order", id);
  return row && row.store_id === storeId ? row : null;
}

export interface OrderChildren {
  lines: Row[];
  oms: Row[];
  creatives: Row[];
  photos: Row[];
  invoices: Row[];
}

/** Hijas de varias órdenes en un viaje (lista de órdenes). */
export async function listChildrenOf(storeId: string, orderIds: string[]): Promise<OrderChildren> {
  // LET: un `IN $ids.map(...)` inline se reevalúa por fila (O(filas × ids)).
  const r = "LET $r = $ids.map(|$i| type::record('io_order', $i));";
  const [lines, oms, creatives, photos, invoices] = await Promise.all([
    readLines(`store = ${S} AND order IN $r`, { store: storeId, ids: orderIds }, r),
    surql<Row[]>(`${r} SELECT ${AGENCY_ORDER_COLS} FROM io_agency_order WHERE store = ${S} AND order IN $r`, { store: storeId, ids: orderIds }),
    surql<Row[]>(`${r} SELECT ${CREATIVE_COLS} FROM io_creative WHERE store = ${S} AND order IN $r`, { store: storeId, ids: orderIds }),
    surql<Row[]>(`${r} SELECT ${PHOTO_COLS} FROM io_photo_check WHERE store = ${S} AND order IN $r`, { store: storeId, ids: orderIds }),
    readInvoices(`store = ${S} AND order IN $r`, { store: storeId, ids: orderIds }, r),
  ]);
  return { lines, oms, creatives, photos, invoices };
}

/** Hijas de UNA orden para la ficha (líneas por fecha, fotos recientes primero, tope 50). */
export async function listChildrenOfOne(storeId: string, orderId: string): Promise<OrderChildren & { bookings: number }> {
  const o = "type::record('io_order', $id)";
  const v = { store: storeId, id: orderId };
  const [lines, oms, creatives, photos, invoices, bookings] = await Promise.all([
    surql<Row[]>(`SELECT ${LINE_COLS} FROM io_line WHERE store = ${S} AND order = ${o} ORDER BY starts_at ASC`, v),
    surql<Row[]>(`SELECT ${AGENCY_ORDER_COLS} FROM io_agency_order WHERE store = ${S} AND order = ${o}`, v),
    surql<Row[]>(`SELECT ${CREATIVE_COLS} FROM io_creative WHERE store = ${S} AND order = ${o}`, v),
    surql<Row[]>(`SELECT ${PHOTO_COLS} FROM io_photo_check WHERE store = ${S} AND order = ${o} ORDER BY taken_at DESC `, v),
    surql<Row[]>(`SELECT ${INVOICE_COLS} FROM io_invoice WHERE store = ${S} AND order = ${o}`, v),
    countWhere("inv_booking", storeId, orderId),
  ]);
  return { lines, oms, creatives, photos, invoices, bookings };
}

async function countWhere(table: "inv_booking" | "io_invoice" | "io_campaign" | "io_play_log", storeId: string, orderId: string): Promise<number> {
  return (
    (await surql<number[]>(
      `SELECT VALUE count() FROM ${table} WHERE store = ${S} AND order = type::record('io_order', $id) GROUP ALL`,
      { store: storeId, id: orderId },
    ))[0] ?? 0
  );
}

export const countInvoices = (storeId: string, orderId: string) => countWhere("io_invoice", storeId, orderId);
export const countBookings = (storeId: string, orderId: string) => countWhere("inv_booking", storeId, orderId);

/** Historia que impide borrar la orden. */
export async function orderDependents(storeId: string, orderId: string) {
  const [invoices, bookings, campaigns, plays] = await Promise.all([
    countWhere("io_invoice", storeId, orderId),
    countWhere("inv_booking", storeId, orderId),
    countWhere("io_campaign", storeId, orderId),
    countWhere("io_play_log", storeId, orderId),
  ]);
  return { invoices, bookings, campaigns, plays };
}

/** Líneas de la pantalla que tocan el día `[from, to)` con su orden (ocupación del día). */
export async function listScreenDayLines(storeId: string, screenId: string, from: string, to: string): Promise<Row[]> {
  return surql<Row[]>(
    `SELECT ${iso("starts_at")} AS starts_at, ${iso("ends_at")} AS ends_at, cant_slots,
            order.number AS io_number, order.brand AS brand, order.status AS status, ${iso("order.created_at")} AS created_at, ${iso("order.reservation_expires_at")} AS reservation_expires_at
     FROM io_line
     WHERE store = ${S} AND screen = type::record('inv_screen', $screen)
       AND starts_at < <datetime> $to AND ends_at > <datetime> $from`,
    { store: storeId, screen: screenId, from, to },
  );
}

// ── Escrituras de la orden ────────────────────────────────────────────────
export interface LineInput {
  screen_id: string;
  starts: string;
  ends: string;
  total: number;
  slots: number;
  notes?: string | null;
}
/** Líneas para la BD: cada día del periodo (días del tenant, ambos inclusivos) como ventana UTC
 *  `[from, to)`. La BD no conoce zonas ni DST: recibe los instantes ya resueltos. */
const toDbLines = (lines: LineInput[], tz: string) =>
  lines.map((l) => {
    const days: Array<{ d: string; from: string; to: string }> = [];
    for (let d = l.starts; d <= l.ends; d = addDays(d, 1)) days.push({ d, from: dayStart(d, tz), to: dayStart(addDays(d, 1), tz) });
    return { screen_id: l.screen_id, days, total: l.total, slots: l.slots, notes: l.notes ?? undefined };
  });

/** Crea la orden con número correlativo y sus líneas en UNA transacción: o queda todo o nada,
 *  con la capacidad verificada (sin compensaciones ni "degradación elegante"). */
export async function createOrderWithLines(storeId: string, fields: Row, lines: LineInput[], actor: string | null): Promise<string> {
  const id = randomUUID();
  const { sql, vars } = assignments(fields, ORDER_LINKS);
  const tz = await getStoreTimeZone(storeId);
  const year = Number(todayIn(tz).slice(0, 4)); // año del correlativo: el del tenant
  await surql(
    `BEGIN;
     LET $number = fn::mint_io_number(${S}, $year);
     CREATE type::record('io_order', $id) SET store = ${S}, number = $number, ${sql};
     fn::replace_lines(type::record('io_order', $id), $lines, $actor);
     COMMIT;`,
    { store: storeId, id, year, lines: toDbLines(lines, tz), actor, ...vars },
  );
  return id;
}

/** Reemplaza las líneas de un borrador (capacidad validada en la misma transacción). */
export async function replaceOrderLines(storeId: string, orderId: string, lines: LineInput[], actor: string | null): Promise<void> {
  const owner = await surql<string[]>(`SELECT VALUE record::id(store) FROM io_order WHERE id = type::record('io_order', $id)`, { id: orderId });
  if (owner[0] !== storeId) throw new Error("orden no encontrada");
  await surql(`fn::replace_lines(type::record('io_order', $id), $lines, $actor)`, { id: orderId, lines: toDbLines(lines, await getStoreTimeZone(storeId)), actor });
}

export async function patchOrder(storeId: string, id: string, fields: Row): Promise<void> {
  const { sql, vars } = assignments(fields, ORDER_LINKS);
  if (!sql) return;
  await surql(`UPDATE io_order SET ${sql}, workflow_rev += 1 WHERE store = ${S} AND id = type::record('io_order', $id)`, { store: storeId, id, ...vars });
}

/** Marca `updated_by` de la orden (la fecha se sella sola). */
export async function touchOrder(storeId: string, id: string, actor: string | null): Promise<void> {
  await patchOrder(storeId, id, { updated_by: actor });
}

export async function deleteOrder(storeId: string, id: string): Promise<void> {
  await surql(`DELETE io_order WHERE store = ${S} AND id = type::record('io_order', $id)`, { store: storeId, id });
}

// ── Hijas ─────────────────────────────────────────────────────────────────
type ChildKind = "io_agency_order" | "io_creative" | "io_photo_check";
const CHILD_LINKS: LinkMap = { screen_id: { field: "screen", table: "inv_screen" } };

/** Inserta una hija de la orden; la clave la genera la app. Devuelve el id. */
export async function insertChild(kind: ChildKind, storeId: string, orderId: string, fields: Row): Promise<string> {
  const id = randomUUID();
  const { sql, vars } = assignments(fields, CHILD_LINKS);
  await surql(
    `CREATE type::record('${kind}', $id) SET store = ${S}, order = type::record('io_order', $id_order), ${sql}`,
    { store: storeId, id, id_order: orderId, ...vars },
  );
  return id;
}

export async function deleteChild(kind: ChildKind, storeId: string, id: string): Promise<void> {
  await surql(`DELETE type::record('${kind}', $id) WHERE store = ${S}`, { store: storeId, id });
}

// ── Facturas y cobros ─────────────────────────────────────────────────────
export async function createInvoice(storeId: string, orderId: string, fields: Row): Promise<string> {
  const id = randomUUID();
  const { sql, vars } = assignments(fields);
  await surql(
    `CREATE type::record('io_invoice', $id) SET store = ${S}, order = type::record('io_order', $order), ${sql}`,
    { store: storeId, id, order: orderId, ...vars },
  );
  return id;
}

export async function cancelInvoice(invoiceId: string, actor: string | null): Promise<void> {
  await surql(`fn::invoice_cancel(type::record('io_invoice', $id), $actor)`, { id: invoiceId, actor });
}

export async function recordInvoicePayment(
  invoiceId: string,
  p: { requestId: string; amountMinor: number; paidOn: string; reference: string },
  actor: string | null,
): Promise<void> {
  const [store] = await surql<string[]>(`SELECT VALUE record::id(store) FROM io_invoice WHERE id = type::record('io_invoice', $id)`, { id: invoiceId });
  if (!store) throw new Error("Factura no encontrada");
  const today = todayIn(await getStoreTimeZone(store)); // "hoy" del tenant: no se cobra a futuro
  await surql(
    `fn::invoice_record_payment(type::record('io_invoice', $id), $payment, $amount, $paid_on, $reference, $today, $actor)`,
    { id: invoiceId, payment: p.requestId, amount: p.amountMinor, paid_on: p.paidOn, reference: p.reference, today, actor },
  );
}

export async function voidInvoicePayment(invoiceId: string, paymentId: string, reason: string, actor: string | null): Promise<void> {
  await surql(`fn::invoice_void_payment(type::record('io_invoice', $id), $payment, $reason, $actor)`, {
    id: invoiceId, payment: paymentId, reason, actor,
  });
}

/** Mensaje legible de un error de la DB (los THROW de las funciones ya vienen en español). */
export const dbMessage = thrownMessage;

/** Bookings (slot de la pantalla) que tocan el día `[from, to)`, con su orden. */
export async function listScreenDayBookings(storeId: string, screenId: string, from: string, to: string): Promise<Row[]> {
  return surql<Row[]>(
    `SELECT ${iso("starts_at")} AS starts_at, ${iso("ends_at")} AS ends_at, status, order.number AS io_number, order.brand AS brand
     FROM inv_booking
     WHERE store = ${S} AND slot.screen = type::record('inv_screen', $screen) AND status != 'cancelled'
       AND starts_at < <datetime> $to AND ends_at > <datetime> $from`,
    { store: storeId, screen: screenId, from, to },
  );
}

// ── Consultas genéricas para consumidores (dashboard, finanzas, marcas, insights, agente) ──
export interface OrderFilter {
  ids?: string[];
  /** Sin canceladas. */
  live?: boolean;
  /** Solo con marca. */
  withBrand?: boolean;
  /** Orden donde participa la empresa (anunciante o facturación). */
  companyId?: string;
  /** Terminadas antes de `yyyy-mm-dd`. */
  endedBefore?: string;
  order?: "starts_asc" | "starts_desc" | "created_desc";
  limit?: number;
}

const ORDER_BY = { starts_asc: "starts_at ASC", starts_desc: "starts_at DESC", created_desc: "created_at DESC" } as const;

/** Prefijo LET del filtro `ids` (ver `listChildrenOf`: el `.map` inline se reevalúa por fila). */
function orderIdsLet(f: OrderFilter): string {
  return f.ids ? "LET $r = $ids.map(|$i| type::record('io_order', $i));" : "";
}

function orderWhere(f: OrderFilter): string {
  const c = [`store = ${S}`];
  if (f.ids) c.push("id IN $r");
  if (f.live) c.push("status != 'cancelled'");
  if (f.withBrand) c.push("brand != NONE");
  if (f.companyId) c.push("(advertiser = type::record('crm_company', $company) OR billing = type::record('crm_company', $company))");
  if (f.endedBefore) c.push("ends_at <= <datetime> $endedBefore"); // fin exclusivo ≤ inicio de ese día
  return c.join(" AND ");
}

/** Órdenes como DTO según el filtro. */
export async function selectOrders(storeId: string, f: OrderFilter = {}): Promise<Row[]> {
  if (f.ids && f.ids.length === 0) return [];
  const tz = await getStoreTimeZone(storeId);
  const rows = await surql<Row[]>(
    `${orderIdsLet(f)} SELECT ${ORDER_COLS} FROM io_order WHERE ${orderWhere(f)} ${f.order ? `ORDER BY ${ORDER_BY[f.order]}` : ""} ${f.limit ? "LIMIT $limit" : ""}`,
    { store: storeId, ids: f.ids, company: f.companyId, endedBefore: f.endedBefore ? dayStart(f.endedBefore, tz) : undefined, limit: f.limit },
  );
  return rows.map((r) => withOrderDays(r, tz));
}

export async function countOrders(storeId: string, f: OrderFilter = {}): Promise<number> {
  if (f.ids && f.ids.length === 0) return 0;
  const endedBefore = f.endedBefore ? dayStart(f.endedBefore, await getStoreTimeZone(storeId)) : undefined;
  return (
    (await surql<number[]>(`${orderIdsLet(f)} SELECT VALUE count() FROM io_order WHERE ${orderWhere(f)} GROUP ALL`, {
      store: storeId, ids: f.ids, company: f.companyId, endedBefore,
    }))[0] ?? 0
  );
}

/** Líneas de las órdenes dadas (DTO). */
export async function selectLines(storeId: string, orderIds: string[]): Promise<Row[]> {
  if (orderIds.length === 0) return [];
  return readLines(`store = ${S} AND order IN $r`, { store: storeId, ids: orderIds }, "LET $r = $ids.map(|$i| type::record('io_order', $i));");
}

/** Facturas de la tienda con sus cobros anidados (más recientes primero). */
export async function selectInvoices(storeId: string, limit?: number): Promise<Row[]> {
  return readInvoices(`store = ${S}`, { store: storeId, limit }, "", `ORDER BY created_at DESC ${limit ? "LIMIT $limit" : ""}`);
}

/** Ids de órdenes (de `orderIds`) que ya tienen foto check. */
export async function orderIdsWithPhotos(storeId: string, orderIds: string[]): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const rows = await surql<string[]>(
    `LET $r = $ids.map(|$i| type::record('io_order', $i));
     SELECT VALUE record::id(order) FROM io_photo_check WHERE store = ${S} AND order IN $r`,
    { store: storeId, ids: orderIds },
  );
  return new Set(rows);
}

/** Marcas distintas ya usadas (autocomplete). */
export async function listDistinctBrands(storeId: string, limit: number): Promise<string[]> {
  return surql<string[]>(
    `SELECT VALUE brand FROM io_order WHERE store = ${S} AND brand != NONE GROUP BY brand LIMIT $limit`,
    { store: storeId, limit },
  );
}

/** Campañas del anunciante (más recientes primero). */
export async function listCampaignsOfAdvertiser(storeId: string, companyId: string, limit: number): Promise<Row[]> {
  return surql<Row[]>(
    `SELECT record::id(id) AS id, name, status, starts_at, ends_at, ${key("primary_contact")} AS primary_contact_id
     FROM io_campaign WHERE store = ${S} AND advertiser = type::record('crm_company', $company) ORDER BY created_at DESC LIMIT $limit`,
    { store: storeId, company: companyId, limit },
  );
}

/** Re-apunta el contacto principal de las campañas (fusión de contactos). */
export async function repointCampaignContact(storeId: string, fromIds: string[], toId: string): Promise<void> {
  await surql(
    `LET $r = $from.map(|$i| type::record('crm_contact', $i));
     UPDATE io_campaign SET primary_contact = type::record('crm_contact', $to)
     WHERE store = ${S} AND primary_contact IN $r`,
    { store: storeId, from: fromIds, to: toId },
  );
}
