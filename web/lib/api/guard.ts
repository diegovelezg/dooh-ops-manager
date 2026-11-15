// Guard compartido de las rutas `app/api/*/[id]/*` + settings actions.
// Centraliza: exigir la DB configurada, extraer `:id` (Next 16: promesa),
// exigir sesión (401) y membresía por tenant vía la arista `member_of` (403).
// Multiuser por tenant: cualquier miembro ve todo su tenant; sin membresía
// no hay acceso (sin bypass legacy).
import "server-only";

/** Usuario autenticado o `Response` 401. Sin auth configurada: fail-closed salvo
 *  anon-dev explícito (`ALLOW_ANON_DEV=1` fuera de prod), que retorna null. */
export async function requireApiUser(): Promise<{ id: string; email: string | null } | Response | null> {
  const { isDbConfigured } = await import("@/lib/surreal");
  if (!isDbConfigured()) {
    const { isAnonDevAllowed } = await import("@/lib/tenant");
    if (isAnonDevAllowed()) return null;
    return Response.json({ error: "No autenticado." }, { status: 401 });
  }
  try {
    const { getSessionUser } = await import("@/lib/auth");
    const user = await getSessionUser();
    if (!user) return Response.json({ error: "No autenticado." }, { status: 401 });
    return { id: user.id, email: user.email };
  } catch {
    return Response.json({ error: "No autenticado." }, { status: 401 });
  }
}

/** Roles del usuario por tienda (arista `member_of`, identidad de servidor). */
async function userStoreRoles(userId: string): Promise<Map<string, string>> {
  try {
    const { surql } = await import("@/lib/surreal");
    const rows = await surql<Array<{ store: string; role: string }>>(
      "SELECT record::id(out) AS store, role FROM member_of WHERE in = type::record('user', $user)",
      { user: userId },
    );
    return new Map(rows.map((r) => [r.store, r.role]));
  } catch {
    return new Map();
  }
}

/** Exige membresía a `storeId`. Sin membresías no hay acceso (403).
 * Devuelve null si ok, o `Response` 403 listo para retornar.
 * SSOT issue #4: delega en `tenant.hasStoreMembership` (un solo chequeo).
 */
export async function requireStoreMember(
  storeId: string,
  user: { id: string; email: string | null } | null,
): Promise<Response | null> {
  if (!user) {
    try {
      const { isAnonDevAllowed } = await import("@/lib/tenant");
      if (isAnonDevAllowed()) return null;
    } catch { /* fail-closed */ }
    return Response.json({ error: "No autenticado." }, { status: 401 });
  }
  if (!storeId) return Response.json({ error: "Falta store." }, { status: 400 });
  const { hasStoreMembership } = await import("@/lib/tenant");
  const ok = await hasStoreMembership(user.id, storeId).catch(() => false);
  if (ok) return null;
  return Response.json({ error: "Sin acceso a esta tienda." }, { status: 403 });
}

/**
 * Exige sesión + membresía para una tienda dada (rutas con ?store= / body.storeId).
 * Devuelve el usuario o un `Response` (401/403) listo para retornar.
 */
export async function requireStoreAccess(
  storeId: string,
): Promise<{ id: string; email: string | null } | Response | null> {
  const auth = await requireApiUser();
  if (auth instanceof Response || auth === null) return auth;
  const denied = await requireStoreMember(storeId, auth);
  if (denied) return denied;
  return auth;
}

/** Fila propia por id + acceso anti-oráculo para rutas GET con `:id`.
 *  Devuelve `{storeId, auth, row}` o el `Response` 404 listo para retornar
 *  (ausencia y falta de acceso responden idéntico: nunca oráculo). */
export async function requireRouteEntity(
  table: import("@/lib/entity-lookup").EntityTable,
  id: string,
  notFound: string,
): Promise<
  | { storeId: string; auth: { id: string; email: string | null } | null; row: Record<string, unknown> }
  | Response
> {
  const { findEntity } = await import("@/lib/entity-lookup");
  const row = await findEntity(table, id);
  if (!row) return Response.json({ error: notFound }, { status: 404 });
  const storeId = String(row.store_id ?? "");
  const access = await requireStoreAccess(storeId);
  if (access instanceof Response) return Response.json({ error: notFound }, { status: 404 });
  return { storeId, auth: access, row };
}

/** Rol del caller para gating de UI (null = sin auth/dev o sin membresía). */
export async function resolveMyRole(
  auth: { id: string; email: string | null } | null,
  storeId: string,
): Promise<string | null> {
  if (!auth) return null;
  const { isMemberRole } = await import("@/lib/roles");
  const roles = await userStoreRoles(auth.id).catch(() => new Map<string, string>());
  const raw = roles.get(storeId) ?? null;
  return raw && isMemberRole(raw) ? raw : null;
}

/** Preámbulo de rutas por tienda activa (sin id en URL): sesión + tienda +
 *  membresía. Devuelve `{storeId, auth}` o el `Response` listo para retornar. */
export async function requireActiveStoreAccess(): Promise<
  { storeId: string; auth: { id: string; email: string | null } | null } | Response
> {
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  const { resolveActiveStoreId } = await import("@/lib/tenant");
  const storeId = await resolveActiveStoreId();
  if (!storeId) return Response.json({ error: "Sin tienda." }, { status: 400 });
  const denied = await requireStoreMember(storeId, auth);
  if (denied) return denied;
  return { storeId, auth };
}
