// Identidad y tenencia sobre SurrealDB real (base efímera): login, PERMISSIONS
// por tienda, rotación de refresh e invariante "siempre un propietario" (incl. carrera).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, pointAppAt, type TestDb } from "./helpers/surreal-test-db";

let t: TestDb;
const q = async <T = unknown>(sql: string, vars?: Record<string, unknown>): Promise<T> => {
  const res = await t.root.query(sql, vars).collect();
  return res[res.length - 1] as T;
};
const asUser = async <T = unknown>(token: string, sql: string): Promise<T> => {
  const res = await t.root.query(sql).as(token).collect();
  return res[res.length - 1] as T;
};
const mkUser = (id: string, email: string, pw: string) =>
  q(`CREATE type::record('user', $id) SET email = $email, password = crypto::bcrypt::generate($pw)`, { id, email, pw });
const mkStore = (id: string) => q(`CREATE type::record('sys_store', $id) SET name = $id`, { id });
const join = (u: string, s: string, role: string) =>
  q(`RELATE (type::record('user', $u))->member_of->(type::record('sys_store', $s)) SET role = $role`, { u, s, role });

before(async () => {
  t = await createTestDb();
  await mkUser("alice", "Alice@Test.dev", "alice-pass-1");
  await mkUser("bob", "bob@test.dev", "bob-pass-1");
  await mkStore("s1");
  await mkStore("s2");
  await join("alice", "s1", "owner");
  await join("bob", "s2", "seller");
});
after(async () => {
  // lib/surreal abre una conexión compartida al usarse (validateAccessToken): sin cerrarla el proceso no termina.
  await (await import("../lib/surreal")).closeDb();
  await t?.drop();
});

describe("login (DEFINE ACCESS app)", () => {
  it("emite access + refresh con credenciales correctas (email insensible a mayúsculas)", async () => {
    const tok = await t.signin("alice@test.dev", "alice-pass-1");
    assert.ok(tok.access && tok.refresh);
  });

  it("rechaza password incorrecto y usuario inexistente", async () => {
    await assert.rejects(t.signin("alice@test.dev", "mal"));
    await assert.rejects(t.signin("nadie@test.dev", "alice-pass-1"));
  });

  it("acepta hashes bcrypt $2a$ heredados (GoTrue)", async () => {
    // Vector estándar de OpenBSD: password "U*U".
    await q(`CREATE type::record('user', 'legacy') SET email = 'legacy@test.dev', password = $h`, {
      h: "$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW",
    });
    assert.ok((await t.signin("legacy@test.dev", "U*U")).access);
  });

  it("el refresh rota, no se reutiliza y se puede revocar", async () => {
    const tok = await t.signin("alice@test.dev", "alice-pass-1");
    const db = await t.anonymous();
    const next = await db.authenticate({ access: tok.access, refresh: tok.refresh! });
    assert.notEqual(next.refresh, tok.refresh);
    const replay = await t.anonymous();
    await assert.rejects(replay.authenticate({ access: tok.access, refresh: tok.refresh! }));
    await db.revoke(next);
    const after = await t.anonymous();
    await assert.rejects(after.authenticate(next));
    await Promise.all([db.close(), replay.close(), after.close()]);
  });
});

describe("aislamiento por tienda (PERMISSIONS nativas)", () => {
  it("el usuario solo ve sus tiendas y su membresía", async () => {
    const a = (await t.signin("alice@test.dev", "alice-pass-1")).access;
    const b = (await t.signin("bob@test.dev", "bob-pass-1")).access;
    assert.deepEqual(await asUser(a, "SELECT VALUE record::id(id) FROM sys_store"), ["s1"]);
    assert.deepEqual(await asUser(b, "SELECT VALUE record::id(id) FROM sys_store"), ["s2"]);
    assert.deepEqual(await asUser(b, "SELECT VALUE record::id(out) FROM member_of"), ["s2"]);
  });

  it("nunca expone el hash ni otros usuarios", async () => {
    const a = (await t.signin("alice@test.dev", "alice-pass-1")).access;
    const rows = await asUser<Array<{ email: string; password?: string }>>(a, "SELECT * FROM user");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].password, undefined);
  });

  it("un usuario no puede escribir tiendas ni membresías", async () => {
    const b = (await t.signin("bob@test.dev", "bob-pass-1")).access;
    await asUser(b, "UPDATE sys_store SET name = 'hack'");
    await asUser(b, "UPDATE member_of SET role = 'owner'");
    assert.equal((await q<Array<{ name: string }>>("SELECT name FROM sys_store WHERE id = sys_store:s2"))[0].name, "s2");
    assert.equal((await q<Array<{ role: string }>>("SELECT role FROM member_of WHERE out = sys_store:s2"))[0].role, "seller");
  });
});

describe("invariante: la tienda conserva un propietario", () => {
  const demote = (u: string, s: string) =>
    q(`UPDATE member_of SET role = 'seller' WHERE in = type::record('user', $u) AND out = type::record('sys_store', $s)`, { u, s })
      .then(() => "ok" as const, (e: Error) => e.message);
  const owners = async (s: string) =>
    (await q<Array<{ n: number }>>(
      `SELECT count() AS n FROM member_of WHERE out = type::record('sys_store', $s) AND role = 'owner' GROUP ALL`,
      { s },
    ))[0]?.n ?? 0;

  it("bloquea degradar o quitar al único propietario", async () => {
    assert.match(String(await demote("alice", "s1")), /sin propietario/);
    await assert.rejects(
      q(`DELETE member_of WHERE in = type::record('user', 'alice') AND out = sys_store:s1`),
      /sin propietario/,
    );
    assert.equal(await owners("s1"), 1);
  });

  it("dos degradaciones simultáneas de propietarios distintos nunca dejan 0", async () => {
    await mkStore("s3");
    await mkUser("c1", "c1@test.dev", "pass-c1-xx");
    await mkUser("c2", "c2@test.dev", "pass-c2-xx");
    await join("c1", "s3", "owner");
    await join("c2", "s3", "owner");
    const res = await Promise.all([demote("c1", "s3"), demote("c2", "s3")]);
    assert.equal(await owners("s3"), 1, `resultados: ${JSON.stringify(res)}`);
    assert.equal(res.filter((r) => r === "ok").length, 1);
  });
});

describe("renovación de sesión (lib/auth)", () => {
  it("canjea un refresh válido y devuelve null ante tokens vencidos, ilegibles o de otra sesión", async () => {
    pointAppAt(t);
    const { refreshTokens, validateAccessToken } = await import("../lib/auth");
    const tok = await t.signin("alice@test.dev", "alice-pass-1");
    const next = await refreshTokens({ access: tok.access, refresh: tok.refresh! });
    assert.ok(next && (await validateAccessToken(next.access))?.email === "alice@test.dev");
    assert.equal(await refreshTokens({ access: tok.access, refresh: tok.refresh! }), null); // refresh ya canjeado
    assert.equal(await refreshTokens({ access: "basura", refresh: "basura" }), null); // cookie manipulada
    assert.equal(await validateAccessToken("basura"), null);
  });
});
