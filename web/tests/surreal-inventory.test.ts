// Inventario sobre SurrealDB real (base efímera): pantalla+venue transaccional,
// búsqueda (venue/proveedor, tildes, typos), cercanía geoespacial y embedding HNSW.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, pointAppAt, type TestDb } from "./helpers/surreal-test-db";

let t: TestDb;
let inv: typeof import("../lib/screens-store");
let invDb: typeof import("../lib/screens-db");
let crm: typeof import("../lib/crm-store");
let surreal: typeof import("../lib/surreal");
const A = "store-a";
const B = "store-b";
const venue = (name: string, extra: Record<string, unknown> = {}) => ({
  name, city: "Lima", district: "Miraflores", address: name, latitude: -12.1219, longitude: -77.0282,
  country: "PE", ownership: "own" as const, supplier_company_id: null, ...extra,
});

before(async () => {
  t = await createTestDb();
  pointAppAt(t);
  inv = await import("../lib/screens-store");
  invDb = await import("../lib/screens-db");
  crm = await import("../lib/crm-store");
  surreal = await import("../lib/surreal");
  await t.root.query(`CREATE sys_store:⟨${A}⟩ SET name='A'; CREATE sys_store:⟨${B}⟩ SET name='B';`).collect();
});
after(async () => {
  await surreal?.closeDb();
  await t?.drop();
});

describe("pantalla + ubicación", () => {
  it("crea ubicación y pantalla en una transacción y las lee como DTO plano", async () => {
    const id = await inv.createScreenWithVenue(A, venue("Av. Pardo 793, Miraflores, Lima"), {
      name: "LED Pardo", modality: "digital", width_px: 1920, height_px: 1080, price_pen: 1500, is_active: true,
      source: "manual", enrichment_status: "pending", technology: "LED",
    });
    const d = await invDb.getScreenRecord(A, id);
    assert.equal(d?.screen.name, "LED Pardo");
    assert.equal(d?.screen.store_id, A);
    assert.equal(typeof d?.screen.venue_id, "string");
    assert.equal(d?.venue?.latitude, -12.1219);
    assert.equal(d?.venue?.longitude, -77.0282);
    assert.equal(d?.has_embedding, false);
  });

  it("si falla la pantalla no queda ubicación huérfana", async () => {
    const before = await surreal.surql<number[]>("SELECT VALUE count() FROM inv_venue GROUP ALL");
    await assert.rejects(inv.createScreenWithVenue(A, venue("Huérfana"), { name: "   ", source: "manual" }));
    const after = await surreal.surql<number[]>("SELECT VALUE count() FROM inv_venue GROUP ALL");
    assert.deepEqual(after, before);
  });

  it("borrar la pantalla borra su ubicación si nadie más la usa", async () => {
    const id = await inv.createScreenWithVenue(A, venue("Para borrar"), { name: "Efímera", source: "manual" });
    await inv.deleteScreenAndOrphanVenue(A, id);
    assert.equal(await invDb.getScreenRecord(A, id), null);
    assert.equal((await surreal.surql<unknown[]>("SELECT * FROM inv_venue WHERE name = 'Para borrar'")).length, 0);
  });

  it("no toca pantallas de otra tienda", async () => {
    const id = await inv.createScreenWithVenue(A, venue("Solo A"), { name: "Pantalla A", source: "manual" });
    assert.equal(await invDb.getScreenRecord(B, id), null);
    await inv.patchScreen(B, id, { name: "hack" });
    await inv.deleteScreenAndOrphanVenue(B, id);
    assert.equal((await invDb.getScreenRecord(A, id))?.screen.name, "Pantalla A");
  });

  it("proveedor de otra tienda es rechazado; ownership supplier exige proveedor", async () => {
    const foreign = await crm.createCompany(B, { name: "Prov B", kind: "proveedor", provider_type: "media_owner" });
    await assert.rejects(inv.createScreenWithVenue(A, venue("X"), { name: "P", supplier_company_id: foreign, ownership: "supplier", source: "manual" }));
    await assert.rejects(inv.createScreenWithVenue(A, venue("Y"), { name: "Q", ownership: "supplier", source: "manual" }));
  });

  it("las métricas derivadas con decimales se redondean al guardar (columnas int)", async () => {
    const id = await inv.createScreenWithVenue(A, venue("Métricas"), { name: "Metr", source: "manual" });
    await inv.patchScreen(A, id, { views_per_spot: 12.6, vehicular_pct: 40.4, score: 71.25 });
    const d = await invDb.getScreenRecord(A, id);
    assert.equal(d?.screen.views_per_spot, 13);
    assert.equal(d?.screen.vehicular_pct, 40);
    assert.equal(d?.screen.score, 71.25);
  });
});

describe("búsqueda y listado", () => {
  before(async () => {
    const sup = await crm.createCompany(A, { name: "SmartMedia", kind: "proveedor", provider_type: "media_owner" });
    await inv.createScreenWithVenue(A, venue("Estadio Bonilla", { district: "Miraflores", ownership: "supplier", supplier_company_id: sup }), {
      name: "Pantalla LED — Av. Ejército", external_ref: "MI001", price_pen: 900, impact_day: 5000, source: "manual",
      supplier_company_id: sup, ownership: "supplier",
    });
    await inv.createScreenWithVenue(A, venue("Centro Cusco", { city: "Cusco", district: "Cusco" }), {
      name: "Plaza de Armas", external_ref: "CU001", price_pen: 400, source: "manual", is_active: false,
    });
  });
  const names = async (opts: Parameters<typeof invDb.listScreens>[1]) => (await invDb.listScreens(A, opts)).rows.map((r) => r.name);

  it("encuentra por venue, proveedor, código y distrito (sin tildes)", async () => {
    assert.ok((await names({ q: "bonilla" })).includes("Pantalla LED — Av. Ejército"));
    assert.ok((await names({ q: "smartmedia" })).includes("Pantalla LED — Av. Ejército"));
    assert.ok((await names({ q: "cu001" })).includes("Plaza de Armas"));
    assert.ok((await names({ q: "ejercito miraflores" })).includes("Pantalla LED — Av. Ejército"));
  });
  it("tolera typos y exige todos los tokens", async () => {
    assert.ok((await names({ q: "ejersito" })).includes("Pantalla LED — Av. Ejército"));
    assert.deepEqual(await names({ q: "ejercito cusco" }), []);
  });
  it("filtra por proveedor, red propia, ciudad y estado", async () => {
    assert.deepEqual(await names({ q: "smartmedia", ownOnly: true }), []);
    assert.equal((await invDb.listScreens(A, { city: "cusco" })).rows.length, 1);
    assert.equal((await invDb.listScreens(A, { active: "inactive" })).rows[0].name, "Plaza de Armas");
    const supplier = (await invDb.listScreenFilterOptions(A)).suppliers[0];
    assert.equal((await invDb.listScreens(A, { supplierId: supplier.id })).total, 1);
  });
  it("ordena con nulos al final y pagina con total exacto", async () => {
    const asc = await invDb.listScreens(A, { sortKey: "price", sortDir: "asc" });
    assert.ok(asc.total >= 3);
    const last = asc.rows[asc.rows.length - 1];
    assert.ok(last.price_pen === null || last.price_pen >= (asc.rows[0].price_pen ?? 0));
    const page = await invDb.listScreens(A, { pageSize: 1, page: 2 });
    assert.equal(page.rows.length, 1);
    assert.equal(page.total, asc.total);
  });
  it("el nombre del proveedor y la ciudad se reflejan al renombrar (campo COMPUTED)", async () => {
    const supplier = (await invDb.listScreenFilterOptions(A)).suppliers[0];
    await crm.patchCompany(A, supplier.id, { name: "Red Andina" });
    assert.ok((await names({ q: "andina" })).includes("Pantalla LED — Av. Ejército"));
    assert.deepEqual(await names({ q: "smartmedia" }), []);
  });
});

describe("geo y embeddings nativos", () => {
  it("cercanía con geo::distance", async () => {
    const near = await surreal.surql<Array<{ name: string; m: number }>>(
      `SELECT name, geo::distance(location, type::point([-77.03, -12.12])) AS m FROM inv_venue
       WHERE location != NONE AND geo::distance(location, type::point([-77.03, -12.12])) < 1000 ORDER BY m LIMIT 1`,
    );
    assert.ok(near[0] && near[0].m < 1000);
    const far = await surreal.surql<unknown[]>(
      `SELECT name FROM inv_venue WHERE location != NONE AND geo::distance(location, type::point([-71.97, -13.53])) < 1000 AND city = 'Lima'`,
    );
    assert.equal(far.length, 0);
  });
  it("guarda el embedding en la pantalla y lo encuentra por KNN (HNSW 768d)", async () => {
    const v = Array.from({ length: 768 }, (_, i) => Math.sin(i));
    const id = await inv.createScreenWithVenue(A, venue("Semántica"), { name: "Embed", source: "manual" });
    await inv.setScreenEmbedding(A, id, v, "gemini-embedding-001");
    const d = await invDb.getScreenRecord(A, id);
    assert.equal(d?.has_embedding, true);
    assert.equal(d?.embedding_model, "gemini-embedding-001");
    const hit = await surreal.surql<Array<{ id: string }>>(
      `SELECT record::id(id) AS id FROM inv_screen WHERE embedding <|1,40|> $v`, { v },
    );
    assert.equal(hit[0]?.id, id);
  });
});
