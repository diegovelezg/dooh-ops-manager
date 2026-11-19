import { exchangeAgentKey, keyFingerprint } from "@/lib/agent-tokens";
import { bearerKey, filterToolsList, shapeInitialize, inspectRequest } from "@/lib/mcp-proxy";
import { agentInstructions } from "@/lib/agent-schema";
import { surrealEnv } from "@/lib/surreal";
import { createLogger } from "@/lib/log";
import { bindSession, sessionAllowed } from "@/lib/mcp-sessions";
import { publicOrigin, resourceMetadataUrl } from "@/lib/oauth";

// Endpoint MCP de solo lectura para agentes (Claude, ChatGPT, Cursor…).
// Auth: `Authorization: Bearer dooh_agent_…` (clave personal de Ajustes). La clave se canjea por
// el JWT del propio usuario y la petición se reenvía al `/mcp` embebido de SurrealDB (que debe
// quedar solo en red interna): las PERMISSIONS del usuario deciden qué ve. Ver lib/mcp-proxy.ts.

const log = createLogger("mcp");
const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const DROP_RESPONSE_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding", "connection"]);

/** 401 con `resource_metadata` (RFC 9728): así un cliente MCP descubre dónde iniciar el flujo OAuth. */
function unauthorized(self: string): Response {
  const meta = resourceMetadataUrl(self);
  return Response.json(
    { error: "Acceso no autorizado: inicia sesión desde tu cliente MCP o el token fue revocado." },
    { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${meta}"` } },
  );
}

async function handle(req: Request): Promise<Response> {
  // Streamable HTTP: validar `Origin` contra DNS rebinding/CSRF de navegador. Los clientes MCP de servidor no lo envían.
  // El origen público se resuelve SIEMPRE (no solo cuando llega `Origin`): en producción una `PUBLIC_APP_URL` ausente o
  // inválida debe fallar aquí, no pasar de largo porque el cliente MCP no envía `Origin`.
  let self: string;
  try {
    self = publicOrigin(req.headers, req.url);
  } catch (e) {
    log.error("config", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "Configuración del servidor incompleta." }, { status: 500 });
  }
  const origin = req.headers.get("origin");
  if (origin && origin !== self) {
    return Response.json({ error: "Origin no permitido." }, { status: 403 });
  }
  // Sin GET (flujo SSE) ni DELETE (cerrar sesión): el transporte de Surreal los resuelve por id de sesión SIN comprobar la
  // identidad (otro usuario con un token válido podría cerrar o escuchar una sesión ajena). Las peticiones son POST.
  if (req.method !== "POST") {
    return Response.json({ error: "Método no permitido." }, { status: 405, headers: { Allow: "POST" } });
  }
  const key = bearerKey(req.headers.get("authorization"));
  if (!key) return unauthorized(self);

  let jwt: string | null;
  try {
    jwt = await exchangeAgentKey(key);
  } catch (e) {
    log.error("exchange", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "Servicio no disponible." }, { status: 503 });
  }
  if (!jwt) return unauthorized(self);

  let body: string | undefined;
  let method: string | null = null;
  if (req.method === "POST") {
    body = await req.text();
    const verdict = inspectRequest(body);
    if (verdict.kind === "reject") {
      return verdict.payload === null ? new Response(null, { status: verdict.status }) : Response.json(verdict.payload, { status: verdict.status });
    }
    method = verdict.method;
  }

  // Sesión MCP: solo la credencial que la abrió puede usarla. Se comprueba ANTES de reenviar (ver lib/mcp-sessions.ts).
  const owner = keyFingerprint(key);
  const sessionId = req.headers.get("mcp-session-id");
  if (sessionId && method !== "initialize" && !sessionAllowed(sessionId, owner)) {
    return Response.json({ error: "Sesión no encontrada." }, { status: 404 });
  }

  const { url, namespace, database } = surrealEnv();
  const headers = new Headers();
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    // `initialize` abre una sesión nueva: nunca hereda un id de sesión del cliente.
    if (v && !(method === "initialize" && h === "mcp-session-id")) headers.set(h, v);
  }
  headers.set("authorization", `Bearer ${jwt}`);
  headers.set("surreal-ns", namespace);
  headers.set("surreal-db", database);

  let upstream: Response;
  try {
    upstream = await fetch(`${url.replace(/^ws/, "http").replace(/\/rpc\/?$/, "")}/mcp`, {
      method: req.method,
      headers,
      body,
      signal: req.signal,
    });
  } catch (e) {
    log.error("upstream", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "Servicio no disponible." }, { status: 502 });
  }

  const out = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) out.set(k, v);
  });
  if (method === "tools/list") {
    return new Response(filterToolsList(await upstream.text()), { status: upstream.status, headers: out });
  }
  if (method === "initialize") {
    const opened = upstream.headers.get("mcp-session-id");
    if (opened && upstream.ok) bindSession(opened, owner);
    return new Response(shapeInitialize(await upstream.text(), agentInstructions()), { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { handle as GET, handle as POST, handle as DELETE };
