// CRM sobre SurrealDB real (base efímera): unicidad, aislamiento por tienda,
// transacciones (principal, vínculos, cuentas, fusión) y búsqueda tolerante.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, pointAppAt, type TestDb } from "./helpers/surreal-test-db";

let t: TestDb;
let store: typeof import("../lib/crm-store");
let db: typeof import("../lib/crm-db");
let surreal: typeof import("../lib/surreal");
const A = "store-a";
const B = "store-b";

before(async () => {
  t = await createTestDb();
  pointAppAt(t);
  store = await import("../lib/crm-store");
  db = await import("../lib/crm-db");
  surreal = await import("../lib/surreal");
  await t.root.query(`CREATE sys_store:⟨${A}⟩ SET name='A'; CREATE sys_store:⟨${B}⟩ SET name='B';`).collect();
});
after(async () => {
  await surreal?.closeDb();
  await t?.drop();
});

const company = (storeId: string, name: string, kind: string, extra: Record<string, unknown> = {}) =>
  store.createCompany(storeId, { name, kind, ...extra });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("empresas", () => {
  it("las claves creadas por la app son UUID (empresa y contacto)", async () => {
    const id = await company(A, "Con UUID", "agencia");
    assert.match(id, UUID);
    await store.createContact(A, { company_id: id, email: "uuid@x.pe" }, null);
    const [c] = (await db.listCrmContacts(A, { companyId: id })).rows;
    assert.match(c.id, UUID);
  });

  it("crea, edita y archiva; NONE al limpiar un campo", async () => {
    const id = await company(A, "Teléfonica del Perú", "anunciante", { tax_id: "20100017491", city: "Lima" });
    await store.patchCompany(A, id, { city: null, legal_name: "Telefónica del Perú S.A.A." });
    const row = await store.getCompany(A, id);
    assert.equal(row?.city, undefined);
    assert.equal(row?.legal_name, "Telefónica del Perú S.A.A.");
    await store.setArchived("crm_company", A, id, true, "ana@x.pe");
    assert.ok((await store.getCompany(A, id))?.deleted_at);
    await store.setArchived("crm_company", A, id, false, null);
    assert.equal((await store.getCompany(A, id))?.deleted_at, undefined);
  });

  it("tax_id único por tienda (no entre tiendas)", async () => {
    await company(A, "Dup A1", "agencia", { tax_id: "111" });
    await assert.rejects(company(A, "Dup A2", "agencia", { tax_id: "111" }), (e) => surreal.isUniqueViolation(e));
    await company(B, "Dup B1", "agencia", { tax_id: "111" });
  });

  it("no lee ni escribe empresas de otra tienda", async () => {
    const id = await company(A, "Solo de A", "proveedor", { provider_type: "media_owner" });
    assert.equal(await store.getCompany(B, id), null);
    await store.patchCompany(B, id, { name: "hack" });
    assert.equal((await store.getCompany(A, id))?.name, "Solo de A");
  });

  it("provider_type exige kind proveedor", async () => {
    await assert.rejects(company(A, "Mal", "agencia", { provider_type: "other" }));
  });
});

describe("contactos", () => {
  let agency: string;
  before(async () => {
    agency = await company(A, "Agencia Contactos", "agencia");
  });

  it("un solo principal por empresa (el nuevo desplaza al anterior, atómico)", async () => {
    await store.createContact(A, { company_id: agency, first_name: "Uno", email: "uno@x.pe", is_primary: true }, "t");
    await store.createContact(A, { company_id: agency, first_name: "Dos", email: "dos@x.pe", is_primary: true }, "t");
    const rows = (await db.listCrmContacts(A, { companyId: agency })).rows;
    assert.deepEqual(rows.filter((r) => r.is_primary).map((r) => r.first_name), ["Dos"]);
  });

  it("email único por empresa sin importar mayúsculas; mismo email en otra empresa sí", async () => {
    assert.equal(await store.contactExists(agency, { email: "UNO@x.pe" }), true);
    await assert.rejects(store.createContact(A, { company_id: agency, email: "Uno@X.pe" }, null), (e) => surreal.isUniqueViolation(e));
    const other = await company(A, "Otra", "agencia");
    await store.createContact(A, { company_id: other, email: "uno@x.pe" }, null);
  });

  it("exige email o teléfono", async () => {
    await assert.rejects(store.createContact(A, { company_id: agency, first_name: "Sin canal" }, null));
  });

  it("no admite empresa de otra tienda", async () => {
    const foreign = await company(B, "Ajena", "agencia");
    await assert.rejects(store.createContact(A, { company_id: foreign, email: "z@z.pe" }, null));
  });
});

describe("vínculos, cuentas y fusión", () => {
  let ag: string, adv1: string, adv2: string, c1: string, c2: string;
  before(async () => {
    ag = await company(A, "Agencia Red", "agencia");
    adv1 = await company(A, "Anunciante Uno", "anunciante", { category_iab: "IAB1" });
    adv2 = await company(A, "Anunciante Dos", "anunciante", { category_iab: "IAB2" });
    await store.createContact(A, { company_id: ag, first_name: "Pía", email: "pia@red.pe" }, null);
    await store.createContact(A, { company_id: ag, first_name: "Leo", phone: "999" }, null);
    const rows = (await db.listCrmContacts(A, { companyId: ag })).rows;
    c1 = rows.find((r) => r.first_name === "Pía")!.id;
    c2 = rows.find((r) => r.first_name === "Leo")!.id;
  });

  it("vínculo único; reintento = violación de unicidad", async () => {
    await store.createLink(A, ag, adv1, "t");
    await store.createLink(A, ag, adv2, "t");
    assert.equal(await store.linkExists(A, ag, adv1), true);
    await assert.rejects(store.createLink(A, ag, adv1, "t"), (e) => surreal.isUniqueViolation(e));
    assert.deepEqual([...(await store.linkedAdvertisers(A, ag, [adv1, adv2]))].sort(), [adv1, adv2].sort());
  });

  it("cuentas por contacto: reemplaza el set y es idempotente", async () => {
    await store.replaceContactAccounts(A, c1, [adv1, adv2], "t");
    await store.replaceContactAccounts(A, c1, [adv1], "t");
    await store.replaceContactAccounts(A, c1, [adv1], "t");
    const co = await db.getCrmCompany(A, ag);
    assert.deepEqual(co?.contact_accounts, [{ contact_id: c1, advertiser_company_id: adv1 }]);
    assert.deepEqual(co?.incoming_accounts ?? [], []);
    const adv = await db.getCrmCompany(A, adv1);
    assert.deepEqual(adv?.incoming_accounts, [{ contact_id: c1, agency_company_id: ag }]);
  });

  it("atendidos por anunciante: reemplaza el set", async () => {
    await store.replaceAttendants(A, ag, adv2, [c1, c2], "t");
    assert.equal((await db.getCrmCompany(A, adv2))?.incoming_accounts.length, 2);
    await store.replaceAttendants(A, ag, adv2, [c2], "t");
    assert.deepEqual((await db.getCrmCompany(A, adv2))?.incoming_accounts.map((a) => a.contact_id), [c2]);
  });

  it("borrar el vínculo borra sus cuentas (atómico)", async () => {
    await store.deleteLinkAndAccounts(A, ag, adv1);
    assert.equal(await store.linkExists(A, ag, adv1), false);
    assert.equal((await db.getCrmCompany(A, adv1))?.incoming_accounts.length, 0);
    assert.equal(await store.linkExists(A, ag, adv2), true);
  });

  it("fusión: borra perdedores y el sobreviviente absorbe email y principal", async () => {
    const co = await company(A, "Fusión SA", "agencia");
    await store.createContact(A, { company_id: co, first_name: "Sobre", phone: "1" }, null);
    await store.createContact(A, { company_id: co, first_name: "Perd", email: "p@f.pe", phone: "2", is_primary: true }, null);
    const rows = (await db.listCrmContacts(A, { companyId: co })).rows;
    const survivor = rows.find((r) => r.first_name === "Sobre")!;
    const loser = rows.find((r) => r.first_name === "Perd")!;
    await store.mergeContacts(A, survivor.id, [loser.id], { email: "p@f.pe", is_primary: true }, "t", true, co);
    const after = (await db.listCrmContacts(A, { companyId: co })).rows;
    assert.equal(after.length, 1);
    assert.equal(after[0].email, "p@f.pe");
    assert.equal(after[0].is_primary, true);
  });
});

describe("búsqueda tolerante", () => {
  before(async () => {
    await company(A, "Línea Aérea Perú SAC", "anunciante", { tax_id: "20999", domain: "lap.pe" });
    await company(A, "Agencia Publicitaria Andina", "agencia");
  });
  const names = async (q: string) => (await db.listCrmCompanies(A, { q })).rows.map((r) => r.name);

  it("ignora tildes y mayúsculas, y calza subcadenas", async () => {
    assert.ok((await names("AEREA")).includes("Línea Aérea Perú SAC"));
    assert.ok((await names("telefon")).includes("Teléfonica del Perú"));
  });
  it("tolera typos de 4+ letras y exige todos los tokens (AND)", async () => {
    assert.ok((await names("publicitria")).includes("Agencia Publicitaria Andina"));
    assert.deepEqual(await names("andina zzzz"), []);
  });
  it("busca por tax_id y domain", async () => {
    assert.deepEqual(await names("20999"), ["Línea Aérea Perú SAC"]);
    assert.deepEqual(await names("lap.pe"), ["Línea Aérea Perú SAC"]);
  });
  it("filtra por tipo, estado y pagina con total exacto", async () => {
    const agencies = await db.listCrmCompanies(A, { kinds: ["agencia"], pageSize: 2 });
    assert.ok(agencies.total > 2);
    assert.equal(agencies.rows.length, 2);
    assert.equal((await db.listCrmCompanies(A, { kinds: [] })).total, 0);
    assert.equal((await db.listCrmCompanies(A, { status: "archived" })).total, 0);
  });
  it("contacts_count cuenta solo contactos activos de CADA empresa (agregado, no por fila)", async () => {
    const full = await company(A, "ConteoLleno SA", "agencia");
    const gone = await company(A, "ConteoArchivado SA", "agencia");
    const empty = await company(A, "ConteoVacio SA", "agencia");
    await store.createContact(A, { company_id: full, first_name: "Uno", phone: "11" }, null);
    await store.createContact(A, { company_id: full, first_name: "Dos", phone: "12" }, null);
    await store.createContact(A, { company_id: gone, first_name: "Baja", phone: "13" }, null);
    const [baja] = (await db.listCrmContacts(A, { companyId: gone })).rows;
    await store.setArchived("crm_contact", A, baja.id, true, "t");
    const count = async (id: string) => (await db.listCrmCompanies(A, { q: "Conteo", sortKey: "contacts" })).rows.find((r) => r.id === id)?.contacts_count;
    assert.equal(await count(full), 2);
    assert.equal(await count(gone), 0);
    assert.equal(await count(empty), 0);
  });
  it("contactos: el texto encuentra por nombre de empresa y el total sin texto es exacto", async () => {
    const byCompany = await db.listCrmContacts(A, { q: "fusion" });
    assert.ok(byCompany.rows.length >= 1);
    const all = await db.listCrmContacts(A, { limit: 1 });
    assert.ok(all.total > 1 && all.truncated);
  });
});
