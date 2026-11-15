// Guardián de auditoría de órdenes: quién crea / edita / cambia estado.
// Patrón `*_by` (email de sesión, null sin sesión) como approved_by/closed_by.
// Corre con: npm test (node:test vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const readRepo = (p: string) => readFileSync(join(ROOT, "..", p), "utf8");

describe("auditoría de órdenes (actor)", () => {
  it("el esquema de la orden lleva created_by/updated_by", () => {
    const p = "surreal/migrations/0006_orders.surql";
    assert.ok(existsSync(join(ROOT, "..", p)), `falta migración ${p}`);
    const src = readRepo(p);
    assert.ok(src.includes("DEFINE FIELD created_by ON io_order"), "io_order sin created_by");
    assert.ok(src.includes("DEFINE FIELD updated_by ON io_order"), "io_order sin updated_by");
  });

  it("resolveActor nunca inventa identidad (null sin sesión)", () => {
    const src = read("lib/actor.ts");
    assert.ok(src.includes("resolveActor"), "falta resolveActor");
    assert.ok(src.includes("getSessionUser"), "debe leer la sesión de usuario");
    assert.ok(src.includes("?? null"), "sin sesión debe quedar null");
  });

  it("crear orden sella created_by + updated_by", () => {
    const src = read("lib/order-actions.ts");
    assert.ok(src.includes("resolveActor"), "createOrderAction no resuelve actor");
    assert.ok(src.includes("created_by"), "insert sin created_by");
    assert.ok(src.includes("updated_by"), "insert sin updated_by");
  });

  it("el drawer muestra quién creó la orden", () => {
    const src = read("app/(dashboard)/orders/orden-drawer.tsx");
    assert.ok(src.includes("created_by"), "ficha sin creada por");
  });

  it("el esquema de empresas y contactos lleva created_by/updated_by", () => {
    const src = readRepo("surreal/migrations/0004_crm.surql");
    for (const t of ["crm_company", "crm_contact"]) {
      assert.ok(src.includes(`DEFINE FIELD created_by ON ${t} `), `${t} sin created_by`);
      assert.ok(src.includes(`DEFINE FIELD updated_by ON ${t} `), `${t} sin updated_by`);
    }
  });

  it("empresas y contactos sellan actor al crear y al editar", () => {
    const actions = read("lib/crm-actions.ts");
    const store = read("lib/crm-store.ts");
    assert.ok(actions.includes("resolveActor"), "crm-actions sin resolver actor");
    // Empresa: el action sella created_by; contacto: crm-store lo sella al crear (CREATE ... created_by = $actor).
    assert.ok(actions.includes("created_by: actor"), "create empresa sin sello");
    assert.ok(/CREATE type::record\('crm_contact', \$id\) SET[\s\S]*?created_by = \$actor/.test(store), "create contacto sin sello");
    assert.ok(actions.includes("updated_by") && store.includes("updated_by = $actor"), "edits sin updated_by");
  });

  it("el drawer de empresa muestra quién la creó", () => {
    const src = read("app/(dashboard)/companies/empresa-drawer.tsx");
    assert.ok(src.includes("created_by"), "ficha empresa sin creada por");
  });
});
