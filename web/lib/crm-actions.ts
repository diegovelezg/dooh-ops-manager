"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { repointCampaignContact } from "@/lib/orders-store";
import { isUniqueViolation } from "@/lib/surreal";
import { isCompanyKind, normalizeCompany, normalizeContact, type CompanyKind } from "@/lib/crm";
import { normalizeCommissionPct } from "@/lib/agency-commission";
import { resolveActor } from "@/lib/actor";
import { resolveTenantStoreAction as resolveTenantStore } from "@/lib/tenant";
import { createLogger } from "@/lib/log";
import * as store from "@/lib/crm-store";

const log = createLogger("crm");

export interface CrmState {
  orderId?: string;
  ok: boolean;
  message: string;
}

// SSOT: resolveTenantStore = resolveTenantStoreAction (ver lib/tenant.ts).

/** Cuerpo común de las acciones: error inesperado → log + mensaje (nunca se traga). */
function fail(action: string, e: unknown): CrmState {
  const message = e instanceof Error ? e.message : "Error.";
  log.error(action, { error: message });
  return { ok: false, message };
}

/** Resuelve tenant y exige `need` (por defecto seller). */
async function guard(need: "seller" | "admin" | null = "seller"): Promise<{ storeId: string } | CrmState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  if (need) {
    const { denyRole } = await import("@/lib/tenant");
    const denied = await denyRole(t.storeId, need);
    if (denied) return { ok: false, message: denied };
  }
  return { storeId: t.storeId };
}
const denied = (g: { storeId: string } | CrmState): g is CrmState => "ok" in g;

export async function createCompanyAction(form: FormData): Promise<CrmState> {
  const t = await resolveTenantStore("seller");
  if ("error" in t) return { ok: false, message: t.error };
  const kindRaw = String(form.get("kind") ?? "").trim();
  if (!isCompanyKind(kindRaw)) return { ok: false, message: "Tipo requerido: agencia, anunciante o proveedor." };
  const kind: CompanyKind = kindRaw;
  const commissionRaw = form.get("agency_commission_pct");
  const hasCommissionInput =
    commissionRaw !== null && String(commissionRaw).trim() !== "";
  let commissionPct: number | null = null;
  if (hasCommissionInput) {
    const parsed = normalizeCommissionPct(String(commissionRaw).trim());
    if (parsed === null) return { ok: false, message: "Comisión inválida (entero 0-100)." };
    commissionPct = parsed;
  }
  // La comisión solo aplica a agencias y solo la gestionan owner/admin.
  if (hasCommissionInput && kind !== "agencia") {
    return { ok: false, message: "Solo las agencias llevan comisión." };
  }
  if (hasCommissionInput) {
    const { denyRole } = await import("@/lib/tenant");
    const deny = await denyRole(t.storeId, "admin");
    if (deny) return { ok: false, message: deny };
  }
  const parsed = normalizeCompany({
    name: String(form.get("name") ?? ""),
    legal_name: String(form.get("legal_name") ?? "") || null,
    kind,
    tax_id: String(form.get("tax_id") ?? "") || null,
    domain: String(form.get("domain") ?? "") || null,
    email: String(form.get("email") ?? "") || null,
    phone: String(form.get("phone") ?? "") || null,
    address: String(form.get("address") ?? "") || null,
    city: String(form.get("city") ?? "") || null,
    country: String(form.get("country") ?? "") || null,
    notes: String(form.get("notes") ?? "") || null,
    external_ref: String(form.get("external_ref") ?? "") || null,
    category_iab: String(form.get("category_iab") ?? "") || null,
    provider_type: String(form.get("provider_type") ?? "") || null,
  });
  if (!parsed.ok) return { ok: false, message: parsed.error };
  // Clasificaciones obligatorias al crear (legados con null siguen editables).
  if (kind === "anunciante" && !parsed.value.category_iab) {
    return { ok: false, message: "Categoría requerida para anunciantes." };
  }
  if (kind === "proveedor" && !parsed.value.provider_type) {
    return { ok: false, message: "Tipo de proveedor requerido." };
  }
  try {
    const actor = await resolveActor();
    await store.createCompany(t.storeId, {
      ...parsed.value,
      ...(hasCommissionInput ? { agency_commission_pct: commissionPct } : {}),
      created_by: actor,
      updated_by: actor,
    });
    revalidatePath("/companies");
    return { ok: true, message: "Empresa creada." };
  } catch (e) {
    return fail("createCompanyAction", e);
  }
}

export async function setCompanyKindAction(input: { companyId: string; kind: CompanyKind }): Promise<CrmState> {
  const g = await guard();
  if (denied(g)) return g;
  if (!isCompanyKind(input.kind)) return { ok: false, message: "Tipo requerido: agencia, anunciante o proveedor." };
  try {
    const existing = await store.getCompany(g.storeId, input.companyId);
    if (!existing) return { ok: false, message: "Empresa no encontrada en esta tienda." };
    if (existing.deleted_at) return { ok: false, message: "Empresa archivada: restáurala para editarla." };
    await store.patchCompany(g.storeId, input.companyId, {
      kind: input.kind,
      // Al salir de proveedor el subtipo no aplica (el esquema lo exige).
      ...(input.kind === "proveedor" ? {} : { provider_type: null }),
      updated_by: await resolveActor(),
    });
    revalidatePath("/companies");
    revalidatePath(`/companies/${input.companyId}`);
    return { ok: true, message: "Tipo actualizado." };
  } catch (e) {
    return fail("setCompanyKindAction", e);
  }
}

/**
 * Edición inline de la ficha (drawer): identidad y contacto.
 * El tipo se edita con setCompanyKindAction; la comisión con su propio action.
 * Requiere rol vendedor o superior (FEATURE crm.edit).
 */
export async function updateCompanyAction(input: {
  companyId: string;
  patch: {
    name?: string | null;
    legal_name?: string | null;
    tax_id?: string | null;
    domain?: string | null;
    email?: string | null;
    phone?: string | null;
    city?: string | null;
    country?: string | null;
    address?: string | null;
    category_iab?: string | null;
    provider_type?: string | null;
  };
}): Promise<CrmState> {
  const g = await guard();
  if (denied(g)) return g;
  const companyId = String(input.companyId ?? "").trim();
  if (!companyId) return { ok: false, message: "Falta empresa." };
  try {
    const row = await store.getCompany(g.storeId, companyId);
    if (!row) return { ok: false, message: "Empresa no encontrada en esta tienda." };
    if (row.deleted_at) return { ok: false, message: "Empresa archivada: restáurala para editarla." };
    if (!isCompanyKind(row.kind)) return { ok: false, message: "Define el tipo de empresa primero." };
    const p = (input.patch ?? {}) as Record<string, string | null | undefined>;
    const val = (k: string, fb: unknown) => (p[k] !== undefined ? p[k] : ((fb as string | null | undefined) ?? null));
    const parsed = normalizeCompany({
      name: String(val("name", row.name) ?? ""),
      legal_name: val("legal_name", row.legal_name) as string | null,
      kind: row.kind,
      tax_id: val("tax_id", row.tax_id),
      domain: val("domain", row.domain),
      email: val("email", row.email),
      phone: val("phone", row.phone),
      address: val("address", row.address),
      city: val("city", row.city),
      country: val("country", row.country),
      category_iab: val("category_iab", row.category_iab),
      provider_type: val("provider_type", row.provider_type),
    });
    if (!parsed.ok) return { ok: false, message: parsed.error };
    const v = parsed.value;
    await store.patchCompany(g.storeId, companyId, {
      name: v.name,
      legal_name: v.legal_name,
      tax_id: v.tax_id,
      domain: v.domain,
      email: v.email,
      phone: v.phone,
      address: v.address,
      city: v.city,
      country: v.country,
      category_iab: v.category_iab,
      provider_type: v.provider_type,
      updated_by: await resolveActor(),
    });
    revalidatePath("/companies");
    revalidatePath(`/companies/${companyId}`);
    return { ok: true, message: "Empresa actualizada." };
  } catch (e) {
    return fail("updateCompanyAction", e);
  }
}

/**
 * Edición inline del contacto (drawer). Requiere rol vendedor o superior.
 * Si se marca principal, desmarca a los demás de la misma empresa (1 principal).
 */
export async function updateContactAction(input: {
  contactId: string;
  patch: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone?: string | null;
    job_title?: string | null;
    is_primary?: boolean;
  };
}): Promise<CrmState> {
  const g = await guard();
  if (denied(g)) return g;
  const contactId = String(input.contactId ?? "").trim();
  if (!contactId) return { ok: false, message: "Falta contacto." };
  try {
    const row = await store.getContact(g.storeId, contactId);
    if (!row) return { ok: false, message: "Contacto no encontrado en esta tienda." };
    if (row.deleted_at) return { ok: false, message: "Contacto archivado: restáuralo para editarlo." };
    const p = (input.patch ?? {}) as Record<string, string | boolean | null | undefined>;
    const sVal = (k: string, fb: unknown) => (p[k] !== undefined ? (p[k] as string | null) : ((fb as string | null | undefined) ?? null));
    const parsed = normalizeContact({
      company_id: typeof row.company_id === "string" ? row.company_id : null,
      first_name: sVal("first_name", row.first_name),
      last_name: sVal("last_name", row.last_name),
      email: sVal("email", row.email),
      phone: sVal("phone", row.phone),
      job_title: sVal("job_title", row.job_title),
      is_primary: p.is_primary !== undefined ? p.is_primary === true : row.is_primary === true,
    });
    if (!parsed.ok) return { ok: false, message: parsed.error };
    await store.patchContact(g.storeId, contactId, parsed.value as Record<string, unknown>, await resolveActor());
    revalidatePath("/contacts");
    revalidatePath("/companies");
    return { ok: true, message: "Contacto actualizado." };
  } catch (e) {
    return fail("updateContactAction", e);
  }
}

/**
 * Comisión de agencia (% sobre bruto, default a nivel empresa).
 * Solo agencias y solo owner/admin (FEATURE agency.commission.edit).
 * `pct` null/"" = sin acuerdo (NULL = 0 efectivo).
 */
export async function setAgencyCommissionAction(input: {
  companyId: string;
  pct: number | string | null;
}): Promise<CrmState> {
  const g = await guard("admin");
  if (denied(g)) return g;
  const pct = normalizeCommissionPct(input.pct);
  // Distingue "limpiar" (null/"") de valor inválido (p. ej. 150, 12.5 o texto).
  const raw = input.pct;
  const wantsClear = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
  if (!wantsClear && pct === null) return { ok: false, message: "Comisión inválida (entero 0-100)." };
  try {
    const co = await store.getCompany(g.storeId, input.companyId);
    if (!co) return { ok: false, message: "Empresa no encontrada en esta tienda." };
    if (co.deleted_at) return { ok: false, message: "Empresa archivada: restáurala para editarla." };
    if (co.kind !== "agencia") return { ok: false, message: "Solo las agencias llevan comisión." };
    await store.patchCompany(g.storeId, input.companyId, { agency_commission_pct: pct, updated_by: await resolveActor() });
    revalidatePath("/companies");
    revalidatePath(`/companies/${input.companyId}`);
    return { ok: true, message: pct === null ? "Comisión eliminada." : "Comisión actualizada." };
  } catch (e) {
    return fail("setAgencyCommissionAction", e);
  }
}

/**
 * Archiva o restaura una empresa (borrado lógico: las órdenes que la
 * referencian conservan el vínculo y el historial intacto).
 * Solo owner/admin (el maestro de empresas es dato sensible).
 */
export async function setCompanyArchivedAction(input: {
  companyId: string;
  archived: boolean;
}): Promise<CrmState> {
  const g = await guard("admin");
  if (denied(g)) return g;
  const companyId = String(input.companyId ?? "").trim();
  if (!companyId) return { ok: false, message: "Falta empresa." };
  try {
    if (!(await store.getCompany(g.storeId, companyId))) return { ok: false, message: "Empresa no encontrada en esta tienda." };
    await store.setArchived("crm_company", g.storeId, companyId, input.archived, await resolveActor());
    revalidatePath("/companies");
    revalidatePath(`/companies/${companyId}`);
    revalidatePath("/orders");
    revalidatePath("/orders/new");
    return { ok: true, message: input.archived ? "Empresa archivada." : "Empresa restaurada." };
  } catch (e) {
    return fail("setCompanyArchivedAction", e);
  }
}

/**
 * Archiva o restaura un contacto (borrado lógico). Requiere vendedor o superior.
 */
export async function setContactArchivedAction(input: {
  contactId: string;
  archived: boolean;
}): Promise<CrmState> {
  const g = await guard();
  if (denied(g)) return g;
  const contactId = String(input.contactId ?? "").trim();
  if (!contactId) return { ok: false, message: "Falta contacto." };
  try {
    if (!(await store.getContact(g.storeId, contactId))) return { ok: false, message: "Contacto no encontrado en esta tienda." };
    await store.setArchived("crm_contact", g.storeId, contactId, input.archived, await resolveActor());
    revalidatePath("/companies");
    revalidatePath("/contacts");
    revalidatePath("/orders");
    revalidatePath("/orders/new");
    return { ok: true, message: input.archived ? "Contacto archivado." : "Contacto restaurado." };
  } catch (e) {
    return fail("setContactArchivedAction", e);
  }
}

export async function createContactAction(form: FormData): Promise<CrmState> {
  const g = await guard();
  if (denied(g)) return g;
  const companyId = String(form.get("company_id") ?? "");
  if (!companyId) return { ok: false, message: "Falta empresa." };
  const parsed = normalizeContact({
    company_id: companyId,
    first_name: String(form.get("first_name") ?? "") || null,
    last_name: String(form.get("last_name") ?? "") || null,
    email: String(form.get("email") ?? "") || null,
    phone: String(form.get("phone") ?? "") || null,
    job_title: String(form.get("job_title") ?? "") || null,
    is_primary: form.get("is_primary") === "on",
    notes: undefined,
  });
  if (!parsed.ok) return { ok: false, message: parsed.error };
  try {
    // La empresa debe ser del mismo tenant.
    if (!(await store.getCompany(g.storeId, companyId))) return { ok: false, message: "Empresa no encontrada en esta tienda." };
    // Dedupe por empresa: mismo email o teléfono → ya existe (idempotente con import).
    if (await store.contactExists(companyId, { email: parsed.value.email, phone: parsed.value.phone })) {
      return { ok: true, message: "Contacto ya existía." };
    }
    await store.createContact(g.storeId, parsed.value as Record<string, unknown>, await resolveActor());
    revalidatePath(`/companies/${companyId}`);
    revalidatePath("/companies");
    revalidatePath("/contacts");
    return { ok: true, message: "Contacto agregado." };
  } catch (e) {
    return fail("createContactAction", e);
  }
}

/**
 * Vínculos explícitos agencia ↔ anunciante (pre-OI).
 * Crea el par (agency, advertiser); requiere vendedor o superior.
 * Valida tenant, activas y roles (agencia + anunciante). Idempotente:
 * si el par ya existe devuelve ok sin duplicar.
 */
export async function createCompanyLinkAction(input: {
  agencyCompanyId: string;
  advertiserCompanyId: string;
}): Promise<CrmState> {
  const g = await guard();
  if (denied(g)) return g;
  const { validateCompanyLinkPair } = await import("@/lib/company-links");
  const parsed = validateCompanyLinkPair({
    agencyCompanyId: input.agencyCompanyId,
    advertiserCompanyId: input.advertiserCompanyId,
  });
  if (!parsed.ok) return { ok: false, message: parsed.error };
  try {
    const byId = await store.getCompaniesById(g.storeId, [parsed.agencyCompanyId, parsed.advertiserCompanyId]);
    const agency = byId.get(parsed.agencyCompanyId);
    const advertiser = byId.get(parsed.advertiserCompanyId);
    if (!agency || !advertiser) return { ok: false, message: "Empresa no encontrada en esta tienda." };
    if (agency.deleted_at != null || advertiser.deleted_at != null) {
      return { ok: false, message: "Empresa archivada: restáurala para vincularla." };
    }
    if (agency.kind !== "agencia") return { ok: false, message: "La agencia debe tener tipo agencia." };
    if (advertiser.kind !== "anunciante") return { ok: false, message: "El anunciante debe tener tipo anunciante." };
    try {
      await store.createLink(g.storeId, parsed.agencyCompanyId, parsed.advertiserCompanyId, await resolveActor());
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: true, message: "El vínculo ya existía." };
      throw e;
    }
    revalidatePath("/companies");
    return { ok: true, message: "Vínculo creado." };
  } catch (e) {
    return fail("createCompanyLinkAction", e);
  }
}

/**
 * Elimina un vínculo explícito agencia ↔ anunciante.
 * Solo borra la fila manual/explícita; el historial de OIs sigue
 * mostrando la contraparte como derivada (ios>0).
 */
export async function deleteCompanyLinkAction(input: {
  agencyCompanyId: string;
  advertiserCompanyId: string;
}): Promise<CrmState> {
  const g = await guard();
  if (denied(g)) return g;
  const { validateCompanyLinkPair } = await import("@/lib/company-links");
  const parsed = validateCompanyLinkPair({
    agencyCompanyId: input.agencyCompanyId,
    advertiserCompanyId: input.advertiserCompanyId,
  });
  if (!parsed.ok) return { ok: false, message: parsed.error };
  try {
    if (!(await store.linkExists(g.storeId, parsed.agencyCompanyId, parsed.advertiserCompanyId))) {
      return { ok: false, message: "El vínculo ya no existe." };
    }
    // Las cuentas que colgaban del par pierden su requisito (vínculo previo):
    // se borran junto al vínculo (una transacción) para no dejar atendidos huérfanos.
    await store.deleteLinkAndAccounts(g.storeId, parsed.agencyCompanyId, parsed.advertiserCompanyId);
    revalidatePath("/companies");
    return { ok: true, message: "Vínculo eliminado." };
  } catch (e) {
    return fail("deleteCompanyLinkAction", e);
  }
}

/**
 * Cuentas que atiende un contacto de agencia (reemplazo del set).
 * Reglas: el contacto pertenece a una agencia, cada destino es anunciante y
 * el par (agencia, anunciante) ya existe como vínculo (primero se
 * vinculan las empresas, luego se asignan sus contactos). Requiere seller+.
 * Sin filas = sin asignación declarada. Idempotente.
 */
export async function setContactAccountsAction(input: {
  contactId: string;
  advertiserCompanyIds: string[];
}): Promise<CrmState> {
  const g = await guard();
  if (denied(g)) return g;
  const contactId = String(input.contactId ?? "").trim();
  if (!contactId) return { ok: false, message: "Falta el contacto." };
  const rawWanted = [...new Set((input.advertiserCompanyIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean))];
  try {
    const crow = await store.getContact(g.storeId, contactId);
    if (!crow) return { ok: false, message: "Contacto no encontrado en esta tienda." };
    if (crow.deleted_at) return { ok: false, message: "Contacto archivado: restáuralo para asignarle cuentas." };
    const agencyId = typeof crow.company_id === "string" ? crow.company_id : null;
    if (!agencyId) return { ok: false, message: "El contacto no tiene empresa: solo contactos de agencia atienden cuentas." };
    const arow = await store.getCompany(g.storeId, agencyId);
    if (!arow) return { ok: false, message: "Empresa no encontrada en esta tienda." };
    if (arow.deleted_at) return { ok: false, message: "Empresa archivada: restáurala para asignar cuentas." };
    if (arow.kind !== "agencia") return { ok: false, message: "Solo los contactos de agencia atienden anunciantes." };
    const { normalizeContactAccountSet } = await import("@/lib/contact-accounts");
    const normalized = normalizeContactAccountSet({ contactId, agencyCompanyId: agencyId, advertiserCompanyIds: rawWanted });
    if (!normalized.ok) return { ok: false, message: normalized.error };
    const wanted = normalized.value.advertiserCompanyIds;
    const actor = await resolveActor();
    if (wanted.length > 0) {
      // Destinos: existen, activos y son anunciantes del mismo tenant.
      const byId = await store.getCompaniesById(g.storeId, wanted);
      for (const id of wanted) {
        const c = byId.get(id);
        if (!c) return { ok: false, message: "Anunciante no encontrado en esta tienda." };
        if (c.deleted_at != null) return { ok: false, message: "Empresa archivada: restáurala para asignarla." };
        if (c.kind !== "anunciante") return { ok: false, message: "Las cuentas deben ser anunciantes." };
        if (id === agencyId) return { ok: false, message: "Agencia y anunciante deben ser empresas distintas." };
      }
      // Vínculo previo agencia ↔ anunciante exigido (no se autocrea).
      const linked = await store.linkedAdvertisers(g.storeId, agencyId, wanted);
      if (wanted.some((id) => !linked.has(id))) {
        return { ok: false, message: "Primero vincula la agencia con el anunciante y luego asigna sus contactos." };
      }
    }
    await store.replaceContactAccounts(g.storeId, contactId, wanted, actor);
    revalidatePath("/companies");
    revalidatePath("/contacts");
    return { ok: true, message: "Cuentas actualizadas." };
  } catch (e) {
    return fail("setContactAccountsAction", e);
  }
}

/**
 * Atendidos vista-anunciante: reemplaza qué contactos de UNA agencia
 * atienden a UN anunciante. Exige el vínculo agencia ↔ anunciante salvo
 * vaciado total (permite limpiar huérfanos cuyo vínculo ya se borró).
 * Requiere seller+.
 */
export async function setAccountAttendantsAction(input: {
  agencyCompanyId: string;
  advertiserCompanyId: string;
  contactIds: string[];
}): Promise<CrmState> {
  const g = await guard();
  if (denied(g)) return g;
  const { normalizeAgencyAttendantsSet } = await import("@/lib/contact-accounts");
  const normalized = normalizeAgencyAttendantsSet({
    agencyCompanyId: input.agencyCompanyId,
    advertiserCompanyId: input.advertiserCompanyId,
    contactIds: input.contactIds ?? [],
  });
  if (!normalized.ok) return { ok: false, message: normalized.error };
  const { agencyCompanyId, advertiserCompanyId, contactIds } = normalized.value;
  try {
    const byId = await store.getCompaniesById(g.storeId, [agencyCompanyId, advertiserCompanyId]);
    const agency = byId.get(agencyCompanyId);
    const advertiser = byId.get(advertiserCompanyId);
    if (!agency || !advertiser) return { ok: false, message: "Empresa no encontrada en esta tienda." };
    if (agency.deleted_at != null || advertiser.deleted_at != null) {
      return { ok: false, message: "Empresa archivada: restáurala para gestionarla." };
    }
    if (agency.kind !== "agencia") return { ok: false, message: "La agencia debe tener tipo agencia." };
    if (advertiser.kind !== "anunciante") return { ok: false, message: "El anunciante debe tener tipo anunciante." };
    if (contactIds.length > 0) {
      // Los atendidos pertenecen a la agencia y están activos.
      const team = await store.getContactsById(g.storeId, contactIds);
      for (const id of contactIds) {
        const c = team.get(id);
        if (!c) return { ok: false, message: "Contacto no encontrado en esta tienda." };
        if (c.deleted_at != null) return { ok: false, message: "Contacto archivado: restáuralo para asignarlo." };
        if (c.company_id !== agencyCompanyId) return { ok: false, message: "Solo contactos de la agencia pueden atenderla." };
      }
      // Vínculo previo exigido (no se autocrea).
      if (!(await store.linkExists(g.storeId, agencyCompanyId, advertiserCompanyId))) {
        return { ok: false, message: "Primero vincula la agencia con el anunciante y luego asigna sus contactos." };
      }
    }
    await store.replaceAttendants(g.storeId, agencyCompanyId, advertiserCompanyId, contactIds, await resolveActor());
    revalidatePath("/companies");
    revalidatePath("/contacts");
    return { ok: true, message: "Atendidos actualizados." };
  } catch (e) {
    return fail("setAccountAttendantsAction", e);
  }
}

// Variante para `useActionState` en /companies/new: en éxito redirige
// al listado; en error devuelve el mensaje sin navegar.
export async function createCompanyRedirectAction(_prev: CrmState, form: FormData): Promise<CrmState> {
  const res = await createCompanyAction(form);
  if (res.ok) redirect("/companies");
  return res;
}
// Variante para `useActionState` en /contacts/new: en éxito redirige
// al listado; en error devuelve el mensaje sin navegar.
export async function createContactRedirectAction(_prev: CrmState, form: FormData): Promise<CrmState> {
  const res = await createContactAction(form);
  if (res.ok) redirect("/contacts");
  return res;
}

/**
 * Fusiona contactos duplicados: el sobreviviente conserva su empresa y
 * absorbe datos faltantes; las campañas que apuntaban a los eliminados
 * se re-apuntan; `is_primary` se preserva (si algún eliminado era principal
 * y el sobreviviente no, este pasa a serlo, liberando al anterior de su
 * empresa para respetar 1 principal por empresa).
 */
export async function mergeContactsAction(input: { survivorId: string; loserIds: string[] }): Promise<CrmState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const loserIds = [...new Set((input.loserIds ?? []).filter((id) => id && id !== input.survivorId))];
  if (!input.survivorId || loserIds.length === 0) return { ok: false, message: "Elige el contacto que queda y al menos uno para fusionar." };
  try {
    const found = await store.getContactsById(t.storeId, [input.survivorId, ...loserIds]);
    const survivor = found.get(input.survivorId);
    if (!survivor) return { ok: false, message: "El contacto que queda ya no existe." };
    const losers = loserIds.map((id) => found.get(id)).filter((c): c is Record<string, unknown> => !!c);
    if (losers.length === 0) return { ok: false, message: "Los contactos a fusionar ya no existen." };
    // Rellena huecos del sobreviviente con datos de los eliminados (en orden).
    // Se aplica DESPUÉS de borrar: si el sobreviviente absorbe el email o
    // teléfono de un eliminado de su misma empresa, el update no choca con
    // los índices únicos.
    const patch: Record<string, unknown> = {};
    for (const f of ["first_name", "last_name", "email", "phone", "job_title"] as const) {
      if (survivor[f] == null || String(survivor[f]).trim() === "") {
        const donor = losers.find((l) => l[f] != null && String(l[f]).trim() !== "");
        if (donor) patch[f] = donor[f];
      }
    }
    const survivorCompany = (survivor.company_id as string | null) ?? null;
    const promote = survivor.is_primary !== true && losers.some((l) => l.is_primary === true);
    if (promote) patch.is_primary = true;
    // Re-apunta campañas ANTES de borrar: sin esto (REFERENCE ON DELETE UNSET) el
    // delete dejaría primary_contact vacío y se perdería el vínculo.
    await repointCampaignContact(t.storeId, loserIds, input.survivorId);
    await store.mergeContacts(t.storeId, input.survivorId, loserIds, patch, await resolveActor(), promote, survivorCompany);
    revalidatePath("/contacts");
    revalidatePath("/contacts/duplicates");
    return { ok: true, message: `Fusionados ${losers.length + 1} contactos en uno.` };
  } catch (e) {
    return fail("mergeContactsAction", e);
  }
}
