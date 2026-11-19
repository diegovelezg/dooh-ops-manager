import { oauthJson, oauthPreflight, clientIp } from "@/lib/oauth-http";
import { OAuthError, exchangeCode } from "@/lib/oauth";
import { checkRateLimit, pruneRateLimits } from "@/lib/rate-limit";
import { createLogger } from "@/lib/log";

const log = createLogger("oauth");

async function readParams(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const j = (await req.json().catch(() => ({}))) as unknown;
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  }
  return Object.fromEntries(new URLSearchParams(await req.text()));
}

// Endpoint de token: authorization_code + PKCE (clientes públicos). Devuelve un token que no caduca.
export async function POST(req: Request) {
  pruneRateLimits();
  if (!checkRateLimit(`oauth-token:${clientIp(req)}`, 30, 60_000)) {
    return oauthJson({ error: "invalid_request", error_description: "Demasiadas peticiones." }, 429);
  }
  try {
    const p = await readParams(req);
    if (p.grant_type !== "authorization_code") {
      throw new OAuthError("unsupported_grant_type", "Solo authorization_code.");
    }
    return oauthJson(await exchangeCode(p as Parameters<typeof exchangeCode>[0]));
  } catch (e) {
    if (e instanceof OAuthError) return oauthJson({ error: e.code, error_description: e.description }, e.status);
    log.error("token", { error: e instanceof Error ? e.message : String(e) });
    return oauthJson({ error: "server_error" }, 500);
  }
}
export const OPTIONS = oauthPreflight;
