// Los fragmentos inline de `lib/search-sql` aplican LA MISMA regla que las funciones de la migración 0003
// (`fn::norm`, `fn::match_all`, `fn::match_score`). Van inline por rendimiento (llamar una fn:: de usuario cuesta
// ~35 µs por fila); esta prueba garantiza que no se desincronizan.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./helpers/surreal-test-db";
import { matchAll, matchScore, norm } from "../lib/search-sql";

let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t?.drop(); });

const run = async <T>(sql: string, vars: Record<string, unknown>): Promise<T> => {
  const res = await t.root.query(sql, vars).collect();
  return res[res.length - 1] as T;
};

const HAYS = [
  "wpp media management peru s.a.c. stephanie espejo planner",
  "publicidad y marketing digital lima",
  "avenida paseo la castellana 107 surco",
  "acme", "", "ñandú café áéíóú",
];
const QUERIES = ["wpp", "publicitria", "Stephanie  ESPEJO", "castelana", "ñandu cafe", "acme acme", "zzz", "", "lima marketing", "planner wpp media"];

describe("búsqueda inline = fn:: (migración 0003)", () => {
  it("norm", async () => {
    for (const s of ["Café ÑANDÚ  Áéíóú", "", "WPP Media S.A.C.", "  espacios   múltiples "]) {
      const [a] = await run<string[]>(`RETURN [fn::norm($s)]`, { s });
      const [b] = await run<string[]>(`RETURN [${norm("$s")}]`, { s });
      assert.equal(b, a, `norm(${JSON.stringify(s)})`);
    }
    const [a] = await run<string[]>(`RETURN [fn::norm(NONE)]`, {});
    const [b] = await run<string[]>(`RETURN [${norm("NONE")}]`, {});
    assert.equal(b, a);
  });

  it("match_all coincide en todas las combinaciones texto × consulta", async () => {
    for (const hayRaw of HAYS) for (const q of QUERIES) {
      const vars = { hay: hayRaw, q };
      const [a] = await run<boolean[]>(`LET $tokens = fn::tokens($q); LET $h = fn::norm($hay); RETURN [fn::match_all($h, $tokens)]`, vars);
      const [b] = await run<boolean[]>(`LET $tokens = fn::tokens($q); LET $h = fn::norm($hay); RETURN [${matchAll("$h")}]`, vars);
      assert.equal(b, a, `match_all(${JSON.stringify(hayRaw)}, ${JSON.stringify(q)})`);
    }
  });

  it("match_score coincide (mismo valor, solo se usa para ordenar)", async () => {
    for (const hayRaw of HAYS) for (const q of QUERIES) {
      const vars = { hay: hayRaw, primary: hayRaw.split(" ").slice(0, 2).join(" "), q };
      const common = `LET $qn = fn::norm($q); LET $h = fn::norm($hay); LET $p = fn::norm($primary);`;
      const [a] = await run<number[]>(`${common} RETURN [fn::match_score($p, $h, $qn)]`, vars);
      const [b] = await run<number[]>(`${common} RETURN [${matchScore("$p", "$h")}]`, vars);
      assert.ok(Math.abs(b - a) < 1e-12, `match_score(${JSON.stringify(hayRaw)}, ${JSON.stringify(q)}): ${b} vs ${a}`);
    }
  });
});

describe("search guardado (migración 0016): se mantiene al escribir y por cascada", () => {
  const q = async <T = unknown>(sql: string, vars?: Record<string, unknown>): Promise<T> => {
    const res = await t.root.query(sql, vars).collect();
    return res[res.length - 1] as T;
  };
  const has = async (table: string, id: string, needle: string): Promise<boolean> =>
    ((await q<unknown[]>(`SELECT id FROM type::record($t, $id) WHERE string::contains(search, $n)`, { t: table, id, n: needle })).length) === 1;

  it("renombrar la empresa actualiza el search de sus contactos y de las pantallas que provee; el venue, el de sus pantallas", async () => {
    await q(`CREATE sys_store:⟨ss⟩ SET name = 'SS', io_prefix = 'SS';
      CREATE crm_company:⟨prov⟩ SET store = sys_store:⟨ss⟩, name = 'Proveedor Original', kind = 'proveedor';
      CREATE crm_contact:⟨c1⟩ SET store = sys_store:⟨ss⟩, company = crm_company:⟨prov⟩, first_name = 'Ana', email = 'ana@x.pe';
      CREATE inv_venue:⟨v1⟩ SET store = sys_store:⟨ss⟩, name = 'Mall Uno', city = 'Lima', ownership = 'supplier', supplier = crm_company:⟨prov⟩;
      CREATE inv_screen:⟨s1⟩ SET store = sys_store:⟨ss⟩, venue = inv_venue:⟨v1⟩, supplier = crm_company:⟨prov⟩, name = 'Pantalla Uno', ownership = 'supplier';`);
    // Escritura inicial: el search ya incluye los textos de las tablas enlazadas.
    assert.ok(await has("crm_contact", "c1", "proveedor original"), "contacto incluye la empresa");
    assert.ok(await has("inv_screen", "s1", "proveedor original") && await has("inv_screen", "s1", "mall uno"), "pantalla incluye proveedor y venue");
    // Renombrar la empresa.
    await q(`UPDATE crm_company:⟨prov⟩ SET name = 'Zeta Medios'`);
    assert.ok(await has("crm_company", "prov", "zeta medios"));
    assert.ok(await has("crm_contact", "c1", "zeta medios") && !(await has("crm_contact", "c1", "proveedor original")), "cascada a contactos");
    assert.ok(await has("inv_screen", "s1", "zeta medios") && !(await has("inv_screen", "s1", "proveedor original")), "cascada a pantallas por proveedor");
    // Renombrar la ciudad del venue.
    await q(`UPDATE inv_venue:⟨v1⟩ SET city = 'Cusco'`);
    assert.ok(await has("inv_screen", "s1", "cusco") && !(await has("inv_screen", "s1", "lima")), "cascada a pantallas por venue");
    // Edición normal del propio registro.
    await q(`UPDATE crm_contact:⟨c1⟩ SET job_title = 'Gerente'`);
    assert.ok(await has("crm_contact", "c1", "gerente") && await has("crm_contact", "c1", "zeta medios"));
  });
});
