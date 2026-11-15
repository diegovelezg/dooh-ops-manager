"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth";
import { surql, thrownMessage } from "@/lib/surreal";
import { setDefaultSlots, setStoreTimeZone } from "@/lib/stores-db";
import { isValidTimeZone } from "@/lib/format";
import { DEFAULT_SLOTS_PER_SCREEN, normalizeSlotsPerScreen } from "@/lib/tenant";
import { hasMinRole, isMemberRole } from "@/lib/roles";
import { createLogger } from "@/lib/log";

const log = createLogger("settings");

export interface StoreSettingsState {
  ok: boolean;
  message: string;
}

/** Cambia los espacios vendibles por pantalla y día (1 slot = 1 espacio).
 *  Solo admin/owner. Rango 1..100. */
export async function updateDefaultSlotsAction(input: {
  storeId: string;
  slots: number;
}): Promise<StoreSettingsState> {
  const slots = normalizeSlotsPerScreen(input.slots);
  if (!input.storeId) return { ok: false, message: "Falta tienda." };
  if (!Number.isSafeInteger(input.slots) || input.slots < 1 || input.slots > 100) {
    return { ok: false, message: `Espacios inválidos: entero 1..100 (recibido ${String(input.slots)}).` };
  }
  try {
    const user = await getSessionUser();
    if (!user) return { ok: false, message: "No autenticado." };

    const caller = (
      await surql<Array<{ role: unknown }>>(
        `SELECT role FROM member_of
         WHERE in = type::record('user', $user) AND out = type::record('sys_store', $store)`,
        { user: user.id, store: input.storeId },
      )
    )[0];
    const callerRole = caller?.role;
    if (!isMemberRole(callerRole) || !hasMinRole(callerRole, "admin")) {
      return { ok: false, message: "Requiere rol admin o propietario." };
    }

    try {
      await setDefaultSlots(input.storeId, slots);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn("updateDefaultSlotsAction", { fail: `DB write: ${msg}` });
      return { ok: false, message: `DB write: ${msg}` };
    }
    revalidatePath("/settings");
    return { ok: true, message: `Espacios por pantalla: ${slots} (default ${DEFAULT_SLOTS_PER_SCREEN}).` };
  } catch (e) {
    log.error("updateDefaultSlotsAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Cambia la zona horaria del tenant (IANA). Solo admin/owner; la BD lo rechaza si ya hay órdenes o reservas. */
export async function updateTimeZoneAction(input: { storeId: string; timezone: string }): Promise<StoreSettingsState> {
  if (!input.storeId) return { ok: false, message: "Falta tienda." };
  if (!isValidTimeZone(input.timezone)) return { ok: false, message: "Zona horaria inválida (nombre IANA, p. ej. America/Lima)." };
  try {
    const user = await getSessionUser();
    if (!user) return { ok: false, message: "No autenticado." };
    const caller = (
      await surql<Array<{ role: unknown }>>(
        `SELECT role FROM member_of WHERE in = type::record('user', $user) AND out = type::record('sys_store', $store)`,
        { user: user.id, store: input.storeId },
      )
    )[0];
    if (!isMemberRole(caller?.role) || !hasMinRole(caller.role, "admin")) {
      return { ok: false, message: "Requiere rol admin o propietario." };
    }
    try {
      await setStoreTimeZone(input.storeId, input.timezone);
    } catch (e) {
      return { ok: false, message: thrownMessage(e) };
    }
    revalidatePath("/", "layout");
    return { ok: true, message: `Zona horaria: ${input.timezone}.` };
  } catch (e) {
    log.error("updateTimeZoneAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}
