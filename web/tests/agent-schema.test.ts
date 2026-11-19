// La guía de datos del mensaje para agentes debe describir el esquema REAL (si no, el agente consulta
// tablas o campos que no existen) y no debe exponer campos que el rol oculta (comisión).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./helpers/surreal-test-db";
import { AGENT_SCHEMA, renderAgentSchema } from "../lib/agent-schema";

let t: TestDb;
before(async () => {
  t = await createTestDb();
});
after(async () => {
  await t?.drop();
});

describe("guía de datos para agentes (lib/agent-schema)", () => {
  for (const { table, fields } of AGENT_SCHEMA) {
    it(`${table}: la tabla y sus campos existen en el esquema real`, async () => {
      const res = await t.root.query(`INFO FOR TABLE ${table}`).collect();
      const info = res[0] as { fields?: Record<string, string> };
      assert.ok(info.fields, `la tabla ${table} no existe`);
      const real = new Set(Object.keys(info.fields));
      const missing = fields.filter((f) => !real.has(f));
      assert.deepEqual(missing, [], `campos inexistentes en ${table}`);
    });
  }
  it("no menciona campos de comisión ni secretos", () => {
    const text = renderAgentSchema();
    assert.equal(/commission|password|key_hash|snapshot/i.test(text), false);
  });
});
