import { oauthJson, oauthPreflight } from "@/lib/oauth-http";
import { protectedResourceMetadata, publicOrigin } from "@/lib/oauth";

// RFC 9728: documento del recurso protegido (el MCP). Los clientes lo descubren por el 401 de /mcp.
export async function GET(req: Request) {
  return oauthJson(protectedResourceMetadata(publicOrigin(req.headers, req.url)));
}
export const OPTIONS = oauthPreflight;
