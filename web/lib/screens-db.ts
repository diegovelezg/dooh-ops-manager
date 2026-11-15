// Lecturas de inventario DOOH sobre SurrealDB (identidad de servidor; aislamiento
// por `WHERE store = $store`). Escrituras vía Sheet/CSV en dooh-import y screens-actions.
//
// Búsqueda: `fn::tokens` / `fn::match_all` / `fn::match_score` (migración 0003) sobre
// el campo COMPUTED `search` (pantalla + venue + proveedor): un solo roundtrip con
// ranking, tolerancia a tildes/typos y paginación real con total exacto.
import { surql } from "@/lib/surreal";
import { SCREENS_SORT_ALIASES } from "@/lib/sort";

export interface ScreenListRow {
  id: string;
  name: string;
  is_active: boolean;
  width_px: number | null;
  height_px: number | null;
  width_m: number | null;
  height_m: number | null;
  price_pen: number | null;
  impact_day: number | null;
  impressions_day: number | null;
  district: string | null;
  city: string | null;
  venue_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  external_ref: string | null;
}

export type ScreensSortKey = "name" | "supplier" | "city" | "impact" | "price";
export type ScreensSortDir = "asc" | "desc";

// SSOT: mapa de alias en lib/sort.ts (issue #8 P2). Re-export de compat.

export function parseScreensSort(sp: { sort?: string; dir?: string }): {
  key: ScreensSortKey;
  dir: ScreensSortDir;
} {
  const key: ScreensSortKey = SCREENS_SORT_ALIASES[sp.sort ?? ""] ?? "name";
  if (sp.dir === "asc" || sp.dir === "desc") return { key, dir: sp.dir };
  return { key, dir: key === "name" || key === "supplier" || key === "city" ? "asc" : "desc" };
}

export interface ScreensFilter {
  q?: string;
  supplierId?: string | null;
  /** Red propia: pantallas sin proveedor (supplier_company_id IS NULL).
   *  Se filtra en la query (SQL), nunca en memoria sobre la muestra. */
  ownOnly?: boolean;
  city?: string | null;
  active?: "all" | "active" | "inactive";
  sortKey?: ScreensSortKey;
  sortDir?: ScreensSortDir;
  page?: number;
  pageSize?: number;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapRow(r: Record<string, unknown>): ScreenListRow {
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    is_active: r.is_active === true,
    width_px: num(r.width_px),
    height_px: num(r.height_px),
    width_m: num(r.width_m),
    height_m: num(r.height_m),
    price_pen: num(r.price_pen),
    impact_day: num(r.impact_day),
    impressions_day: num(r.impressions_day),
    district: (r.district as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    venue_name: (r.venue_name as string | null) ?? null,
    supplier_id: (r.supplier_id as string | null) ?? null,
    supplier_name: (r.supplier_name as string | null) ?? null,
    external_ref: (r.external_ref as string | null) ?? null,
  };
}

/** Orden por clave; los nulos van al final (como `nulls last`). */
const SCREEN_ORDER: Record<ScreensSortKey, (d: string) => string> = {
  name: (d) => `name_key ${d}`,
  supplier: (d) => `supplier_missing ASC, supplier_key ${d}, name_key ASC`,
  city: (d) => `city_missing ASC, city_key ${d}, name_key ASC`,
  impact: (d) => `impact_missing ASC, impact_day ${d}, name_key ASC`,
  price: (d) => `price_missing ASC, price_pen ${d}, name_key ASC`,
};

export async function listScreens(
  storeId: string,
  opts: ScreensFilter = {},
): Promise<{ rows: ScreenListRow[]; total: number; truncated?: boolean }> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 20, 1), 100);
  const page = Math.max(1, opts.page ?? 1);
  const sortKey = opts.sortKey ?? "name";
  const dir = (opts.sortDir ?? "asc") === "desc" ? "DESC" : "ASC";
  const q = (opts.q ?? "").trim();
  // Con texto y orden por nombre asc manda la relevancia (relevancia primero).
  const order = q && sortKey === "name" && dir === "ASC" ? "score DESC, name_key ASC" : SCREEN_ORDER[sortKey](dir);
  const result = await surql<{ total: number; rows: Array<Record<string, unknown>> }>(
    `LET $tokens = fn::tokens($q);
     LET $qn = fn::norm($q);
     LET $cityKey = IF $city { fn::norm($city) } ELSE { NONE };
     LET $m = SELECT record::id(id) AS id, name, is_active, width_px, height_px, width_m, height_m, price_pen,
         impact_day, impressions_day, external_ref,
         venue.district AS district, venue.city AS city, venue.name AS venue_name,
         IF supplier { record::id(supplier) } ELSE { NONE } AS supplier_id, supplier.name AS supplier_name,
         fn::norm(name) AS name_key,
         fn::norm(supplier.name) AS supplier_key, supplier = NONE AS supplier_missing,
         fn::norm(venue.city) AS city_key, venue.city = NONE AS city_missing,
         impact_day = NONE AS impact_missing, price_pen = NONE AS price_missing,
         fn::match_score(fn::norm(name), search, $qn) AS score
       FROM inv_screen
       WHERE store = type::record('sys_store', $store)
         AND ($supplier = NONE OR supplier = type::record('crm_company', $supplier))
         AND ($own = false OR supplier = NONE)
         AND ($cityKey = NONE OR fn::norm(venue.city) = $cityKey)
         AND ($active = 'all' OR ($active = 'active' AND is_active = true) OR ($active = 'inactive' AND is_active != true))
         AND fn::match_all(search, $tokens);
     RETURN {
       total: array::len($m),
       rows: (SELECT * FROM $m ORDER BY ${order} LIMIT $limit START $offset)
     };`,
    {
      store: storeId,
      q,
      supplier: opts.supplierId ?? undefined,
      own: Boolean(opts.ownOnly),
      city: (opts.city ?? "").trim() || undefined,
      active: opts.active ?? "all",
      limit: pageSize,
      offset: (page - 1) * pageSize,
    },
  );
  return { rows: result.rows.map(mapRow), total: result.total };
}

/** Opciones para los filtros (proveedores y ciudades con inventario). */
export async function listScreenFilterOptions(
  storeId: string,
): Promise<{ suppliers: Array<{ id: string; name: string }>; cities: string[]; truncated: boolean }> {
  const SUPPLIER_LIMIT = 200;
  const [cities, suppliers, total] = await Promise.all([
    surql<string[]>(
      `SELECT VALUE city FROM inv_venue WHERE store = type::record('sys_store', $store) AND city != NONE GROUP BY city`,
      { store: storeId },
    ),
    surql<Array<{ id: string; name: string }>>(
      `SELECT record::id(id) AS id, name FROM crm_company
       WHERE store = type::record('sys_store', $store) AND kind = 'proveedor' ORDER BY name ASC LIMIT $limit`,
      { store: storeId, limit: SUPPLIER_LIMIT },
    ),
    surql<number[]>(
      `SELECT VALUE count() FROM crm_company WHERE store = type::record('sys_store', $store) AND kind = 'proveedor' GROUP ALL`,
      { store: storeId },
    ),
  ]);
  return {
    suppliers: suppliers.map((c) => ({ id: c.id, name: String(c.name ?? "") })),
    cities: cities.map((c) => c.trim()).filter((c) => c !== "").sort((a, b) => a.localeCompare(b, "es")),
    truncated: (total[0] ?? 0) > SUPPLIER_LIMIT,
  };
}

/** Pantalla completa como DTO de la app (ids planos, fechas ISO). Sin el embedding (pesado). */
export const SCREEN_FULL = `SELECT *, record::id(id) AS id, record::id(store) AS store_id, record::id(venue) AS venue_id,
  IF supplier { record::id(supplier) } ELSE { NONE } AS supplier_company_id,
  fn::iso(created_at) AS created_at, fn::iso(updated_at) AS updated_at,
  embedding != NONE AS has_embedding
  OMIT store, venue, supplier, embedding, search`;

/** Venue completo como DTO de la app: `latitude`/`longitude` salen del punto geoespacial. */
export const VENUE_FULL = `SELECT *, record::id(id) AS id, record::id(store) AS store_id,
  IF company { record::id(company) } ELSE { NONE } AS company_id,
  IF supplier { record::id(supplier) } ELSE { NONE } AS supplier_company_id,
  IF location { location.coordinates[1] } ELSE { NONE } AS latitude,
  IF location { location.coordinates[0] } ELSE { NONE } AS longitude,
  fn::iso(created_at) AS created_at, fn::iso(updated_at) AS updated_at
  OMIT store, company, supplier, location, search`;

export interface ScreenDetail {
  screen: Record<string, unknown>;
  venue: Record<string, unknown> | null;
  supplier_name: string | null;
  has_embedding: boolean;
  embedding_model: string | null;
  bookings_count: number;
  lines_count: number;
}

/** Pantalla + ubicación + proveedor + estado del embedding (todo SurrealDB). */
export async function getScreenRecord(
  storeId: string,
  screenId: string,
): Promise<Pick<ScreenDetail, "screen" | "venue" | "supplier_name" | "has_embedding" | "embedding_model"> | null> {
  const found = await surql<{
    screen: Record<string, unknown>;
    venue: Record<string, unknown> | null;
    supplier_name: string | null;
    embedding_model: string | null;
  } | null>(
    `LET $s = (${SCREEN_FULL} FROM inv_screen WHERE store = type::record('sys_store', $store) AND id = type::record('inv_screen', $id))[0];
     RETURN IF $s {
       {
         screen: $s,
         venue: (${VENUE_FULL} FROM inv_venue WHERE id = type::record('inv_venue', $s.venue_id))[0],
         supplier_name: (SELECT VALUE name FROM crm_company WHERE id = type::record('crm_company', $s.supplier_company_id))[0],
         embedding_model: (SELECT VALUE embedding_model FROM inv_screen WHERE id = type::record('inv_screen', $id))[0]
       }
     } ELSE { NONE };`,
    { store: storeId, id: screenId },
  );
  if (!found) return null;
  const has_embedding = found.screen.has_embedding === true;
  delete found.screen.has_embedding;
  return {
    screen: found.screen,
    venue: found.venue ?? null,
    supplier_name: found.supplier_name ?? null,
    has_embedding,
    embedding_model: has_embedding ? (found.embedding_model ?? null) : null,
  };
}

export async function getScreenDetail(storeId: string, screenId: string): Promise<ScreenDetail | null> {
  const record = await getScreenRecord(storeId, screenId);
  if (!record) return null;
  // Las reservas cuelgan de slots (inv_booking.slot → inv_slot) y las líneas referencian la pantalla.
  const [bookings, lines] = await Promise.all([
    surql<number[]>(
      `SELECT VALUE count() FROM inv_booking WHERE store = type::record('sys_store', $store) AND slot.screen = type::record('inv_screen', $id) GROUP ALL`,
      { store: storeId, id: screenId },
    ),
    surql<number[]>(
      `SELECT VALUE count() FROM io_line WHERE store = type::record('sys_store', $store) AND screen = type::record('inv_screen', $id) GROUP ALL`,
      { store: storeId, id: screenId },
    ),
  ]);
  return { ...record, bookings_count: bookings[0] ?? 0, lines_count: lines[0] ?? 0 };
}
