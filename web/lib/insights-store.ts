// Muro de avisos (`sys_insight`) y descartes por usuario (`insight_read`, arista user → aviso)
// sobre SurrealDB. DTO con los nombres de la app (`links_json`, `audience_json`, `context_json`).
import { randomUUID } from "node:crypto";
import { surql } from "@/lib/surreal";

const S = "type::record('sys_store', $store)";
type Row = Record<string, unknown>;

const COLS = `record::id(id) AS id, kind, title, body, links AS links_json, audience AS audience_json, severity,
  scope_kind, scope_id, context AS context_json, fn::iso(created_at) AS created_at`;

/** Últimos avisos de la tienda. */
export async function listInsights(storeId: string, limit: number): Promise<Row[]> {
  return surql<Row[]>(`SELECT ${COLS} FROM sys_insight WHERE store = ${S} ORDER BY created_at DESC LIMIT $limit`, { store: storeId, limit });
}

/** Ids (de `ids`) que el usuario ya descartó. */
export async function readInsightIds(userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await surql<string[]>(
    `LET $r = $ids.map(|$i| type::record('sys_insight', $i));
     SELECT VALUE record::id(out) FROM insight_read
     WHERE in = type::record('user', $user) AND out IN $r`,
    { user: userId, ids },
  );
  return new Set(rows);
}

/** `kind` + `scope_id` de lo publicado desde `sinceIso` (dedupe del día). */
export async function listInsightKeysSince(storeId: string, sinceIso: string): Promise<Row[]> {
  return surql<Row[]>(
    `SELECT kind, scope_id FROM sys_insight WHERE store = ${S} AND created_at >= <datetime> $since`,
    { store: storeId, since: sinceIso },
  );
}

/** Tienda dueña del aviso (anti-IDOR: el store sale del aviso, no del cliente). */
export async function insightStore(insightId: string): Promise<string | null> {
  return (
    (await surql<string[]>(`SELECT VALUE record::id(store) FROM sys_insight WHERE id = type::record('sys_insight', $id)`, { id: insightId }))[0] ?? null
  );
}

export interface NewInsight {
  kind: string;
  title: string;
  body: string;
  links_json: string[];
  audience_json: Record<string, unknown>;
  severity: string;
  scope_kind: string | null;
  scope_id: string | null;
  context_json: object | null;
}

/** Publica varios avisos en una transacción (todo o nada). */
export async function insertInsights(storeId: string, rows: NewInsight[]): Promise<void> {
  if (rows.length === 0) return;
  const items = rows.map((r) => ({
    id: randomUUID(), kind: r.kind, title: r.title, body: r.body, links: r.links_json, audience: r.audience_json,
    severity: r.severity, scope_kind: r.scope_kind ?? undefined, scope_id: r.scope_id ?? undefined, context: r.context_json ?? undefined,
  }));
  await surql(
    `BEGIN;
     FOR $r IN $items {
       CREATE type::record('sys_insight', $r.id) SET store = ${S}, kind = $r.kind, title = $r.title, body = $r.body,
         links = $r.links, audience = $r.audience, severity = $r.severity,
         scope_kind = $r.scope_kind, scope_id = $r.scope_id, context = $r.context;
     };
     COMMIT;`,
    { store: storeId, items },
  );
}

/** Descarta el aviso para el usuario (idempotente): nunca borra el aviso global. */
export async function dismissInsight(insightId: string, userId: string): Promise<void> {
  await surql(
    `BEGIN;
     LET $u = type::record('user', $user);
     LET $i = type::record('sys_insight', $id);
     IF array::len(SELECT id FROM insight_read WHERE in = $u AND out = $i) = 0 { RELATE $u->insight_read->$i; };
     COMMIT;`,
    { user: userId, id: insightId },
  );
}

export async function restoreInsight(insightId: string, userId: string): Promise<void> {
  await surql(`DELETE insight_read WHERE in = type::record('user', $user) AND out = type::record('sys_insight', $id)`, { user: userId, id: insightId });
}

/** Ids de los últimos `limit` avisos de la tienda (badge del Inbox). */
export async function latestInsightIds(storeId: string, limit: number): Promise<string[]> {
  return surql<string[]>(`SELECT VALUE record::id(id) FROM sys_insight WHERE store = ${S} ORDER BY created_at DESC LIMIT $limit`, { store: storeId, limit });
}

/** Responsable (email) por id de orden, de una sola consulta. */
export async function orderAssignees(storeId: string, orderIds: string[]): Promise<Map<string, string>> {
  if (orderIds.length === 0) return new Map();
  const rows = await surql<Array<{ id: string; email: string | null }>>(
    `LET $r = $ids.map(|$i| type::record('io_order', $i));
     SELECT record::id(id) AS id, responsible_email AS email FROM io_order WHERE store = ${S} AND id IN $r`,
    { store: storeId, ids: orderIds },
  );
  return new Map(rows.flatMap((r) => (r.email ? [[r.id, r.email] as [string, string]] : [])));
}
