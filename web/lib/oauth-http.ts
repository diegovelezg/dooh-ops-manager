// Respuestas HTTP comunes de los endpoints /oauth/* y /.well-known/*. Sin `next/*`.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

/** JSON con CORS abierto (metadatos, registro y token no usan cookies: la seguridad va en PKCE/código). */
export function oauthJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store", Pragma: "no-cache", ...extra } });
}

export const oauthPreflight = (): Response => new Response(null, { status: 204, headers: CORS });

/** Clave de rate limit por IP. De `X-Forwarded-For` se toma la entrada MÁS A LA DERECHA: la añade el proxy inverso de
 *  confianza; las de la izquierda las puede inventar el cliente. (Con más de un proxy hay que ajustarlo.) */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  return xff?.at(-1) || req.headers.get("x-real-ip") || "unknown";
}
