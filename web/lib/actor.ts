// Identidad para auditoría: email de la sesión.
// Mismo patrón que `resolveApprover` (review) y `closed_by` (inbox):
// `*_by` guarda email legible sin join; sin sesión resoluble (seed, jobs)
// queda null. Nunca inventar un nombre.
import { getSessionUser } from "@/lib/auth";

export async function resolveActor(): Promise<string | null> {
  try {
    return (await getSessionUser())?.email ?? null;
  } catch {
    return null;
  }
}
