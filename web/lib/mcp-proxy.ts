// Proxy MCP de solo lectura delante del `/mcp` embebido de SurrealDB. Puro (sin `next/*`):
// decide qué peticiones pasan y filtra `tools/list`. El aislamiento por tienda y por
// campo lo hace SurrealDB con el JWT del usuario; esto solo evita que el agente vea o
// intente herramientas de escritura (una escritura denegada por PERMISSIONS responde
// `[]` sin error y el agente creería que escribió).

/** Herramientas publicadas al agente. `run`/`gql`/`graphql` quedan fuera: pueden ejecutar funciones o mutar. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["query", "select", "list", "info"]);

export type Inspected =
  | { kind: "forward"; method: string | null }
  | { kind: "reject"; status: number; payload: Record<string, unknown> };

/** Revisa el cuerpo de un POST al MCP antes de reenviarlo. */
export function inspectRequest(body: string): Inspected {
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    return reject(400, null, -32700, "JSON inválido.");
  }
  if (Array.isArray(msg)) return reject(400, null, -32600, "Lotes JSON-RPC no soportados.");
  if (!msg || typeof msg !== "object") return reject(400, null, -32600, "Petición inválida.");
  const m = msg as { id?: unknown; method?: unknown; params?: { name?: unknown } };
  const method = typeof m.method === "string" ? m.method : null;
  if (method === "tools/call") {
    const name = typeof m.params?.name === "string" ? m.params.name : "";
    if (!READ_ONLY_TOOLS.has(name)) {
      return {
        kind: "reject",
        status: 200,
        payload: {
          jsonrpc: "2.0",
          id: m.id ?? null,
          result: {
            isError: true,
            content: [{ type: "text", text: `Herramienta no disponible: "${name}". Este acceso es de solo lectura (${[...READ_ONLY_TOOLS].join(", ")}).` }],
          },
        },
      };
    }
  }
  return { kind: "forward", method };
}

function reject(status: number, id: unknown, code: number, message: string): Inspected {
  return { kind: "reject", status, payload: { jsonrpc: "2.0", id, error: { code, message } } };
}

function filterMessage(msg: unknown): unknown {
  const m = msg as { result?: { tools?: Array<{ name?: string }> } } | null;
  if (m?.result && Array.isArray(m.result.tools)) {
    return { ...m, result: { ...m.result, tools: m.result.tools.filter((t) => t.name && READ_ONLY_TOOLS.has(t.name)) } };
  }
  return msg;
}

/** Deja en la respuesta de `tools/list` solo las herramientas de lectura. JSON plano o SSE (`data: {…}`). */
export function filterToolsList(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.stringify(filterMessage(JSON.parse(trimmed)));
    } catch {
      return text;
    }
  }
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const raw = line.slice(5).trim();
      if (!raw.startsWith("{")) return line;
      try {
        return `data: ${JSON.stringify(filterMessage(JSON.parse(raw)))}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

/** Extrae la clave de `Authorization: Bearer <clave>`. */
export function bearerKey(header: string | null): string | null {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}
