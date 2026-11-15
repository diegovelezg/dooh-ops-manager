"use server";

import { revalidatePath } from "next/cache";
import { dismissInsight, insightStore, latestInsightIds, readInsightIds } from "@/lib/insights-store";
import { listWallInsights, type WallInsight } from "@/lib/insights";
import { createLogger } from "@/lib/log";

const log = createLogger("insights");

/** Inbox del tenant para Hoy (server action: storeId siempre del servidor).
 *  Acepta `storeId` explícito para no resolver la tienda 2 veces (la página
 *  ya resolvió + chequeó membresía); sin arg, resuelve internamente. */
export async function getWallAction(storeIdArg?: string): Promise<WallInsight[]> {
  const { resolveTenantStoreAction, getMyStoreRole } = await import("@/lib/tenant");
  let storeId = (storeIdArg ?? "").trim();
  if (!storeId) {
    const t = await resolveTenantStoreAction().catch(() => ({ error: "Sin tienda." }) as const);
    if ("error" in t) return [];
    storeId = t.storeId;
  }
  let userId: string | null = null;
  let email: string | null = null;
  try {
    const { getSessionUser } = await import("@/lib/auth");
    const sessionUser = await getSessionUser();
    userId = sessionUser?.id ?? null;
    email = sessionUser?.email ?? null;
  } catch {
    userId = null;
  }
  const role = await getMyStoreRole(storeId).catch(() => null);
  return listWallInsights(storeId, { userId, email, role }).catch(() => []);
}

/** Contador para el badge del icono Inbox: avisos activos (no descartados).
 *  Liviano para el sidebar (solo ids + reads, sin cuerpos). */
export async function getUnreadWallCountAction(): Promise<number> {
  try {
    const { resolveTenantStoreAction } = await import("@/lib/tenant");
    const t = await resolveTenantStoreAction().catch(() => ({ error: "Sin tienda." }) as const);
    if ("error" in t) return 0;
    const { getSessionUser } = await import("@/lib/auth");
    const sessionUser = await getSessionUser();
    const userId = sessionUser?.id ?? null;
    const ids = await latestInsightIds(t.storeId, 20);
    if (ids.length === 0) return 0;
    // Sin usuario (sesión no resuelta): todo cuenta como sin leer, no hay
    // estado de dismiss per-user con que comparar. Antes devolvía 0 y el
    // badge del icono Inbox nunca aparecía.
    if (!userId) return ids.length;
    const readIds = await readInsightIds(userId, ids);
    return ids.filter((id) => !readIds.has(id)).length;
  } catch {
    return 0;
  }
}

/** Dismiss per-user (sys_insight_reads): nunca borra el post global. */export async function dismissInsightAction(insightId: string): Promise<{ ok: boolean; message: string }> {
  if (!insightId) return { ok: false, message: "Falta insight." };
  try {
    const { getSessionUser } = await import("@/lib/auth");
    const sessionUser = await getSessionUser();
    if (!sessionUser) return { ok: false, message: "No autenticado." };
    const storeId = (await insightStore(insightId)) ?? "";
    if (!storeId) return { ok: false, message: "Insight no encontrado." };
    const { requireMyStoreAccess } = await import("@/lib/tenant");
    if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
      return { ok: false, message: "Sin acceso a esta tienda." };
    }
    await dismissInsight(insightId, sessionUser.id);
    revalidatePath("/");
    revalidatePath("/inbox");
    return { ok: true, message: "Descartado." };
  } catch (e) {
    log.error("getUnreadWallCountAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Resuelve sesión + tienda del aviso (SSOT anti-IDOR: el store sale del aviso). */
async function guardInsight(
  insightId: string,
): Promise<{ storeId: string; userId: string; email: string | null } | { error: string }> {
  if (!insightId) return { error: "Falta insight." };
  try {
    const { getSessionUser } = await import("@/lib/auth");
    const sessionUser = await getSessionUser();
    if (!sessionUser) return { error: "No autenticado." };
    const storeId = (await insightStore(insightId)) ?? "";
    if (!storeId) return { error: "Aviso no encontrado." };
    const { requireMyStoreAccess } = await import("@/lib/tenant");
    if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
      return { error: "Sin acceso a esta tienda." };
    }
    return { storeId, userId: sessionUser.id, email: sessionUser.email };
  } catch (e) {
    log.error("getUnreadWallCountAction", { error: e instanceof Error ? e.message : String(e) });
    return { error: e instanceof Error ? e.message : "Error." };
  }
}

/** Restaura un aviso descartado. */
export async function restoreInsightAction(insightId: string): Promise<{ ok: boolean; message: string }> {
  const g = await guardInsight(insightId);
  if ("error" in g) return { ok: false, message: g.error };
  try {
    const { restoreInsight } = await import("@/lib/insights");
    await restoreInsight(insightId, g.userId);
    revalidatePath("/");
    revalidatePath("/inbox");
    return { ok: true, message: "Restaurado." };
  } catch (e) {
    log.error("restoreInsightAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}
