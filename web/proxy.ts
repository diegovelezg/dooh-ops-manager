import { NextResponse, type NextRequest } from "next/server";
import type { Tokens } from "surrealdb";
import { ACCESS_COOKIE, REFRESH_COOKIE, refreshTokens, sessionCookieOptions, validateAccessToken } from "@/lib/auth";
import { isDbConfigured } from "@/lib/surreal";

// /mcp se autentica por sí mismo con el token del agente (Bearer); /oauth/* y /.well-known/* son el flujo OAuth
// del agente: register/token/metadatos son públicos y /oauth/authorize gestiona su propio login (conserva la query).
const PUBLIC_PREFIXES = ["/login", "/api/auth", "/mcp", "/oauth", "/.well-known"];

/** El refresh de SurrealDB es de un solo uso: si varias requests en paralelo (prefetch, /api/*) llegan con el mismo
 *  access vencido, solo la primera lo canjearía y las demás borrarían la sesión. Se comparte el resultado del
 *  canje entre requests con el mismo refresh durante unos segundos (el navegador aún envía las cookies viejas). */
const RENEW_SHARE_MS = 30_000;
const renewals = new Map<string, Promise<Tokens | null>>();
function renewOnce(tokens: Tokens & { refresh: string }): Promise<Tokens | null> {
  let p = renewals.get(tokens.refresh);
  if (!p) {
    p = refreshTokens(tokens);
    renewals.set(tokens.refresh, p);
    p.catch(() => renewals.delete(tokens.refresh)); // error transitorio (DB caída): que se pueda reintentar
    setTimeout(() => renewals.delete(tokens.refresh), RENEW_SHARE_MS).unref?.();
  }
  return p;
}

/** Valida el access token; si venció, canjea el refresh y devuelve el par nuevo
 *  para que el proxy lo escriba en la request (lo ven los handlers) y la response. */
async function resolveSession(request: NextRequest) {
  if (!isDbConfigured()) return { user: null, renewed: null, cleared: false };
  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  const user = await validateAccessToken(access);
  if (user) return { user, renewed: null, cleared: false };
  if (!access || !refresh) return { user: null, renewed: null, cleared: Boolean(access || refresh) };
  const renewed = await renewOnce({ access, refresh });
  if (!renewed) return { user: null, renewed: null, cleared: true };
  return { user: await validateAccessToken(renewed.access), renewed, cleared: false };
}

/** Renueva sesión; redirige a /login si no hay usuario (salvo login/API auth).
 *  Las rutas /api/* (salvo /api/auth) exigen sesión: sin ella devuelven 401
 *  JSON en vez de redirect (los fetch del dashboard esperan JSON). */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { user, renewed, cleared } = await resolveSession(request);
  if (renewed) {
    request.cookies.set(ACCESS_COOKIE, renewed.access);
    if (renewed.refresh) request.cookies.set(REFRESH_COOKIE, renewed.refresh);
  }
  const finish = (res: NextResponse) => {
    if (renewed) {
      const opts = sessionCookieOptions();
      res.cookies.set(ACCESS_COOKIE, renewed.access, opts);
      if (renewed.refresh) res.cookies.set(REFRESH_COOKIE, renewed.refresh, opts);
    } else if (cleared) {
      res.cookies.delete(ACCESS_COOKIE);
      res.cookies.delete(REFRESH_COOKIE);
    }
    return res;
  };
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return finish(NextResponse.next({ request }));
  }
  if (pathname.startsWith("/api/")) {
    if (!user) return finish(NextResponse.json({ error: "No autenticado." }, { status: 401 }));
    return finish(NextResponse.next({ request }));
  }
  if (!user) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.searchParams.set("next", pathname);
    return finish(NextResponse.redirect(login));
  }
  return finish(NextResponse.next({ request }));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
