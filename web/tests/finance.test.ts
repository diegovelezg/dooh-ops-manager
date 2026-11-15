// Finanzas: KPIs por mes calendario (alineados con Hoy).
// Mes en curso a la fecha vs mismo tramo del mes anterior.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bucketMonthly, computeFinanceKpis } from "../lib/finance";

const TZ = "America/Lima";

const now = Date.parse("2026-11-09T12:00:00-05:00");

let nextOrder = 0;
const o = (placed_at: string | null, total_amount = 10000, currency: string | null = "PEN") => ({
  order_id: String(++nextOrder),
  placed_at,
  total_amount,
  currency,
});

describe("computeFinanceKpis por mes", () => {
  it("varias líneas de una orden suman sus importes y cuentan una sola orden", () => {
    const lines = [
      { ...o("2026-11-02T10:00:00-05:00", 20000), order_id: "actual" },
      { ...o("2026-11-03T10:00:00-05:00", 10000), order_id: "actual" },
      { ...o("2026-10-02T10:00:00-05:00", 10000), order_id: "previa" },
      { ...o("2026-10-03T10:00:00-05:00", 5000), order_id: "previa" },
    ];
    const k = computeFinanceKpis(lines, "PEN", TZ, now);
    assert.equal(k.salesMesMinor, 30000);
    assert.equal(k.ordersMes, 1);
    assert.equal(k.ticketMesMinor, 30000);
    assert.equal(k.ordersDeltaPct, 0);
    assert.equal(k.salesDeltaPct, 100);
    const buckets = bucketMonthly(lines, "PEN", TZ, now);
    assert.equal(buckets.find((b) => b.key === "2026-11")?.orders, 1);
    assert.equal(buckets.find((b) => b.key === "2026-11")?.salesMinor, 30000);
    assert.equal(buckets.find((b) => b.key === "2026-10")?.orders, 1);
  });
  it("mes en curso a la fecha vs mismo tramo del anterior", () => {
    const k = computeFinanceKpis(
      [
        o("2026-11-02T10:00:00-05:00", 20000), // mes actual
        o("2026-10-02T10:00:00-05:00", 10000), // mismo tramo mes anterior
        o("2026-10-20T10:00:00-05:00", 50000), // fuera del tramo previo
      ],
      "PEN",
      TZ, now,
    );
    assert.equal(k.salesMesMinor, 20000);
    assert.equal(k.ordersMes, 1);
    assert.equal(k.ticketMesMinor, 20000);
    assert.equal(k.salesDeltaPct, 100);
    assert.equal(k.ordersDeltaPct, 0);
  });
  it("sin base previa → null; sin órdenes → 0", () => {
    const k = computeFinanceKpis([o("2026-11-02T10:00:00-05:00", 20000)], "PEN", TZ, now);
    assert.equal(k.salesDeltaPct, null);
    const empty = computeFinanceKpis([], "PEN", TZ, now);
    assert.equal(empty.salesMesMinor, 0);
    assert.equal(empty.ticketMesMinor, 0);
    assert.equal(empty.salesDeltaPct, 0);
  });
  it("respeta moneda de la vista y excluye futuro", () => {
    const k = computeFinanceKpis(
      [
        o("2026-11-02T10:00:00-05:00", 10000, "USD"),
        o("2026-11-20T10:00:00-05:00", 99999), // futuro: se ignora
      ],
      "PEN",
      TZ, now,
    );
    assert.equal(k.salesMesMinor, 0);
    assert.equal(k.ordersMes, 0);
  });
});

describe("bucketMonthly", () => {
  it("agrupa por mes calendario incluyendo el actual", () => {
    const b = bucketMonthly(
      [o("2026-11-02T10:00:00-05:00", 20000), o("2026-10-15T10:00:00-05:00", 10000)],
      "PEN",
      TZ, now,
    );
    assert.equal(b.length, 12);
    const nov = b.find((x) => x.key === "2026-11");
    const oct = b.find((x) => x.key === "2026-10");
    assert.equal(nov?.salesMinor, 20000);
    assert.equal(nov?.orders, 1);
    assert.equal(oct?.salesMinor, 10000);
  });
});

describe("frontera de mes en hora Lima", () => {
  it("30-nov 20:00 Lima (01:00Z de diciembre) es noviembre, no diciembre", () => {
    const dec = Date.parse("2026-12-05T12:00:00-05:00");
    const b = bucketMonthly([o("2026-11-30T20:00:00-05:00", 7000)], "PEN", TZ, dec);
    assert.equal(b.find((x) => x.key === "2026-11")?.salesMinor, 7000);
    assert.equal(b.find((x) => x.key === "2026-12")?.salesMinor, 0);
    assert.equal(computeFinanceKpis([o("2026-11-30T20:00:00-05:00", 7000)], "PEN", TZ, dec).salesMesMinor, 0);
  });
  it("1-dic 00:00 Lima (05:00Z) abre diciembre", () => {
    const dec = Date.parse("2026-12-05T12:00:00-05:00");
    assert.equal(computeFinanceKpis([o("2026-12-01T05:00:00Z", 100)], "PEN", TZ, dec).salesMesMinor, 100);
  });
  it("tramo previo acotado al mes anterior (30-mar vs febrero de 28 días)", () => {
    const mar30 = Date.parse("2027-03-30T12:00:00-05:00");
    const k = computeFinanceKpis([o("2027-02-27T10:00:00-05:00", 100), o("2027-03-01T10:00:00-05:00", 300)], "PEN", TZ, mar30);
    assert.equal(k.salesMesMinor, 300);
    assert.equal(k.ordersDeltaPct, 0);
  });
});
