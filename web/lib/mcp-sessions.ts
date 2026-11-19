// Vínculo sesión MCP ↔ credencial. El transporte de Surreal (rmcp) resuelve la sesión y registra el canal de
// respuesta por id JSON-RPC ANTES de comprobar la identidad, así que un POST con la sesión de otro llegaría hasta
// allí. El proxy recuerda qué credencial abrió cada sesión y corta en la frontera cualquier POST de otra.
// En memoria y por instancia: si la sesión no está aquí (reinicio, otra instancia) se responde 404 y el cliente
// reinicia la sesión (lo que la especificación prevé). Falla cerrado. Puro, sin `next/*`.
const IDLE_MS = 60 * 60_000;
const MAX_SESSIONS = 5000;

interface Entry {
  owner: string;
  lastMs: number;
}
const KEY = "__mcpSessions";
function sessions(): Map<string, Entry> {
  const g = globalThis as Record<string, unknown>;
  let m = g[KEY] as Map<string, Entry> | undefined;
  if (!m) {
    m = new Map();
    g[KEY] = m;
  }
  return m;
}

/** Registra que `owner` (huella de su credencial) abrió la sesión `sessionId`. */
export function bindSession(sessionId: string, owner: string, now = Date.now()): void {
  const m = sessions();
  if (m.size >= MAX_SESSIONS) {
    for (const [id, e] of m) if (now - e.lastMs > IDLE_MS) m.delete(id);
    // Si siguen todas activas se descarta la más antigua (el Map conserva el orden de inserción).
    while (m.size >= MAX_SESSIONS) m.delete(m.keys().next().value as string);
  }
  m.set(sessionId, { owner, lastMs: now });
}

/** ¿La sesión pertenece a esta credencial? Una sesión desconocida o ajena NO se distingue (ambas 404). */
export function sessionAllowed(sessionId: string, owner: string, now = Date.now()): boolean {
  const m = sessions();
  const e = m.get(sessionId);
  if (!e || e.owner !== owner) return false;
  if (now - e.lastMs > IDLE_MS) {
    m.delete(sessionId);
    return false;
  }
  e.lastMs = now;
  return true;
}

/** Solo tests. */
export function resetMcpSessions(): void {
  sessions().clear();
}
