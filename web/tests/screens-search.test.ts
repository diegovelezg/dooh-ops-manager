// Normalización de texto compartida por los pickers del cliente (tildes, espacios,
// tokens). La búsqueda en servidor vive en SurrealDB: ver tests/surreal-inventory.test.ts.
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSearch, tokenizeSearch } from "@/lib/search-text";

describe("normalizeSearch", () => {
  it("tildes, mayúsculas y espacios colapsan", () => {
    assert.equal(normalizeSearch("Av. Ejército  / Estadio"), "av. ejercito / estadio");
    assert.equal(normalizeSearch("Paseo de la República"), "paseo de la republica");
    assert.equal(normalizeSearch("  Miraflores\t\nAlto  "), "miraflores alto");
  });

  it("ñ y diéresis degradan a ASCII", () => {
    assert.equal(normalizeSearch("NIÑO"), "nino");
    assert.equal(normalizeSearch("pingüino"), "pinguino");
  });

  it("null/undefined → vacío, sin lanzar", () => {
    assert.equal(normalizeSearch(null), "");
    assert.equal(normalizeSearch(undefined), "");
    assert.equal(normalizeSearch(123), "123");
  });
});

describe("tokenizeSearch", () => {
  it("parte por espacios y filtra vacíos", () => {
    assert.deepEqual(tokenizeSearch("  Bonilla   Ejercito "), ["bonilla", "ejercito"]);
  });

  it("vacío → sin tokens", () => {
    assert.deepEqual(tokenizeSearch("   "), []);
  });

  it("tope 6 tokens (paridad con fn::tokens)", () => {
    assert.equal(tokenizeSearch("a b c d e f g h").length, 6);
  });
});
