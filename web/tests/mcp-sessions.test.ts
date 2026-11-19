import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { bindSession, resetMcpSessions, sessionAllowed } from "../lib/mcp-sessions";

describe("mcp-sessions", () => {
  beforeEach(resetMcpSessions);
  it("solo el dueño usa la sesión; desconocida y ajena no se distinguen", () => {
    bindSession("s1", "dueño");
    assert.equal(sessionAllowed("s1", "dueño"), true);
    assert.equal(sessionAllowed("s1", "otro"), false);
    assert.equal(sessionAllowed("no-existe", "dueño"), false);
  });
  it("una sesión inactiva más de 1 h deja de valer; usarla la mantiene viva", () => {
    const t0 = 1_000_000;
    bindSession("s1", "o", t0);
    assert.equal(sessionAllowed("s1", "o", t0 + 59 * 60_000), true);
    assert.equal(sessionAllowed("s1", "o", t0 + 59 * 60_000 + 59 * 60_000), true, "se renueva con el uso");
    assert.equal(sessionAllowed("s1", "o", t0 + 59 * 60_000 + 59 * 60_000 + 61 * 60_000), false, "vence tras 1 h sin uso");
  });
  it("está acotada: al llenarse descarta la más antigua", () => {
    for (let i = 0; i < 5000; i++) bindSession(`s${i}`, "o");
    bindSession("nueva", "o");
    assert.equal(sessionAllowed("nueva", "o"), true);
    assert.equal(sessionAllowed("s0", "o"), false, "la más antigua se descartó");
    assert.equal(sessionAllowed("s4999", "o"), true);
  });
});
