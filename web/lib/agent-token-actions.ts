"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth";
import { createAgentToken, revokeAgentToken } from "@/lib/agent-tokens";
import { createLogger } from "@/lib/log";

const log = createLogger("agent-tokens");

export interface AgentTokenState {
  ok: boolean;
  message: string;
  /** Solo al crear: la clave completa, que no se puede recuperar después. */
  key?: string;
}

/** Cualquier miembro puede conectar su agente: ve exactamente lo mismo que él en la web, solo lectura. */
export async function createAgentTokenAction(input: { label: string }): Promise<AgentTokenState> {
  try {
    const user = await getSessionUser();
    if (!user) return { ok: false, message: "No autenticado." };
    const { key } = await createAgentToken(user.id, String(input.label ?? ""));
    revalidatePath("/settings");
    return { ok: true, message: "Clave creada. Cópiala ahora: no se vuelve a mostrar.", key };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Error.";
    log.error("createAgentTokenAction", { error: message });
    return { ok: false, message };
  }
}

export async function revokeAgentTokenAction(input: { id: string }): Promise<AgentTokenState> {
  try {
    const user = await getSessionUser();
    if (!user) return { ok: false, message: "No autenticado." };
    const done = await revokeAgentToken(user.id, String(input.id ?? ""));
    if (!done) return { ok: false, message: "Clave no encontrada o ya revocada." };
    revalidatePath("/settings");
    return { ok: true, message: "Clave revocada: el agente pierde el acceso ahora." };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Error.";
    log.error("revokeAgentTokenAction", { error: message });
    return { ok: false, message };
  }
}
