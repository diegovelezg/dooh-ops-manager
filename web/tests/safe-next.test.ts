import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeNext } from "../lib/safe-next";

describe("safeNext (anti open-redirect)", () => {
  it("acepta rutas internas, con query y la raíz", () => {
    for (const ok of ["/", "/settings", "/?store=abc", "/orders/1?x=1&y=2", "/oauth/authorize?q=abc_DEF-123"]) assert.equal(safeNext(ok), ok);
  });
  it("rechaza todo lo que acabe en otro origen", () => {
    for (const bad of ["//evil.com", "/\\evil.com", "/\\/evil.com", "/%2fevil.com", "/%2Fevil.com", "https://evil.com", "evil.com", "", "javascript:alert(1)", "/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "/\u0000/evil.com", "///evil.com"]) {
      assert.equal(safeNext(bad), null, JSON.stringify(bad));
    }
    assert.equal(safeNext(null), null);
    assert.equal(safeNext(undefined), null);
  });
});
