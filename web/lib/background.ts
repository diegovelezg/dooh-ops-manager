// Corridas en segundo plano. Fuente única de verdad (SSOT) para la cinta de
// progreso global: cualquier trabajo de larga duración (perfil profundo,
// import, ...) registra aquí su estado y la UI lo muestra con un solo componente.
// Sin `server-only`: lo importan los server actions (profile-actions,
// background-actions); ningún componente cliente lo importa en runtime
// (solo el tipo BackgroundRun).
//
// Contrato de `summary` (Fase 2): 1 línea, lenguaje humano,
// outcome + $ cuando aplique, pausa intencional explicada. Nunca jerga de logs.
// Formatos vivos: profile ("Perfil X/Y etapas"), import ("import <kind>
// <source>: X/Y ok", traspaso desde import_runs en 20261124).
// (HISTÓRICO: los formatos scout/strategist/copywriter/prospect/dispatcher/
// analyst son del motor de retención extirpado en 20261122 y ya no se emiten.)
// El `failed` va en su columna, no en el texto. `current` nunca lleva PII.
import { surql } from "@/lib/surreal";
import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/log";
import type { ErrorCode, ScopeKind } from "@/lib/operations";

const log = createLogger("background");

export type RunStatus = "running" | "done" | "error";

/** Estado TeamPulse que cada corrida declara al cerrar: la SSOT para ordenar
 *  needs > active > paused. `null` = corrida vieja (pre-migración). */
export type PulseState = "needs" | "active" | "paused";

export interface BackgroundRun {
  id: string;
  kind: string;
  label: string;
  status: RunStatus;
  pulseState: PulseState | null;
  total: number;
  processed: number;
  failed: number;
  current: string | null;
  summary: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Acotación del lock (issue #16 Fase 0): `global` = toda la tienda,
   *  `signal`/`customer`/`domain` + `scopeId` = una sola unidad. */
  scopeKind: ScopeKind;
  scopeId: string | null;
  /** Heartbeat de los workers (último `advanceRun`/`touchRun`). */
  updatedAt: string | null;
  /** Cierre tipado para la UI (veto ≠ fallo). */
  errorCode: ErrorCode | null;
}

const SCOPE_KINDS: ScopeKind[] = ["global", "signal", "customer", "domain"];
const ERROR_CODES: ErrorCode[] = ["judge_veto", "busy", "llm_fail", "stale", "conflict"];

function mapRun(r: Record<string, unknown>): BackgroundRun {
  const scopeKind = r.scope_kind as ScopeKind | null;
  const errorCode = r.error_code as ErrorCode | null;
  return {
    id: String(r.id),
    kind: (r.kind as string) ?? "",
    label: (r.label as string) ?? "",
    status: (r.status as RunStatus) ?? "running",
    pulseState: ((r.pulse_state as PulseState | null) ?? null),
    total: Number(r.total ?? 0),
    processed: Number(r.processed ?? 0),
    failed: Number(r.failed ?? 0),
    current: (r.current as string) ?? null,
    summary: (r.summary as string) ?? null,
    error: (r.error as string) ?? null,
    startedAt: String(r.started_at ?? ""),
    finishedAt: (r.finished_at as string) ?? null,
    scopeKind: (scopeKind && SCOPE_KINDS.includes(scopeKind) ? scopeKind : "global"),
    scopeId: (r.scope_id as string | null) ?? null,
    updatedAt: (r.updated_at as string | null) ?? null,
    errorCode: (errorCode && ERROR_CODES.includes(errorCode) ? errorCode : null),
  };
}

const S = "type::record('sys_store', $store)";
const RUN_COLS = `record::id(id) AS id, kind, label, status, pulse_state, total, processed, failed, current, summary,
  error, fn::iso(started_at) AS started_at, fn::iso(finished_at) AS finished_at, scope_kind, scope_id,
  fn::iso(updated_at) AS updated_at, error_code`;
const RUN = "type::record('sys_run', $id)";

export async function getLatestRun(storeId: string): Promise<BackgroundRun | null> {
  const rows = await surql<Array<Record<string, unknown>>>(
    `SELECT ${RUN_COLS} FROM sys_run WHERE store = ${S} ORDER BY started_at DESC LIMIT 1`,
    { store: storeId },
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

/** ISO del último run terminado de un kind (para throttles). null si nunca. */
export async function getLastFinishedAt(storeId: string, kind: string): Promise<string | null> {
  const rows = await surql<Array<{ at: string | null }>>(
    `SELECT fn::iso(finished_at ?? started_at) AS at FROM sys_run
     WHERE store = ${S} AND kind = $kind AND status != 'running' ORDER BY started_at DESC LIMIT 1`,
    { store: storeId, kind },
  );
  return rows[0]?.at ?? null;
}

/** Todas las corridas en curso (el lock granular y la cinta las leen de aquí). */
async function getRunningRuns(storeId: string): Promise<BackgroundRun[]> {
  const rows = await surql<Array<Record<string, unknown>>>(
    `SELECT ${RUN_COLS} FROM sys_run WHERE store = ${S} AND status = 'running' ORDER BY started_at DESC`,
    { store: storeId },
  );
  return rows.map(mapRun);
}

/** Fuente de la cinta multi-run (Fase 2): en curso + últimos terminados. */
export async function getActiveRuns(storeId: string, finishedLimit = 3): Promise<BackgroundRun[]> {
  const [running, finished] = await Promise.all([
    getRunningRuns(storeId),
    surql<Array<Record<string, unknown>>>(
      `SELECT ${RUN_COLS} FROM sys_run WHERE store = ${S} AND status != 'running' ORDER BY started_at DESC LIMIT $limit`,
      { store: storeId, limit: finishedLimit },
    ),
  ]);
  return [...running, ...finished.map(mapRun)];
}

/** Minutos sin heartbeat tras los cuales un `running` se da por muerto.
 *  Cada escritura sella `updated_at`, así que una corrida que progresa nunca se siega;
 *  una colgada (crash, deploy, script manual) libera el lock sola en vez de bloquear
 *  para siempre. */
const STALE_RUN_MINUTES = 30;

/** Marca como error los `running` sin heartbeat (best-effort, nunca lanza).
 *  Devuelve cuántos segó. */
async function reapStaleRuns(storeId: string): Promise<number> {
  try {
    const dead = await surql<unknown[]>(
      `UPDATE sys_run SET status = 'error', error = $msg, current = NONE, finished_at = time::now()
       WHERE store = ${S} AND status = 'running' AND updated_at < time::now() - <duration> $age RETURN record::id(id)`,
      { store: storeId, msg: `Stuck sin cierre ni heartbeat en ${STALE_RUN_MINUTES}min (reap automático)`, age: `${STALE_RUN_MINUTES}m` },
    );
    if (dead.length > 0) log.warn("reapStaleRuns", { count: dead.length, storeId });
    return dead.length;
  } catch {
    return 0;
  }
}

export async function startRun(
  storeId: string,
  kind: string,
  label: string,
  total: number,
  opts?: { scopeKind?: ScopeKind; scopeId?: string | null },
): Promise<string> {
  // Auto-limpieza: un colgado no debe bloquear a los vivos.
  await reapStaleRuns(storeId).catch(() => {});
  const id = randomUUID();
  await surql(
    `CREATE type::record('sys_run', $id) SET store = ${S}, kind = $kind, label = $label, total = $total,
       scope_kind = $scopeKind, scope_id = $scopeId ?? NONE`,
    { id, store: storeId, kind, label, total, scopeKind: opts?.scopeKind ?? "global", scopeId: opts?.scopeId ?? null },
  );
  log.info("startRun", { storeId, kind, runId: id });
  return id;
}

/**
 * Slot atómico de corrida (issue #24, workers concurrentes): check de la matriz #16 + alta en UNA
 * transacción (`fn::run_start`, registro compartido por tienda). Devuelve el run id, o `null`
 * si hay ocupación (el caller omite en vez de duplicar: el trabajo ya lo cubre la corrida en curso).
 */
export async function claimRunSlot(
  storeId: string,
  kind: string,
  label: string,
  total: number,
): Promise<string | null> {
  await reapStaleRuns(storeId).catch(() => {});
  return (await surql<string | null>(`RETURN fn::run_start(${S}, $kind, $label, $total)`, { store: storeId, kind, label, total })) ?? null;
}

/** Actualiza el progreso en vivo de una corrida (el heartbeat `updated_at` se sella solo). */
export async function advanceRun(
  runId: string,
  p: { processed: number; failed: number; current: string | null },
): Promise<void> {
  await surql(`UPDATE ${RUN} SET current = $current ?? NONE, processed = $processed, failed = $failed`, {
    id: runId, current: p.current, processed: p.processed, failed: p.failed,
  });
}

/** Error compacto con stack para sys_runs.error (text): si un worker
 *  falla en prod, el origen queda en la DB sin adivinar (deuda 2026-10-21:
 *  prospect moría con "Cannot read properties of undefined (reading
 *  'bind')" sin frames). Solo mensaje + 3 frames, cap 600. */
export function formatRunError(e: unknown, max = 600): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (!(e instanceof Error) || !e.stack) return msg;
  const frames = e.stack
    .split("\n")
    .slice(1, 4)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" <- ");
  const out = frames ? `${msg} [${frames}]` : msg;
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** Cierra una corrida con su resultado final. */
export async function finishRun(
  runId: string,
  p: {
    status: RunStatus;
    processed: number;
    failed: number;
    summary?: string | null;
    error?: string | null;
    pulseState?: PulseState | null;
    errorCode?: ErrorCode | null;
  },
): Promise<void> {
  const t0 = Date.now();
  await surql(
    `UPDATE ${RUN} SET status = $status, processed = $processed, failed = $failed, summary = $summary ?? NONE,
       error = $error ?? NONE, current = NONE, finished_at = time::now(),
       pulse_state = $pulse ?? NONE, error_code = $code ?? NONE`,
    {
      id: runId, status: p.status, processed: p.processed, failed: p.failed, summary: p.summary ?? null,
      error: p.error ?? null, pulse: p.pulseState ?? null, code: p.errorCode ?? null,
    },
  );
  if (p.status === "error") log.error("finishRun", { runId, status: p.status, error: p.error ?? undefined });
  else log.info("finishRun", { runId, status: p.status, processed: p.processed, failed: p.failed, ms: Date.now() - t0 });
}
