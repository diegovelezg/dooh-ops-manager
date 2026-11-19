"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth";
import { revokeAgentToken } from "@/lib/agent-tokens";
import { createLogger } from "@/lib/log";

const log = createLogger("agent-tokens");

export interface AgentTokenState {
  ok: boolean;
  message: string;
}

/** Revoca el acceso de un agente (token OAuth) del usuario actual. */
export async function revokeAgentTokenAction(input: { id: string }): Promise<AgentTokenState> {
  try {
    const user = await getSessionUser();
    if (!user) return { ok: false, message: "No autenticado." };
    const done = await revokeAgentToken(user.id, String(input.id ?? ""));
    if (!done) return { ok: false, message: "Acceso no encontrado o ya revocado." };
    revalidatePath("/settings");
    return { ok: true, message: "El agente pierde el acceso ahora." };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Error.";
    log.error("revokeAgentTokenAction", { error: message });
    return { ok: false, message };
  }
}
