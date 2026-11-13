// Anti-sobreventa: solape de rangos, frescura del hold y bordes de periodo.
// Corre con: npm test (node:test vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HOLD_DAYS,
  dayBlocked,
  displayEndOf,
  isHoldFresh,
  periodBounds,
  rangesOverlap,
} from "../lib/availability";

describe("rangesOverlap (semiabierto [inicio,fin))", () => {
  it("detecta solape parcial y contenido", () => {
    assert.equal(rangesOverlap("a", "c", "b", "d"), true);
    assert.equal(rangesOverlap("b", "d", "a", "c"), true);
    assert.equal(rangesOverlap("a", "d", "b", "c"), true);
  });
  it("adyacentes no solapan (fin exclusivo)", () => {
    assert.equal(rangesOverlap("a", "b", "b", "c"), false);
    assert.equal(rangesOverlap("b", "c", "a", "b"), false);
  });
  it("idénticos solapan", () => {
    assert.equal(rangesOverlap("a", "b", "a", "b"), true);
  });
});

describe("isHoldFresh (borrador aparta HOLD_DAYS)", () => {
  it("fresco dentro de la ventana", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    assert.equal(isHoldFresh("2026-11-01T12:00:00Z", now), true);
  });
  it("vencido libera", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    assert.equal(isHoldFresh("2026-10-01T12:00:00Z", now), false);
  });
  it(`HOLD_DAYS es 7`, () => {
    assert.equal(HOLD_DAYS, 7);
  });
  it("sin fecha no aparta", () => {
    assert.equal(isHoldFresh(null), false);
    assert.equal(isHoldFresh("no-fecha"), false);
  });
});

describe("bordes de periodo UI ↔ BD", () => {
  it("periodBounds: fin inclusivo → exclusivo día siguiente Lima", () => {
    const { qStart, qEnd } = periodBounds("2026-11-03", "2026-11-24");
    assert.equal(qStart, "2026-11-03T00:00:00-05:00");
    assert.equal(qEnd, "2026-11-25T00:00:00-05:00");
  });
  it("displayEndOf: fin exclusivo → día inclusivo", () => {
    assert.equal(displayEndOf("2026-11-25T00:00:00-05:00"), "2026-11-24");
  });
  it("fecha inválida lanza, nunca {} libre (issue #5 P0)", () => {
    assert.throws(() => periodBounds("nonsense", "2026-11-24"), /Fecha inválida/);
    assert.throws(() => periodBounds("2026-11-03", "no-fecha"), /Fecha inválida/);
    assert.throws(() => periodBounds("2026-11-24", "2026-11-03"), /Rango inválido/);
    assert.throws(() => displayEndOf("NaN-nada"), /Fecha inválida/);
  });
});

describe("dayBlocked (issue #13: capacidad + exclusividad)", () => {
  it("compartida cabe si hay cupo, bloquea si se excede", () => {
    assert.equal(dayBlocked({ reserved: 3, capacity: 10, hasExclusive: false, reqSlots: 1, reqExclusive: false }), false);
    assert.equal(dayBlocked({ reserved: 9, capacity: 10, hasExclusive: false, reqSlots: 1, reqExclusive: false }), false);
    assert.equal(dayBlocked({ reserved: 10, capacity: 10, hasExclusive: false, reqSlots: 1, reqExclusive: false }), true);
    assert.equal(dayBlocked({ reserved: 9, capacity: 10, hasExclusive: false, reqSlots: 2, reqExclusive: false }), true);
  });

  it("exclusiva vigente bloquea todo", () => {
    assert.equal(dayBlocked({ reserved: 0, capacity: 10, hasExclusive: true, reqSlots: 1, reqExclusive: false }), true);
    assert.equal(dayBlocked({ reserved: 0, capacity: 10, hasExclusive: true, reqSlots: 1, reqExclusive: true }), true);
  });

  it("exclusiva pedida requiere día vacío", () => {
    assert.equal(dayBlocked({ reserved: 0, capacity: 10, hasExclusive: false, reqSlots: 1, reqExclusive: true }), false);
    assert.equal(dayBlocked({ reserved: 1, capacity: 10, hasExclusive: false, reqSlots: 1, reqExclusive: true }), true);
  });
});
