// PERMISSIONS por campo de comisión (migración 0017) sobre SurrealDB real.
// Paridad con web/lib/roles.ts: el rol mínimo de `agency.commission.view` decide
// quién ve el campo en la BD. Si se cambia FEATURE_MIN_ROLE sin migrar, este test falla.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Surreal } from "surrealdb";
import { createTestDb, TEST_NS, type TestDb } from "./helpers/surreal-test-db";
import { MEMBER_ROLES, canAccessFeature } from "../lib/roles";

let t: TestDb;
const q = async <T = unknown>(sql: string): Promise<T> => {
  const res = await t.root.query(sql).collect();
  return res[res.length - 1] as T;
};
const asUser = async <T = unknown>(token: string, sql: string): Promise<T> => {
  const res = await t.root.query(sql).as(token).collect();
  return res[res.length - 1] as T;
};
const tokens = new Map<string, string>();

before(async () => {
  t = await createTestDb();
  await q(`CREATE sys_store:s1 SET name = 's1'; CREATE sys_store:s2 SET name = 's2';`);
  for (const role of MEMBER_ROLES) {
    await q(
      `CREATE user:${role} SET email = '${role}@t.dev', password = crypto::bcrypt::generate('pass-${role}-1');
       RELATE user:${role}->member_of->sys_store:s1 SET role = '${role}';`,
    );
    tokens.set(role, (await t.signin(`${role}@t.dev`, `pass-${role}-1`)).access);
  }
  // Admin de OTRA tienda: no debe ver nada de s1.
  await q(
    `CREATE user:other SET email = 'other@t.dev', password = crypto::bcrypt::generate('pass-other-1');
     RELATE user:other->member_of->sys_store:s2 SET role = 'owner';`,
  );
  tokens.set("other", (await t.signin("other@t.dev", "pass-other-1")).access);
  await q(
    `CREATE crm_company:ag SET store = sys_store:s1, name = 'Agencia', kind = 'agencia', agency_commission_pct = 15;
     CREATE io_order:o1 SET store = sys_store:s1, number = 'OI-1', commission_pct = 12.5, snapshot_json = { commission_pct: 12.5 };
     CREATE io_order_version SET store = sys_store:s1, order = io_order:o1, revision = 1, snapshot = { commission_pct: 12.5 }, reason = 'x';`,
  );
});
after(async () => {
  await t?.drop();
});

describe("campos de comisión: PERMISSIONS por rol (paridad con roles.ts)", () => {
  for (const role of MEMBER_ROLES) {
    const expected = canAccessFeature(role, "agency.commission.view");
    it(`${role}: ${expected ? "ve" : "NO ve"} la comisión y sigue viendo la fila`, async () => {
      const tok = tokens.get(role)!;
      const [c] = await asUser<Array<{ name: string; agency_commission_pct?: number }>>(
        tok,
        `SELECT name, agency_commission_pct FROM crm_company:ag`,
      );
      assert.equal(c.name, "Agencia", "la fila sigue visible");
      assert.equal(c.agency_commission_pct, expected ? 15 : undefined);

      const [o] = await asUser<Array<{ number: string; commission_pct?: number; snapshot_json?: unknown }>>(
        tok,
        `SELECT number, commission_pct, snapshot_json FROM io_order:o1`,
      );
      assert.equal(o.number, "OI-1");
      assert.equal(o.commission_pct, expected ? 12.5 : undefined);
      assert.equal(o.snapshot_json !== undefined, expected);

      const [v] = await asUser<Array<{ revision: number; snapshot?: unknown }>>(
        tok,
        `SELECT revision, snapshot FROM io_order_version`,
      );
      assert.equal(v.revision, 1);
      assert.equal(v.snapshot !== undefined, expected);
    });
  }

  it("no se filtra por SELECT * ni por proyección anidada", async () => {
    const tok = tokens.get("viewer")!;
    const [c] = await asUser<Array<Record<string, unknown>>>(tok, `SELECT * FROM crm_company:ag`);
    assert.equal("agency_commission_pct" in c, false);
    const [o] = await asUser<Array<Record<string, unknown>>>(tok, `SELECT * FROM io_order:o1`);
    assert.equal("commission_pct" in o, false);
    assert.equal("snapshot_json" in o, false);
  });

  it("un owner de otra tienda no ve ni la fila ni la comisión", async () => {
    const tok = tokens.get("other")!;
    assert.deepEqual(await asUser(tok, `SELECT * FROM crm_company:ag`), []);
    assert.deepEqual(await asUser(tok, `SELECT * FROM io_order:o1`), []);
  });

  it("app_server (la web) sigue leyendo la comisión: los permisos de campo no la rompen", async () => {
    const app = new Surreal();
    await app.connect(t.url, {
      namespace: TEST_NS,
      database: t.database,
      authentication: { namespace: TEST_NS, database: t.database, username: "app_server", password: "test-app-server-pass" },
    });
    try {
      const res = await app.query(`SELECT agency_commission_pct FROM crm_company:ag`).collect();
      assert.equal((res[0] as Array<{ agency_commission_pct: number }>)[0].agency_commission_pct, 15);
    } finally {
      await app.close();
    }
  });
});
