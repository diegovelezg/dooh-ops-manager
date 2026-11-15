// Tenant activo (SSOT). Orden: ?store=uuid validado en stores > conexión
// legacy (.data/connections.json) > primera tienda. Sin cookie todavía:
// la persistencia entre páginas llega en Fase 1 con el selector global.
//
// Multiuser por tenant: las lecturas de datos de dominio usan la identidad de
// servidor (`app_server`), así que el aislamiento se enforcea en esta capa por
// membresía (arista `member_of`). La membresía del usuario actual se lee con SU
// token (`surqlAs`): las PERMISSIONS de SurrealDB solo le devuelven sus filas.
// `listStores` = sin filtro (workers y contextos sin sesión).
// `listMyStores`/`getMyActiveStore` = solo las tiendas del usuario actual.
//
// Solo server: nunca importar en cliente.
import "server-only";
import { cache } from "react";

// SSOT (issue #8 P2): shop_currency siempre vía normalizeCurrency
// (nunca `String(x ?? 'PEN')` a mano); resolveTenantStoreAction unifica el
// resolve de server actions (antes copiado en crm/order/screens-actions).
import { getAccessToken } from "@/lib/auth";
import { isDbConfigured, surql, surqlAs } from "@/lib/surreal";
import { countStores, getStore, listStores as dbListStores, type StoreRow } from "@/lib/stores-db";
import { isMemberRole } from "@/lib/roles";
import { normalizeCurrency } from "@/lib/currency";
import { DEFAULT_SLOTS_PER_SCREEN, normalizeSlotsPerScreen } from "@/lib/store-slots";
import type { MemberRole } from "@/lib/roles";

export { DEFAULT_SLOTS_PER_SCREEN, normalizeSlotsPerScreen };

export interface TenantStore {
  id: string;
  name: string | null;
  shop_currency: string;
  shop_country: string | null;
  /** Zona IANA del tenant (define el día de negocio; la BD guarda UTC). */
  timezone: string;
  /** Espacios vendibles por pantalla y día (1 slot = 1 espacio).
   *  Fallback cuando la pantalla no tiene slots explícitos. Default 10. */
  default_slots_per_screen: number;
}

function toTenantStore(r: StoreRow): TenantStore {
  return {
    id: r.id,
    name: r.name,
    shop_currency: normalizeCurrency(r.shop_currency),
    shop_country: r.shop_country,
    timezone: r.timezone,
    default_slots_per_screen: normalizeSlotsPerScreen(r.default_slots_per_screen),
  };
}

/** Lista tiendas ordenadas por creación. Si hay más de 50, valida el ?store=
 *  pedido por ID directo para no caer al tenant equivocado por ventana.
 *  `truncated` declara el corte (nunca total exacto silencioso). */
async function listStores(
  requestedId?: string | null,
): Promise<{ stores: TenantStore[]; truncated: boolean; total: number }> {
  if (requestedId) {
    const one = await getStore(requestedId);
    if (one) return { stores: [toTenantStore(one)], truncated: false, total: 1 };
  }
  const [rows, total] = await Promise.all([dbListStores({ limit: 50 }), countStores()]);
  const truncated = total > 50;
  if (truncated) {
    const { createLogger } = await import("@/lib/log");
    createLogger("tenant")(`stores truncados a 50/${total}: validar ?store= por ID directo`);
  }
  return { stores: rows.map(toTenantStore), truncated, total };
}

/** Nombre propio: sys_stores.name. Sin fallback: si está vacío es un
 *  dato por fijar en DB, no algo que la UI deba inventar. */
export function displayStoreName(s: { name: string | null }): string {
  return s.name?.trim() ?? "";
}

/** Anon-dev explícito: solo `ALLOW_ANON_DEV=1` fuera de producción permite el
 *  modo sin auth. Por defecto: fail-closed (sin sesión = sin acceso). */
export function isAnonDevAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.ALLOW_ANON_DEV === "1";
}

/** Roles del usuario actual por tienda (arista `member_of`, leída con SU token:
 *  las PERMISSIONS de la tabla ya limitan las filas al propio usuario).
 *  null = anon-dev explícito (`ALLOW_ANON_DEV=1`, no-prod): sin scoping.
 *  Map vacío = sin sesión / sin membresías (fail-closed: sin acceso).
 *  Errores de DB se propagan: un fallo no puede degradar a "sin acceso" mudo
 *  ni, peor, a "acceso". Los callers que ya manejan error deniegan. */
export const getMyStoreRoles = cache(async (): Promise<Map<string, MemberRole> | null> => {
  if (!isDbConfigured()) return isAnonDevAllowed() ? null : new Map();
  const token = await getAccessToken();
  if (!token) return new Map();
  const rows = await surqlAs<Array<{ store: string; role: unknown }>>(
    token,
    "SELECT record::id(out) AS store, role FROM member_of",
  );
  const out = new Map<string, MemberRole>();
  for (const r of rows) {
    if (isMemberRole(r.role)) out.set(r.store, r.role);
  }
  return out;
});

/** IDs de tiendas del usuario actual. null = anon-dev explícito; [] = sin acceso. */
export async function getMyStoreIds(): Promise<string[] | null> {
  const roles = await getMyStoreRoles();
  return roles === null ? null : [...roles.keys()];
}

/** ¿El usuario actual pertenece a `storeId`? null = anon-dev explícito (permite).
 *  Sin auth configurada y sin bypass: false (fail-closed). */
export async function requireMyStoreAccess(storeId: string): Promise<boolean | null> {
  const ids = await getMyStoreIds().catch(() => [] as string[] | null);
  if (ids === null) return null;
  return ids.includes(storeId);
}

/** Rol del usuario actual en `storeId`. null = anon-dev o sin membresía (el caller deniega). */
export async function getMyStoreRole(storeId: string): Promise<MemberRole | null> {
  const roles = await getMyStoreRoles().catch(() => new Map());
  if (roles === null) return null;
  return roles.get(storeId) ?? null;
}

/** ¿El usuario actual alcanza el rol mínimo en `storeId`? null = anon-dev explícito.
 *  Sin auth y sin bypass: false (fail-closed). */
async function requireMinRole(
  storeId: string,
  need: MemberRole,
): Promise<boolean | null> {
  const { hasMinRole } = await import("@/lib/roles");
  const roles = await getMyStoreRoles().catch(() => new Map());
  if (roles === null) return null; // anon-dev: permite
  const role = roles.get(storeId) ?? null;
  if (role === null) return false; // sin membresía: deniega
  return hasMinRole(role, need);
}

/** Mensajes de denegación por rol (SSOT: una sola redacción por nivel). */
const ROLE_DENY_MSG: Record<MemberRole, string> = {
  viewer: "Requiere acceso a la tienda.",
  seller: "Requiere rol vendedor o superior.",
  admin: "Requiere rol admin o propietario.",
  owner: "Solo el propietario puede realizar esta acción.",
};

/** Niega el acceso si el rol en `storeId` no alcanza `need`. Devuelve el
 *  mensaje de denegación o null si ok. Fail-closed: si el chequeo lanza,
 *  deniega. `message` permite el texto específico del flujo. */
export async function denyRole(
  storeId: string,
  need: MemberRole,
  message?: string,
): Promise<string | null> {
  const allowed = await requireMinRole(storeId, need).catch(() => false);
  if (allowed === false) return message ?? ROLE_DENY_MSG[need];
  return null;
}

/** Membresía por userId explícito (identidad de servidor, sin token del usuario).
 *  SSOT issue #4: `api/guard.ts` delega aquí — un solo chequeo de membresía,
 *  no dos stacks. */
export async function hasStoreMembership(userId: string, storeId: string): Promise<boolean> {
  if (!userId || !storeId) return false;
  try {
    const rows = await surql<unknown[]>(
      `SELECT VALUE id FROM member_of
       WHERE in = type::record('user', $user) AND out = type::record('sys_store', $store) LIMIT 1`,
      { user: userId, store: storeId },
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Tiendas visibles para el usuario actual. Fuera de membresía no se lista
 *  nada (el ?store= hostil se ignora aguas abajo en `getMyActiveStore`). */
export async function listMyStores(requestedId?: string | null): Promise<TenantStore[]> {
  const ids = await getMyStoreIds();
  if (ids === null) return (await listStores(requestedId)).stores;
  if (ids.length === 0) return [];
  if (requestedId) {
    if (!ids.includes(requestedId)) return listMyStores();
    const one = await getStore(requestedId);
    return one ? [toTenantStore(one)] : [];
  }
  return (await dbListStores({ ids, limit: ids.length })).map(toTenantStore);
}

/** `getActiveStore` filtrado por membresía: ?store= fuera del tenant se
 *  ignora (fallback a la primera tienda del usuario, nunca a la ajena). */
export async function getMyActiveStore(
  requestedId: string | null | undefined,
): Promise<{ stores: TenantStore[]; active: TenantStore | null }> {
  const stores = await listMyStores();
  if (stores.length === 0) return { stores, active: null };
  const picked = requestedId ? (stores.find((s) => s.id === requestedId) ?? null) : null;
  if (picked) return { stores, active: picked };
  return { stores, active: stores[0] };
}

/** Atajo server-action: id del tenant activo (primera tienda del usuario). */
export async function resolveActiveStoreId(requestedId?: string | null): Promise<string | null> {
  try {
    const { active } = await getMyActiveStore(requestedId ?? null);
    return active?.id ?? null;
  } catch {
    return null;
  }
}

/** SSOT server-action para resolver el tenant (issue #8 P2).
 *  Antes copiado en crm/order/screens-actions: misma secuencia
 *  resolveActiveStoreId → requireMyStoreAccess. Semántica tri-estado única: `requireMyStoreAccess`/`getMyStoreIds`/`getMyStoreRoles` retornan `null` SOLO en anon-dev explícito (`ALLOW_ANON_DEV=1`, no-prod); en todo lo demás, `false`/[] (fail-closed). Por eso los callers comparan `=== false` para denegar: `false` deniega, `null` permite (anon-dev). Nunca `!== true`, que denegaría el anon-dev. */
export async function resolveTenantStoreAction(need?: "seller" | "admin"): Promise<{ storeId: string } | { error: string }> {
  const storeId = await resolveActiveStoreId();
  if (!storeId) return { error: "Sin tienda." };
  if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
    return { error: "Sin acceso a esta tienda." };
  }
  if (need) {
    const allowed = await requireMinRole(storeId, need).catch(() => false);
    if (allowed === false) return { error: "Requiere rol vendedor o superior." };
  }
  return { storeId };
}
