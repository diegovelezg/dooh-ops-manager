// Lecturas de órdenes y sus hijas para los listados derivados (Hoy, Inbox, /orders): UNA ronda de
// consultas independientes, en paralelo, con SOLO las columnas que usan las reglas de negocio
// (`lib/order-workflow`, `lib/order-stage`, `lib/billing-status`).
//   · Sin viaje intermedio de ids: las hijas se filtran con una subconsulta no correlacionada
//     (`order IN (SELECT VALUE id FROM io_order …)`), que SurrealDB 4 evalúa una vez por sentencia,
//     o por tienda completa (índice `*_store`, migración 0013).
//   · Sin lo que esos listados no usan: snapshots/eventos de versiones, `snapshot_json`.
//   · Sin topes mudos. Proyecciones inline (`lib/surql-cols`), no `fn::iso`/`fn::key`.
//   · El proveedor de cada línea sale de UNA lectura de pantallas (no de un join por línea).
import { surql } from "@/lib/surreal";
import { iso, key } from "@/lib/surql-cols";
import { withOrderDays, type Row } from "@/lib/orders-store";
import { getStoreTimeZone } from "@/lib/stores-db";

export const S = "type::record('sys_store', $store)";
/** Órdenes vigentes de la tienda (no canceladas), como subconsulta reutilizable. */
const LIVE = `(SELECT VALUE id FROM io_order WHERE store = ${S} AND status != 'cancelled')`;

/** Agrupa por orden en un solo recorrido (evita `filter` por orden: O(órdenes × filas)). */
export function groupByIo<T extends Record<string, unknown>>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = String(r.io_id);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export interface OrderBundle {
  /** Zona IANA del tenant (define el día de negocio). */
  tz: string;
  orders: Row[];
  lines: Row[];
  oms: Row[];
  creatives: Row[];
  photos: Row[];
  purchases: Row[];
  deliveries: Row[];
  /** Facturas de la tienda (también de órdenes ya no vigentes), con sus cobros. */
  invoices: Row[];
  /** Proveedor de cada pantalla (todas las de la tienda). */
  supplierOf: Map<string, string | null>;
}

/**
 * `live`: solo órdenes vigentes (tablero) o todas (listado). `order`: orden por inicio.
 * Las hijas siguen el mismo alcance que las órdenes.
 */
export async function readOrderBundle(
  storeId: string,
  opts: { live: boolean; order: "ASC" | "DESC" },
): Promise<OrderBundle> {
  const v = { store: storeId };
  const q = <T = Row[]>(sql: string) => surql<T>(sql, v);
  const child = opts.live ? `store = ${S} AND order IN ${LIVE}` : `store = ${S}`;
  const [tz, orders, screens, lines, oms, creatives, photos, purchases, deliveries, invoices, payments] = await Promise.all([
    getStoreTimeZone(storeId),
    // Autorización (kind/doc_*/agreement_revision), vigencia, periodo, plazo de pago y partes.
    // El nombre de empresa viaja en la misma fila (sin consulta aparte).
    q(`SELECT record::id(id) AS id, number AS io_number, status, brand, currency, agreement_revision, authorization_kind,
         doc_orden_medios, doc_orden_compra, doc_contrato, payment_terms_days, ${iso("reservation_expires_at")} AS reservation_expires_at,
         ${key("advertiser")} AS advertiser_company_id, ${key("billing")} AS billing_company_id,
         advertiser.name AS advertiser_name, billing.name AS billing_name,
         ${iso("starts_at")} AS starts_at, ${iso("ends_at")} AS ends_at
       FROM io_order WHERE store = ${S}${opts.live ? " AND status != 'cancelled'" : ""} ORDER BY starts_at ${opts.order}`),
    q(`SELECT record::id(id) AS id, ${key("supplier")} AS supplier_company_id FROM inv_screen WHERE store = ${S}`),
    q(`SELECT record::id(id) AS id, record::id(order) AS io_id, record::id(screen) AS screen_id,
         ${iso("starts_at")} AS starts_at, ${iso("ends_at")} AS ends_at, rate_minor, cant_slots, cant_dias
       FROM io_line WHERE ${child}`),
    q(`SELECT record::id(order) AS io_id, kind, agreement_revision, document_url FROM io_agency_order WHERE ${child}`),
    q(`SELECT record::id(id) AS id, record::id(order) AS io_id, qc_status, legal_status, ${iso("superseded_at")} AS superseded_at,
         ${iso("qc_reviewed_at")} AS qc_reviewed_at, ${iso("legal_reviewed_at")} AS legal_reviewed_at,
         lines.map(|$l| record::id($l)) AS line_ids
       FROM io_creative WHERE ${child}`),
    q(`SELECT record::id(id) AS id, record::id(order) AS io_id, ${key("line")} AS line_id,
         ${iso("coverage_from")} AS coverage_from, ${iso("coverage_to")} AS coverage_to
       FROM io_photo_check WHERE ${child}`),
    q(`SELECT record::id(order) AS io_id, record::id(line) AS line_id, record::id(supplier) AS supplier_id, status, terms, sequence
       FROM io_purchase WHERE ${child}`),
    q(`SELECT record::id(order) AS io_id, record::id(line) AS line_id, ${key("evidence")} AS evidence_id, status,
         delivered_slots_days, resolution, terms, sequence
       FROM io_delivery WHERE ${child}`),
    q(`SELECT record::id(id) AS id, ${key("order")} AS io_id, amount_minor, currency, issue_date, due_date, status
       FROM io_invoice WHERE store = ${S}`),
    q(`SELECT record::id(invoice) AS invoice_id, amount_minor, paid_on, source, ${iso("voided_at")} AS voided_at
       FROM io_invoice_payment WHERE store = ${S}`),
  ]);

  const paymentsOf = new Map<string, Row[]>();
  for (const p of payments) {
    const k = String(p.invoice_id);
    const list = paymentsOf.get(k);
    if (list) list.push(p);
    else paymentsOf.set(k, [p]);
  }
  const supplierOf = new Map(screens.map((s) => [String(s.id), (s.supplier_company_id as string | null) ?? null]));
  return {
    tz,
    orders: orders.map((o) => withOrderDays(o, tz)),
    lines: lines.map((l) => ({ ...l, supplier_company_id: supplierOf.get(String(l.screen_id)) ?? null })),
    oms,
    creatives,
    photos,
    purchases,
    deliveries,
    invoices: invoices.map((i) => ({ ...i, payments: paymentsOf.get(String(i.id)) ?? [] })),
    supplierOf,
  };
}
