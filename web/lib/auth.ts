// Sesión de usuario (solo servidor). SurrealDB emite el JWT (`DEFINE ACCESS app`,
// 0001_identity_tenancy.surql): access token de 15 min + refresh token rotativo.
// Ambos viajan en cookies HttpOnly; `proxy.ts` renueva el par cuando el access
// expira (los Server Components no pueden escribir cookies).
import { cookies } from "next/headers";
import { InternalError, NotAllowedError, NotFoundError, Surreal, type Tokens } from "surrealdb";
import { surqlAs, surrealEnv } from "@/lib/surreal";

export const ACCESS_COOKIE = "dooh_at";
export const REFRESH_COOKIE = "dooh_rt";
/** Vida de la cookie = vida del grant (30d): el proxy necesita ver el access
 *  ya vencido para poder canjear el refresh. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export interface SessionUser {
  id: string;
  email: string;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  };
}

/** Usuario dueño del access token, o null si es inválido/expirado/inexistente.
 *  Valida contra la DB (`$auth`): un usuario borrado pierde acceso al instante. */
export async function validateAccessToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const row = await surqlAs<{ id: string; email: string } | undefined>(
      token,
      "SELECT record::id(id) AS id, email FROM ONLY $auth",
    );
    return row?.id ? { id: row.id, email: row.email } : null;
  } catch {
    return null;
  }
}

/** Conexión HTTP efímera sin credenciales (signin/refresh no la comparten). */
async function anonymous(): Promise<Surreal> {
  const { url, namespace, database } = surrealEnv();
  const db = new Surreal();
  await db.connect(url, { namespace, database });
  return db;
}

/** Canjea refresh (+ access vencido) por un par nuevo. null = refresh inválido/revocado. */
export async function refreshTokens(tokens: Tokens): Promise<Tokens | null> {
  const db = await anonymous();
  try {
    return await db.authenticate(tokens);
  } catch (e) {
    // Refresh vencido, revocado, de otra DB o cookie manipulada (token ilegible): sesión inválida;
    // el proxy limpia las cookies. Cualquier otro error (DB caída) se propaga.
    if (e instanceof NotFoundError || e instanceof NotAllowedError) return null;
    if (e instanceof InternalError && e.message === "InvalidToken") return null;
    throw e;
  } finally {
    await db.close();
  }
}

/** Usuario de la sesión actual (cookies), o null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return validateAccessToken(store.get(ACCESS_COOKIE)?.value);
}

/** Access token de la sesión actual (para `surqlAs`), o null. */
export async function getAccessToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACCESS_COOKIE)?.value ?? null;
}

/** Login email+password. null = credenciales inválidas; otros errores (DB caída) se propagan.
 *  Devuelve los tokens para que el caller pueda leer con la sesión recién creada. */
export async function signInWithPassword(email: string, password: string): Promise<Tokens | null> {
  const { namespace, database } = surrealEnv();
  const db = await anonymous();
  try {
    const tokens = await db.signin({ namespace, database, access: "app", variables: { email, password } });
    const store = await cookies();
    const opts = sessionCookieOptions();
    store.set(ACCESS_COOKIE, tokens.access, opts);
    if (tokens.refresh) store.set(REFRESH_COOKIE, tokens.refresh, opts);
    return tokens;
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  } finally {
    await db.close();
  }
}

/** Cierra sesión: revoca el refresh token en la DB y borra las cookies. */
export async function signOut(): Promise<void> {
  const store = await cookies();
  const access = store.get(ACCESS_COOKIE)?.value;
  const refresh = store.get(REFRESH_COOKIE)?.value;
  if (access && refresh) {
    const db = await anonymous();
    try {
      await db.revoke({ access, refresh });
    } finally {
      await db.close();
    }
  }
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
}
