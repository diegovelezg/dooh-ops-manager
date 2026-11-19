"use server";

import { redirect } from "next/navigation";
import { signInWithPassword, signOut } from "@/lib/auth";
import { surqlAs } from "@/lib/surreal";
import { createLogger } from "@/lib/log";
import { safeNext } from "@/lib/safe-next";

const log = createLogger("auth");

export interface AuthState {
  ok: boolean;
  message: string;
}

/** Login solo con email+password (sin signup público: los usuarios se crean con scripts/db-user.ts). */
export async function signInAction(_prev: AuthState | null, formData: FormData): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "").trim();
  if (!email || !password) return { ok: false, message: "Falta email o password." };
  const { checkRateLimit, pruneRateLimits } = await import("@/lib/rate-limit");
  pruneRateLimits();
  if (!checkRateLimit(`login:${email.toLowerCase()}`, 10, 60_000)) {
    return { ok: false, message: "Demasiados intentos. Espera un momento." };
  }
  const tokens = await signInWithPassword(email, password);
  if (!tokens) {
    // Mensaje genérico (no expone detalle): evita enumeración de usuarios.
    log.warn("signIn fail");
    return { ok: false, message: "Credenciales inválidas." };
  }
  const rows = await surqlAs<Array<{ store: string }>>(
    tokens.access,
    "SELECT record::id(out) AS store FROM member_of ORDER BY created_at ASC",
  );
  const memberIds = rows.map((r) => r.store).filter(Boolean);
  const storeId = memberIds[0] as string | undefined;
  const dest = pickSafeNext(next, memberIds) ?? (storeId ? `/?store=${storeId}` : "/");
  redirect(dest);
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}

/** `next` solo si apunta a una tienda del usuario (o no pide tienda). */
function pickSafeNext(next: string, memberIds: string[]): string | null {
  const safe = safeNext(next);
  if (!safe) return null;
  let store: string | null = null;
  try {
    store = new URL(safe, "http://x").searchParams.get("store");
  } catch {
    return null;
  }
  if (store && !memberIds.includes(store)) return null;
  return safe;
}
