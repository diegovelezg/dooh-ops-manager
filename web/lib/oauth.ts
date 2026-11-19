// OAuth 2.1 mínimo para el MCP de agentes (ChatGPT, Claude, Antigravity…): registro dinámico de
// clientes públicos (RFC 7591), código de autorización de un solo uso con PKCE S256 y emisión de un
// `agent_token` como token de acceso (no caduca; se revoca en Ajustes). Sin refresh tokens.
// Solo servidor, sin `next/*` (testeable con `tsx --test`). Las rutas /oauth/* son capas finas encima.
import { createHash, randomBytes } from "node:crypto";
import { CodeUnavailableError, createAgentToken, revokeCodeToken } from "@/lib/agent-tokens";
import { surql } from "@/lib/surreal";

export const OAUTH_SCOPE = "mcp:read";
const CODE_TTL_MIN = 5;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class OAuthError extends Error {
  constructor(
    public code: string,
    public description: string,
    public status = 400,
  ) {
    super(`${code}: ${description}`);
  }
}

/** `PUBLIC_APP_URL` como origen canónico: https (http solo en loopback y fuera de producción), sin ruta, query ni
 *  credenciales. Lanza si no lo es: ese valor sale tal cual en `issuer`, `resource` y los endpoints de los metadatos. */
export function canonicalOrigin(v: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`PUBLIC_APP_URL inválida: "${v}" no es una URL.`);
  }
  const loopbackHttp = u.protocol === "http:" && LOOPBACK.has(u.hostname) && process.env.NODE_ENV !== "production";
  if (u.protocol !== "https:" && !loopbackHttp) throw new Error("PUBLIC_APP_URL debe ser https (http solo en localhost y fuera de producción).");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) {
    throw new Error("PUBLIC_APP_URL debe ser solo el origen (https://dominio), sin ruta, query ni credenciales.");
  }
  return u.origin;
}

/** Origen público de la app (metadatos, `resource`, `issuer`). En producción EXIGE `PUBLIC_APP_URL` (https): las
 *  cabeceras reenviadas las controla quien llega al proxy, no la app. Fuera de producción se infiere de las cabeceras. */
export function publicOrigin(headers: Headers, fallbackUrl?: string): string {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (configured) return canonicalOrigin(configured);
  if (process.env.NODE_ENV === "production") {
    throw new Error("PUBLIC_APP_URL es obligatorio en producción (origen https canónico de la app).");
  }
  const proto = headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const host = headers.get("x-forwarded-host")?.split(",")[0].trim() ?? headers.get("host");
  if (host) return `${proto || (fallbackUrl ? new URL(fallbackUrl).protocol.replace(":", "") : "http")}://${host}`;
  return fallbackUrl ? new URL(fallbackUrl).origin : "http://localhost:3000";
}

/** Metadatos RFC 9728 (recurso protegido) y RFC 8414 (servidor de autorización). */
export function protectedResourceMetadata(origin: string) {
  return { resource: resourceUrl(origin), authorization_servers: [origin], bearer_methods_supported: ["header"], scopes_supported: [OAUTH_SCOPE] };
}
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

/** Cuerpo del WWW-Authenticate de /mcp: apunta al documento de recurso protegido (RFC 9728). */
export const resourceMetadataUrl = (origin: string): string => `${origin}/.well-known/oauth-protected-resource/mcp`;

/** URL de retorno al cliente con código o error (+ `iss`, RFC 9207). */
export function clientRedirect(redirectUri: string, state: string | null, origin: string, result: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(result)) u.searchParams.set(k, v);
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", origin);
  return u.toString();
}

/** URL del recurso protegido (el MCP). */
export const resourceUrl = (origin: string): string => `${origin}/mcp`;

/** redirect_uri permitido: https, o http solo en loopback (clientes locales). Sin fragmento ni credenciales. */
export function isValidRedirectUri(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

export interface OAuthClient {
  id: string;
  name: string;
  redirect_uris: string[];
}

/** Registro dinámico de un cliente público. */
export async function registerClient(body: unknown): Promise<OAuthClient> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(isValidRedirectUri)) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris: 1 a 5 URIs https (o http en localhost), sin fragmento.");
  }
  const method = b.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    throw new OAuthError("invalid_client_metadata", "Solo se admiten clientes públicos (token_endpoint_auth_method: none).");
  }
  const rawName = typeof b.client_name === "string" ? b.client_name.trim() : "";
  const name = (rawName || "Agente de IA").slice(0, 100);
  const id = randomBytes(16).toString("hex");
  await surql(`CREATE type::record('oauth_client', $id) SET name = $name, redirect_uris = $uris`, { id, name, uris });
  // Limpieza ocasional (1 de cada 50 altas, no en cada una): clientes de más de 1 día que nunca emitieron un token.
  // Los que tienen algún token (aunque esté revocado) se conservan: el agente puede reconectar con su client_id.
  if (Math.floor(Math.random() * 50) === 0) {
    await surql(
      `DELETE oauth_client WHERE created_at < time::now() - 1d AND id NOT IN (SELECT VALUE client FROM agent_token WHERE client != NONE)`,
    );
  }
  return { id, name, redirect_uris: uris as string[] };
}

export async function getClient(id: unknown): Promise<OAuthClient | null> {
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) return null;
  const rows = await surql<Array<{ id: string; name: string; redirect_uris: string[] }>>(
    `SELECT record::id(id) AS id, name, redirect_uris FROM type::record('oauth_client', $id)`,
    { id },
  );
  return rows[0] ?? null;
}

export interface AuthorizeParams {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
}

export type AuthorizeCheck =
  | { ok: true; params: AuthorizeParams }
  /** No se puede confiar en el redirect_uri: mostrar error en pantalla, NUNCA redirigir. */
  | { ok: false; kind: "page"; message: string }
  /** Cliente y redirect_uri válidos: se informa al cliente por redirect_uri. */
  | { ok: false; kind: "redirect"; redirectUri: string; state: string | null; error: string; description: string };

/** Valida una petición /oauth/authorize (query o campos del formulario de consentimiento). */
export async function checkAuthorizeRequest(get: (k: string) => string | null, origin: string): Promise<AuthorizeCheck> {
  const client = await getClient(get("client_id"));
  const redirectUri = get("redirect_uri");
  if (!client) return { ok: false, kind: "page", message: "Aplicación desconocida." };
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return { ok: false, kind: "page", message: "La dirección de retorno no coincide con la registrada." };
  }
  const state = get("state");
  const fail = (error: string, description: string): AuthorizeCheck => ({ ok: false, kind: "redirect", redirectUri, state, error, description });
  if (get("response_type") !== "code") return fail("unsupported_response_type", "Solo response_type=code.");
  const challenge = get("code_challenge");
  if (!challenge || get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return fail("invalid_request", "PKCE S256 obligatorio (code_challenge y code_challenge_method=S256).");
  }
  const resource = get("resource");
  if (resource && resource !== resourceUrl(origin)) return fail("invalid_target", `resource debe ser ${resourceUrl(origin)}.`);
  return { ok: true, params: { client, redirectUri, state, codeChallenge: challenge } };
}

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Código de autorización de un solo uso (5 min), ligado a cliente, usuario, redirect_uri y desafío PKCE. */
export async function createAuthCode(userId: string, p: AuthorizeParams, origin: string): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await surql(
    `DELETE oauth_code WHERE expires_at < time::now() - 1h;
     CREATE oauth_code SET code_hash = $hash, client = type::record('oauth_client', $client),
       user = type::record('user', $user), redirect_uri = $redirect, code_challenge = $challenge, resource = $resource,
       expires_at = time::now() + ${CODE_TTL_MIN}m`,
    { hash: sha256hex(code), client: p.client.id, user: userId, redirect: p.redirectUri, challenge: p.codeChallenge, resource: resourceUrl(origin) },
  );
  return code;
}

/** PKCE S256: base64url(sha256(verifier)) === challenge. */
export function pkceMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

/** Canje del código por el token de acceso. Orden: primero se comprueban TODAS las vinculaciones (cliente, redirect_uri,
 *  PKCE, resource); solo con un canje legítimo se actúa sobre un código ya usado (se revoca únicamente el token que
 *  emitió). El reclamo del código y la emisión del token son una sola transacción: no se quema un código sin emitir. */
export async function exchangeCode(input: {
  code: unknown;
  client_id: unknown;
  redirect_uri: unknown;
  code_verifier: unknown;
  resource?: unknown;
}): Promise<{ access_token: string; token_type: "Bearer"; scope: string }> {
  const bad = (d: string) => new OAuthError("invalid_grant", d);
  if (typeof input.code !== "string" || typeof input.client_id !== "string") throw new OAuthError("invalid_request", "Faltan code o client_id.");
  const rows = await surql<
    Array<{ id: string; client: string; user: string; redirect_uri: string; code_challenge: string; resource: string | null; used: boolean; expired: boolean }>
  >(
    `SELECT record::id(id) AS id, record::id(client) AS client, record::id(user) AS user, redirect_uri, code_challenge, resource,
            used_at != NONE AS used, expires_at <= time::now() AS expired
     FROM oauth_code WHERE code_hash = $hash`,
    { hash: sha256hex(input.code) },
  );
  const row = rows[0];
  if (!row || row.client !== input.client_id) throw bad("Código inválido.");
  if (input.redirect_uri !== row.redirect_uri) throw bad("redirect_uri no coincide.");
  if (!pkceMatches(input.code_verifier, row.code_challenge)) throw bad("code_verifier inválido.");
  if (input.resource !== undefined && input.resource !== "" && input.resource !== row.resource) {
    throw new OAuthError("invalid_target", "resource no coincide con el concedido en la autorización.");
  }
  if (row.used) {
    await revokeCodeToken(row.id); // canje legítimo repetido: se revoca solo lo que ese código emitió (RFC 9700 §4.5)
    throw bad("Código ya utilizado.");
  }
  if (row.expired) throw bad("Código vencido.");
  const client = await getClient(row.client);
  try {
    const { key } = await createAgentToken(row.user, client?.name ?? "Agente de IA", { clientId: row.client, codeId: row.id });
    return { access_token: key, token_type: "Bearer", scope: OAUTH_SCOPE };
  } catch (e) {
    if (e instanceof CodeUnavailableError) {
      // Perdimos el reclamo: si el código está CONSUMIDO (otro canje ganó), es una repetición como la secuencial y se
      // revoca lo que ese código emitió; si solo venció, no hay nada que revocar.
      const [again] = await surql<Array<{ used: boolean }>>(`SELECT used_at != NONE AS used FROM type::record('oauth_code', $id)`, { id: row.id });
      if (again?.used) await revokeCodeToken(row.id);
      throw bad(e.message);
    }
    if (e instanceof Error && e.message.startsWith("Máximo")) throw new OAuthError("invalid_request", e.message);
    throw e;
  }
}

/** La query original de /oauth/authorize viaja en UN parámetro base64url (`q`): el `next` del login rechaza `%2F`,
 *  que aparece al codificar el redirect_uri. */
export const encodeAuthorizeQuery = (search: string): string => Buffer.from(search, "utf8").toString("base64url");
export function decodeAuthorizeQuery(q: string): URLSearchParams {
  return new URLSearchParams(Buffer.from(q, "base64url").toString("utf8"));
}
