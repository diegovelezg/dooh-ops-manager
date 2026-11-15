"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth";
import { surql } from "@/lib/surreal";
import { hasMinRole, isMemberRole, type MemberRole } from "@/lib/roles";
import { createLogger } from "@/lib/log";

const log = createLogger("members");

export interface MembersState {
  ok: boolean;
  message: string;
}

/** Cambia el rol de un miembro. Solo admin+: admin no toca owners ni crea owners. */
export async function updateMemberRoleAction(input: {
  storeId: string;
  userId: string;
  role: MemberRole;
}): Promise<MembersState> {
  if (!input.storeId || !input.userId) return { ok: false, message: "Falta tienda o usuario." };
  if (!isMemberRole(input.role)) return { ok: false, message: "Rol inválido." };
  try {
    const user = await getSessionUser();
    if (!user) return { ok: false, message: "No autenticado." };

    const roleOf = async (userId: string): Promise<unknown> =>
      (
        await surql<Array<{ role: unknown }>>(
          `SELECT role FROM member_of
           WHERE in = type::record('user', $user) AND out = type::record('sys_store', $store)`,
          { user: userId, store: input.storeId },
        )
      )[0]?.role;
    const callerRole = await roleOf(user.id);
    if (!isMemberRole(callerRole) || !hasMinRole(callerRole, "admin")) {
      return { ok: false, message: "Requiere rol admin o propietario." };
    }
    const targetRole = await roleOf(input.userId);
    if (targetRole === undefined) return { ok: false, message: "Miembro no encontrado en esta tienda." };
    if (!isMemberRole(targetRole)) return { ok: false, message: "Rol actual inválido." };
    // Admin no gestiona owners (ni los degrada ni crea nuevos).
    if (callerRole === "admin" && (targetRole === "owner" || input.role === "owner")) {
      return { ok: false, message: "Solo el propietario gestiona propietarios." };
    }
    if (targetRole === input.role) return { ok: true, message: "Sin cambios." };
    // "Nunca quedarse sin owner" lo garantiza la DB (evento member_of_keep_owner).
    try {
      await surql(
        `UPDATE member_of SET role = $role
         WHERE in = type::record('user', $user) AND out = type::record('sys_store', $store)`,
        { role: input.role, user: input.userId, store: input.storeId },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("sin propietario")) return { ok: false, message: "No puedes quitar al único propietario." };
      log.warn("updateMemberRoleAction", { fail: `DB write: ${msg}` });
      return { ok: false, message: `DB write: ${msg}` };
    }
    revalidatePath("/settings");
    return { ok: true, message: "Rol actualizado." };
  } catch (e) {
    log.error("updateMemberRoleAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}
