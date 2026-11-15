// Base SurrealDB efímera por suite: NS `dooh_test`, DB aleatoria con TODAS las
// migraciones aplicadas. Requiere el servidor local (infra/surrealdb) y las
// credenciales root en el entorno (`npm test` carga .env.local).
import { randomBytes } from "node:crypto";
import { Surreal } from "surrealdb";
import { applyMigrations } from "../../scripts/lib/migrate";

export const TEST_NS = "dooh_test";

export interface TestDb {
  /** Conexión root sobre la DB efímera. */
  root: Surreal;
  database: string;
  url: string;
  /** Login por el acceso `app` como lo hace la app. */
  signin(email: string, password: string): Promise<{ access: string; refresh?: string }>;
  /** Conexión nueva sin credenciales (para signin/refresh). */
  anonymous(): Promise<Surreal>;
  drop(): Promise<void>;
}

/** Apunta `lib/surreal` (usuario de sistema `app_server`) a la DB efímera. Llamar ANTES de importar módulos de `lib/`. */
export function pointAppAt(t: TestDb): void {
  process.env.SURREAL_URL = t.url;
  process.env.SURREAL_NS = TEST_NS;
  process.env.SURREAL_DB = t.database;
  process.env.SURREAL_APP_USER = "app_server";
  process.env.SURREAL_APP_PASSWORD = "test-app-server-pass";
}

export async function createTestDb(): Promise<TestDb> {
  const url = process.env.SURREAL_URL;
  const user = process.env.SURREAL_ROOT_USER;
  const pass = process.env.SURREAL_ROOT_PASS;
  if (!url || !user || !pass) {
    throw new Error("Tests de SurrealDB: define SURREAL_URL / SURREAL_ROOT_USER / SURREAL_ROOT_PASS (.env.local) y levanta infra/surrealdb.");
  }
  const database = `t_${randomBytes(6).toString("hex")}`;
  const root = new Surreal();
  await root.connect(url, { authentication: { username: user, password: pass } });
  await root
    .query(`DEFINE NAMESPACE IF NOT EXISTS ${TEST_NS}; USE NS ${TEST_NS}; DEFINE DATABASE ${database};`)
    .collect();
  await root.use({ namespace: TEST_NS, database });
  await applyMigrations(root, { APP_SERVER_PASSWORD: "test-app-server-pass" });
  const anonymous = async (): Promise<Surreal> => {
    const db = new Surreal();
    await db.connect(url, { namespace: TEST_NS, database });
    return db;
  };
  return {
    root,
    database,
    url,
    anonymous,
    async signin(email, password) {
      const db = await anonymous();
      try {
        return await db.signin({ namespace: TEST_NS, database, access: "app", variables: { email, password } });
      } finally {
        await db.close();
      }
    },
    async drop() {
      await root.query(`USE NS ${TEST_NS}; REMOVE DATABASE ${database};`).collect();
      await root.close();
    },
  };
}
