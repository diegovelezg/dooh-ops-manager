// Escrituras puntuales de inventario (pantallas y venues) sobre SurrealDB.
// Cada función recibe el `storeId` ya resuelto por el caller (tenant).
import { randomUUID } from "node:crypto";
import { assignments, surql, type LinkMap } from "@/lib/surreal";
import { SCREEN_FULL, VENUE_FULL } from "@/lib/screens-db";

const S = "type::record('sys_store', $store)";
const SCREEN_LINKS: LinkMap = {
  supplier_company_id: { field: "supplier", table: "crm_company" },
};
const VENUE_LINKS: LinkMap = {
  supplier_company_id: { field: "supplier", table: "crm_company" },
  company_id: { field: "company", table: "crm_company" },
};

export type Row = Record<string, unknown>;

/** Punto (lon, lat) o NONE si falta una coordenada. */
const POINT = "IF $lng != NONE AND $lat != NONE { <geometry<point>> [<float> $lng, <float> $lat] } ELSE { NONE }";

export interface NewVenue {
  name: string;
  city: string | null;
  district: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  country: string | null;
  ownership: "own" | "supplier";
  supplier_company_id: string | null;
}

/** Crea ubicación + pantalla en UNA transacción (1 pantalla = 1 ubicación propia). */
export async function createScreenWithVenue(storeId: string, venue: NewVenue, screen: Row): Promise<string> {
  const v = assignments(
    { name: venue.name, city: venue.city, district: venue.district, address: venue.address, country: venue.country,
      ownership: venue.ownership, supplier_company_id: venue.supplier_company_id, source: "manual" },
    VENUE_LINKS,
    "v",
  );
  if ((screen.ownership !== undefined && screen.ownership !== venue.ownership) || (screen.supplier_company_id !== undefined && screen.supplier_company_id !== venue.supplier_company_id)) throw new Error("Propiedad y proveedor deben coincidir con la ubicación.");
  if (venue.ownership === "own" && venue.supplier_company_id) throw new Error("Una pantalla propia no lleva proveedor externo.");
  if (venue.ownership === "supplier" && !venue.supplier_company_id) throw new Error("Proveedor requerido para pantalla externa.");
  const sc = assignments({ ...screen, ownership: venue.ownership, supplier_company_id: venue.supplier_company_id }, SCREEN_LINKS, "s");
  // La clave la genera la app (UUID, como los históricos): una transacción BEGIN…COMMIT
  // no devuelve filas, y así el id se conoce sin leerlo de vuelta.
  const id = randomUUID();
  await surql(
    `BEGIN;
     IF $supplier != NONE {
       LET $p=type::record('crm_company',$supplier);
       IF !record::exists($p) OR $p.store != ${S} OR $p.kind != 'proveedor' OR $p.deleted_at != NONE { THROW 'Proveedor activo del tenant requerido' };
     };
     LET $v = CREATE type::record('inv_venue', $venue_id) SET store = ${S}, ${v.sql}, location = ${POINT};
     CREATE type::record('inv_screen', $id) SET store = ${S}, venue = $v[0].id, ${sc.sql};
     COMMIT;`,
    { id, venue_id: randomUUID(), store: storeId, supplier: venue.supplier_company_id??undefined, lat: venue.latitude ?? undefined, lng: venue.longitude ?? undefined, ...v.vars, ...sc.vars },
  );
  return id;
}

export async function getScreenState(
  storeId: string,
  id: string,
): Promise<{ id: string; enrichment_status: string; venue_id: string } | null> {
  return (
    (await surql<Array<{ id: string; enrichment_status: string; venue_id: string }>>(
      `SELECT record::id(id) AS id, enrichment_status, record::id(venue) AS venue_id FROM inv_screen
       WHERE store = ${S} AND id = type::record('inv_screen', $id)`,
      { store: storeId, id },
    ))[0] ?? null
  );
}

/** Pantalla completa + venue como DTO de la app (para enriquecimiento). */
export async function getScreenWithVenue(storeId: string, id: string): Promise<{ screen: Row; venue: Row } | null> {
  const screen = (await surql<Row[]>(
    `${SCREEN_FULL} FROM inv_screen WHERE store = ${S} AND id = type::record('inv_screen', $id)`,
    { store: storeId, id },
  ))[0];
  if (!screen) return null;
  const venue = (await surql<Row[]>(
    `${VENUE_FULL} FROM inv_venue WHERE store = ${S} AND id = type::record('inv_venue', $id)`,
    { store: storeId, id: screen.venue_id },
  ))[0];
  return { screen, venue };
}

/** Columnas `int` de inv_screen: las métricas derivadas llegan con decimales y se redondean al persistir. */
const SCREEN_INT_FIELDS = new Set([
  "width_px", "height_px", "dpi", "impact_day", "impressions_day", "duration_sec", "views_per_spot",
  "effective_daily_views", "plays_per_day", "traffic_mobility_score", "commercial_intensity_score",
  "vehicular_pct", "pedestrian_pct", "pois_anchors_count", "pois_total_count",
]);

export async function patchScreen(storeId: string, id: string, fields: Row): Promise<void> {
  const rounded = Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, SCREEN_INT_FIELDS.has(k) && typeof v === "number" ? Math.round(v) : v]),
  );
  const { sql, vars } = assignments(rounded, SCREEN_LINKS);
  if (!sql) return;
  await surql(
    `UPDATE inv_screen SET ${sql} WHERE store = ${S} AND id = type::record('inv_screen', $id)`,
    { store: storeId, id, ...vars },
  );
}

/** `latitude`/`longitude` del DTO → punto geoespacial. */
export async function patchVenue(storeId: string, id: string, fields: Row): Promise<void> {
  const { latitude, longitude, ...rest } = fields;
  const { sql, vars } = assignments(rest, VENUE_LINKS);
  const geo = latitude !== undefined || longitude !== undefined ? `${sql ? "," : ""} location = ${POINT}` : "";
  if (!sql && !geo) return;
  await surql(
    `UPDATE inv_venue SET ${sql}${geo} WHERE store = ${S} AND id = type::record('inv_venue', $id)`,
    { store: storeId, id, lat: (latitude as number | null | undefined) ?? undefined, lng: (longitude as number | null | undefined) ?? undefined, ...vars },
  );
}

/** Guarda el embedding semántico (768 dim) en la propia pantalla. */
export async function setScreenEmbedding(storeId: string, id: string, values: number[], model: string): Promise<void> {
  await surql(
    `UPDATE inv_screen SET embedding = $values, embedding_model = $model
     WHERE store = ${S} AND id = type::record('inv_screen', $id)`,
    { store: storeId, id, values, model },
  );
}

/** Borra la pantalla y, si ninguna otra la usa, su ubicación (una transacción). */
export async function deleteScreenAndOrphanVenue(storeId: string, id: string): Promise<void> {
  await surql(
    `BEGIN;
     LET $s = (SELECT venue FROM inv_screen WHERE store = ${S} AND id = type::record('inv_screen', $id))[0];
     DELETE inv_screen WHERE store = ${S} AND id = type::record('inv_screen', $id);
     IF $s AND array::len(SELECT id FROM inv_screen WHERE venue = $s.venue) = 0 {
       DELETE inv_venue WHERE store = ${S} AND id = $s.venue;
     };
     COMMIT;`,
    { store: storeId, id },
  );
}

// ── Lecturas auxiliares para consumidores (pedidos, finanzas, pickers) ────
/** Pantallas como DTO plano para pickers/pedidos: datos propios + venue (+ proveedor). */
export async function listScreensBrief(
  storeId: string,
  opts: { ids?: string[]; activeOnly?: boolean; limit?: number } = {},
): Promise<Row[]> {
  if (opts.ids && opts.ids.length === 0) return [];
  return surql<Row[]>(
    `${opts.ids ? "LET $r = $ids.map(|$i| type::record('inv_screen', $i));" : ""}
     SELECT record::id(id) AS id, name, external_ref, technology, width_px, height_px, price_pen, is_active,
       IF supplier { record::id(supplier) } ELSE { NONE } AS supplier_company_id,
       venue.name AS venue_name, venue.district AS district, venue.city AS city, supplier.name AS supplier_name
     FROM inv_screen
     WHERE store = ${S}
       ${opts.ids ? "AND id IN $r" : ""}
       ${opts.activeOnly ? "AND is_active = true" : ""}
     ORDER BY name ASC ${opts.limit ? "LIMIT $limit" : ""}`,
    { store: storeId, ids: opts.ids, limit: opts.limit },
  );
}

export async function countScreens(storeId: string, opts: { activeOnly?: boolean } = {}): Promise<number> {
  return (
    (await surql<number[]>(
      `SELECT VALUE count() FROM inv_screen WHERE store = ${S} ${opts.activeOnly ? "AND is_active = true" : ""} GROUP ALL`,
      { store: storeId },
    ))[0] ?? 0
  );
}

export async function countVenues(storeId: string): Promise<number> {
  return (await surql<number[]>(`SELECT VALUE count() FROM inv_venue WHERE store = ${S} GROUP ALL`, { store: storeId }))[0] ?? 0;
}

export async function countSlots(storeId: string): Promise<number> {
  return (await surql<number[]>(`SELECT VALUE count() FROM inv_slot WHERE store = ${S} GROUP ALL`, { store: storeId }))[0] ?? 0;
}

/** Historia comercial de una pantalla (impide borrarla): líneas de pedido y reservas. */
export async function screenHistory(storeId: string, id: string): Promise<{ lines: number; bookings: number }> {
  const [lines, bookings] = await Promise.all([
    surql<number[]>(`SELECT VALUE count() FROM io_line WHERE store = ${S} AND screen = type::record('inv_screen', $id) GROUP ALL`, { store: storeId, id }),
    surql<number[]>(`SELECT VALUE count() FROM inv_booking WHERE store = ${S} AND slot.screen = type::record('inv_screen', $id) GROUP ALL`, { store: storeId, id }),
  ]);
  return { lines: lines[0] ?? 0, bookings: bookings[0] ?? 0 };
}
