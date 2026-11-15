// El proceso hijo usa la condición react-server para ejecutar los repositorios
// de Next con cookies controladas; los datos viven solo en una DB efímera.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createTestDb, pointAppAt, type TestDb } from "./helpers/surreal-test-db";

let t: TestDb;
let token: string;

before(async () => {
  t = await createTestDb();
  pointAppAt(t);
  await t.root.query(`
    CREATE sys_store:store_a SET name = 'A';
    CREATE sys_store:store_b SET name = 'B';
    CREATE user:reader SET email = 'reader@audit.test', password = crypto::bcrypt::generate('test-reader-pass');
    RELATE user:reader->member_of->sys_store:store_a SET role = 'viewer';
    CREATE inv_venue:picker SET store = sys_store:store_a, name = 'Picker';
    FOR $id IN $ids {
      CREATE type::record('inv_screen', $id) SET store = sys_store:store_a, venue = inv_venue:picker, name = $id;
    };
    CREATE inv_venue:other SET store = sys_store:store_b, name = 'Ajena';
    CREATE inv_screen:other SET store = sys_store:store_b, venue = inv_venue:other, name = 'Ajena';
  `, { ids: Array.from({ length: 203 }, (_, i) => `screen_${i}`) }).collect();
  token = (await t.signin("reader@audit.test", "test-reader-pass")).access;
});

after(async () => { await t?.drop(); });

it("un error de sesión no lista tiendas; el picker incluye más de 200 pantallas propias", () => {
  const web = resolve(import.meta.dirname, "..");
  const script = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(resolve(web, "package.json"))});
    const headers = require('next/headers');
    let token = 'invalid-audit-token';
    headers.cookies = async () => ({ get: () => token ? { value: token } : undefined });
    const tenant = await import(${JSON.stringify(resolve(web, "lib/tenant.ts"))});
    const surreal = await import(${JSON.stringify(resolve(web, "lib/surreal.ts"))});
    try {
      await assert.rejects(tenant.listMyStores());
      token = '';
      assert.deepEqual(await tenant.listMyStores(), []);
      token = process.env.AUDIT_TEST_TOKEN;
      assert.deepEqual((await tenant.listMyStores('store_b')).map(s => s.id), ['store_a']);
      assert.equal((await tenant.getMyActiveStore('store_b')).active.id, 'store_a');
      const { GET } = await import(${JSON.stringify(resolve(web, "app/api/screens/route.ts"))});
      const response = await GET(new Request('http://localhost/api/screens?store=store_a'));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.screens.length, 203);
      assert.equal(new Set(body.screens.map(s => s.id)).size, 203);
      assert.ok(body.screens.every(s => s.name !== 'Ajena'));
      // La navegación la resuelve el bundler de Next en producción; las
      // acciones de lectura no deben redirigir ni importar el router cliente.
      require.cache[require.resolve('next/navigation')] = { exports: { redirect() { throw new Error('Unexpected redirect'); } } };
      const actions = await import(${JSON.stringify(resolve(web, "lib/order-actions.ts"))});
      const ids = body.screens.map(s => s.id);
      const availability = await actions.checkAvailabilityAction({ screenIds: ids, starts: '2027-01-01', ends: '2027-01-02' });
      assert.equal(availability.ok, true, availability.message);
      assert.equal(Object.keys(availability.capacities).length, 203);
      const occupancy = await actions.getScreenOccupancyAction({ screenIds: ids, from: '2027-01-01' });
      assert.equal(occupancy.ok, true, occupancy.message);
      assert.equal(Object.keys(occupancy.occupancy).length, 203);
      const { GET: getOccupancy } = await import(${JSON.stringify(resolve(web, "app/api/screens/[id]/occupancy/route.ts"))});
      const request = new Request('http://localhost/api/screens/screen_0/occupancy');
      const params = { params: Promise.resolve({ id: 'screen_0' }) };
      const normal = await getOccupancy(request, params);
      assert.equal(normal.status, 200);
      const normalBody = await normal.json();
      const { addDays } = await import(${JSON.stringify(resolve(web, "lib/format.ts"))});
      assert.equal(normalBody.from, addDays(normalBody.today, -90));
      assert.equal(normalBody.to, addDays(normalBody.today, 120));
      // Un fallo parcial de DB debe ser 500, nunca una pantalla libre.
      const connection = await surreal.getDb();
      const query = connection.query;
      connection.query = function(sql, ...args) {
        if (typeof sql === 'string' && sql.includes('fn::screen_capacity')) throw new Error('Forced capacity read failure');
        return query.call(this, sql, ...args);
      };
      const failed = await getOccupancy(request, params);
      assert.equal(failed.status, 500);
      assert.match((await failed.json()).error, /Forced capacity read failure/);
    } finally {
      await surreal.closeDb();
    }
  `;
  const child = spawnSync(process.execPath, ["--conditions=react-server", "--import=tsx", "--input-type=module", "-e", script], {
    cwd: web,
    env: { ...process.env, AUDIT_TEST_TOKEN: token, LOG_LEVEL: "error" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
});
