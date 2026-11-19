// Aislamiento entre tenants en el ESQUEMA (reemplaza al guardarraíl de las FK compuestas de Postgres):
// todo campo que referencia a otra tabla de tenant debe afirmar que el destino es de la MISMA tienda,
// y toda tabla de tenant lleva `store` READONLY. Se lee el esquema real de una DB efímera.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./helpers/surreal-test-db";

let t: TestDb;
type Info = { fields: Record<string, string> };
const info = async (table: string): Promise<Info> => {
  const res = await t.root.query(`INFO FOR TABLE ${table}`).collect();
  return res[0] as Info;
};

// Tablas SIN tenant: identidad global, contadores internos y caches globales de IA.
// Vistas de tabla (`AS SELECT … GROUP BY store`, solo lectura, derivadas de una tabla que sí tiene `store` READONLY):
// no se escriben, así que no hay `store` que proteger; su PERMISSIONS ya limita el select a miembros de la tienda.
const TABLE_VIEWS = ["ai_llm_usage_total"];
const NON_TENANT = new Set(["user", "sys_store", "member_of", "agent_token", "insight_read", "io_counter", "ai_vertical_profile", "ai_domain_cache", "_migration", ...TABLE_VIEWS]);

before(async () => {
  t = await createTestDb();
});
after(async () => {
  await t?.drop();
});

describe("same-store: el esquema impide referencias entre tenants", () => {
  it("toda tabla de tenant tiene `store` READONLY", async () => {
    const db = (await t.root.query("INFO FOR DB").collect())[0] as { tables: Record<string, string> };
    const tenant = Object.keys(db.tables).filter((n) => !NON_TENANT.has(n));
    assert.ok(tenant.length >= 20, `tablas de tenant halladas: ${tenant.length}`);
    for (const table of tenant) {
      const f = (await info(table)).fields.store;
      assert.ok(f, `${table}: sin campo store`);
      assert.match(f, /READONLY/, `${table}.store debe ser READONLY`);
    }
  });

  it("todo enlace a otra tabla de tenant exige misma tienda (ASSERT … .store = $this.store)", async () => {
    const db = (await t.root.query("INFO FOR DB").collect())[0] as { tables: Record<string, string> };
    const tenantTables = new Set(Object.keys(db.tables).filter((n) => !NON_TENANT.has(n)));
    const missing: string[] = [];
    for (const table of tenantTables) {
      for (const [field, def] of Object.entries((await info(table)).fields)) {
        if (field === "store" || field === "in" || field === "out") continue;
        if (/\sVALUE\s/.test(def)) continue; // derivados de otros campos del propio registro (claves de unicidad)
        const targets = [...def.matchAll(/record<([a-z_|\s]+)>/g)].flatMap((m) => m[1].split("|").map((x) => x.trim()));
        if (!targets.some((x) => tenantTables.has(x))) continue;
        if (!/\.store\s*=\s*\$this\.store/.test(def)) missing.push(`${table}.${field}`);
      }
    }
    assert.deepEqual(missing, [], `enlaces sin validar misma tienda: ${missing.join(", ")}`);
  });

  it("las aristas entre tenants validan ambos extremos", async () => {
    for (const edge of ["crm_company_link", "crm_contact_account"]) {
      const f = (await info(edge)).fields;
      assert.match(f.in, /\.store\s*=\s*\$this\.store/, `${edge}.in`);
      assert.match(f.out, /\.store\s*=\s*\$this\.store/, `${edge}.out`);
    }
  });
});
