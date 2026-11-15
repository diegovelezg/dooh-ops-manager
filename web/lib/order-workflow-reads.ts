import { surql } from "@/lib/surreal";
import type { WorkflowRow as Row } from "@/lib/order-workflow";
const S="type::record('sys_store', $store)";
export interface WorkflowRows { purchases: Row[]; deliveries: Row[]; versions: Row[]; events: Row[] }
export async function workflowRows(store: string, ids: string[]): Promise<WorkflowRows> {
  if (ids.length === 0) return { purchases: [], deliveries: [], versions: [], events: [] };
  const where = `WHERE store = ${S} AND order IN $ids.map(|$i| type::record('io_order', $i))`;
  const common = "record::id(id) AS id, record::id(order) AS io_id, created_by, fn::iso(created_at) AS created_at";
  const [purchases, deliveries, versions, events] = await Promise.all([
    surql<Row[]>(`SELECT ${common}, record::id(line) AS line_id, record::id(supplier) AS supplier_id, status, cost_minor, currency, reference, reason, terms, sequence FROM io_purchase ${where} ORDER BY sequence DESC`, { store, ids }),
    surql<Row[]>(`SELECT ${common}, record::id(line) AS line_id, fn::key(evidence) AS evidence_id, status, delivered_slots_days, resolution, terms, sequence FROM io_delivery ${where} ORDER BY sequence DESC`, { store, ids }),
    surql<Row[]>(`SELECT ${common}, revision, snapshot, reason FROM io_order_version ${where} ORDER BY revision DESC`, { store, ids }),
    surql<Row[]>(`SELECT ${common}, kind, payload FROM io_order_event ${where} ORDER BY created_at DESC`, { store, ids }),
  ]);
  return { purchases, deliveries, versions, events };
}
