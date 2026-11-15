// Órdenes sobre SurrealDB real (base efímera): numeración, capacidad por día-pantalla,
// reemplazo de líneas, cobros — incluida la CONCURRENCIA, que en Postgres se resolvía con
// locks y aquí se resuelve con registros compartidos + reintento OCC (ver migración 0006).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, pointAppAt, type TestDb } from "./helpers/surreal-test-db";

let t: TestDb;
let o: typeof import("../lib/orders-store");
let av: typeof import("../lib/availability");
let inv: typeof import("../lib/screens-store");
let surreal: typeof import("../lib/surreal");
const A = "store-a";
const B = "store-b";
const DAY = "2027-03-10";

const q = async <T = unknown>(sql: string, vars?: Record<string, unknown>): Promise<T> => {
  const res = await t.root.query(sql, vars).collect();
  return res[res.length - 1] as T;
};
const fields = (extra: Record<string, unknown> = {}) => ({ brand: "Marca", currency: "PEN", payment_terms_days: 30, reservation_expires_at: new Date(Date.now()+86_400_000), ...extra });
const line = (screen: string, slots: number, starts = DAY, ends = DAY) => ({ screen_id: screen, starts, ends, total: 100, slots });
const newScreen = (name: string, store = A) =>
  inv.createScreenWithVenue(store, { name: `V ${name}`, city: "Lima", district: null, address: null, latitude: null, longitude: null, country: "PE", ownership: "own", supplier_company_id: null }, { name, source: "manual" });
const orderCount = async () => (await q<number[]>("SELECT VALUE count() FROM io_order GROUP ALL"))[0] ?? 0;

before(async () => {
  t = await createTestDb();
  pointAppAt(t);
  o = await import("../lib/orders-store");
  av = await import("../lib/availability");
  inv = await import("../lib/screens-store");
  surreal = await import("../lib/surreal");
  await q(`CREATE sys_store:⟨${A}⟩ SET name='A', io_prefix='SM'; CREATE sys_store:⟨${B}⟩ SET name='B', default_slots_per_screen=3;`);
});
after(async () => {
  await surreal?.closeDb();
  await t?.drop();
});

describe("numeración", () => {
  it("correlativa por tienda y año con el prefijo de la tienda", async () => {
    const s = await newScreen("num");
    const ids = [] as string[];
    for (let i = 0; i < 3; i++) ids.push(await o.createOrderWithLines(A, fields(), [line(s, 1, `2027-0${i + 1}-01`, `2027-0${i + 1}-01`)], "t"));
    const nums = (await o.selectOrders(A, { ids })).map((r) => String(r.io_number)).sort();
    assert.match(nums[0], /^SM-\d{4}-0001$/);
    assert.deepEqual(nums.map((n) => n.slice(-4)), ["0001", "0002", "0003"]);
  });

  it("creaciones concurrentes nunca repiten ni saltan números", async () => {
    const screens = await Promise.all(Array.from({ length: 8 }, (_, i) => newScreen(`c${i}`, B)));
    await Promise.all(screens.map((s) => o.createOrderWithLines(B, fields(), [line(s, 1)], "t")));
    const nums = (await q<string[]>(`SELECT VALUE number FROM io_order WHERE store = sys_store:⟨${B}⟩`)).map((n) => Number(n.slice(-4))).sort((a, b) => a - b);
    assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("capacidad por día-pantalla", () => {
  it("el periodo de la orden sale de sus líneas y el total en centavos", async () => {
    const s = await newScreen("periodo");
    const id = await o.createOrderWithLines(A, fields(), [line(s, 2, "2027-05-03", "2027-05-05"), { ...line(s, 1, "2027-05-10", "2027-05-12"), total: 295.5 }], "t");
    const ord = await o.getOrder(A, id);
    assert.equal(ord?.starts_at, "2027-05-03");
    assert.equal(ord?.ends_at, "2027-05-12");
    const lines = (await o.selectLines(A, [id])).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
    assert.equal(lines[0].cant_dias, 3);
    assert.equal(lines[1].rate_minor, 29550);
    assert.equal(lines[0].starts_at, "2027-05-03T05:00:00Z"); // medianoche Lima
    assert.equal(lines[0].ends_at, "2027-05-06T05:00:00Z"); // fin exclusivo
  });

  it("rechaza exceder la capacidad y no deja orden a medias", async () => {
    const s = await newScreen("cap");
    await o.createOrderWithLines(A, fields(), [line(s, 6)], "t");
    const before = await orderCount();
    await assert.rejects(o.createOrderWithLines(A, fields(), [line(s, 5)], "t"), (e) => /sin slots/.test(surreal.thrownMessage(e)));
    assert.equal(await orderCount(), before);
    await o.createOrderWithLines(A, fields(), [line(s, 4)], "t"); // 6 + 4 = 10 = capacidad
  });

  it("slots == capacidad es exclusiva por convención", async () => {
    const s = await newScreen("exclusiva");
    await o.createOrderWithLines(A, fields(), [line(s, 10)], "t");
    await assert.rejects(o.createOrderWithLines(A, fields(), [line(s, 1)], "t"), /sin slots/);
  });

  it("dos líneas de la misma orden se suman entre sí", async () => {
    const s = await newScreen("intra");
    await assert.rejects(o.createOrderWithLines(A, fields(), [line(s, 6), line(s, 6)], "t"), /sin slots/);
  });

  it("canceladas y reservas vencidas liberan; firmadas siguen apartando", async () => {
    const s = await newScreen("estados");
    const full = await o.createOrderWithLines(A, fields(), [line(s, 10)], "t");
    await assert.rejects(o.createOrderWithLines(A, fields(), [line(s, 1)], "t"), /sin slots/);
    await o.patchOrder(A, full, { status: "cancelled" });
    const again = await o.createOrderWithLines(A, fields(), [line(s, 10)], "t");
    await o.patchOrder(A, again, { status: "signed", signed_at: new Date() });
    await assert.rejects(o.createOrderWithLines(A, fields(), [line(s, 1)], "t"), /sin slots/);
    // Borrador creado hace 8 días: su hold venció.
    const s2 = await newScreen("vencido");
    await q(`CREATE io_order SET store = sys_store:⟨${A}⟩, number = 'OLD-1', created_at = time::now() - 8d, reservation_expires_at = time::now() - 1d`);
    await q(
      `CREATE io_line SET store = sys_store:⟨${A}⟩, order = (SELECT VALUE id FROM io_order WHERE number = 'OLD-1')[0], screen = type::record('inv_screen', $s),
        starts_at = <datetime> '2027-03-09T05:00:00Z', ends_at = <datetime> '2027-03-11T05:00:00Z', cant_slots = 10`, { s: s2 });
    await o.createOrderWithLines(A, fields(), [line(s2, 10)], "t");
  });

  it("slots propios activos fijan la capacidad; todos inactivos = pausada", async () => {
    const s = await newScreen("slots");
    await q(`FOR $i IN [1, 2] { CREATE inv_slot SET store = sys_store:⟨${A}⟩, screen = type::record('inv_screen', $s), slot_index = $i; }`, { s });
    assert.equal((await av.getScreenCapacities(A, [s])).get(s), 2);
    await assert.rejects(o.createOrderWithLines(A, fields(), [line(s, 3)], "t"), /sin slots/);
    await q(`UPDATE inv_slot SET is_active = false WHERE screen = type::record('inv_screen', $s)`, { s });
    assert.equal((await av.getScreenCapacities(A, [s])).get(s), 0);
    await assert.rejects(o.createOrderWithLines(A, fields(), [line(s, 1)], "t"), /sin slots/);
  });

  it("la capacidad por defecto sale de la tienda; una pantalla ajena no tiene capacidad", async () => {
    const s = await newScreen("default");
    assert.equal((await av.getScreenCapacities(A, [s])).get(s), 10);
    assert.equal((await av.getScreenCapacities(B, [s])).get(s), 0);
  });

  it("CONCURRENTES: 12 ventas de 4 slots sobre la misma pantalla/día, solo caben 2", async () => {
    const s = await newScreen("carrera");
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => o.createOrderWithLines(A, fields(), [line(s, 4)], "t")));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(ok, 2, `exitosas: ${ok}`);
    for (const r of results) if (r.status === "rejected") assert.match(surreal.thrownMessage(r.reason), /sin slots/);
    const reserved = (await q<number[]>(
      `SELECT VALUE math::sum(cant_slots) FROM io_line WHERE screen = type::record('inv_screen', $s) GROUP ALL`, { s }))[0];
    assert.equal(reserved, 8);
  });

  it("CONCURRENTES en pantallas distintas no se bloquean entre sí", async () => {
    const screens = await Promise.all(Array.from({ length: 6 }, (_, i) => newScreen(`par${i}`)));
    const results = await Promise.allSettled(screens.map((s) => o.createOrderWithLines(A, fields(), [line(s, 10)], "t")));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 6);
  });

  it("disponibilidad (grilla) coincide con la regla de la DB", async () => {
    const s = await newScreen("grilla");
    await o.createOrderWithLines(A, fields(), [line(s, 7)], "t");
    const p = await av.getPeriodAvailability(A, [s], DAY, DAY, { slots: 4 });
    assert.equal(p.capacities[s], 10);
    assert.equal(p.remaining[s][DAY], 3);
    assert.equal(p.conflicts.length, 1); // pedir 4 con 3 libres
    assert.equal((await av.getPeriodAvailability(A, [s], DAY, DAY, { slots: 3 })).conflicts.length, 0);
  });
});

describe("reemplazo de líneas", () => {
  it("solo borradores; ignora a la propia orden en la capacidad", async () => {
    const s = await newScreen("repl");
    const id = await o.createOrderWithLines(A, fields(), [line(s, 10)], "t");
    await o.replaceOrderLines(A, id, [line(s, 10, "2027-06-01", "2027-06-02")], "t"); // no choca consigo misma
    assert.equal((await o.selectLines(A, [id])).length, 1);
    await o.patchOrder(A, id, { status: "signed", signed_at: new Date() });
    await assert.rejects(o.replaceOrderLines(A, id, [line(s, 1)], "t"), /solo borradores/);
  });
  it("no opera sobre órdenes de otra tienda", async () => {
    const s = await newScreen("ajena");
    const id = await o.createOrderWithLines(A, fields(), [line(s, 1)], "t");
    await assert.rejects(o.replaceOrderLines(B, id, [line(s, 1)], "t"), /orden no encontrada/);
  });
  it("una pantalla con historia no se puede eliminar (REFERENCE … REJECT)", async () => {
    const s = await newScreen("historia");
    await o.createOrderWithLines(A, fields(), [line(s, 1)], "t");
    await assert.rejects(inv.deleteScreenAndOrphanVenue(A, s));
  });
});

describe("facturas y cobros", () => {
  let order: string;
  const invoice = async (amount: number, extra: Record<string, unknown> = {}) =>
    o.createInvoice(A, order, { number: `F-${Math.random().toString(36).slice(2, 8)}`, amount_minor: amount, currency: "PEN", status: "issued", ...extra });
  const pay = (id: string, rid: string, amount: number, ref = "ref") => o.recordInvoicePayment(id, { requestId: rid, amountMinor: amount, paidOn: "2026-01-02", reference: ref }, "t");
  const paid = async (id: string) => (await q<Array<{ paid_minor: number; status: string }>>(`SELECT paid_minor, status FROM type::record('io_invoice', $id)`, { id }))[0];

  before(async () => {
    const s = await newScreen("fact");
    order = await o.createOrderWithLines(A, fields(), [line(s, 1)], "t");
  });

  it("cobra, completa y revierte con historial", async () => {
    const id = await invoice(1000);
    await pay(id, "p1", 600);
    assert.deepEqual(await paid(id), { paid_minor: 600, status: "issued" });
    await pay(id, "p2", 400);
    assert.deepEqual(await paid(id), { paid_minor: 1000, status: "paid" });
    await o.voidInvoicePayment(id, "p2", "error de captura", "t");
    assert.deepEqual(await paid(id), { paid_minor: 600, status: "issued" });
    const inv1 = (await o.selectInvoices(A, 50)).find((r) => r.id === id);
    const voided = (inv1?.payments as Array<Record<string, unknown>>).find((p) => p.id === "p2");
    assert.ok(voided?.voided_at && voided.void_reason === "error de captura");
  });

  it("idempotente por requestId; mismo id con otros datos se rechaza", async () => {
    const id = await invoice(500);
    await pay(id, "idem", 200);
    await pay(id, "idem", 200);
    assert.equal((await paid(id)).paid_minor, 200);
    await assert.rejects(pay(id, "idem", 250), /ya existe con otros datos/);
  });

  it("nunca excede el saldo ni acepta fechas futuras o datos inválidos", async () => {
    const id = await invoice(300);
    await assert.rejects(pay(id, "x1", 301), /supera el saldo/);
    await assert.rejects(o.recordInvoicePayment(id, { requestId: "x2", amountMinor: 10, paidOn: "2999-01-01", reference: "r" }, "t"), /inválidos/);
    await assert.rejects(pay(id, "x3", 10, "   "), /inválidos/);
  });

  it("CONCURRENTES: 10 cobros de 300 sobre una factura de 1000, solo caben 3", async () => {
    const id = await invoice(1000);
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => pay(id, `race-${i}`, 300)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
    for (const r of results) if (r.status === "rejected") assert.match(surreal.thrownMessage(r.reason), /supera el saldo/);
    assert.deepEqual(await paid(id), { paid_minor: 900, status: "issued" });
  });

  it("anular exige emitida y sin cobros vigentes", async () => {
    const id = await invoice(200);
    await pay(id, "c1", 50);
    await assert.rejects(o.cancelInvoice(id, "t"), /tiene cobros/);
    await o.voidInvoicePayment(id, "c1", "reverso", "t");
    await o.cancelInvoice(id, "t");
    assert.equal((await paid(id)).status, "cancelled");
    await assert.rejects(pay(id, "c2", 10), /no admite nuevos cobros/);
  });

  it("moneda distinta a la de la orden o número repetido se rechazan", async () => {
    await assert.rejects(invoice(10, { currency: "USD" }), /currency/);
    await invoice(10, { number: "UNICO-1" });
    await assert.rejects(invoice(10, { number: "UNICO-1" }), (e) => surreal.isUniqueViolation(e));
  });

  it("la red de seguridad del evento frena un cobro escrito por fuera de la función", async () => {
    const id = await invoice(100);
    await assert.rejects(
      q(`CREATE io_invoice_payment SET store = sys_store:⟨${A}⟩, invoice = type::record('io_invoice', $id), amount_minor = 150, paid_on = '2026-01-01', reference = 'x'`, { id }),
      /excede/,
    );
  });
});
