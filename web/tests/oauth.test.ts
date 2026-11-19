// OAuth del MCP de agentes sobre SurrealDB real (base efímera): registro dinámico, PKCE, códigos de un solo
// uso, token que no caduca, revocación y los ataques típicos (redirect abierto, reutilización de código…).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createTestDb, pointAppAt, type TestDb } from "./helpers/surreal-test-db";

let t: TestDb;
let oauth: typeof import("../lib/oauth");
let agent: typeof import("../lib/agent-tokens");
const routes: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORIGIN = "https://app.example.com";
const CB = "https://agent.example.com/callback";

const q = async <T = unknown>(sql: string): Promise<T> => {
  const res = await t.root.query(sql).collect();
  return res[res.length - 1] as T;
};
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
let ipN = 0;
const post = async (route: { POST: (r: Request) => Promise<Response> }, body: unknown, form = false) => {
  const res = await route.POST(
    new Request(`${ORIGIN}/x`, {
      method: "POST",
      headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", "x-forwarded-for": `10.0.0.${++ipN}` },
      body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const register = async (uris: unknown = [CB], extra: object = {}) => post(routes.register, { client_name: "Agente X", redirect_uris: uris, ...extra });
const authorize = (clientId: string, challenge: string, over: Record<string, string> = {}) => {
  const p = new URLSearchParams({ client_id: clientId, redirect_uri: CB, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "xyz", ...over });
  return oauth.checkAuthorizeRequest((k) => p.get(k), ORIGIN);
};
/** Flujo completo: registro → autorización (usuario `userId`) → código. */
const getCode = async (userId = "ua", clientId?: string) => {
  const id = clientId ?? (await register()).json.client_id;
  const { verifier, challenge } = pkce();
  const check = await authorize(id, challenge);
  assert.ok(check.ok);
  const code = await oauth.createAuthCode(userId, (check as { ok: true; params: Parameters<typeof oauth.createAuthCode>[1] }).params, ORIGIN);
  return { id, code, verifier };
};
/** Deja al usuario sin accesos activos (los tests comparten BD: el límite de 10 depende del estado previo). */
const resetTokens = async (user: string) => {
  for (const x of await agent.listAgentTokens(user)) await agent.revokeAgentToken(user, x.id);
};
const tokenReq = (b: Record<string, string>) => post(routes.token, { grant_type: "authorization_code", redirect_uri: CB, ...b }, true);

before(async () => {
  t = await createTestDb();
  pointAppAt(t);
  oauth = await import("../lib/oauth");
  agent = await import("../lib/agent-tokens");
  routes.register = await import("../app/oauth/register/route");
  routes.token = await import("../app/oauth/token/route");
  routes.mcp = await import("../app/mcp/route");
  routes.prm = await import("../app/.well-known/oauth-protected-resource/route");
  routes.asm = await import("../app/.well-known/oauth-authorization-server/route");
  await q(`
    CREATE sys_store:a SET name = 'A'; CREATE sys_store:b SET name = 'B';
    CREATE user:ua SET email = 'ua@t.dev', password = crypto::bcrypt::generate('pass-ua-12');
    CREATE user:ub SET email = 'ub@t.dev', password = crypto::bcrypt::generate('pass-ub-12');
    RELATE user:ua->member_of->sys_store:a SET role = 'viewer';
    RELATE user:ub->member_of->sys_store:b SET role = 'owner';
    CREATE crm_company:a1 SET store = sys_store:a, name = 'Cliente A', kind = 'agencia';
    CREATE crm_company:b1 SET store = sys_store:b, name = 'Cliente B secreto';`);
});
after(async () => {
  await (await import("../lib/surreal")).closeDb();
  await t?.drop();
});

describe("metadatos", () => {
  it("recurso protegido y servidor de autorización apuntan a este origen (PKCE S256, cliente público, DCR)", async () => {
    const h = { headers: { host: "app.example.com", "x-forwarded-proto": "https" } };
    const prm = await (await routes.prm.GET(new Request("http://localhost/x", h))).json();
    assert.equal(prm.resource, `${ORIGIN}/mcp`);
    assert.deepEqual(prm.authorization_servers, [ORIGIN]);
    const asm = await (await routes.asm.GET(new Request("http://localhost/x", h))).json();
    assert.equal(asm.issuer, ORIGIN);
    assert.equal(asm.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
    assert.equal(asm.token_endpoint, `${ORIGIN}/oauth/token`);
    assert.equal(asm.registration_endpoint, `${ORIGIN}/oauth/register`);
    assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(asm.token_endpoint_auth_methods_supported, ["none"]);
  });
  it("el 401 de /mcp anuncia dónde empezar el flujo OAuth", async () => {
    const res = await routes.mcp.POST(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { host: "app.example.com", "x-forwarded-proto": "https", "content-type": "application/json" }, body: "{}" }));
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/app\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
  });
});

describe("origen público", () => {
  it("PUBLIC_APP_URL se valida como origen canónico: https, sin ruta, query ni credenciales", () => {
    const prev = { env: process.env.NODE_ENV, url: process.env.PUBLIC_APP_URL };
    const h = new Headers();
    try {
      (process.env as Record<string, string>).NODE_ENV = "production";
      for (const bad of ["http://app.example.com", "https://app.example.com/mcp", "https://app.example.com/app", "https://app.example.com?x=1", "https://u:p@app.example.com", "app.example.com", "ftp://app.example.com", "http://localhost:3000", "https://app.example.com#x"]) {
        process.env.PUBLIC_APP_URL = bad;
        assert.throws(() => oauth.publicOrigin(h), /PUBLIC_APP_URL/, bad);
      }
      process.env.PUBLIC_APP_URL = "https://app.example.com/";
      assert.equal(oauth.publicOrigin(h), "https://app.example.com", "la barra final se normaliza");
      process.env.PUBLIC_APP_URL = "https://app.example.com:8443";
      assert.equal(oauth.publicOrigin(h), "https://app.example.com:8443");
      (process.env as Record<string, string>).NODE_ENV = "development";
      process.env.PUBLIC_APP_URL = "http://localhost:3000";
      assert.equal(oauth.publicOrigin(h), "http://localhost:3000", "http en loopback fuera de producción");
      process.env.PUBLIC_APP_URL = "http://app.example.com";
      assert.throws(() => oauth.publicOrigin(h), /https/, "http no loopback nunca");
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev.env ?? "test";
      if (prev.url === undefined) delete process.env.PUBLIC_APP_URL;
      else process.env.PUBLIC_APP_URL = prev.url;
    }
  });
  it("sin PUBLIC_APP_URL se autodetecta de las cabeceras del proxy; en producción solo https y host válido", () => {
    const prev = { env: process.env.NODE_ENV, url: process.env.PUBLIC_APP_URL };
    const h = (o: Record<string, string>) => new Headers(o);
    try {
      delete process.env.PUBLIC_APP_URL;
      (process.env as Record<string, string>).NODE_ENV = "production";
      assert.equal(oauth.publicOrigin(h({ host: "interno:3000", "x-forwarded-host": "App.Example.com", "x-forwarded-proto": "https" })), "https://app.example.com");
      assert.equal(oauth.publicOrigin(h({ host: "app.example.com:8443", "x-forwarded-proto": "https" })), "https://app.example.com:8443");
      assert.equal(oauth.publicOrigin(h({ "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https,http" })), "https://app.example.com", "toma el primero de la lista");
      assert.throws(() => oauth.publicOrigin(h({ host: "app.example.com", "x-forwarded-proto": "http" })), /https/, "proxy declara http");
      assert.throws(() => oauth.publicOrigin(h({ host: "app.example.com" }), "http://app.example.com/x"), /https/, "sin proxy y sin https");
      for (const bad of ["evil.com/path", "evil.com?x=1", "a b.com", "evil.com@x.com", "https://evil.com", "-evil.com", "evil.com:99999999"]) {
        assert.throws(() => oauth.publicOrigin(h({ "x-forwarded-host": bad, "x-forwarded-proto": "https" })), /Host inválido/, bad);
      }
      assert.throws(() => oauth.publicOrigin(h({})), /No se pudo detectar/);
      (process.env as Record<string, string>).NODE_ENV = "development";
      assert.equal(oauth.publicOrigin(h({ host: "localhost:3000" }), "http://localhost:3000/x"), "http://localhost:3000", "desarrollo: http permitido");
      assert.equal(oauth.publicOrigin(h({ host: "evil.example", "x-forwarded-proto": "https" })), "https://evil.example");
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev.env ?? "test";
      if (prev.url === undefined) delete process.env.PUBLIC_APP_URL;
      else process.env.PUBLIC_APP_URL = prev.url;
    }
  });
  it("PUBLIC_APP_URL, si existe, manda sobre las cabeceras", () => {
    const prev = process.env.PUBLIC_APP_URL;
    try {
      process.env.PUBLIC_APP_URL = "https://fijo.example.com";
      assert.equal(oauth.publicOrigin(new Headers({ host: "otro.example", "x-forwarded-proto": "https" })), "https://fijo.example.com");
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_APP_URL;
      else process.env.PUBLIC_APP_URL = prev;
    }
  });
});

describe("registro dinámico de clientes", () => {
  it("registra un cliente público", async () => {
    const r = await register(["https://agent.example.com/cb", "http://localhost:8123/cb", "http://127.0.0.1:9/cb"]);
    assert.equal(r.status, 201);
    assert.match(r.json.client_id, /^[a-f0-9]{32}$/);
    assert.equal(r.json.token_endpoint_auth_method, "none");
  });
  it("rechaza redirect_uris peligrosos o mal formados", async () => {
    for (const bad of [["http://evil.com/cb"], ["javascript:alert(1)"], ["https://a.com/cb#frag"], ["https://u:p@a.com/cb"], [], "https://a.com", ["data:text/html,x"], ["ftp://a.com/x"], Array(6).fill("https://a.com/cb")]) {
      const r = await register(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match(r.json.error, /invalid_(redirect_uri|client_metadata)/);
    }
  });
  it("rechaza clientes confidenciales (solo públicos con PKCE)", async () => {
    assert.equal((await register([CB], { token_endpoint_auth_method: "client_secret_basic" })).status, 400);
  });
});

describe("/oauth/authorize: validación", () => {
  it("cliente desconocido o redirect_uri no registrado → error en pantalla, NUNCA redirige (anti redirect abierto)", async () => {
    const { id } = await getCode();
    const { challenge } = pkce();
    for (const over of [{ redirect_uri: "https://evil.com/steal" }, { redirect_uri: `${CB}/x` }, { redirect_uri: `${CB}?x=1` }, { redirect_uri: "" }]) {
      const c = await authorize(id, challenge, over);
      assert.equal(c.ok, false);
      assert.equal((c as { kind: string }).kind, "page", JSON.stringify(over));
    }
    assert.equal(((await authorize("0".repeat(32), challenge)) as { kind: string }).kind, "page");
    assert.equal(((await authorize("no-es-un-id", challenge)) as { kind: string }).kind, "page");
  });
  it("sin PKCE S256, response_type ≠ code o resource ajeno → error por redirect_uri validado", async () => {
    const { id } = await getCode();
    const { challenge } = pkce();
    const cases: Array<[Record<string, string>, string]> = [
      [{ code_challenge: "" }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: "corto" }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: "https://otro.example.com/mcp" }, "invalid_target"],
      [{ resource: ORIGIN }, "invalid_target"], // solo la URL canónica del MCP, no el origen a secas
    ];
    for (const [over, error] of cases) {
      const c = (await authorize(id, challenge, over)) as { ok: boolean; kind?: string; error?: string; redirectUri?: string; state?: string };
      assert.equal(c.ok, false, JSON.stringify(over));
      assert.equal(c.kind, "redirect");
      assert.equal(c.error, error);
      assert.equal(c.redirectUri, CB);
      assert.equal(c.state, "xyz");
    }
    assert.equal((await authorize(id, challenge, { resource: `${ORIGIN}/mcp` })).ok, true);
  });
  it("la query viaja en un solo parámetro base64url (el next del login rechaza %2F)", () => {
    const qs = `client_id=a&redirect_uri=${encodeURIComponent(CB)}&state=a/b`;
    const enc = oauth.encodeAuthorizeQuery(qs);
    assert.match(enc, /^[A-Za-z0-9_-]+$/);
    assert.equal(oauth.decodeAuthorizeQuery(enc).toString(), new URLSearchParams(qs).toString());
  });
  it("clientRedirect añade code/state/iss y conserva los parámetros existentes", () => {
    const u = new URL(oauth.clientRedirect("https://a.com/cb?x=1", "st", ORIGIN, { code: "c" }));
    assert.equal(u.searchParams.get("x"), "1");
    assert.equal(u.searchParams.get("code"), "c");
    assert.equal(u.searchParams.get("state"), "st");
    assert.equal(u.searchParams.get("iss"), ORIGIN);
  });
});

describe("/oauth/token y el MCP con el token emitido", () => {
  const initBody = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
  const mcp = async (token: string, body: unknown, sid?: string) => {
    const res = await routes.mcp.POST(
      new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) }),
    );
    const text: string = await res.text();
    const d = text.split("\n").find((l: string) => l.startsWith("data: {"));
    return { status: res.status, sid: res.headers.get("mcp-session-id"), json: d ? JSON.parse(d.slice(6)) : null };
  };
  const rows = async (token: string, query: string) => {
    const i = await mcp(token, initBody);
    await mcp(token, { jsonrpc: "2.0", method: "notifications/initialized" }, i.sid ?? undefined);
    const r = await mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "query", arguments: { query } } }, i.sid ?? undefined);
    return { status: r.status, value: r.json?.result?.structuredContent?.value };
  };

  it("flujo completo: código + PKCE → token que no caduca → el agente ve solo lo del usuario", async () => {
    const { id, code, verifier } = await getCode("ua");
    const r = await tokenReq({ code, client_id: id, code_verifier: verifier });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.token_type, "Bearer");
    assert.equal("expires_in" in r.json, false, "no caduca");
    assert.ok(agent.isAgentKey(r.json.access_token));

    const out = await rows(r.json.access_token, "SELECT name FROM crm_company");
    assert.deepEqual(out.value, [{ name: "Cliente A" }], "solo la tienda del usuario");
    const list = await agent.listAgentTokens("ua");
    assert.ok(list.some((x) => x.label === "Agente X"), "aparece en Ajustes con el nombre del cliente");
    assert.equal(list.find((x) => x.label === "Agente X")!.expires_at, null);
  });
  it("initialize entrega al agente SUS instrucciones (guía de datos), no las de Surreal", async () => {
    const { id, code, verifier } = await getCode("ub");
    const r = await tokenReq({ code, client_id: id, code_verifier: verifier });
    const i = await mcp(r.json.access_token, initBody);
    const ins = i.json.result.instructions as string;
    assert.match(ins, /solo lectura/i);
    assert.match(ins, /crm_company/);
    assert.match(ins, /io_order/);
    assert.doesNotMatch(ins, /\*\*(create|delete|run|upsert|relate)\*\*/, "no anuncia herramientas ocultas");
  });
  it("PKCE: verifier incorrecto, corto o ausente → invalid_grant / invalid_request", async () => {
    const { id, code, verifier } = await getCode();
    const wrong = randomBytes(32).toString("base64url");
    assert.equal((await tokenReq({ code, client_id: id, code_verifier: wrong })).json.error, "invalid_grant");
    assert.equal((await tokenReq({ code, client_id: id, code_verifier: "corto" })).json.error, "invalid_grant");
    assert.equal((await tokenReq({ code, client_id: id })).json.error, "invalid_grant");
    // intentos fallidos no queman el código: el legítimo aún puede canjearlo
    assert.equal((await tokenReq({ code, client_id: id, code_verifier: verifier })).status, 200);
  });
  it("el código solo sirve una vez; reutilizarlo revoca el token emitido", async () => {
    const { id, code, verifier } = await getCode("ua");
    const ok = await tokenReq({ code, client_id: id, code_verifier: verifier });
    assert.equal(ok.status, 200);
    assert.equal((await rows(ok.json.access_token, "SELECT name FROM crm_company")).status, 200);
    const again = await tokenReq({ code, client_id: id, code_verifier: verifier });
    assert.equal(again.status, 400);
    assert.equal(again.json.error, "invalid_grant");
    assert.equal((await rows(ok.json.access_token, "SELECT name FROM crm_company")).status, 401, "token revocado");
  });
  it("el código está ligado a su cliente, su redirect_uri y no vence antes de tiempo", async () => {
    const a = await getCode();
    const other = (await register()).json.client_id as string;
    assert.equal((await tokenReq({ code: a.code, client_id: other, code_verifier: a.verifier })).json.error, "invalid_grant");
    assert.equal((await tokenReq({ code: a.code, client_id: a.id, code_verifier: a.verifier, redirect_uri: "https://evil.com/cb" })).json.error, "invalid_grant");
    assert.equal((await tokenReq({ code: "no-existe", client_id: a.id, code_verifier: a.verifier })).json.error, "invalid_grant");
  });
  it("un código vencido no sirve", async () => {
    const { id, verifier } = await getCode();
    // expires_at es READONLY: se simula creando uno ya vencido desde root.
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const old = randomBytes(32).toString("base64url");
    await q(`CREATE oauth_code SET code_hash = '${createHash("sha256").update(old).digest("hex")}', client = oauth_client:${id}, user = user:ua, redirect_uri = '${CB}', code_challenge = '${challenge}', expires_at = time::now() - 1m`);
    assert.equal((await tokenReq({ code: old, client_id: id, code_verifier: verifier })).json.error, "invalid_grant");
  });
  it("grant_type distinto de authorization_code → unsupported_grant_type", async () => {
    const r = await post(routes.token, { grant_type: "client_credentials", client_id: "x" }, true);
    assert.equal(r.json.error, "unsupported_grant_type");
  });
  it("autorizar de nuevo al mismo cliente reemplaza el token anterior (no se acumulan)", async () => {
    const { id } = await getCode("ua");
    const first = await (async () => { const g = await getCode("ua", id); return tokenReq({ code: g.code, client_id: id, code_verifier: g.verifier }); })();
    const second = await (async () => { const g = await getCode("ua", id); return tokenReq({ code: g.code, client_id: id, code_verifier: g.verifier }); })();
    assert.equal((await rows(first.json.access_token, "SELECT name FROM crm_company")).status, 401, "el anterior queda revocado");
    assert.equal((await rows(second.json.access_token, "SELECT name FROM crm_company")).status, 200);
  });
  it("revocar el acceso desde Ajustes corta al agente al instante", async () => {
    const { id, code, verifier } = await getCode("ub");
    const r = await tokenReq({ code, client_id: id, code_verifier: verifier });
    assert.equal((await rows(r.json.access_token, "SELECT name FROM crm_company")).status, 200);
    const mine = (await agent.listAgentTokens("ub")).find((x) => x.hint === r.json.access_token.slice(-4))!;
    assert.equal(await agent.revokeAgentToken("ub", mine.id), true);
    assert.equal((await rows(r.json.access_token, "SELECT name FROM crm_company")).status, 401);
  });
  it("resource: el canje exige la misma audiencia concedida en la autorización (invalid_target)", async () => {
    const a = await getCode();
    assert.equal((await tokenReq({ code: a.code, client_id: a.id, code_verifier: a.verifier, resource: "https://otro.example.com/mcp" })).json.error, "invalid_target");
    assert.equal((await tokenReq({ code: a.code, client_id: a.id, code_verifier: a.verifier, resource: `${ORIGIN}/mcp` })).status, 200, "el código no se quemó con el intento erróneo");
  });
  it("un código viejo ya usado NO revoca la autorización nueva sin aportar el verificador (RFC 9700 §4.5)", async () => {
    const { id } = await getCode("ua"); // registra el cliente
    const first = await getCode("ua", id);
    const t1 = await tokenReq({ code: first.code, client_id: id, code_verifier: first.verifier });
    const second = await getCode("ua", id);
    const t2 = await tokenReq({ code: second.code, client_id: id, code_verifier: second.verifier });
    assert.equal((await rows(t2.json.access_token, "SELECT name FROM crm_company")).status, 200);
    // repetición del código viejo sin verificador / con verificador ajeno: no toca el token vigente
    assert.equal((await tokenReq({ code: first.code, client_id: id })).json.error, "invalid_grant");
    assert.equal((await tokenReq({ code: first.code, client_id: id, code_verifier: second.verifier })).json.error, "invalid_grant");
    assert.equal((await rows(t2.json.access_token, "SELECT name FROM crm_company")).status, 200, "el token vigente sigue vivo");
    // repetición legítima del código viejo: revoca solo lo que ese código emitió (t1, ya reemplazado), no t2
    assert.equal((await tokenReq({ code: first.code, client_id: id, code_verifier: first.verifier })).json.error, "invalid_grant");
    assert.equal((await rows(t2.json.access_token, "SELECT name FROM crm_company")).status, 200);
    assert.equal((await rows(t1.json.access_token, "SELECT name FROM crm_company")).status, 401);
  });
  it("límite de 10 accesos: no se quema el código al fallar y se puede reintentar tras revocar", async () => {
    await resetTokens("ub");
    for (let i = 0; i < 10; i++) await agent.createAgentToken("ub", `lleno ${i}`);
    const g = await getCode("ub");
    const full = await tokenReq({ code: g.code, client_id: g.id, code_verifier: g.verifier });
    assert.equal(full.status, 400);
    assert.equal(full.json.error, "invalid_request");
    const [mine] = await agent.listAgentTokens("ub");
    await agent.revokeAgentToken("ub", mine.id);
    assert.equal((await tokenReq({ code: g.code, client_id: g.id, code_verifier: g.verifier })).status, 200, "el código sigue disponible");
    for (const x of await agent.listAgentTokens("ub")) await agent.revokeAgentToken("ub", x.id);
  });
  it("concurrencia: con 9 accesos activos, dos autorizaciones simultáneas emiten como mucho una (límite 10)", async () => {
    await resetTokens("ua");
    for (let i = 0; i < 9; i++) await agent.createAgentToken("ua", `base ${i}`);
    const before = (await agent.listAgentTokens("ua")).length;
    const [a, b] = await Promise.all([getCode("ua"), getCode("ua")]);
    const res = await Promise.all([
      tokenReq({ code: a.code, client_id: a.id, code_verifier: a.verifier }),
      tokenReq({ code: b.code, client_id: b.id, code_verifier: b.verifier }),
    ]);
    const ok = res.filter((r) => r.status === 200).length;
    const after = (await agent.listAgentTokens("ua")).length;
    assert.equal(before, 9);
    assert.ok(after <= 10, `activos: ${after}`);
    assert.equal(ok, 1, "exactamente una de las dos cabe");
    assert.equal(after, 10);
    for (const x of await agent.listAgentTokens("ua")) await agent.revokeAgentToken("ua", x.id);
  });
  it("dos canjes simultáneos del MISMO código: solo uno emite token", async () => {
    await resetTokens("ub");
    const g = await getCode("ub");
    const res = await Promise.all([1, 2, 3].map(() => tokenReq({ code: g.code, client_id: g.id, code_verifier: g.verifier })));
    assert.equal(res.filter((r) => r.status === 200).length, 1);
    // Los perdedores también repiten un código ya consumido (con su verificador): igual que una repetición secuencial,
    // el token que ese código emitió debe quedar revocado, no vigente.
    assert.equal((await agent.listAgentTokens("ub")).length, 0, "ningún token vigente tras el canje repetido");
    for (const x of await agent.listAgentTokens("ub")) await agent.revokeAgentToken("ub", x.id);
  });
  it("las tablas OAuth no son legibles con un token de usuario", async () => {
    const tok = (await t.signin("ua@t.dev", "pass-ua-12")).access;
    for (const table of ["oauth_client", "oauth_code", "agent_token"]) {
      const res = await t.root.query(`SELECT * FROM ${table}`).as(tok).collect();
      assert.deepEqual(res[0], [], table);
    }
  });
});
