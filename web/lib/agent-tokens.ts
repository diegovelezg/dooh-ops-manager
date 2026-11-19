// Claves personales para agentes de IA (Claude, ChatGPT, Cursor…): no caducan, duran hasta que el
// usuario las revoca; guardada solo como hash SHA-256 (migración 0018). La clave
// se canjea por un JWT de 10 min del PROPIO usuario (`signin` del acceso `agent`),
// así el agente ve exactamente lo que él ve en la web. Solo servidor, sin `next/*`
// (testeable con `tsx --test`).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { surql, surrealEnv, thrownMessage } from "@/lib/surreal";

export const AGENT_KEY_PREFIX = "dooh_agent_";
/** 32 bytes en base64url = 43 caracteres. */
const KEY_RE = /^dooh_agent_[A-Za-z0-9_-]{43}$/;
export const MAX_AGENT_TOKENS_PER_USER = 10;
const TOKEN_LIMIT = "agent_token_limit";
const CODE_UNAVAILABLE = "oauth_code_unavailable";
/** Renovar el JWT cuando le quede menos de esto (evita usarlo al borde de expirar). */
const JWT_MIN_LEFT_MS = 60_000;

export interface AgentTokenRow {
  id: string;
  label: string;
  hint: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

export function isAgentKey(v: unknown): v is string {
  return typeof v === "string" && KEY_RE.test(v);
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Huella estable de una clave (su hash): identifica la credencial sin exponerla. */
export const keyFingerprint = hashKey;

/**
 * Crea un token de agente. Todo en UNA transacción serializada por usuario (escribe `agent_lock`, así dos emisiones
 * simultáneas chocan y se reintentan): reclamo del código OAuth (si lo hay), reemplazo del token anterior del mismo
 * cliente, límite de tokens activos y alta. Si algo falla, no queda nada a medias (el código no se quema).
 * La clave completa solo existe en este retorno: no se puede recuperar después.
 */
export async function createAgentToken(
  userId: string,
  label: string,
  opts: { clientId?: string; codeId?: string } = {},
): Promise<{ id: string; key: string }> {
  const clean = label.trim().slice(0, 60);
  if (clean.length < 1) throw new Error("Nombre inválido (1 a 60 caracteres).");
  const key = AGENT_KEY_PREFIX + randomBytes(32).toString("base64url");
  const hash = hashKey(key);
  const id = randomUUID(); // se fija antes de la transacción: no hace falta releer después del COMMIT
  const claim = opts.codeId
    ? `LET $claimed = (UPDATE type::record('oauth_code', $code) SET used_at = time::now()
         WHERE used_at = NONE AND expires_at > time::now() RETURN AFTER);
       IF array::len($claimed) = 0 { THROW '${CODE_UNAVAILABLE}' };`
    : "";
  const link = opts.codeId ? `UPDATE type::record('oauth_code', $code) SET token = $created[0].id;` : "";
  try {
    await surql(
      `BEGIN;
       ${claim}
       UPSERT type::record('agent_lock', $user) SET n += 1;
       IF $client {
         UPDATE agent_token SET revoked_at = time::now()
           WHERE user = type::record('user', $user) AND client = type::record('oauth_client', $client) AND revoked_at = NONE;
       };
       LET $active = (SELECT count() FROM agent_token
         WHERE user = type::record('user', $user) AND revoked_at = NONE AND (expires_at = NONE OR expires_at > time::now()) GROUP ALL)[0].count ?? 0;
       IF $active >= ${MAX_AGENT_TOKENS_PER_USER} { THROW '${TOKEN_LIMIT}' };
       LET $created = (CREATE type::record('agent_token', $id) SET user = type::record('user', $user), label = $label, key_hash = $hash, hint = $hint,
         client = IF $client { type::record('oauth_client', $client) } ELSE { NONE });
       ${link}
       COMMIT;`,
      { id, user: userId, label: clean, hash, hint: key.slice(-4), client: opts.clientId ?? null, code: opts.codeId ?? null },
    );
  } catch (e) {
    const m = thrownMessage(e);
    if (m === TOKEN_LIMIT) throw new Error(`Máximo ${MAX_AGENT_TOKENS_PER_USER} accesos de agentes activos: revoca alguno en Ajustes.`);
    if (m === CODE_UNAVAILABLE) throw new CodeUnavailableError();
    throw e;
  }
  return { id, key };
}

export class CodeUnavailableError extends Error {
  constructor() {
    super("Código ya utilizado o vencido.");
  }
}

/** Claves vigentes (no revocadas; `expires_at` solo existe en claves anteriores a la 0019) del usuario, de la más nueva a la más vieja. */
export async function listAgentTokens(userId: string): Promise<AgentTokenRow[]> {
  const rows = await surql<
    Array<{ id: string; label: string; hint: string; created_at: string; expires_at: string | null; last_used_at: string | null }>
  >(
    `SELECT record::id(id) AS id, label, hint, <string> created_at AS created_at, IF expires_at != NONE { <string> expires_at } ELSE { NONE } AS expires_at,
            IF last_used_at != NONE { <string> last_used_at } ELSE { NONE } AS last_used_at
     FROM agent_token
     WHERE user = type::record('user', $user) AND revoked_at = NONE AND (expires_at = NONE OR expires_at > time::now())
     ORDER BY created_at DESC`,
    { user: userId },
  );
  return rows.map((r) => ({ ...r, expires_at: r.expires_at ?? null, last_used_at: r.last_used_at ?? null }));
}

/** Revoca una clave del usuario. false = no existía, ya estaba revocada o no es suya. */
export async function revokeAgentToken(userId: string, id: string): Promise<boolean> {
  const rows = await surql<unknown[]>(
    `UPDATE agent_token SET revoked_at = time::now()
     WHERE id = type::record('agent_token', $id) AND user = type::record('user', $user) AND revoked_at = NONE
     RETURN AFTER`,
    { id, user: userId },
  );
  return rows.length > 0;
}

/** Revoca el token que emitió un código OAuth (reutilización del código, RFC 9700 §4.5): solo ese, no otros del cliente. */
export async function revokeCodeToken(codeId: string): Promise<void> {
  await surql(
    `LET $t = (SELECT VALUE token FROM ONLY type::record('oauth_code', $code));
     IF $t { UPDATE $t SET revoked_at = time::now() WHERE revoked_at = NONE };`,
    { code: codeId },
  );
}

// ── Canje clave → JWT (lo usa el proxy /mcp) ────────────────────────────────

interface Cached {
  jwt: string;
  expMs: number;
}
// Una sola estructura, acotada. Un token revocado no necesita limpieza explícita: `exchangeAgentKey` comprueba la
// vigencia en cada llamada y descarta su entrada.
const jwtCache = new Map<string, Cached>(); // hash de la clave → JWT
const CACHE_MAX = 500;

/** Solo tests. */
export function resetAgentJwtCache(): void {
  jwtCache.clear();
}

function jwtExpMs(jwt: string): number {
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) as { exp: number };
  return payload.exp * 1000;
}

/**
 * JWT del usuario dueño de la clave, o null si la clave no es válida (inexistente, revocada, vencida).
 * La vigencia se comprueba en CADA llamada (revocar corta al agente al instante); el JWT se
 * reutiliza hasta que le quede poco.
 */
export async function exchangeAgentKey(key: string): Promise<string | null> {
  if (!isAgentKey(key)) return null;
  const hash = hashKey(key);
  const valid = await surql<unknown[]>(
    `SELECT id FROM agent_token
     WHERE key_hash = $hash AND revoked_at = NONE AND (expires_at = NONE OR expires_at > time::now())`,
    { hash },
  );
  if (valid.length === 0) {
    jwtCache.delete(hash);
    return null;
  }
  const hit = jwtCache.get(hash);
  if (hit && hit.expMs - Date.now() > JWT_MIN_LEFT_MS) return hit.jwt;

  const { url, namespace, database } = surrealEnv();
  const res = await fetch(`${url.replace(/^ws/, "http").replace(/\/rpc\/?$/, "")}/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ns: namespace, db: database, ac: "agent", key }),
  });
  if (res.status === 401 || res.status === 404) return null;
  if (!res.ok) throw new Error(`signin del acceso agent falló: HTTP ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("signin del acceso agent sin token");
  if (jwtCache.size >= CACHE_MAX) {
    // Cota de tamaño: se descartan los JWT vencidos y, si siguen todos vigentes, el más antiguo.
    for (const [h, c] of jwtCache) if (c.expMs <= Date.now()) jwtCache.delete(h);
    if (jwtCache.size >= CACHE_MAX) jwtCache.delete(jwtCache.keys().next().value as string);
  }
  jwtCache.set(hash, { jwt: body.token, expMs: jwtExpMs(body.token) });
  // `last_used_at` se refresca al canjear un JWT nuevo (como mucho cada ~10 min de uso): cadencia explícita, no por petición.
  await surql(`UPDATE agent_token SET last_used_at = time::now() WHERE key_hash = $hash`, { hash });
  return body.token;
}
