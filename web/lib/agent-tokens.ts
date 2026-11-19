// Claves personales para agentes de IA (Claude, ChatGPT, Cursor…): una clave por
// (usuario, etiqueta), guardada solo como hash SHA-256 (migración 0018). La clave
// se canjea por un JWT de 10 min del PROPIO usuario (`signin` del acceso `agent`),
// así el agente ve exactamente lo que él ve en la web. Solo servidor, sin `next/*`
// (testeable con `tsx --test`).
import { createHash, randomBytes } from "node:crypto";
import { surql, surrealEnv } from "@/lib/surreal";

export const AGENT_KEY_PREFIX = "dooh_agent_";
/** 32 bytes en base64url = 43 caracteres. */
const KEY_RE = /^dooh_agent_[A-Za-z0-9_-]{43}$/;
export const MAX_AGENT_TOKENS_PER_USER = 10;
export const AGENT_TOKEN_DAYS = 90;
/** Renovar el JWT cuando le quede menos de esto (evita usarlo al borde de expirar). */
const JWT_MIN_LEFT_MS = 60_000;

export interface AgentTokenRow {
  id: string;
  label: string;
  hint: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
}

export function isAgentKey(v: unknown): v is string {
  return typeof v === "string" && KEY_RE.test(v);
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Crea una clave. La clave completa solo existe en este retorno: no se puede recuperar después. */
export async function createAgentToken(userId: string, label: string): Promise<{ id: string; key: string }> {
  const clean = label.trim();
  if (clean.length < 1 || clean.length > 60) throw new Error("Nombre inválido (1 a 60 caracteres).");
  const active = await listAgentTokens(userId);
  if (active.length >= MAX_AGENT_TOKENS_PER_USER) {
    throw new Error(`Máximo ${MAX_AGENT_TOKENS_PER_USER} claves activas: revoca alguna primero.`);
  }
  const key = AGENT_KEY_PREFIX + randomBytes(32).toString("base64url");
  const rows = await surql<Array<{ id: string }>>(
    `CREATE agent_token SET user = type::record('user', $user), label = $label, key_hash = $hash,
       hint = $hint, expires_at = time::now() + ${AGENT_TOKEN_DAYS}d
     RETURN record::id(id) AS id`,
    { user: userId, label: clean, hash: hashKey(key), hint: key.slice(-4) },
  );
  return { id: rows[0].id, key };
}

/** Claves vigentes (no revocadas ni vencidas) del usuario, de la más nueva a la más vieja. */
export async function listAgentTokens(userId: string): Promise<AgentTokenRow[]> {
  const rows = await surql<
    Array<{ id: string; label: string; hint: string; created_at: string; expires_at: string; last_used_at: string | null }>
  >(
    `SELECT record::id(id) AS id, label, hint, <string> created_at AS created_at, <string> expires_at AS expires_at,
            <string> last_used_at AS last_used_at
     FROM agent_token
     WHERE user = type::record('user', $user) AND revoked_at = NONE AND expires_at > time::now()
     ORDER BY created_at DESC`,
    { user: userId },
  );
  return rows.map((r) => ({ ...r, last_used_at: r.last_used_at ?? null }));
}

/** Revoca una clave del usuario. false = no existía, ya estaba revocada o no es suya. */
export async function revokeAgentToken(userId: string, id: string): Promise<boolean> {
  const rows = await surql<unknown[]>(
    `UPDATE agent_token SET revoked_at = time::now()
     WHERE id = type::record('agent_token', $id) AND user = type::record('user', $user) AND revoked_at = NONE
     RETURN AFTER`,
    { id, user: userId },
  );
  forgetJwt(id);
  return rows.length > 0;
}

// ── Canje clave → JWT (lo usa el proxy /mcp) ────────────────────────────────

interface Cached {
  jwt: string;
  expMs: number;
}
const jwtCache = new Map<string, Cached>(); // hash de la clave → JWT
const hashById = new Map<string, string>(); // id de token → hash (para olvidar al revocar)

function forgetJwt(id: string): void {
  const h = hashById.get(id);
  if (h) jwtCache.delete(h);
  hashById.delete(id);
}

/** Solo tests. */
export function resetAgentJwtCache(): void {
  jwtCache.clear();
  hashById.clear();
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
  const valid = await surql<Array<{ id: string }>>(
    `SELECT record::id(id) AS id FROM agent_token
     WHERE key_hash = $hash AND revoked_at = NONE AND expires_at > time::now()`,
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
  jwtCache.set(hash, { jwt: body.token, expMs: jwtExpMs(body.token) });
  hashById.set(valid[0].id, hash);
  await surql(`UPDATE agent_token SET last_used_at = time::now() WHERE key_hash = $hash`, { hash });
  return body.token;
}
