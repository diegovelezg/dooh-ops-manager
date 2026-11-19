import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_METHODS, READ_ONLY_TOOLS, bearerKey, filterToolsList, shapeInitialize, inspectRequest } from "../lib/mcp-proxy";

const tools = ["query", "select", "create", "insert", "upsert", "update", "delete", "relate", "run", "list", "use", "info", "gql", "graphql"].map((name) => ({ name }));

describe("mcp-proxy: inspectRequest", () => {
  it("deja pasar tools/call de lectura", () => {
    for (const name of READ_ONLY_TOOLS) {
      const r = inspectRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }));
      assert.equal(r.kind, "forward");
    }
  });
  it("rechaza herramientas de escritura con un resultado de error legible (id conservado)", () => {
    for (const name of ["create", "insert", "upsert", "update", "delete", "relate", "run", "gql", "graphql", "nope"]) {
      const r = inspectRequest(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name } }));
      assert.equal(r.kind, "reject", name);
      if (r.kind !== "reject") continue;
      const p = r.payload as { id: number; result: { isError: boolean; content: Array<{ text: string }> } };
      assert.equal(p.id, 7);
      assert.equal(p.result.isError, true);
      assert.match(p.result.content[0].text, /solo lectura/);
    }
  });
  it("lista cerrada de métodos: resources/prompts/completion no se reenvían (error con id, o 202 si es notificación)", () => {
    for (const method of ["resources/read", "resources/list", "prompts/list", "prompts/get", "completion/complete", "logging/setLevel", "tools/call2"]) {
      const r = inspectRequest(JSON.stringify({ jsonrpc: "2.0", id: 4, method }));
      assert.equal(r.kind, "reject", method);
      if (r.kind === "reject") assert.equal((r.payload as { error: { code: number } }).error.code, -32601);
    }
    for (const m of ["notifications/roots/list_changed", "notifications/cancelled"]) {
      assert.deepEqual(inspectRequest(JSON.stringify({ jsonrpc: "2.0", method: m })), { kind: "reject", status: 202, payload: null }, m);
    }
    assert.equal(inspectRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })).kind, "reject", "respuestas del cliente no se reenvían");
    for (const m of ALLOWED_METHODS) assert.equal(inspectRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: { name: "query" } })).kind, "forward", m);
  });
  it("tools/call no puede cambiar de namespace o base de datos", () => {
    for (const arguments_ of [{ query: "x", database: "otra" }, { query: "x", namespace: "otro" }, { target: "t", database: null }]) {
      const r = inspectRequest(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "query", arguments: arguments_ } }));
      assert.equal(r.kind, "reject", JSON.stringify(arguments_));
      if (r.kind === "reject") assert.match(JSON.stringify(r.payload), /namespace o base de datos/);
    }
  });
  it("rechaza JSON inválido y lotes; reenvía el resto de métodos", () => {
    assert.equal(inspectRequest("{no").kind, "reject");
    assert.equal(inspectRequest("[]").kind, "reject");
    const ini = inspectRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    assert.deepEqual(ini, { kind: "forward", method: "initialize" });
  });
});

describe("mcp-proxy: filterToolsList", () => {
  const msg = { jsonrpc: "2.0", id: 3, result: { tools } };
  const names = (text: string) => {
    const j = JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: {"))!.slice(6));
    return (j.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
  };
  it("filtra JSON plano", () => {
    assert.deepEqual(names(filterToolsList(JSON.stringify(msg))), ["query", "select"]);
  });
  it("filtra SSE conservando el resto de líneas", () => {
    const sse = `data: \nid: 0\nretry: 3000\n\ndata: ${JSON.stringify(msg)}\nid: 1/1\n\n`;
    const out = filterToolsList(sse);
    assert.deepEqual(names(out), ["query", "select"]);
    assert.match(out, /retry: 3000/);
    assert.match(out, /id: 1\/1/);
  });
  it("no toca otras respuestas", () => {
    const other = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } });
    assert.equal(filterToolsList(other), other);
  });
});

describe("mcp-proxy: bearerKey", () => {
  it("extrae la clave", () => {
    assert.equal(bearerKey("Bearer abc"), "abc");
    assert.equal(bearerKey("bearer abc"), "abc");
    assert.equal(bearerKey("Basic abc"), null);
    assert.equal(bearerKey(null), null);
  });
});

describe("mcp-proxy: shapeInitialize", () => {
  const init = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: "surrealdb" } } };
  it("añade instructions y reduce capabilities a tools (JSON y SSE)", () => {
    const j = JSON.parse(shapeInitialize(JSON.stringify({ ...init, result: { ...init.result, capabilities: { tools: {}, resources: {}, prompts: {}, completions: {} } } }), "GUIA"));
    assert.equal(j.result.instructions, "GUIA");
    assert.deepEqual(j.result.capabilities, { tools: {} });
    const sse = shapeInitialize(`data: \nid: 0\n\ndata: ${JSON.stringify(init)}\nid: 1\n\n`, "GUIA");
    assert.match(sse, /"instructions":"GUIA"/);
    assert.match(sse, /id: 1/);
  });
  it("reemplaza las instrucciones del servidor (anuncian herramientas ocultas) y no toca otras respuestas", () => {
    const prev = { ...init, result: { ...init.result, instructions: "Tools: create, delete, run" } };
    assert.equal(JSON.parse(shapeInitialize(JSON.stringify(prev), "GUIA")).result.instructions, "GUIA");
    const other = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    assert.equal(shapeInitialize(other, "GUIA"), other);
  });
});
