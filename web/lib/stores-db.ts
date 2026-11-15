// Repositorio de tiendas (tenants): SurrealDB `sys_store`. Ids como string plano.
// Sin `import "server-only"`: lo usan scripts y tests en node plano.
import { surql } from "@/lib/surreal";

export interface StoreRow {
  id: string;
  name: string | null;
  shop_currency: string;
  shop_country: string | null;
  io_prefix: string;
  /** Zona IANA del tenant: define el "día" de negocio (la BD guarda UTC). */
  timezone: string;
  default_slots_per_screen: number;
  /** id (clave) de `crm_company`; null si la tienda no tiene empresa propia. */
  home_company_id: string | null;
}

const COLS = `record::id(id) AS id, name, shop_currency, shop_country, io_prefix, timezone,
  default_slots_per_screen,
  IF home_company { record::id(home_company) } ELSE { NONE } AS home_company_id`;

function toRow(r: Record<string, unknown>): StoreRow {
  return {
    id: String(r.id),
    name: (r.name as string | null | undefined) ?? null,
    shop_currency: String(r.shop_currency),
    shop_country: (r.shop_country as string | null | undefined) ?? null,
    io_prefix: String(r.io_prefix),
    timezone: String(r.timezone),
    default_slots_per_screen: Number(r.default_slots_per_screen),
    home_company_id: (r.home_company_id as string | null | undefined) ?? null,
  };
}

export async function getStore(id: string): Promise<StoreRow | null> {
  if (!id) return null;
  const rows = await surql<Array<Record<string, unknown>>>(
    `SELECT ${COLS} FROM sys_store WHERE id = type::record('sys_store', $id)`,
    { id },
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** Tiendas por antigüedad. `ids` filtra (vacío = ninguna). */
export async function listStores(opts: { ids?: string[]; limit?: number } = {}): Promise<StoreRow[]> {
  const { ids, limit = 50 } = opts;
  if (ids && ids.length === 0) return [];
  const rows = await surql<Array<Record<string, unknown>>>(
    `SELECT ${COLS}, created_at FROM sys_store
     ${ids ? "WHERE id IN $ids.map(|$i| type::record('sys_store', $i))" : ""}
     ORDER BY created_at ASC LIMIT $limit`,
    { ids, limit },
  );
  return rows.map(toRow);
}

export async function countStores(): Promise<number> {
  const rows = await surql<Array<{ n: number }>>("SELECT count() AS n FROM sys_store GROUP ALL");
  return rows[0]?.n ?? 0;
}

/** Primera tienda creada (scripts headless), o null. */
export async function firstStoreId(): Promise<string | null> {
  return (await listStores({ limit: 1 }))[0]?.id ?? null;
}

/** Búsqueda por nombre (insensible a mayúsculas; scripts de import). */
export async function findStoreByName(name: string): Promise<{ id: string; name: string | null } | null> {
  const rows = await surql<Array<{ id: string; name: string | null }>>(
    `SELECT record::id(id) AS id, name FROM sys_store
     WHERE string::lowercase(name ?? '') = string::lowercase($name) LIMIT 1`,
    { name },
  );
  return rows[0] ?? null;
}

export async function setDefaultSlots(storeId: string, slots: number): Promise<void> {
  await surql(`UPDATE type::record('sys_store', $id) SET default_slots_per_screen = $slots`, { id: storeId, slots });
}

/** Cambia la zona del tenant. La BD lo rechaza si ya hay órdenes o reservas (EVENT). */
export async function setStoreTimeZone(storeId: string, tz: string): Promise<void> {
  await surql(`UPDATE type::record('sys_store', $id) SET timezone = $tz`, { id: storeId, tz });
}

/** Zona IANA del tenant. Falla si la tienda no existe o no tiene zona: nunca se asume una. */
export async function getStoreTimeZone(storeId: string): Promise<string> {
  const rows = await surql<Array<string | null>>(`SELECT VALUE timezone FROM sys_store WHERE id = type::record('sys_store', $id)`, { id: storeId });
  const tz = rows[0];
  if (!tz) throw new Error(`Tienda sin zona horaria: ${storeId}`);
  return tz;
}
