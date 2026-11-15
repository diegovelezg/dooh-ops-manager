"use server";

import { consumesCapacity } from "@/lib/order-workflow";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as orders from "@/lib/orders-store";
import { thrownMessage } from "@/lib/surreal";
import { getCompany, getContact, getContactsById, createLink } from "@/lib/crm-store";
import { isUniqueViolation } from "@/lib/surreal";
import { listScreensBrief } from "@/lib/screens-store";

/** Vínculo agencia↔anunciante nacido de una OI (origin='oi'). Idempotente: si el par ya existía, nada. */
async function createOrderLink(storeId: string, agencyId: string, advertiserId: string, actor: string | null): Promise<void> {
  try {
    await createLink(storeId, agencyId, advertiserId, actor, "oi");
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
}
import { getStore } from "@/lib/stores-db";
import { resolveTenantStoreAction as resolveTenantStore } from "@/lib/tenant";
import { getScreenOccupancy, type ScreenConflict } from "@/lib/availability";
import { DEFAULT_SLOTS_PER_SCREEN } from "@/lib/store-slots";
import { resolveActor } from "@/lib/actor";
import { isValidCurrency, normalizeCurrency } from "@/lib/currency";
import { addDays, dayOf, dayStart, displayEndOf, formatDate, isISODateShape } from "@/lib/format";
import { getStoreTimeZone } from "@/lib/stores-db";
import type { CrmState } from "@/lib/crm-actions";
import { createLogger } from "@/lib/log";

const log = createLogger("orders");

// SSOT: resolveTenantStore = resolveTenantStoreAction (ver lib/tenant.ts).

/** Crea la OI en borrador con número autogenerado (etapa Firmada).
 *  Líneas y OM llegan después. */
export async function createOrderAction(form: FormData): Promise<CrmState> {
  const t = await resolveTenantStore("seller");
  if ("error" in t) return { ok: false, message: t.error };
  // Anunciante (bloque 1): requerido siempre; el contratante es él mismo
  // (directo) o una agencia. La marca sigue siendo texto libre del pedido.
  const advertiserRaw = String(form.get("advertiser_company_id") ?? "").trim() || null;
  if (!advertiserRaw) return { ok: false, message: "Anunciante requerido." };
  const company = String(form.get("company_id") ?? "").trim() || advertiserRaw;
  if (!company) return { ok: false, message: "Empresa requerida." };
  const brand = String(form.get("brand") ?? "").trim() || null;
  if (!brand) return { ok: false, message: "Marca requerida." };
  if (brand.length > 200) return { ok: false, message: "Marca muy larga (máx 200)." };
  const notes = String(form.get("notes") ?? "").trim() || null;
  if (notes !== null && notes.length > 2000) return { ok: false, message: "Notas muy largas (máx 2000)." };
  // Condición de pago en días (0 = Contado). Fuente numérica para vencimientos:
  // due_date = issue_date + N días. El texto es solo display (paymentTermsLabel).
  const termsRaw = String(form.get("payment_terms_days") ?? "").trim();
  const payment_terms_days = termsRaw === "" ? null : Number(termsRaw);
  // Documento para facturación (select único requerido → 3 flags).
  const billingDoc = String(form.get("billing_doc") ?? "").trim();
  if (billingDoc && !["orden_medios", "orden_compra", "contrato"].includes(billingDoc)) {
    return { ok: false, message: "Documento para facturación requerido." };
  }
  const billing_detail = String(form.get("billing_detail") ?? "").trim() || null;
  if (billing_detail !== null && billing_detail.length > 500) {
    return { ok: false, message: "Detalle de facturación muy largo (máx 500)." };
  }
  const invoice_registration = String(form.get("invoice_registration") ?? "").trim() || null;
  if (invoice_registration !== null && invoice_registration.length > 500) {
    return { ok: false, message: "Registro de factura muy largo (máx 500)." };
  }
  const billing_portal_email = String(form.get("billing_portal_email") ?? "").trim() || null;
  if (billing_portal_email !== null && billing_portal_email.length > 320) {
    return { ok: false, message: "Correo y/o portal muy largo (máx 320)." };
  }
  if (payment_terms_days !== null && (!Number.isInteger(payment_terms_days) || payment_terms_days < 0)) {
    return { ok: false, message: "Condición de pago inválida." };
  }
  // Moneda de la IO (default: moneda del tenant). Un país puede operar PEN+USD.
  const currencyRaw = normalizeCurrency(form.get("currency"), "");
  let orderCurrency: string | null = null;
  try {
    orderCurrency = normalizeCurrency((await getStore(t.storeId))?.shop_currency, "PEN");
  } catch {
    orderCurrency = "PEN";
  }
  if (currencyRaw) {
    // isValidCurrency rechaza ISO3 falsos (XXX/ZZZ/XTS/...) que el regex suelto aceptaba.
    if (!isValidCurrency(currencyRaw)) {
      return { ok: false, message: "Moneda inválida (usa PEN, USD…)." };
    }
    orderCurrency = currencyRaw;
  }
  // Líneas: mismo largo en los 6 arreglos (una fila por pantalla).
  const screens = form.getAll("screen_id").map((v) => String(v).trim());
  const inis = form.getAll("line_starts_at").map((v) => String(v).trim());
  const fins = form.getAll("line_ends_at").map((v) => String(v).trim());
  const totals = form.getAll("line_total").map((v) => String(v).trim().replace(",", "."));
  const dias = form.getAll("line_cant_dias").map((v) => String(v).trim().replace(",", "."));
  const slotsRaw = form.getAll("line_slots").map((v) => String(v).trim());
  if (slotsRaw.length > 0 && slotsRaw.length !== screens.length) {
    return { ok: false, message: "Líneas incompletas." };
  }
  const { normalizeLineSlots } = await import("@/lib/order-lines");
  if (screens.length === 0 || screens.some((s) => !s)) {
    return { ok: false, message: "Cada línea necesita su pantalla." };
  }
  if (![inis.length, fins.length, totals.length, dias.length].every((n) => n === screens.length)) {
    return { ok: false, message: "Líneas incompletas." };
  }
  const parsedLines: Array<{ screen: string; total: number; cant_dias: number | null; cant_slots: number }> = [];
  for (let i = 0; i < screens.length; i++) {
    if (!inis[i] || !fins[i]) return { ok: false, message: `Línea ${i + 1}: periodo requerido.` };
    if (fins[i] < inis[i]) return { ok: false, message: `Línea ${i + 1}: fin anterior al inicio.` };
    const total = Number(totals[i]);
    if (!Number.isFinite(total) || total <= 0) return { ok: false, message: `Línea ${i + 1}: total inválido.` };
    const cant = dias[i] ? Number(dias[i]) : NaN;
    const cantSlots = normalizeLineSlots(slotsRaw[i] ?? "", { blankInvalid: true });
    if (cantSlots === null) return { ok: false, message: `Línea ${i + 1}: slots inválidos (1–100).` };
    parsedLines.push({
      screen: screens[i],
      total,
      cant_dias: Number.isFinite(cant) && cant > 0 ? cant : null,
      cant_slots: cantSlots,
    });
  }
  try {
    // Anti-sobreventa en la venta: el cliente no es la garantía (carrera entre
    // dos vendedores). Dos chequeos: solape intra-orden (la propia orden no
    // puede sumar cupo contra sí misma) y cupo por línea contra lo vigente
    // (su periodo × su q, no MAX sobre el envoltorio).
    const { findLineOverlaps } = await import("@/lib/order-lines");
    if (
      findLineOverlaps(parsedLines.map((l, i) => ({ screen_id: l.screen, starts: inis[i], ends: fins[i], total: l.total }))).length > 0
    ) {
      return { ok: false, message: "Dos líneas usan la misma pantalla en periodos que se cruzan." };
    }
    // Las contrapartes deben pertenecer al tenant y estar activas (nada
    // nuevo con archivados; lo firmado vive en el snapshot de la NP).
    const cos = await getCompany(t.storeId, company);
    if (!cos) return { ok: false, message: "Empresa fuera de tu tienda." };
    {
      const { archivedBlockerMessage } = await import("@/lib/order-guards");
      const block = archivedBlockerMessage([
        {
          label: "facturador",
          archived: (cos as Record<string, unknown>).deleted_at != null,
          name: (cos as Record<string, unknown>).name as string | null,
        },
      ]);
      if (block) return { ok: false, message: block };
    }
    // El tipo manda: agencia → factura ella y el anunciante queda en la marca;
    // anunciante → anuncia y paga directo. Proveedor (o sin tipo) no puede
    // ser contratante: el picker no lo ofrece y aquí se rechaza el POST
    // directo ("contratante" marca el campo en el form).
    const kind = (cos as Record<string, unknown>).kind;
    // Anunciante: misma tienda, tipo anunciante, no archivado.
    const adv = await getCompany(t.storeId, advertiserRaw);
    if (!adv) return { ok: false, message: "Anunciante no encontrado en esta tienda." };
    {
      const { archivedBlockerMessage } = await import("@/lib/order-guards");
      const block = archivedBlockerMessage([
        {
          label: "anunciante",
          archived: (adv as Record<string, unknown>).deleted_at != null,
          name: (adv as Record<string, unknown>).name as string | null,
        },
      ]);
      if (block) return { ok: false, message: block };
    }
    // Reglas puras (testeadas): anunciante tipo anunciante; contratante =
    // el propio anunciante (directo) o una agencia.
    const { resolveOrderParties } = await import("@/lib/company-links");
    const parties = resolveOrderParties({
      billingId: company,
      billingKind: kind,
      advertiserId: advertiserRaw,
      advertiserKind: (adv as Record<string, unknown>).kind,
    });
    if (!parties.ok) return { ok: false, message: parties.error };
    const billing = parties.billingCompanyId;
    const advertiser = parties.advertiserCompanyId;
    // Intermediaria (Opción B): check "es el contratante" (default) o agencia
    // definida desde Empresas. Sin texto manual: todo sale de Empresas.
    const agencySelf = String(form.get("agency_is_self") ?? "") === "1";
    let agency_company_id: string | null = null;
    if (agencySelf) {
      agency_company_id = company;
    } else {
      const agencyRaw = String(form.get("agency_company_id") ?? "").trim() || null;
      if (!agencyRaw) return { ok: false, message: "Define la intermediaria o marca que es el contratante." };
      const ag = await getCompany(t.storeId, agencyRaw);
      if (!ag) return { ok: false, message: "Agencia intermediaria no encontrada en esta tienda." };
      if ((ag as Record<string, unknown>).kind !== "agencia") {
        return { ok: false, message: "La agencia intermediaria debe ser una agencia de tu tienda." };
      }
      {
        const { archivedBlockerMessage } = await import("@/lib/order-guards");
        const block = archivedBlockerMessage([
          {
            label: "intermediaria",
            archived: (ag as Record<string, unknown>).deleted_at != null,
            name: (ag as Record<string, unknown>).name as string | null,
          },
        ]);
        if (block) return { ok: false, message: block };
      }
      agency_company_id = String((ag as Record<string, unknown>).id);
    }
    // Contactos por rol: existen en la tienda y pertenecen al contratante
    // o a la intermediaria (las únicas empresas del caso). null = sin definir.
    const contactIds: Record<string, string | null> = {
      billing_contact_id: String(form.get("billing_contact_id") ?? "").trim() || null,
      signer_contact_id: String(form.get("signer_contact_id") ?? "").trim() || null,
      payment_contact_id: String(form.get("payment_contact_id") ?? "").trim() || null,
      manager_contact_id: String(form.get("manager_contact_id") ?? "").trim() || null,
    };
    const contactLabels: Record<string, string> = {
      billing_contact_id: "POC",
      signer_contact_id: "firmante",
      payment_contact_id: "pago",
      manager_contact_id: "responsable",
    };
    const wanted = Object.values(contactIds).filter((x): x is string => !!x);
    if (wanted.length > 0) {
      const byId = await getContactsById(t.storeId, [...new Set(wanted)]);
      const allowedCompanies = new Set([company, agency_company_id].filter((x): x is string => !!x));
      const { archivedBlockerMessage } = await import("@/lib/order-guards");
      const fullName = (r: Record<string, unknown>): string | null => {
        const n = [r.first_name, r.last_name].filter((v) => typeof v === "string" && (v as string).trim()).join(" ");
        if (n) return n;
        return typeof r.email === "string" && r.email ? r.email : null;
      };
      const archivedRefs: Array<{ label: string; archived: boolean; name: string | null }> = [];
      for (const [key, cid] of Object.entries(contactIds)) {
        if (!cid) continue;
        const r = byId.get(cid);
        if (!r) return { ok: false, message: `Contacto (${contactLabels[key]}) no encontrado en esta tienda.` };
        const owner = r.company_id != null ? String(r.company_id) : null;
        if (!owner) return { ok: false, message: `Contacto (${contactLabels[key]}) no encontrado en esta tienda.` };
        if (!allowedCompanies.has(owner)) {
          return { ok: false, message: `Contacto (${contactLabels[key]}) fuera del contratante y la intermediaria.` };
        }
        archivedRefs.push({ label: contactLabels[key], archived: r.deleted_at != null, name: fullName(r) });
      }
      const block = archivedBlockerMessage(archivedRefs);
      if (block) return { ok: false, message: block };
    }
    // Auditoría: quién crea (y primer editor). Todo update futuro de la orden
    // (editar, firmar, cancelar) debe sellar updated_by + updated_at.
    const actor = await resolveActor();
    const base = {
      advertiser_company_id: advertiser,
      billing_company_id: billing,
      brand,
      notes,
      agency_company_id,
      billing_contact_id: contactIds.billing_contact_id,
      signer_contact_id: contactIds.signer_contact_id,
      payment_contact_id: contactIds.payment_contact_id,
      manager_contact_id: contactIds.manager_contact_id,
      doc_orden_medios: billingDoc === "orden_medios",
      doc_orden_compra: billingDoc === "orden_compra",
      doc_contrato: billingDoc === "contrato",
      billing_detail,
      invoice_registration,
      billing_portal_email,
      authorization_kind: billingDoc === "contrato" ? "CONTRACT" : billingDoc === "orden_compra" ? "OC" : billingDoc === "orden_medios" ? "OM" : undefined,
      status: "draft",
      currency: orderCurrency ?? "PEN",
      // El periodo de la OI (envolvente de sus líneas) lo fija la DB al guardar las líneas.
      payment_terms_days,
      created_by: actor,
      updated_by: actor,
    };
    // Valida pantallas del tenant antes de insertar.
    const wantedScreens = [...new Set(parsedLines.map((l) => l.screen))];
    if ((await listScreensBrief(t.storeId, { ids: wantedScreens })).length !== wantedScreens.length) {
      return { ok: false, message: "Pantalla fuera de tu inventario." };
    }
    // Una transacción: número correlativo + orden + líneas + guardia de capacidad. La DB es la
    // autoridad ante concurrentes (registro compartido por pantalla); un conflicto de escritura
    // lo reintenta el cliente con datos frescos. Si no hay cupo, no queda nada a medias.
    let orderId: string;
    try {
      orderId = await orders.createOrderWithLines(
        t.storeId,
        base,
        parsedLines.map((l, i) => ({ screen_id: l.screen, starts: inis[i], ends: fins[i], total: l.total, slots: l.cant_slots })),
        actor,
      );
    } catch (e) {
      const msg = thrownMessage(e);
      if (/sin slots|cupo/i.test(msg)) {
        log.warn("createOrderAction", { fail: `capacity guard: ${msg}` });
        return { ok: false, message: "Sin cupo en ese periodo (otra venta lo tomó primero). Reintenta." };
      }
      throw e;
    }
    {
      // Vínculo explícito agencia ↔ anunciante (origin='oi', best-effort):
      // la OI asegura el par para que Vínculos lo muestre aunque sea la
      // primera operación conjunta. Nunca bloquea la creación.
      try {
        const { linkPairForOrder } = await import("@/lib/company-links");
        const pair = linkPairForOrder({
          advertiserCompanyId: advertiser,
          billingCompanyId: billing,
          agencyCompanyId: agency_company_id,
        });
        if (pair) {
          await createOrderLink(t.storeId, pair.agencyCompanyId, pair.advertiserCompanyId, actor);
        }
      } catch {
        // Best-effort: la red derivada de OIs sigue mostrando la contraparte.
      }
      revalidatePath("/orders");
      return { ok: true, message: "Cotización guardada, sin retener capacidad.", orderId };
    }
  } catch (e) {
    log.error("createOrderAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

export async function createOrderRedirectAction(_prev: CrmState, form: FormData): Promise<CrmState> {
  const res = await createOrderAction(form);
  if (res.ok && res.orderId) redirect(`/orders/${res.orderId}`);
  return res;
}

/**
 * Edición inline de la ficha (drawer): marca, condición de pago y notas.
 * No toca líneas ni fechas (afectan disponibilidad/inventario).
 * Requiere rol vendedor o superior; solo borradores (firmada/autorizada
 * congela la NP: lo firmado vive en el snapshot inmutable).
 */
export async function updateOrderAction(input: {
  orderId: string;
  patch: {
    brand?: string | null;
    payment_terms_days?: number | string | null;
    notes?: string | null;
    doc_orden_medios?: boolean | null;
    doc_orden_compra?: boolean | null;
    doc_contrato?: boolean | null;
    billing_portal_email?: string | null;
    billing_detail?: string | null;
    invoice_registration?: string | null;
    agency_company_id?: string | null;
    commission_pct?: number | string | null;
    billing_contact_id?: string | null;
    signer_contact_id?: string | null;
    payment_contact_id?: string | null;
    manager_contact_id?: string | null;
  };
}): Promise<CrmState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const { denyRole } = await import("@/lib/tenant");
  const denied = await denyRole(t.storeId, "seller");
  if (denied) return { ok: false, message: denied };
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  try {
    const existing = await orders.getOrder(t.storeId, orderId);
    if (!existing) return { ok: false, message: "Orden no encontrada en esta tienda." };
    const st = String(existing.status ?? "");
    if (st === "cancelled") {
      return { ok: false, message: "La orden está cancelada." };
    }
    if (st !== "draft") {
      return { ok: false, message: "La orden ya está firmada: la ficha ya no se edita." };
    }
    const p = (input.patch ?? {}) as Record<string, unknown>;
    const brand = p.brand !== undefined ? String(p.brand ?? "").trim() || null : undefined;
    let terms: number | null | undefined;
    if (p.payment_terms_days !== undefined) {
      const raw = p.payment_terms_days;
      terms = raw === null || raw === "" ? null : Number(raw);
      if (terms !== null && (!Number.isInteger(terms) || terms < 0)) {
        return { ok: false, message: "Condición de pago inválida." };
      }
    }
    const notes = p.notes !== undefined ? String(p.notes ?? "").trim() || null : undefined;
    // Ficha NP: topes espejo del cliente (`order-validation.ts`).
    let np: Record<string, string | boolean | number | null>;
    try {
      // Sección III: checkboxes + texto libre con topes espejo del cliente.
      const bool = (key: string): boolean | undefined =>
        p[key] === undefined ? undefined : String(p[key]) === "true" || p[key] === true;
      const text500 = (key: string, label: string): string | null | undefined => {
        if (p[key] === undefined) return undefined;
        const s = String(p[key] ?? "").trim() || null;
        if (s !== null && s.length > 500) throw new Error(`${label} muy largo (máx 500).`);
        return s;
      };
      const portal_raw = p.billing_portal_email === undefined ? undefined : String(p.billing_portal_email ?? "").trim() || null;
      if (portal_raw !== undefined && portal_raw !== null && portal_raw.length > 320) {
        throw new Error("Correo y/o portal muy largo (máx 320).");
      }
      const billing_detail = text500("billing_detail", "Detalle de facturación");
      const invoice_registration = text500("invoice_registration", "Registro de factura");
      // Opción B: intermediaria vinculada (empresa del tenant).
      // El contratante (billing) se acepta tal cual (check "es el contratante",
      // cualquier kind); otra empresa debe ser agencia de la tienda.
      // Sin texto manual: todo sale de Empresas.
      let agency_company_id: string | null | undefined;
      if (p.agency_company_id !== undefined) {
        const raw = String(p.agency_company_id ?? "").trim();
        if (!raw) {
          agency_company_id = null;
        } else {
          const billingId = existing.billing_company_id != null ? String(existing.billing_company_id) : null;
          if (billingId !== null && raw === billingId) {
            agency_company_id = raw;
          } else {
            const ag = await getCompany(t.storeId, raw);
            if (!ag) throw new Error("Agencia intermediaria no encontrada en esta tienda.");
            if ((ag as Record<string, unknown>).kind !== "agencia") {
              throw new Error("La agencia intermediaria debe ser una agencia de tu tienda.");
            }
            if ((ag as Record<string, unknown>).deleted_at != null) {
              throw new Error(
                `Intermediaria (${String((ag as Record<string, unknown>).name ?? "").trim() || "sin nombre"}) archivada: restáurala para operar con esta orden.`,
              );
            }
            agency_company_id = String((ag as Record<string, unknown>).id);
          }
        }
      }
      let commission_pct: number | null | undefined;
      if (p.commission_pct !== undefined) {
        const { normalizeCommissionPct } = await import("@/lib/agency-commission");
        const raw = p.commission_pct;
        const wantsClear = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
        if (wantsClear) {
          commission_pct = null;
        } else {
          const pct = normalizeCommissionPct(raw);
          if (pct === null) throw new Error("Comisión inválida (entero 0-100).");
          const { denyRole } = await import("@/lib/tenant");
          const denied = await denyRole(t.storeId, "admin", "La comisión por orden requiere rol admin o propietario.");
          if (denied) throw new Error(denied);
          commission_pct = pct;
        }
      }
      np = {
        doc_orden_medios: bool("doc_orden_medios") ?? false,
        doc_orden_compra: bool("doc_orden_compra") ?? false,
        doc_contrato: bool("doc_contrato") ?? false,
        billing_portal_email: portal_raw ?? null,
        billing_detail: billing_detail ?? null,
        invoice_registration: invoice_registration ?? null,
      };
      if (agency_company_id !== undefined) np.agency_company_id = agency_company_id;
      if (commission_pct !== undefined) np.commission_pct = commission_pct;
      // Contactos por rol (FK): existen en la tienda. null/vacío = desvincular.
      // El GUI ofrece solo contactos de las empresas del caso.
      const contactLink = async (key: string, label: string): Promise<string | null | undefined> => {
        if (p[key] === undefined) return undefined;
        const raw = String(p[key] ?? "").trim();
        if (!raw) return null;
        const ct = await getContact(t.storeId, raw);
        if (!ct) throw new Error(`Contacto (${label}) no encontrado en esta tienda.`);
        if ((ct as Record<string, unknown>).deleted_at != null) {
          throw new Error(`Contacto (${label}) archivado: restáuralo para operar con esta orden.`);
        }
        return String((ct as Record<string, unknown>).id);
      };
      const billing_contact_id = await contactLink("billing_contact_id", "POC");
      const signer_contact_id = await contactLink("signer_contact_id", "firmante");
      const payment_contact_id = await contactLink("payment_contact_id", "pago");
      const manager_contact_id = await contactLink("manager_contact_id", "responsable");
      if (billing_contact_id !== undefined) np.billing_contact_id = billing_contact_id;
      if (signer_contact_id !== undefined) np.signer_contact_id = signer_contact_id;
      if (payment_contact_id !== undefined) np.payment_contact_id = payment_contact_id;
      if (manager_contact_id !== undefined) np.manager_contact_id = manager_contact_id;
    } catch (e) {
      log.error("updateOrderAction", { error: e instanceof Error ? e.message : String(e) });
      return { ok: false, message: e instanceof Error ? e.message : "Campo inválido." };
    }
    const patch: Record<string, unknown> = {};
    if (brand !== undefined) patch.brand = brand;
    if (terms !== undefined) patch.payment_terms_days = terms;
    if (notes !== undefined) patch.notes = notes;
    for (const [k, v] of Object.entries(np)) {
      if (p[k] !== undefined) patch[k] = v;
    }
    if (Object.keys(patch).length === 0) return { ok: true, message: "Sin cambios." };
    const actor = await resolveActor();
    await orders.patchOrder(t.storeId, orderId, { ...patch, updated_by: actor });
    // Si cambió la intermediaria, asegura el vínculo explícito (origin='oi').
    if (p.agency_company_id !== undefined) {
      try {
        const r = (await orders.getOrder(t.storeId, orderId)) ?? {};
        const { linkPairForOrder } = await import("@/lib/company-links");
        const pair = linkPairForOrder({
          advertiserCompanyId: typeof r.advertiser_company_id === "string" ? r.advertiser_company_id : null,
          billingCompanyId: typeof r.billing_company_id === "string" ? r.billing_company_id : null,
          agencyCompanyId: typeof r.agency_company_id === "string" ? r.agency_company_id : null,
        });
        if (pair) {
          await createOrderLink(t.storeId, pair.agencyCompanyId, pair.advertiserCompanyId, actor);
        }
      } catch {
        // Best-effort: no bloquea la edición de la ficha.
      }
    }
    revalidatePath("/orders");
    return { ok: true, message: "Orden actualizada." };
  } catch (e) {
    log.error("updateOrderAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

export interface AvailabilityState {
  ok: boolean;
  conflicts: ScreenConflict[];
  /** screenId → día "yyyy-mm-dd" → slots libres (ventana pedida). */
  remaining: Record<string, Record<string, number>>;
  capacities: Record<string, number>;
  message: string;
}

/**
 * Reemplaza las líneas de una orden en borrador (editar pantallas).
 * Solo borradores sin facturas ni reservas: firmadas tienen bookings y
 * cobranza que no se rebookean aquí. Chequeo anti-sobreventa excluyendo la
 * propia orden + reemplazo atómico vía `io_replace_lines`.
 * Requiere rol vendedor o superior.
 */
export async function updateOrderLinesAction(input: {
  orderId: string;
  lines: Array<{
    screen_id: unknown;
    starts: unknown;
    ends: unknown;
    total: unknown;
    slots?: unknown;
    notes?: unknown;
  }>;
}): Promise<CrmState> {
  const t = await resolveTenantStore("seller");
  if ("error" in t) return { ok: false, message: t.error };
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  const { validateOrderLines, totalToMinor, findLineOverlaps, normalizeLineSlots } = await import("@/lib/order-lines");
  const lines = ((input.lines ?? []) as Array<Record<string, unknown>>).map((l) => ({
    screen_id: typeof l.screen_id === "string" ? l.screen_id.trim() : "",
    starts: typeof l.starts === "string" ? l.starts.trim() : "",
    ends: typeof l.ends === "string" ? l.ends.trim() : "",
    total: (l.total as string | number) ?? "",
    // Sin coalescer a "": ausente (legacy/API) = default 1, explícito vacío = inválido (fail-closed).
    slots: (l.slots as string | number | undefined) ?? undefined,
    notes: typeof l.notes === "string" ? l.notes : null,
  }));
  const problems = validateOrderLines(lines);
  if (problems.length > 0) return { ok: false, message: problems[0]?.message ?? "Líneas inválidas." };
  if (findLineOverlaps(lines).length > 0) {
    return { ok: false, message: "Dos líneas usan la misma pantalla en periodos que se cruzan." };
  }
  const slotsList = lines.map((l) => normalizeLineSlots(l.slots));
  if (slotsList.some((x) => x === null)) return { ok: false, message: "Línea con slots inválidos (1–100)." };
  try {
    const existing = await orders.getOrder(t.storeId, orderId);
    if (!existing) return { ok: false, message: "Orden no encontrada en esta tienda." };
    if (String(existing.status ?? "") !== "draft") {
      return { ok: false, message: "Solo borradores: las líneas de una orden avanzada ya no se editan." };
    }
    // Pantallas del tenant.
    const screenIds = [...new Set(lines.map((l) => l.screen_id))];
    if ((await listScreensBrief(t.storeId, { ids: screenIds })).length !== screenIds.length) {
      return { ok: false, message: "Pantalla fuera de tu inventario." };
    }
    // Sin facturas ni reservas: el bruto y la ocupación ya corrieron.
    const [invCount, bookCount] = await Promise.all([
      orders.countInvoices(t.storeId, orderId),
      orders.countBookings(t.storeId, orderId),
    ]);
    if (invCount > 0) return { ok: false, message: "La orden tiene facturas: las líneas ya no se editan." };
    if (bookCount > 0) return { ok: false, message: "La orden tiene reservas: las líneas ya no se editan." };
    // Anti-sobreventa por día (sin la propia orden): cada línea pide sus slots
    // (su periodo × su q, comparación inclusiva por días bloqueados).
    const { findLineConflicts } = await import("@/lib/availability");
    const hit = consumesCapacity(existing) ? await findLineConflicts(
      t.storeId,
      lines.map((l, i) => ({ screen_id: l.screen_id, starts: l.starts, ends: l.ends, slots: slotsList[i] ?? 1 })),
      { excludeIoId: orderId },
    ) : null;
    if (hit) {
      const who = [hit.conflict.io_number, hit.conflict.brand].filter(Boolean).join(" · ");
      const tzHit = await getStoreTimeZone(t.storeId);
      const days = (hit.conflict.blockedDays ?? []).map((d) => formatDate(d, tzHit)).join(", ");
      return { ok: false, message: `Línea ${hit.index + 1}: sin slots en ese periodo${who ? ` por ${who}` : ""}${days ? ` (${days})` : ""}.` };
    }
    const totals = lines.map((l) => totalToMinor(l.total));
    if (totals.some((x) => x === null)) return { ok: false, message: "Línea con total inválido." };
    const actor = await resolveActor();
    try {
      await orders.replaceOrderLines(
        t.storeId,
        orderId,
        lines.map((l, i) => ({
          screen_id: l.screen_id,
          starts: l.starts,
          ends: l.ends,
          total: (totals[i] as number) / 100,
          slots: slotsList[i] as number,
          notes: typeof l.notes === "string" && l.notes.trim() ? l.notes.trim().slice(0, 2000) : null,
        })),
        actor,
      );
    } catch (e) {
      const msg = thrownMessage(e);
      // La BD es la autoridad ante concurrentes: traduce el THROW a UX.
      if (/sin slots|cupo/i.test(msg)) {
        log.warn("updateOrderLinesAction", { fail: `capacity guard: ${msg}` });
        return { ok: false, message: "Sin cupo en ese periodo (otra venta lo tomó primero). Reintenta." };
      }
      return { ok: false, message: msg };
    }
    revalidatePath("/orders");
    return { ok: true, message: "Pantallas actualizadas." };
  } catch (e) {
    log.error("updateOrderLinesAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Disponibilidad por periodo para el formulario (el server action revalida al crear).
 *  `excludeIoId`: editar sin chocar consigo misma. `screenIds` + `slots`:
 *  pantallas evaluadas con su cupo pedido (resto visible); el resto del
 *  inventario se evalúa con 1 slot para los badges del picker. */
export async function checkAvailabilityAction(input: {
  starts: string;
  ends: string;
  excludeIoId?: string | null;
  screenIds?: string[];
  slots?: Record<string, number>;
}): Promise<AvailabilityState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, conflicts: [], remaining: {}, capacities: {}, message: t.error };
  if (!isISODateShape(input.starts) || !isISODateShape(input.ends) || input.ends < input.starts) {
    return { ok: false, conflicts: [], remaining: {}, capacities: {}, message: "Periodo inválido." };
  }
  try {
    const exclude = typeof input.excludeIoId === "string" && input.excludeIoId ? input.excludeIoId : null;
    const ids = [...new Set((input.screenIds ?? []).map(String).filter(Boolean))];
    const { getPeriodAvailability } = await import("@/lib/availability");
    const res = await getPeriodAvailability(t.storeId, ids.length > 0 ? ids : null, input.starts, input.ends, {
      excludeIoId: exclude,
      slots: input.slots ?? {},
    });
    return { ok: true, conflicts: res.conflicts, remaining: res.remaining, capacities: res.capacities, message: "" };
  } catch (e) {
    log.error("checkAvailabilityAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, conflicts: [], remaining: {}, capacities: {}, message: e instanceof Error ? e.message : "Error." };
  }
}

export interface OccupancyState {
  ok: boolean;
  occupancy: Record<string, Array<{ starts: string; ends: string }>>;
  capacities: Record<string, number>;
  message: string;
}

/** Rangos sin cupo por pantalla (calendarios de disponibilidad, próximo hueco).
 *  `slots`: cupo pedido por pantalla para rangos relativos a la reserva. */
export async function getScreenOccupancyAction(input: {
  screenIds: string[];
  from: string;
  excludeIoId?: string | null;
  slots?: Record<string, number>;
}): Promise<OccupancyState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, occupancy: {}, capacities: {}, message: t.error };
  const ids = [...new Set((input.screenIds ?? []).map(String).filter(Boolean))];
  if (ids.length === 0 || !isISODateShape(input.from)) {
    return { ok: false, occupancy: {}, capacities: {}, message: "Parámetros inválidos." };
  }
  try {
    const exclude = typeof input.excludeIoId === "string" && input.excludeIoId ? input.excludeIoId : null;
    const { getScreenCapacities } = await import("@/lib/availability");
    const [occupancy, caps] = await Promise.all([
      getScreenOccupancy(t.storeId, ids, input.from, { excludeIoId: exclude, slots: input.slots ?? {} }),
      getScreenCapacities(t.storeId, ids),
    ]);
    return { ok: true, occupancy, capacities: Object.fromEntries(caps.entries()), message: "" };
  } catch (e) {
    log.error("getScreenOccupancyAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, occupancy: {}, capacities: {}, message: e instanceof Error ? e.message : "Error." };
  }
}

export interface ScreenDayLine {
  io_number: string | null;
  brand: string | null;
  slots: number;
  status: string;
  starts: string;
  ends: string;
  source: "order" | "booking";
}

export interface ScreenDayDetail {
  ok: boolean;
  screenId: string;
  screenName: string | null;
  day: string;
  capacity: number;
  reserved: number;
  lines: ScreenDayLine[];
  message: string;
}

/** Desglose de un día-pantalla para el drawer de la matriz (quién ocupa).
 *  Misma semántica vigente que lib/availability: excluye canceladas y
 *  borradores vencidos (el hold aparta 7 días). */
export async function getScreenDayDetailAction(input: {
  screenId: string;
  day: string;
}): Promise<ScreenDayDetail> {
  const fail = (message: string): ScreenDayDetail => ({
    ok: false, screenId: "", screenName: null, day: "", capacity: 0, reserved: 0, lines: [], message,
  });
  const t = await resolveTenantStore();
  if ("error" in t) return fail(t.error);
  const screenId = String(input.screenId ?? "").trim();
  const day = String(input.day ?? "").trim();
  if (!screenId || !isISODateShape(day)) return fail("Parámetros inválidos.");
  try {
    const [scr] = await listScreensBrief(t.storeId, { ids: [screenId] });
    if (!scr) return fail("Pantalla no encontrada en esta tienda.");
    const { getScreenCapacities } = await import("@/lib/availability");
    const tz = await getStoreTimeZone(t.storeId);
    const caps = await getScreenCapacities(t.storeId, [screenId]);
    const capacity = caps.get(screenId) ?? DEFAULT_SLOTS_PER_SCREEN;
    const qStart = dayStart(day, tz);
    const qEnd = dayStart(addDays(day, 1), tz);
    const lines: ScreenDayLine[] = [];
    for (const l of await orders.listScreenDayLines(t.storeId, screenId, qStart, qEnd)) {
      if (l.status === "cancelled") continue;
      if (!consumesCapacity(l)) continue;
      const qty = Number(l.cant_slots ?? 1);
      lines.push({
        io_number: typeof l.io_number === "string" ? l.io_number : null,
        brand: typeof l.brand === "string" ? l.brand : null,
        slots: Number.isFinite(qty) && qty >= 1 ? Math.floor(qty) : 1,
        status: typeof l.status === "string" ? l.status : "—",
        starts: dayOf(String(l.starts_at), tz),
        ends: displayEndOf(String(l.ends_at), tz),
        source: "order",
      });
    }
    for (const b of await orders.listScreenDayBookings(t.storeId, screenId, qStart, qEnd)) {
      lines.push({
        io_number: typeof b.io_number === "string" ? b.io_number : null,
        brand: typeof b.brand === "string" ? b.brand : null,
        slots: 1,
        status: typeof b.status === "string" ? b.status : "—",
        starts: dayOf(String(b.starts_at), tz),
        ends: displayEndOf(String(b.ends_at), tz),
        source: "booking",
      });
    }
    lines.sort((a, b) => (a.starts < b.starts ? -1 : a.starts > b.starts ? 1 : 0));
    const reserved = lines.reduce((a, l) => a + l.slots, 0);
    return {
      ok: true,
      screenId,
      screenName: typeof (scr as Record<string, unknown>).name === "string" ? String((scr as Record<string, unknown>).name) : null,
      day,
      capacity,
      reserved,
      lines,
      message: "",
    };
  } catch (e) {
    log.error("getScreenDayDetailAction", { error: e instanceof Error ? e.message : String(e) });
    return fail(e instanceof Error ? e.message : "Error.");
  }
}
