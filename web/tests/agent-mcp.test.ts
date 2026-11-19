// Claves de agente + proxy /mcp de extremo a extremo sobre SurrealDB real (base efímera):
// el agente ve lo mismo que el usuario en la web, solo lectura, y revocar lo corta al instante.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, pointAppAt, type TestDb } from "./helpers/surreal-test-db";

let t: TestDb;
let agent: typeof import("../lib/agent-tokens");
let route: typeof import("../app/mcp/route");
const q = async <T = unknown>(sql: string): Promise<T> => {
  const res = await t.root.query(sql).collect();
  return res[res.length - 1] as T;
};

before(async () => {
  t = await createTestDb();
  pointAppAt(t);
  agent = await import("../lib/agent-tokens");
  route = await import("../app/mcp/route");
  await q(`
    CREATE sys_store:a SET name = 'A'; CREATE sys_store:b SET name = 'B';
    CREATE user:ua SET email = 'ua@t.dev', password = crypto::bcrypt::generate('pass-ua-12');
    CREATE user:ub SET email = 'ub@t.dev', password = crypto::bcrypt::generate('pass-ub-12');
    RELATE user:ua->member_of->sys_store:a SET role = 'viewer';
    RELATE user:ub->member_of->sys_store:b SET role = 'owner';
    CREATE crm_company:a1 SET store = sys_store:a, name = 'Cliente A', kind = 'agencia', agency_commission_pct = 15;
    CREATE crm_company:b1 SET store = sys_store:b, name = 'Cliente B secreto';`);
});
after(async () => {
  await (await import("../lib/surreal")).closeDb();
  await t?.drop();
});

const call = async (key: string | null, body?: unknown, sid?: string, method = "POST") => {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (key) headers.authorization = `Bearer ${key}`;
  if (sid) headers["mcp-session-id"] = sid;
  const res = await route.POST(new Request("http://app/mcp", { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: {"));
  return { status: res.status, sid: res.headers.get("mcp-session-id"), json: data ? JSON.parse(data.slice(6)) : text.startsWith("{") ? JSON.parse(text) : null };
};
const open = async (key: string) => {
  const ini = await call(key, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await call(key, { jsonrpc: "2.0", method: "notifications/initialized" }, ini.sid ?? undefined);
  return ini.sid ?? undefined;
};
const tool = async (key: string, sid: string | undefined, name: string, args: unknown) => {
  const r = await call(key, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }, sid);
  return r.json?.result?.structuredContent?.value ?? r.json?.result?.content?.[0]?.text;
};

describe("claves de agente (store)", () => {
  it("crea, lista (sin la clave) y limita por usuario", async () => {
    const { id, key } = await agent.createAgentToken("ua", "Claude Desktop");
    assert.ok(agent.isAgentKey(key));
    const list = await agent.listAgentTokens("ua");
    assert.equal(list.length, 1);
    assert.equal(list[0].id, id);
    assert.equal(list[0].label, "Claude Desktop");
    assert.equal(list[0].hint, key.slice(-4));
    assert.equal(JSON.stringify(list).includes(key), false, "la clave completa no se guarda ni se lista");
    assert.deepEqual(await agent.listAgentTokens("ub"), [], "cada usuario ve solo las suyas");
    await assert.rejects(() => agent.createAgentToken("ua", "  "), /Nombre inválido/);
    await agent.revokeAgentToken("ua", id);
  });
  it("no se puede revocar la clave de otro usuario", async () => {
    const { id } = await agent.createAgentToken("ub", "de B");
    assert.equal(await agent.revokeAgentToken("ua", id), false);
    assert.equal((await agent.listAgentTokens("ub")).length, 1);
    assert.equal(await agent.revokeAgentToken("ub", id), true);
    assert.equal(await agent.revokeAgentToken("ub", id), false, "ya revocada");
  });
  it("la BD no deja leer agent_token con un token de usuario", async () => {
    const tok = (await t.signin("ua@t.dev", "pass-ua-12")).access;
    const res = await t.root.query(`SELECT * FROM agent_token`).as(tok).collect();
    assert.deepEqual(res[0], []);
  });
});

describe("/mcp: proxy de solo lectura con la identidad del usuario", () => {
  it("sin clave o con clave inválida → 401", async () => {
    assert.equal((await call(null, { jsonrpc: "2.0", id: 1, method: "initialize" })).status, 401);
    assert.equal((await call("dooh_agent_" + "x".repeat(43), { jsonrpc: "2.0", id: 1, method: "initialize" })).status, 401);
    assert.equal((await call("basura", { jsonrpc: "2.0", id: 1, method: "initialize" })).status, 401);
  });

  it("el agente de A ve solo A, sin la comisión (viewer), y no puede escribir", async () => {
    const { key } = await agent.createAgentToken("ua", "agente A");
    const sid = await open(key);

    const list = await call(key, { jsonrpc: "2.0", id: 3, method: "tools/list" }, sid);
    assert.deepEqual((list.json.result.tools as Array<{ name: string }>).map((x) => x.name).sort(), ["info", "list", "query", "select"]);

    const rows = (await tool(key, sid, "query", { query: "SELECT name, agency_commission_pct FROM crm_company" })) as Array<Record<string, unknown>>;
    // El MCP serializa NONE como null: la comisión no llega (15) aunque la fila sí.
    assert.deepEqual(rows, [{ name: "Cliente A", agency_commission_pct: null }], "solo su tienda y sin comisión (PERMISSIONS de campo)");
    assert.deepEqual(await tool(key, sid, "query", { query: "SELECT * FROM crm_company:b1" }), [], "ni por id directo");

    assert.match(String(await tool(key, sid, "create", { target: "crm_company", data: { name: "x" } })), /solo lectura/);
    await tool(key, sid, "query", { query: "UPDATE crm_company:a1 SET name = 'pwned'; DELETE crm_company:a1;" });
    const [a1] = await q<Array<{ name: string }>>(`SELECT name FROM crm_company:a1`);
    assert.equal(a1.name, "Cliente A", "la BD tampoco deja escribir");
  });

  it("el agente de B ve lo de B, no lo de A", async () => {
    const { key } = await agent.createAgentToken("ub", "agente B");
    const sid = await open(key);
    assert.deepEqual(await tool(key, sid, "query", { query: "SELECT name FROM crm_company" }), [{ name: "Cliente B secreto" }]);
  });

  it("la sesión MCP sobrevive a un JWT nuevo del mismo usuario (el JWT dura 10 min)", async () => {
    const { key } = await agent.createAgentToken("ua", "renueva");
    const sid = await open(key);
    agent.resetAgentJwtCache();
    await new Promise((r) => setTimeout(r, 1100)); // otro `iat` → otro JWT
    assert.deepEqual(await tool(key, sid, "query", { query: "SELECT name FROM crm_company" }), [{ name: "Cliente A" }]);
  });

  it("revocar corta al agente al instante, aun con JWT en caché", async () => {
    const { id, key } = await agent.createAgentToken("ua", "se revoca");
    const sid = await open(key);
    assert.equal(((await tool(key, sid, "query", { query: "SELECT name FROM crm_company" })) as unknown[]).length, 1);
    await agent.revokeAgentToken("ua", id);
    assert.equal((await call(key, { jsonrpc: "2.0", id: 5, method: "tools/list" }, sid)).status, 401);
  });

  it("una clave vencida no sirve", async () => {
    // expires_at es READONLY: se simula con una clave creada ya vencida desde root.
    const { createHash } = await import("node:crypto");
    const old = "dooh_agent_" + "y".repeat(43);
    await q(`CREATE agent_token SET user = user:ua, label = 'vieja', key_hash = '${createHash("sha256").update(old).digest("hex")}', hint = 'yyyy', expires_at = time::now() - 1m`);
    assert.equal((await call(old, { jsonrpc: "2.0", id: 1, method: "initialize" })).status, 401);
  });
});
