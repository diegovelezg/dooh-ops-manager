"use server";

import { revalidatePath } from "next/cache";
import * as orders from "@/lib/orders-store";
import { isUniqueViolation, thrownMessage } from "@/lib/surreal";
import { getCompany } from "@/lib/crm-store";
import { requireMyStoreAccess } from "@/lib/tenant";
import { normalizeCurrency } from "@/lib/currency";
import { isValidISODate, todayIn } from "@/lib/format";
import { getStoreTimeZone } from "@/lib/stores-db";
import { resolveActor } from "@/lib/actor";
import { taxIdLabel } from "@/lib/tax-id";
import { cancelOrder, confirmOrder, registerAuthorization } from "@/lib/order-workflow-store";
import { createLogger } from "@/lib/log";

const log = createLogger("order-flow");

export interface OrderFlowState {
  ok: boolean;
  message: string;
}

/** Mutaciones del drawer: requieren vendedor o superior (viewer = solo lectura).
 *  null = anon-dev explícito (permite); sin auth y sin bypass = false (deniega). */
async function denyViewer(storeId: string): Promise<string | null> {
  const { denyRole } = await import("@/lib/tenant");
  return denyRole(storeId, "seller");
}

/** Carga una fila propia por id con chequeo de membresía (fail-closed).
 *  Devuelve la fila + storeId, o el mensaje de error. "No encontrada"
 *  enmascara tanto la ausencia como la falta de acceso (no oráculo).
 *  Sin chequeo de rol: el caller aplica `denyViewer`/status después, en el
 *  orden que cada flujo exige. */
async function loadOwnedRow(
  kind: orders.OwnedKind,
  id: string,
): Promise<{ row: Record<string, unknown>; storeId: string } | { error: string }> {
  const row = await orders.findOwned(kind, id);
  if (!row) return { error: "No encontrada." };
  const storeId = String(row.store_id ?? "");
  if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
    return { error: "No encontrada." };
  }
  return { row, storeId };
}

/** Pasa la OI de borrador a firmada (el cliente la firmó). */
export async function signOrderAction(input: { orderId: string; signedByAgency?: string | null; signedByCompany?: string | null }): Promise<OrderFlowState> {
  try {
    const chk = await orderStore(input.orderId);
    if ("error" in chk) return { ok: false, message: chk.error };
    const actor = await resolveActor();
    if (!actor) return { ok: false, message: "Identidad de usuario requerida." };
    await confirmOrder(chk.storeId, input.orderId, Number(chk.row.workflow_rev ?? 0), actor);
    refreshBilling();
    return { ok: true, message: "Acuerdo confirmado y versionado." };
  } catch(e) { return { ok: false, message: thrownMessage(e) }; }
}

/** Registra el documento requerido por la política del acuerdo vigente. */
export async function createAgencyOrderAction(input: { orderId: string; documentUrl: string }): Promise<OrderFlowState> {
  try {
    const chk = await orderStore(input.orderId);
    if ("error" in chk) return { ok: false, message: chk.error };
    const actor = await resolveActor();
    if (!actor) return { ok: false, message: "Identidad de usuario requerida." };
    await registerAuthorization(chk.storeId, input.orderId, Number(chk.row.workflow_rev ?? 0), input.documentUrl, actor);
    refreshBilling();
    return { ok: true, message: "Documento de la versión vigente registrado." };
  } catch(e) { return { ok: false, message: thrownMessage(e) }; }
}

async function orderStore(
  orderId: string,
): Promise<{ row: Record<string, unknown>; storeId: string } | { error: string }> {
  const loaded = await loadOwnedRow("io_order", orderId);
  if ("error" in loaded) return loaded;
  const denied = await denyViewer(loaded.storeId);
  if (denied) return { error: denied };
  return loaded;
}



/** Conserva los documentos como historial; las nuevas versiones se registran en la ficha. */
export async function deleteAgencyOrderAction(input: { agencyOrderId: string }): Promise<OrderFlowState> {
  const chk = await loadOwnedRow("io_agency_order", input.agencyOrderId);
  return { ok: false, message: "error" in chk ? chk.error : "El historial se conserva. Registra una nueva versión o una resolución en la ficha completa." };
}

/** Compatibilidad: la recepción se gestiona con líneas y revisiones en la ficha. */
export async function attachCreativeAction(input: { orderId: string; fileUrl: string; durationSec?: number | string | null; widthPx?: number | string | null; heightPx?: number | string | null }): Promise<OrderFlowState> {
  const chk = await orderStore(input.orderId);
  return { ok: false, message: "error" in chk ? chk.error : "Abre la ficha completa para asociar el material a sus líneas y registrar las revisiones." };
}

/** Conserva materiales y revisiones; permite reemplazarlos desde la ficha. */
export async function deleteCreativeAction(input: { creativeId: string }): Promise<OrderFlowState> {
  const chk = await loadOwnedRow("io_creative", input.creativeId);
  return { ok: false, message: "error" in chk ? chk.error : "El historial se conserva. Registra una nueva versión o una resolución en la ficha completa." };
}

/** Adjunta un foto check (foto o video por URL). */
export async function attachPhotoAction(input: { orderId: string; url: string }): Promise<OrderFlowState> {
  const chk = await orderStore(input.orderId);
  return { ok: false, message: "error" in chk ? chk.error : "Abre la ficha completa para indicar línea, tipo, fecha y periodo cubierto por la evidencia." };
}

/** Conserva las evidencias; una resolución explícita corrige su interpretación. */
export async function deletePhotoAction(input: { photoId: string }): Promise<OrderFlowState> {
  const chk = await loadOwnedRow("io_photo_check", input.photoId);
  return { ok: false, message: "error" in chk ? chk.error : "El historial se conserva. Registra una nueva versión o una resolución en la ficha completa." };
}

/** Cancela la orden (terminal). Los adjuntos se conservan como evidencia. */
export async function cancelOrderAction(input: { orderId: string }): Promise<OrderFlowState> {
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  try {
    const chk = await orderStore(orderId);
    if ("error" in chk) return { ok: false, message: chk.error };
    if (String(chk.row.status ?? "") === "cancelled") return { ok: false, message: "La orden ya está cancelada." };
    const actor=await resolveActor();
    if(!actor)return {ok:false,message:"Identidad de usuario requerida."};
    await cancelOrder(chk.storeId,orderId,Number(chk.row.workflow_rev??0),actor);
    refreshBilling();
    return { ok: true, message: "Orden cancelada." };
  } catch (e) {
    log.error("cancelOrderAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Reactiva una orden cancelada (vuelve a borrador). Requiere vendedor+. */
export async function reactivateOrderAction(input: { orderId: string }): Promise<OrderFlowState> {
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  try {
    const chk = await orderStore(orderId);
    if ("error" in chk) return { ok: false, message: chk.error };
    if (String(chk.row.status ?? "") !== "cancelled") {
      return { ok: false, message: "Solo se puede reactivar una orden cancelada." };
    }
    if (chk.row.signed_at) return { ok: false, message: "El acuerdo aceptado se conserva; crea una nueva cotización para recontratar." };
    await orders.patchOrder(chk.storeId, orderId, { reservation_expires_at: null, status: "draft", updated_by: await resolveActor() });
    revalidatePath("/orders");
    return { ok: true, message: "Orden reactivada como borrador." };
  } catch (e) {
    log.error("reactivateOrderAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Elimina una orden en borrador o cancelada (solo owner).
 *  Líneas, OM/OC, materiales y foto checks caen por cascada (ON DELETE
 *  CASCADE en BD). Bloqueado si tiene historia que quedaría huérfana
 *  (facturas, reservas, campañas o play logs: SET NULL en BD). */
export async function deleteOrderAction(input: { orderId: string }): Promise<OrderFlowState> {
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  try {
    const loaded = await loadOwnedRow("io_order", orderId);
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const { row, storeId } = loaded;
    const { denyRole } = await import("@/lib/tenant");
    const denied = await denyRole(storeId, "owner", "Solo el propietario puede eliminar órdenes.");
    if (denied) return { ok: false, message: denied };
    const status = String(row.status ?? "");
    if (status !== "draft" && status !== "cancelled") {
      return { ok: false, message: "Cancela la orden antes de eliminarla." };
    }
    const dep = await orders.orderDependents(storeId, orderId);
    if (dep.invoices > 0) {
      return { ok: false, message: `No se puede eliminar: tiene ${dep.invoices} factura(s). Anúlalas o registra una nueva orden.` };
    }
    if (dep.bookings > 0) {
      return { ok: false, message: `No se puede eliminar: tiene ${dep.bookings} reserva(s).` };
    }
    if (dep.campaigns > 0) {
      return { ok: false, message: `No se puede eliminar: tiene ${dep.campaigns} campaña(s) vinculada(s).` };
    }
    if (dep.plays > 0) {
      return { ok: false, message: `No se puede eliminar: tiene ${dep.plays} registro(s) de emisión.` };
    }
    // Líneas, OM/OC, materiales y foto checks caen por cascada (REFERENCE ... ON DELETE CASCADE).
    await orders.deleteOrder(storeId, orderId);
    revalidatePath("/orders");
    return { ok: true, message: "Orden eliminada." };
  } catch (e) {
    log.error("deleteOrderAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

function realDate(v: string): boolean {
  return isValidISODate(v);
}

/** Registra una factura emitida contra la orden (monto, número, fechas, estado inicial).
 *  La moneda es siempre la de la orden (el trigger io_invoice_currency_check
 *  aborta cualquier mezcla PEN/USD). Sin `draft` en v1: nace emitida; el cobro se registra por separado. */
export async function createInvoiceAction(input: {
  orderId: string;
  number: string;
  amountMinor: number;
  issueDate?: string | null;
  dueDate?: string | null;
  status?: string;
}): Promise<OrderFlowState> {
  const orderId = String(input.orderId ?? "").trim();
  const number = String(input.number ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  if (!number || number.length > 60) return { ok: false, message: "Número de factura requerido (máx 60)." };
  const rawMinor = Number(input.amountMinor);
  if (!Number.isInteger(rawMinor) || rawMinor < 1 || rawMinor > 99_999_999_999) {
    return { ok: false, message: "Monto inválido: debe ser mayor a 0." };
  }
  const minor = rawMinor;
  const issue = String(input.issueDate ?? "").trim();
  const due = String(input.dueDate ?? "").trim();
  if (issue && !realDate(issue)) return { ok: false, message: "Emisión inválida (aaaa-mm-dd)." };
  if (due && !realDate(due)) return { ok: false, message: "Vencimiento inválido (aaaa-mm-dd)." };
  if (issue && due && due < issue) return { ok: false, message: "Vence antes de la emisión." };
  const status = String(input.status ?? "issued").trim() || "issued";
  if (status !== "issued") {
    return { ok: false, message: "Registra la factura emitida y luego su cobro con fecha y referencia." };
  }
  try {
    const loaded = await loadOwnedRow("io_order", orderId);
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const { row, storeId } = loaded;
    if (String(row.status ?? "") === "cancelled") return { ok: false, message: "La orden está cancelada." };
    // Factura electrónica: exige razón social con ID fiscal (no se factura al aire).
    const billingId = String(row.billing_company_id ?? "");
    if (!billingId) return { ok: false, message: "Sin empresa de facturación: fíjala en la ficha de la orden." };
    const coRec = await getCompany(storeId, billingId);
    if (!coRec) return { ok: false, message: "Sin empresa de facturación: fíjala en la ficha de la orden." };
    if (!String(coRec.tax_id ?? "").trim()) {
      return { ok: false, message: `Sin ${taxIdLabel(coRec.country)}: complétalo en la ficha de la empresa antes de facturar.` };
    }
    const denied = await denyViewer(storeId);
    if (denied) return { ok: false, message: denied };
    const currency = normalizeCurrency(row.currency ?? "PEN");
    const actor = await resolveActor();
    try {
      await orders.createInvoice(storeId, orderId, {
        number,
        amount_minor: minor,
        currency,
        issue_date: issue || null,
        due_date: due || null,
        status,
      });
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: false, message: "Ese número ya existe en esta tienda." };
      if (/field `currency`/i.test(e instanceof Error ? e.message : "")) {
        return { ok: false, message: "La moneda no coincide con la de la orden." };
      }
      throw e;
    }
    await orders.touchOrder(storeId, orderId, actor);
    revalidatePath("/orders");
    revalidatePath("/");
    revalidatePath("/inbox");
  revalidatePath("/finance");
    return { ok: true, message: "Factura emitida registrada. Registra sus cobros por separado." };
  } catch (e) {
    log.error("createInvoiceAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Anular una factura no perdona ni elimina cobros: `fn::invoice_cancel` verifica el saldo en la misma transacción.
 * El estado pagada se deriva de los cobros, nunca se cambia con un botón. */
export async function setInvoiceStatusAction(input: {
  invoiceId: string;
  status: string;
}): Promise<OrderFlowState> {
  if (input.status !== "cancelled") return { ok: false, message: "Registra o revierte un cobro para actualizar el saldo." };
  try {
    const loaded = await loadOwnedRow("io_invoice", String(input.invoiceId ?? ""));
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const denied = await denyViewer(loaded.storeId);
    if (denied) return { ok: false, message: denied };
    try {
      await orders.cancelInvoice(String(input.invoiceId), await resolveActor());
    } catch (e) {
      return { ok: false, message: thrownMessage(e) };
    }
    refreshBilling();
    return { ok: true, message: "Factura anulada." };
  } catch (e) {
    log.error("setInvoiceStatusAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

function refreshBilling() {
  revalidatePath("/orders/[id]", "page");
  revalidatePath("/occupancy");
  revalidatePath("/screens");
  revalidatePath("/orders");
  revalidatePath("/inbox");
  revalidatePath("/finance");
  revalidatePath("/");
}

export async function recordInvoicePaymentAction(input: {
  invoiceId: string;
  requestId: string;
  amountMinor: number;
  paidOn: string;
  reference: string;
}): Promise<OrderFlowState> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    return { ok: false, message: "Monto de cobro inválido." };
  }
  if (!isValidISODate(input.paidOn)) {
    return { ok: false, message: "Fecha de cobro inválida o futura." };
  }
  if (!input.reference?.trim() || input.reference.trim().length > 200) {
    return { ok: false, message: "Indica una referencia de cobro (máx 200)." };
  }
  try {
    const loaded = await loadOwnedRow("io_invoice", input.invoiceId);
    if ("error" in loaded) return { ok: false, message: loaded.error };
    if (input.paidOn > todayIn(await getStoreTimeZone(loaded.storeId))) {
      return { ok: false, message: "Fecha de cobro inválida o futura." };
    }
    const denied = await denyViewer(loaded.storeId);
    if (denied) return { ok: false, message: denied };
    // No bloquear por cancelación de la orden: una deuda puede seguir vigente.
    try {
      await orders.recordInvoicePayment(
        input.invoiceId,
        { requestId: input.requestId, amountMinor: input.amountMinor, paidOn: input.paidOn, reference: input.reference.trim() },
        await resolveActor(),
      );
    } catch (e) {
      return { ok: false, message: thrownMessage(e) };
    }
    refreshBilling();
    return { ok: true, message: "Cobro registrado." };
  } catch (e) {
    log.error("recordInvoicePaymentAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

export async function voidInvoicePaymentAction(input: {
  invoiceId: string;
  paymentId: string;
  reason: string;
}): Promise<OrderFlowState> {
  if (!input.reason?.trim() || input.reason.trim().length > 500) {
    return { ok: false, message: "Indica el motivo de la reversión (máx 500)." };
  }
  try {
    const loaded = await loadOwnedRow("io_invoice", input.invoiceId);
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const denied = await denyViewer(loaded.storeId);
    if (denied) return { ok: false, message: denied };
    try {
      await orders.voidInvoicePayment(input.invoiceId, input.paymentId, input.reason.trim(), await resolveActor());
    } catch (e) {
      return { ok: false, message: thrownMessage(e) };
    }
    refreshBilling();
    return { ok: true, message: "Registro de cobro revertido; se conserva su historial." };
  } catch (e) {
    log.error("voidInvoicePaymentAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}
