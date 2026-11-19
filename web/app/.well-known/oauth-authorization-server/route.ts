import { oauthJson, oauthPreflight } from "@/lib/oauth-http";
import { authorizationServerMetadata, publicOrigin } from "@/lib/oauth";

// RFC 8414: metadatos del servidor de autorización.
export async function GET(req: Request) {
  return oauthJson(authorizationServerMetadata(publicOrigin(req.headers, req.url)));
}
export const OPTIONS = oauthPreflight;
