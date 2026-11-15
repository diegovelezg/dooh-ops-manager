// Indicadores de "Hoy" contra datos reales (base efímera): todo se mide en días LIMA, igual que la
// capacidad y las líneas. Un día/mes en UTC recortaba 5 h de cada línea (que empieza 05:00Z) y
// contaba un día de más por línea.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, pointAppAt, type TestDb } from "./helpers/surreal-test-db";
import { addDays, todayIn } from "../lib/format";

let t: TestDb;
let o: typeof import("../lib/orders-store");
let inv: typeof import("../lib/screens-store");
let surreal: typeof import("../lib/surreal");
let snapshot: (storeId: string) => Promise<import("../lib/dashboard").DashboardSnapshot>;
const A = "store-a";
const TODAY = todayIn("America/Lima");
const newScreen = (name: string, active = true) =>
  inv.createScreenWithVenue(A, { name: `V ${name}`, city: null, district: null, address: null, latitude: null, longitude: null, country: null, ownership: "own", supplier_company_id: null },
    { name, source: "manual", is_active: active });
const order = async (brand: string, lines: Array<{ screen: string; from: string; to: string; total: number; slots: number }>, status: "draft" | "signed") => {
  const id = await o.createOrderWithLines(A, { brand, currency: "PEN" },
    lines.map((l) => ({ screen_id: l.screen, starts: l.from, ends: l.to, total: l.total, slots: l.slots })), "t");
  if (status === "signed") await o.patchOrder(A, id, { status: "signed", signed_at: new Date() });
  return id;
};

before(async () => {
  t = await createTestDb();
  pointAppAt(t);
  o = await import("../lib/orders-store");
  inv = await import("../lib/screens-store");
  surreal = await import("../lib/surreal");
  snapshot = (await import("../lib/dashboard")).getDashboardSnapshot;
  await t.root.query(`CREATE sys_store:⟨${A}⟩ SET name='A'`).collect();
});
after(async () => {
  await surreal?.closeDb();
  await t?.drop();
});

describe("dashboard Hoy (días Lima)", () => {
  it("comprometido: una línea dentro del mes se cuenta COMPLETA (sin recorte de 5 h)", async () => {
    const s = await newScreen("m1");
    await order("Mes", [{ screen: s, from: TODAY, to: TODAY, total: 1000, slots: 1 }], "signed");
    const snap = await snapshot(A);
    assert.equal(snap.firmadoMesMinor, 100000);
    assert.equal(snap.comprometidoMesMinor, 100000);
    assert.equal(snap.draftMesMinor, 0);
  });

  it("borrador no infla el comprometido; va aparte", async () => {
    const s = await newScreen("m2");
    await order("Borrador", [{ screen: s, from: TODAY, to: TODAY, total: 500, slots: 1 }], "draft");
    const snap = await snapshot(A);
    assert.equal(snap.comprometidoMesMinor, 100000);
    assert.equal(snap.draftMesMinor, 50000);
  });

  it("ocupación 14d: slots-día exactos (3 días × 4 slots = 12, no 16)", async () => {
    const s = await newScreen("occ");
    const before = (await snapshot(A)).ocupacion14d.slotsVendidos;
    await order("Occ", [{ screen: s, from: TODAY, to: addDays(TODAY, 2), total: 300, slots: 4 }], "signed");
    const after = (await snapshot(A)).ocupacion14d;
    assert.equal(after.slotsVendidos - before, 12);
    assert.ok(after.slotsDisponibles >= 10 * 14);
  });

  it("ocupación: pantallas inactivas no entran al numerador ni al denominador", async () => {
    const off = await newScreen("inactiva", false);
    const base = (await snapshot(A)).ocupacion14d;
    await order("Off", [{ screen: off, from: TODAY, to: TODAY, total: 100, slots: 5 }], "signed");
    const next = (await snapshot(A)).ocupacion14d;
    assert.equal(next.slotsVendidos, base.slotsVendidos);
    assert.equal(next.slotsDisponibles, base.slotsDisponibles);
    assert.ok((next.ratio ?? 0) <= 1);
  });

  it("relevo 30d: solo cuentan órdenes FIRMADAS que terminan; el relevo puede ser un borrador posterior", async () => {
    const s = await newScreen("rel");
    const base = (await snapshot(A)).renovacion30d;
    // Firmada que termina en 5 días sin relevo + borrador que termina igual (no cuenta).
    await order("SinRelevo", [{ screen: s, from: addDays(TODAY, 1), to: addDays(TODAY, 5), total: 100, slots: 1 }], "signed");
    await order("SoloBorrador", [{ screen: s, from: addDays(TODAY, 1), to: addDays(TODAY, 5), total: 100, slots: 1 }], "draft");
    const mid = (await snapshot(A)).renovacion30d;
    assert.equal(mid.total - base.total, 1);
    assert.equal(mid.conRelevo, base.conRelevo);
  });

  it("al aire: sin OM ni material la orden de hoy está atrasada, no al aire", async () => {
    const snap = await snapshot(A);
    assert.equal(snap.alAire.ois, 0);
  });

  it("endedBefore compara instantes (órdenes terminadas antes de hoy Lima)", async () => {
    const s = await newScreen("eb");
    const yesterday = addDays(TODAY, -1);
    const past = await order("Pasada", [{ screen: s, from: yesterday, to: yesterday, total: 10, slots: 1 }], "signed");
    const cur = await order("Hoy", [{ screen: s, from: TODAY, to: TODAY, total: 10, slots: 1 }], "signed");
    const ended = (await o.selectOrders(A, { live: true, endedBefore: TODAY })).map((r) => String(r.id));
    assert.ok(ended.includes(past));
    assert.ok(!ended.includes(cur));
  });
});
