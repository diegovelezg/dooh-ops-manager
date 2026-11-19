import { oauthJson, oauthPreflight, clientIp } from "@/lib/oauth-http";
import { OAuthError, registerClient } from "@/lib/oauth";
import { checkRateLimit, pruneRateLimits } from "@/lib/rate-limit";
import { createLogger } from "@/lib/log";

const log = createLogger("oauth");

// RFC 7591: registro dinámico de clientes públicos (ChatGPT, Claude, Antigravity… se registran solos).
export async function POST(req: Request) {
  pruneRateLimits();
  // Por IP y, además, una cuota GLOBAL: si la IP no es fiable (cabeceras), igualmente no se puede inundar la tabla.
  if (!checkRateLimit(`oauth-register:${clientIp(req)}`, 10, 60_000) || !checkRateLimit("oauth-register:global", 200, 3_600_000)) {
    return oauthJson({ error: "invalid_request", error_description: "Demasiados registros." }, 429);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return oauthJson({ error: "invalid_client_metadata", error_description: "JSON inválido." }, 400);
  }
  try {
    const c = await registerClient(body);
    return oauthJson(
      {
        client_id: c.id,
        client_name: c.name,
        redirect_uris: c.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        client_id_issued_at: Math.floor(Date.now() / 1000),
      },
      201,
    );
  } catch (e) {
    if (e instanceof OAuthError) return oauthJson({ error: e.code, error_description: e.description }, e.status);
    log.error("register", { error: e instanceof Error ? e.message : String(e) });
    return oauthJson({ error: "server_error" }, 500);
  }
}
export const OPTIONS = oauthPreflight;
