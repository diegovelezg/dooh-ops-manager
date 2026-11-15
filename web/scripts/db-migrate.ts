// Aplica `surreal/migrations/*.surql` (ver scripts/lib/migrate.ts).
// Uso: npm run db:migrate
// Requiere credenciales root del migrador (nunca las de la app):
//   SURREAL_URL, SURREAL_NS, SURREAL_DB, SURREAL_ROOT_USER, SURREAL_ROOT_PASS,
//   SURREAL_APP_PASSWORD (password del usuario `app_server`).
import { Surreal } from "surrealdb";
import { applyMigrations } from "./lib/migrate";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta ${name}`);
  return v;
}

async function main(): Promise<void> {
  const namespace = need("SURREAL_NS");
  const database = need("SURREAL_DB");
  const db = new Surreal();
  await db.connect(need("SURREAL_URL"), {
    authentication: { username: need("SURREAL_ROOT_USER"), password: need("SURREAL_ROOT_PASS") },
  });
  await db
    .query(`DEFINE NAMESPACE IF NOT EXISTS ${namespace}; USE NS ${namespace}; DEFINE DATABASE IF NOT EXISTS ${database};`)
    .collect();
  await db.use({ namespace, database });
  const n = await applyMigrations(db, { APP_SERVER_PASSWORD: need("SURREAL_APP_PASSWORD") });
  console.log(n === 0 ? "Sin migraciones pendientes." : `${n} migración(es) aplicada(s).`);
  await db.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
