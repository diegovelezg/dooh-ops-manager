import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { READ_ONLY_TOOLS, bearerKey, filterToolsList, inspectRequest } from "../lib/mcp-proxy";

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
    assert.deepEqual(names(filterToolsList(JSON.stringify(msg))), ["info", "list", "query", "select"]);
  });
  it("filtra SSE conservando el resto de líneas", () => {
    const sse = `data: \nid: 0\nretry: 3000\n\ndata: ${JSON.stringify(msg)}\nid: 1/1\n\n`;
    const out = filterToolsList(sse);
    assert.deepEqual(names(out), ["info", "list", "query", "select"]);
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
