// Proxy MCP de solo lectura delante del `/mcp` embebido de SurrealDB. Puro (sin `next/*`):
// decide qué peticiones pasan y filtra `tools/list`. El aislamiento por tienda y por
// campo lo hace SurrealDB con el JWT del usuario; esto solo evita que el agente vea o
// intente herramientas de escritura (una escritura denegada por PERMISSIONS responde
// `[]` sin error y el agente creería que escribió).

/** Herramientas publicadas al agente. `run`/`gql`/`graphql` quedan fuera (pueden ejecutar funciones o mutar) e
 *  `info`/`list` también: un usuario normal no puede introspeccionar el esquema (IAM error), ver lib/agent-schema.ts. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["query", "select"]);

/** Métodos MCP que se reenvían. Lista cerrada: `resources/*`, `prompts/*`, `completion/*`, etc. no se exponen.
 *  Tampoco `notifications/cancelled`: el transporte de Surreal cierra la respuesta en curso por id de sesión/petición
 *  antes de comprobar la identidad, así que otro usuario podría interrumpir la de alguien más. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
]);

export type Inspected =
  | { kind: "forward"; method: string | null }
  /** `payload: null` = notificación rechazada: se responde 202 sin cuerpo. */
  | { kind: "reject"; status: number; payload: Record<string, unknown> | null };

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
  const m = msg as { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: Record<string, unknown> } };
  const method = typeof m.method === "string" ? m.method : null;
  if (method === null || !ALLOWED_METHODS.has(method)) {
    // Solo respuestas del cliente a peticiones del servidor (sin `method`) o métodos desconocidos: no se reenvían.
    if (m.id === undefined) return { kind: "reject", status: 202, payload: null };
    return { kind: "reject", status: 200, payload: { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Método no disponible: ${method ?? "(ninguno)"}.` } } };
  }
  if (method === "tools/call") {
    const name = typeof m.params?.name === "string" ? m.params.name : "";
    const toolError = (text: string): Inspected => ({
      kind: "reject",
      status: 200,
      payload: { jsonrpc: "2.0", id: m.id ?? null, result: { isError: true, content: [{ type: "text", text }] } },
    });
    if (!READ_ONLY_TOOLS.has(name)) {
      return toolError(`Herramienta no disponible: "${name}". Este acceso es de solo lectura (${[...READ_ONLY_TOOLS].join(", ")}).`);
    }
    // Surreal da prioridad a `namespace`/`database` de los argumentos sobre las cabeceras fijas del proxy.
    const args = m.params?.arguments ?? {};
    if (args && typeof args === "object" && ("namespace" in args || "database" in args)) {
      return toolError("No se puede cambiar de namespace o base de datos: el acceso está fijado a la de la aplicación.");
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

/** Da forma a la respuesta de `initialize`: fija `instructions` (guía de datos y reglas: REEMPLAZA las de Surreal, que
 *  anuncian herramientas ocultas como create, run, info…) y reduce `capabilities` a lo que el proxy sirve (solo tools:
 *  sin resources, prompts ni completions, que no se reenvían). JSON plano o SSE (`data: {…}`). */
export function shapeInitialize(text: string, instructions: string): string {
  const patch = (msg: unknown): unknown => {
    const m = msg as { result?: { serverInfo?: unknown } } | null;
    if (m?.result && m.result.serverInfo) return { ...m, result: { ...m.result, instructions, capabilities: { tools: {} } } };
    return msg;
  };
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.stringify(patch(JSON.parse(trimmed)));
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
        return `data: ${JSON.stringify(patch(JSON.parse(raw)))}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}
