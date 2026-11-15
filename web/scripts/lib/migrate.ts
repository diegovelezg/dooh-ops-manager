// Motor de migraciones SurrealQL: `surreal/migrations/*.surql` en orden, una vez
// cada una (tabla `_migration` con checksum). Lo usan `scripts/db-migrate.ts` y
// los tests de integración (base efímera por suite).
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Surreal } from "surrealdb";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "..", "surreal", "migrations");

/** Literal SurrealQL seguro (comillas dobles escapadas por JSON). */
const lit = (v: string): string => JSON.stringify(v);

function render(sql: string, vars: Record<string, string>): string {
  return sql.replace(/\{\{([A-Z_]+)\}\}/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`Placeholder sin valor: ${k}`);
    return lit(v);
  });
}

/** Aplica las migraciones pendientes sobre la NS/DB ya seleccionada en `db`. Devuelve cuántas. */
export async function applyMigrations(db: Surreal, vars: Record<string, string>): Promise<number> {
  await db
    .query(
      `DEFINE TABLE IF NOT EXISTS _migration SCHEMAFULL;
       DEFINE FIELD IF NOT EXISTS name ON _migration TYPE string;
       DEFINE FIELD IF NOT EXISTS checksum ON _migration TYPE string;
       DEFINE FIELD IF NOT EXISTS applied_at ON _migration TYPE datetime DEFAULT time::now();
       DEFINE INDEX IF NOT EXISTS _migration_name ON _migration FIELDS name UNIQUE;`,
    )
    .collect();
  const [done] = await db
    .query<[Array<{ name: string; checksum: string }>]>("SELECT name, checksum FROM _migration")
    .collect();
  const applied = new Map((done ?? []).map((r) => [r.name, r.checksum]));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".surql")).sort();
  let n = 0;
  for (const f of files) {
    const raw = await readFile(join(MIGRATIONS_DIR, f), "utf-8");
    const checksum = createHash("sha256").update(raw).digest("hex");
    const prev = applied.get(f);
    if (prev !== undefined) {
      if (prev !== checksum) throw new Error(`Migración ${f} modificada tras aplicarse (checksum distinto). Crea una nueva.`);
      continue;
    }
    await db
      .query(`BEGIN; ${render(raw, vars)}\nCREATE _migration SET name = $name, checksum = $checksum; COMMIT;`, { name: f, checksum })
      // DDL concurrente/índices puede abortar toda la transacción. Solo el
      // conflicto reintentable del servidor se repite; cualquier otro error lanza.
      .retry({ enabled: true, attempts: 5 })
      .collect();
    console.log(`✔ ${f}`);
    n++;
  }
  return n;
}
