import { exchangeAgentKey } from "@/lib/agent-tokens";
import { bearerKey, filterToolsList, inspectRequest } from "@/lib/mcp-proxy";
import { surrealEnv } from "@/lib/surreal";
import { createLogger } from "@/lib/log";

// Endpoint MCP de solo lectura para agentes (Claude, ChatGPT, Cursor…).
// Auth: `Authorization: Bearer dooh_agent_…` (clave personal de Ajustes). La clave se canjea por
// el JWT del propio usuario y la petición se reenvía al `/mcp` embebido de SurrealDB (que debe
// quedar solo en red interna): las PERMISSIONS del usuario deciden qué ve. Ver lib/mcp-proxy.ts.

const log = createLogger("mcp");
const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const DROP_RESPONSE_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding", "connection"]);

function unauthorized(): Response {
  return Response.json(
    { error: "Clave de agente inválida, revocada o vencida." },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="dooh-mcp"' } },
  );
}

async function handle(req: Request): Promise<Response> {
  const key = bearerKey(req.headers.get("authorization"));
  if (!key) return unauthorized();

  let jwt: string | null;
  try {
    jwt = await exchangeAgentKey(key);
  } catch (e) {
    log.error("exchange", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "Servicio no disponible." }, { status: 503 });
  }
  if (!jwt) return unauthorized();

  let body: string | undefined;
  let method: string | null = null;
  if (req.method === "POST") {
    body = await req.text();
    const verdict = inspectRequest(body);
    if (verdict.kind === "reject") return Response.json(verdict.payload, { status: verdict.status });
    method = verdict.method;
  }

  const { url, namespace, database } = surrealEnv();
  const headers = new Headers();
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
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
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { handle as GET, handle as POST, handle as DELETE };
