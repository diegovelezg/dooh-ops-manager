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
    assert.equal(list[0].expires_at, null, "las claves no caducan");
    assert.equal(list[0].last_used_at, null, "sin uso: null, no la cadena 'NONE'");
    assert.equal(JSON.stringify(list).includes(key), false, "la clave completa no se guarda ni se lista");
    assert.deepEqual(await agent.listAgentTokens("ub"), [], "cada usuario ve solo las suyas");
    await assert.rejects(() => agent.createAgentToken("ua", "  "), /Nombre inválido/);
    await agent.revokeAgentToken("ua", id);
  });
  it("el límite de 10 accesos activos se cumple de verdad", async () => {
    const made: string[] = [];
    for (let i = 0; i < 10; i++) made.push((await agent.createAgentToken("ub", `l${i}`)).id);
    await assert.rejects(() => agent.createAgentToken("ub", "once"), /Máximo 10/);
    assert.equal((await agent.listAgentTokens("ub")).length, 10);
    for (const id of made) await agent.revokeAgentToken("ub", id);
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
    assert.deepEqual((list.json.result.tools as Array<{ name: string }>).map((x) => x.name).sort(), ["query", "select"]);

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

  it("GET y DELETE → 405: otro usuario no puede cerrar ni escuchar la sesión ajena", async () => {
    const a = (await agent.createAgentToken("ua", "sesión A")).key;
    const b = (await agent.createAgentToken("ub", "intruso B")).key;
    const sid = await open(a);
    const del = await route.DELETE(new Request("http://app/mcp", { method: "DELETE", headers: { authorization: `Bearer ${b}`, "mcp-session-id": sid ?? "" } }));
    assert.equal(del.status, 405);
    assert.equal(del.headers.get("allow"), "POST");
    const get = await route.GET(new Request("http://app/mcp", { method: "GET", headers: { authorization: `Bearer ${b}`, accept: "text/event-stream", "mcp-session-id": sid ?? "" } }));
    assert.equal(get.status, 405);
    assert.deepEqual(await tool(a, sid, "query", { query: "SELECT name FROM crm_company" }), [{ name: "Cliente A" }], "la sesión de A sigue viva");
  });
  it("una sesión solo la usa la credencial que la abrió: el POST de otra se corta en el proxy (404), sin llegar a Surreal", async () => {
    const a = (await agent.createAgentToken("ua", "dueño")).key;
    const b = (await agent.createAgentToken("ub", "intruso")).key;
    const sid = await open(a);
    // mismo id JSON-RPC que usa A: el transporte registraría el canal de respuesta por ese id si la petición llegara
    for (const body of [
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "query", arguments: { query: "SELECT 1" } } },
      { jsonrpc: "2.0", id: 9, method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]) {
      const r = await call(b, body, sid);
      assert.equal(r.status, 404, JSON.stringify(body));
    }
    assert.equal((await call(b, { jsonrpc: "2.0", id: 9, method: "tools/list" }, "sesion-inventada")).status, 404);
    assert.deepEqual(await tool(a, sid, "query", { query: "SELECT name FROM crm_company" }), [{ name: "Cliente A" }], "la sesión de A sigue viva");
    // el intruso abre la suya y funciona; initialize con un id ajeno en la cabecera no la hereda
    const sidB = await open(b);
    assert.notEqual(sidB, sid);
    const ini = await call(b, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }, sid);
    assert.equal(ini.status, 200);
    assert.notEqual(ini.sid, sid, "no reutiliza la sesión ajena");
  });
  it("con otro JWT del mismo token la sesión sigue siendo suya", async () => {
    const a = (await agent.createAgentToken("ua", "mismo token")).key;
    const sid = await open(a);
    agent.resetAgentJwtCache();
    await new Promise((r) => setTimeout(r, 1100));
    assert.deepEqual(await tool(a, sid, "query", { query: "SELECT name FROM crm_company" }), [{ name: "Cliente A" }]);
  });
  it("producción: autodetecta https del proxy; falla si el proxy declara http o si PUBLIC_APP_URL es inválida (también sin Origin)", async () => {
    const { key } = await agent.createAgentToken("ua", "config");
    const hit = (extra: Record<string, string> = {}) =>
      route.POST(new Request("http://app.example.com/mcp", { method: "POST", headers: { host: "app.example.com", authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) }));
    const prev = { env: process.env.NODE_ENV, url: process.env.PUBLIC_APP_URL };
    try {
      (process.env as Record<string, string>).NODE_ENV = "production";
      delete process.env.PUBLIC_APP_URL;
      assert.equal((await hit({ "x-forwarded-proto": "https" })).status, 200, "autodetección con https");
      assert.equal((await hit({ "x-forwarded-proto": "http" })).status, 500, "el proxy declara http");
      assert.equal((await hit()).status, 500, "sin proxy: http");
      process.env.PUBLIC_APP_URL = "https://app.example.com/mcp";
      assert.equal((await hit({ "x-forwarded-proto": "https" })).status, 500, "valor explícito inválido: no se ignora");
      process.env.PUBLIC_APP_URL = "https://app.example.com";
      assert.equal((await hit()).status, 200, "valor explícito válido");
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev.env ?? "test";
      if (prev.url === undefined) delete process.env.PUBLIC_APP_URL;
      else process.env.PUBLIC_APP_URL = prev.url;
    }
  });
  it("Origin ajeno → 403 (Streamable HTTP); sin Origin (clientes de servidor) pasa", async () => {
    const { key } = await agent.createAgentToken("ua", "origen");
    const hit = (origin?: string) =>
      route.POST(new Request("http://app.example.com/mcp", { method: "POST", headers: { host: "app.example.com", "x-forwarded-proto": "http", authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(origin ? { origin } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) }));
    assert.equal((await hit("https://evil.example")).status, 403);
    assert.equal((await hit()).status, 200);
    assert.equal((await hit("http://app.example.com")).status, 200, "mismo origen");
  });
  it("initialize solo anuncia tools; resources, prompts y cambios de base se rechazan", async () => {
    const { key } = await agent.createAgentToken("ua", "métodos");
    const ini = await call(key, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    assert.deepEqual(ini.json.result.capabilities, { tools: {} });
    const sid = ini.sid ?? undefined;
    await call(key, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
    for (const method of ["resources/read", "prompts/list", "resources/list"]) {
      const r = await call(key, { jsonrpc: "2.0", id: 5, method, params: { uri: "surrealdb://instructions" } }, sid);
      assert.equal(r.json.error.code, -32601, method);
    }
    assert.match(String(await tool(key, sid, "query", { query: "SELECT 1", database: "otra" })), /namespace o base de datos/);
  });
  it("revocar corta al agente al instante, aun con JWT en caché", async () => {
    const { id, key } = await agent.createAgentToken("ua", "se revoca");
    const sid = await open(key);
    assert.equal(((await tool(key, sid, "query", { query: "SELECT name FROM crm_company" })) as unknown[]).length, 1);
    await agent.revokeAgentToken("ua", id);
    assert.equal((await call(key, { jsonrpc: "2.0", id: 5, method: "tools/list" }, sid)).status, 401);
  });

  it("una clave sin vencimiento sirve (no caduca)", async () => {
    const { key } = await agent.createAgentToken("ua", "eterna");
    assert.equal((await call(key, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } })).status, 200);
  });

  it("una clave con vencimiento antiguo ya pasado no sirve", async () => {
    // Claves anteriores a la 0019 pueden tener expires_at: se respeta.
    const { createHash } = await import("node:crypto");
    const old = "dooh_agent_" + "y".repeat(43);
    await q(`CREATE agent_token SET user = user:ua, label = 'vieja', key_hash = '${createHash("sha256").update(old).digest("hex")}', hint = 'yyyy', expires_at = time::now() - 1m`);
    assert.equal((await call(old, { jsonrpc: "2.0", id: 1, method: "initialize" })).status, 401);
  });
});
