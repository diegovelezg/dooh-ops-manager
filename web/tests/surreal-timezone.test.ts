// Zona horaria por tenant (ADR: BD en UTC; el día vive en `sys_store.timezone`).
// Dos tenants con zonas distintas comparten la misma BD: cada uno ve SU día.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, pointAppAt, type TestDb } from "./helpers/surreal-test-db";
import { dayStart, todayIn } from "../lib/format";

let t: TestDb;
let o: typeof import("../lib/orders-store");
let inv: typeof import("../lib/screens-store");
let stores: typeof import("../lib/stores-db");
let surreal: typeof import("../lib/surreal");
const LIMA = "lima-store";
const TOKYO = "tokyo-store";
const newScreen = (store: string, name: string) =>
  inv.createScreenWithVenue(store, { name: `V ${name}`, city: null, district: null, address: null, latitude: null, longitude: null, country: null, ownership: "own", supplier_company_id: null },
    { name, source: "manual", is_active: true });
const line = (screen: string, from: string, to: string, slots = 1) => ({ screen_id: screen, starts: from, ends: to, total: 100, slots });

before(async () => {
  t = await createTestDb();
  pointAppAt(t);
  o = await import("../lib/orders-store");
  inv = await import("../lib/screens-store");
  stores = await import("../lib/stores-db");
  surreal = await import("../lib/surreal");
  await t.root.query(`CREATE sys_store:⟨${LIMA}⟩ SET name='Lima'; CREATE sys_store:⟨${TOKYO}⟩ SET name='Tokyo', timezone='Asia/Tokyo'`).collect();
});
after(async () => {
  await surreal?.closeDb();
  await t?.drop();
});

describe("timezone del tenant", () => {
  it("tienda nueva nace con America/Lima; la zona es explícita y editable", async () => {
    assert.equal(await stores.getStoreTimeZone(LIMA), "America/Lima");
    assert.equal(await stores.getStoreTimeZone(TOKYO), "Asia/Tokyo");
  });

  it("las líneas se guardan como instantes UTC según la zona del tenant", async () => {
    const sl = await newScreen(LIMA, "l1");
    const st = await newScreen(TOKYO, "t1");
    const a = await o.createOrderWithLines(LIMA, { brand: "L", currency: "PEN" }, [line(sl, "2027-03-10", "2027-03-11")], "t");
    const b = await o.createOrderWithLines(TOKYO, { brand: "T", currency: "JPY" }, [line(st, "2027-03-10", "2027-03-11")], "t");
    const la = (await o.selectLines(LIMA, [a]))[0];
    const lb = (await o.selectLines(TOKYO, [b]))[0];
    assert.equal(Date.parse(String(la.starts_at)), Date.parse(dayStart("2027-03-10", "America/Lima")));
    assert.equal(Date.parse(String(lb.starts_at)), Date.parse(dayStart("2027-03-10", "Asia/Tokyo")));
    assert.equal(Date.parse(String(la.ends_at)), Date.parse(dayStart("2027-03-12", "America/Lima")));
    assert.equal(la.cant_dias, 2);
  });

  it("la orden expone su periodo como días del tenant (inicio y último día inclusivo)", async () => {
    const st = await newScreen(TOKYO, "t2");
    const id = await o.createOrderWithLines(TOKYO, { brand: "T2", currency: "JPY" }, [line(st, "2027-04-01", "2027-04-03")], "t");
    const row = await o.getOrder(TOKYO, id);
    assert.equal(row?.starts_at, "2027-04-01");
    assert.equal(row?.ends_at, "2027-04-03");
  });

  it("conteo y listado usan el mismo fin de día en cada zona del tenant", async () => {
    for (const store of [LIMA, TOKYO]) {
      const screen = await newScreen(store, `fin-${store}`);
      const id = await o.createOrderWithLines(store, { brand: "Fin", currency: "PEN" }, [line(screen, "2027-08-01", "2027-08-01")], "t");
      const before = { ids: [id], endedBefore: "2027-08-01" };
      const after = { ids: [id], endedBefore: "2027-08-02" };
      assert.equal(await o.countOrders(store, before), 0);
      assert.equal(await o.countOrders(store, after), 1);
      assert.equal(await o.countOrders(store, after), (await o.selectOrders(store, after)).length);
    }
  });

  it("la capacidad se evalúa por día del tenant, no por día UTC", async () => {
    const st = await newScreen(TOKYO, "cap");
    await t.root.query(`UPDATE sys_store:⟨${TOKYO}⟩ SET default_slots_per_screen = 1`).collect();
    await o.createOrderWithLines(TOKYO, { brand: "C1", currency: "JPY", reservation_expires_at: new Date(Date.now()+86400000) }, [line(st, "2027-05-01", "2027-05-01")], "t");
    // Mismo día (Tokio) → sin cupo; el día siguiente Tokio está libre aunque comparta fecha UTC.
    await assert.rejects(o.createOrderWithLines(TOKYO, { brand: "C2", currency: "JPY", reservation_expires_at: new Date(Date.now()+86400000) }, [line(st, "2027-05-01", "2027-05-01")], "t"), /sin slots/);
    await o.createOrderWithLines(TOKYO, { brand: "C3", currency: "JPY" }, [line(st, "2027-05-02", "2027-05-02")], "t");
  });

  it("el correlativo usa el año del tenant", async () => {
    const st = await newScreen(TOKYO, "num");
    const id = await o.createOrderWithLines(TOKYO, { brand: "N", currency: "JPY" }, [line(st, "2027-06-01", "2027-06-01")], "t");
    const row = await o.getOrder(TOKYO, id);
    assert.match(String(row?.io_number), new RegExp(`-${todayIn("Asia/Tokyo").slice(0, 4)}-\\d{4}$`));
  });

  it("no se puede cambiar la zona de un tenant con órdenes; sí uno vacío", async () => {
    await assert.rejects(stores.setStoreTimeZone(TOKYO, "America/Lima"), /zona horaria no se puede cambiar/);
    await t.root.query(`CREATE sys_store:⟨empty-store⟩ SET name='E'`).collect();
    await stores.setStoreTimeZone("empty-store", "America/Mexico_City");
    assert.equal(await stores.getStoreTimeZone("empty-store"), "America/Mexico_City");
  });
});
