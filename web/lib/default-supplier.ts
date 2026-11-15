// Default de proveedor por empresa logueada (SSOT para Inventario y Ocupación).
// Regla: explícito manda (?proveedor=uuid | own | all). Sin param, default =
// empresa de la cuenta (email sesión → contacto → compañía) > empresa
// configurada de la tienda (sys_store.home_company) > red propia (casa,
// kind NULL → own) > todos. Solo aplican proveedor (su id) y casa (own);
// otros kinds no filtran. Nunca inventa: sin match → todos.
// Solo server: nunca importar en cliente.
import "server-only";

import { findContactCompanyByEmail, findHouseCompany, getCompany } from "@/lib/crm-store";
import { getStore } from "@/lib/stores-db";
import { resolveActor } from "@/lib/actor";

export type SupplierDefault = {
  /** Valor efectivo: uuid | "own" | "all". */
  supplierValue: string;
  /** Default resuelto cuando el param está ausente (para URLs sleek y clear). */
  defaultSupplierValue: string;
  /** UUID o null (own/all → null). */
  supplierId: string | null;
  ownOnly: boolean;
  casaName: string | null;
};

/** `explicit`: null = param ausente/vacío → resolver default. "all"/"own"/uuid = explícito. */
export async function resolveSupplierDefault(
  storeId: string,
  explicit: string | null,
): Promise<SupplierDefault> {
  // Empresa de la cuenta logueada: email de sesión → contacto → compañía.
  // (Sin match: se degrada a casa → todos, nunca inventa.)
  const actorEmail = (await resolveActor().catch(() => null))?.trim() || null;
  let myCompany: { id: string; kind: string | null } | null = null;
  if (actorEmail) {
    const companyId = await findContactCompanyByEmail(storeId, actorEmail);
    const row = companyId ? await getCompany(storeId, companyId) : null;
    if (row) myCompany = { id: String(row.id), kind: (row.kind as string | null) ?? null };
  }
  const casaName = (await findHouseCompany(storeId))?.name ?? null;
  // Vínculo tienda→empresa propia: dato configurado (sys_store.home_company), no heurística.
  let homeCompany: { id: string; kind: string | null } | null = null;
  const homeId = (await getStore(storeId))?.home_company_id;
  if (typeof homeId === "string" && homeId !== "") {
    const hrow = await getCompany(storeId, homeId);
    if (hrow) homeCompany = { id: String(hrow.id), kind: (hrow.kind as string | null) ?? null };
  }
  const pick = (co: { id: string; kind: string | null } | null): string | null =>
    !co ? null : co.kind === "proveedor" ? co.id : co.kind === null ? "own" : null;
  const defaultSupplierValue =
    pick(myCompany) ?? pick(homeCompany) ?? (casaName ? "own" : "all");
  const raw = (explicit ?? "").trim().toLowerCase();
  const supplierValue = raw !== "" ? raw : defaultSupplierValue;
  const supplierId =
    supplierValue !== "own" && supplierValue !== "all" ? supplierValue : null;
  return {
    supplierValue,
    defaultSupplierValue,
    supplierId,
    ownOnly: supplierValue === "own",
    casaName,
  };
}
