// Cliente SurrealDB (solo servidor). Dos identidades:
//   · `getDb()`   — usuario de sistema `app_server` (rol EDITOR): el equivalente
//     del antiguo service_role de Supabase, para jobs, scripts y lecturas sin sesión.
//   · `asUser()`  — la misma conexión HTTP ejecutando UNA llamada con el token
//     del usuario (`query().as(token)`): ahí aplican las PERMISSIONS de las
//     tablas (aislamiento por tienda nativo), sin abrir una conexión por request.
// Concurrencia: SurrealDB usa OCC (sin locks). Un conflicto de escritura es normal bajo carga y
// seguro de reintentar SOLO si la query es atómica (una sentencia o BEGIN…COMMIT): `surql` y
// `surqlAs` reintentan con backoff y jitter (opt-in del SDK: `.retry()`). Toda query con varias
// sentencias que escriban debe ir en BEGIN…COMMIT (el reintento reenvía la query completa).
// Los ids viajan como string plano; las queries usan `record::id(id)` al leer
// y `type::record('tabla', $id)` al escribir/filtrar (sin RecordId en la app).
// Sin `import "server-only"`: los tests `tsx --test` corren en node plano.
import { Surreal } from "surrealdb";

export interface SurrealEnv {
  url: string;
  namespace: string;
  database: string;
  username: string;
  password: string;
}

export function surrealEnv(): SurrealEnv {
  const url = process.env.SURREAL_URL;
  const namespace = process.env.SURREAL_NS;
  const database = process.env.SURREAL_DB;
  const username = process.env.SURREAL_APP_USER;
  const password = process.env.SURREAL_APP_PASSWORD;
  if (!url || !namespace || !database || !username || !password) {
    throw new Error("Falta SURREAL_URL / SURREAL_NS / SURREAL_DB / SURREAL_APP_USER / SURREAL_APP_PASSWORD en .env.local");
  }
  return { url, namespace, database, username, password };
}

export function isDbConfigured(): boolean {
  try {
    surrealEnv();
    return true;
  } catch {
    return false;
  }
}

let cached: Promise<Surreal> | null = null;

/** Conexión compartida autenticada como `app_server`. Un fallo de conexión no
 *  se cachea: el siguiente llamado reintenta. */
export function getDb(): Promise<Surreal> {
  if (!cached) {
    const env = surrealEnv();
    const db = new Surreal();
    cached = db
      .connect(env.url, {
        // Sin deadline un SurrealDB colgado dejaría server actions colgadas para siempre.
        requestTimeout: 60_000,
        namespace: env.namespace,
        database: env.database,
        authentication: {
          namespace: env.namespace,
          database: env.database,
          username: env.username,
          password: env.password,
        },
      })
      .then(() => db)
      .catch((e) => {
        cached = null;
        throw e;
      });
  }
  return cached;
}

const RETRY = { enabled: true, attempts: 20, retryDelay: 10, retryDelayMax: 500, retryDelayMultiplier: 2, retryDelayJitter: 0.5 };

/** Ejecuta SurrealQL con la identidad del servidor y devuelve el resultado de
 *  la última sentencia. Lanza si cualquier sentencia falla. */
export async function surql<T = unknown>(sql: string, vars?: Record<string, unknown>): Promise<T> {
  const db = await getDb();
  const results = await db.query(sql, vars).retry(RETRY).collect();
  return results[results.length - 1] as T;
}

/** Igual que `surql` pero con el token de acceso del usuario: aplican PERMISSIONS. */
export async function surqlAs<T = unknown>(
  token: string,
  sql: string,
  vars?: Record<string, unknown>,
): Promise<T> {
  const db = await getDb();
  const results = await db.query(sql, vars).as(token).retry(RETRY).collect();
  return results[results.length - 1] as T;
}

/** ¿Violación de índice UNIQUE? (el 23505 clásico). */
export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /Database index `[^`]+` already contains/.test(e.message);
}

/** Enlace app↔DB: la columna `company_id` de la app es el campo-record `company` en la DB. */
export type LinkMap = Record<string, { field: string; table: string }>;

/**
 * `SET ...` + variables a partir de un objeto de campos de la app. `null`/`undefined`
 * → NONE (los option<> de SurrealDB no aceptan NULL); las claves de `links` se
 * convierten a record ids. Los nombres de campo salen del código, nunca del usuario.
 * `prefix` evita colisiones de variables cuando una query combina varios `assignments`.
 */
export function assignments(
  fields: Record<string, unknown>,
  links: LinkMap = {},
  prefix = "w",
): { sql: string; vars: Record<string, unknown> } {
  const vars: Record<string, unknown> = {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`Campo inválido: ${key}`);
    const p = `${prefix}_${key}`;
    vars[p] = value;
    const link = links[key];
    parts.push(
      link
        ? `${link.field} = IF $${p} { type::record('${link.table}', $${p}) } ELSE { NONE }`
        : `${key} = $${p} ?? NONE`,
    );
  }
  return { sql: parts.join(", "), vars };
}

/** Cierra la conexión compartida (tests y scripts: sin esto el proceso no termina). */
export async function closeDb(): Promise<void> {
  const pending = cached;
  cached = null;
  if (pending) await (await pending).close();
}

/** Mensaje de un `THROW` de SurrealQL (sin el envoltorio del servidor). Otros errores: su mensaje. */
export function thrownMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const i = m.lastIndexOf("An error occurred: ");
  return i >= 0 ? m.slice(i + "An error occurred: ".length) : m;
}
