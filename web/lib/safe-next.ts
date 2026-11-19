// Destino de redirección seguro tras el login (anti open-redirect). Compartido por la acción de login y la página
// de login (ya con sesión). Puro, sin `next/*`.

/** `next` solo si es una ruta absoluta del MISMO origen. Rechaza `//host`, `/\host`, `/%2f…` y lo que el navegador
 *  normalizaría a otro origen (tabuladores/saltos de línea dentro del path). */
export function safeNext(next: string | null | undefined): string | null {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return null;
  if (next.includes("\\") || /%2f/i.test(next) || /[\u0000-\u001f]/.test(next)) return null;
  if (!/^\/[^/\\]/.test(next) && next !== "/") return null;
  try {
    const u = new URL(next, "http://app.invalid");
    if (u.origin !== "http://app.invalid") return null;
  } catch {
    return null;
  }
  return next;
}
