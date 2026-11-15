// Muro de insights (issue #11): brecha KPI → lectura.
// Un solo proceso determinista (buildBriefFacts, sin LLM) + un solo narrador
// LLM (brief_narrate, con metering en ai_llm_usage). Sin swarm, sin auto-envíos,
// sin scoring probabilístico. Anti-ruido: máx 5/día, dedupe por (kind+scope),
// silencio si sin cambios.
import { insertInsights, listInsightKeysSince, listInsights, readInsightIds, restoreInsight as restoreInsightRead } from "@/lib/insights-store";
import { listCompanies } from "@/lib/crm-store";
import { orderIdsWithPhotos, selectLines, selectOrders } from "@/lib/orders-store";
import type { DashboardSnapshot } from "@/lib/dashboard";
// Puro y client-safe; se re-exporta para los callers de servidor/tests.
// El feed ("use client") importa de `@/lib/insight-mentions` directo:
// importar `@/lib/insights` en cliente arrastraría el acceso a datos y retrieval
// (crawlee → async_hooks) y rompería el bundle (ver _error 2026-11-08).
import { audienceMentions, buildDrawerHref, describeContextShort, insightCta, isMine, stripBodyLinks } from "@/lib/insight-mentions";
import { DAY_MS } from "@/lib/format";

export { audienceMentions, buildDrawerHref, describeContextShort, insightCta, isMine, stripBodyLinks };

const BRIEF_KIND = "brief" as const;
const BRIEF_NARRATE_PROCESS = "brief_narrate" as const;
export const MAX_POSTS_PER_DAY = 5;

export type InsightScopeKind = "order" | "company" | "screen" | "global";

export interface BriefFact {
  kind: string;
  scopeKind: InsightScopeKind;
  scopeId: string | null;
  title: string;
  detail: string;
  link: string;
  /** Contexto humano exacto (solo hechos con scope): cliente, pantallas, monto, vigencia. */
  context?: BriefContext | null;
}

/** Contexto exacto de una OI para humanizar el aviso. Todo viene de la DB
 *  (io_orders + io_lines + crm_companies); nunca estimado ni inventado. */
export interface BriefContext {
  company: string | null;
  brand: string | null;
  screens: number | null;
  amountMinor: number | null;
  currency: string | null;
  startsAt: string | null;
  endsAt: string | null;
  /** Métricas de urgencia por kind global (por_certificar, ocupacion…). */
  metrics?: Array<{ label: string; value: string }> | null;
}

interface InsightPost extends BriefFact {
  body: string;
  severity: "info" | "warning" | "critical";
  audience: { user_ids: string[]; emails: string[]; roles: string[] };
}

const KIND_PRIORITY: Record<string, number> = {
  sin_om: 0,
  material: 1,
  sin_evidencia: 2,
  por_certificar: 3,
  termina_sin_relevo: 4,
};

const KIND_TITLE: Record<string, string> = {
  sin_om: "Falta OM: no se puede facturar",
  material: "Sin material registrado",
  sin_evidencia: "Al aire sin evidencia",
  por_certificar: "Terminadas sin certificar",
  termina_sin_relevo: "Termina sin relevo",
};

/** Analizador determinista: hechos con números exactos del snapshot.
//  Puro y testeable (tsx --test). Nunca inventa cifras: solo reformatea lo
//  que ya trae getDashboardSnapshot().
//  Contrato: el inbox es riesgos y bloqueos con dueño y acción (scope orden
//  + por_certificar global). Las métricas de salud (ocupación, huecos,
//  relevo 30d) viven solo en el dashboard: descartar una métrica no significa
//  nada y el brief la regeneraría como nag permanente. */
export function buildBriefFacts(snap: DashboardSnapshot, max = MAX_POSTS_PER_DAY): BriefFact[] {
  const facts: BriefFact[] = [];
  for (const a of snap.alerts ?? []) {
    facts.push({
      kind: a.kind,
      scopeKind: "order",
      scopeId: a.ioId,
      title: `${KIND_TITLE[a.kind] ?? a.kind} · ${a.ioNumber}`,
      detail: a.detail,
      link: `/orders?order=${a.ioId}`,
    });
  }
  if (snap.porCertificar > 0) {
    facts.push({
      kind: "por_certificar",
      scopeKind: "global",
      scopeId: null,
      title: `${KIND_TITLE.por_certificar} · ${snap.porCertificar}`,
      detail: `${snap.porCertificar} orden(es) terminada(s) sin foto-check — riesgo de disputa al cobrar.`,
      link: "/orders",
    });
  }
  facts.sort(
    (a, b) =>
      (KIND_PRIORITY[a.kind] ?? 99) - (KIND_PRIORITY[b.kind] ?? 99) ||
      a.title.localeCompare(b.title),
  );
  // Dedupe por (kind+scope) dentro del propio snapshot.
  const seen = new Set<string>();
  const out: BriefFact[] = [];
  for (const f of facts) {
    const k = dedupeKey(f.kind, f.scopeId);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

export function dedupeKey(kind: string, scopeId: string | null): string {
  return `${kind}:${scopeId ?? "global"}`;
}

/** Arrobas desde auditoría (actor.ts: created_by/updated_by guardan email).
 *  Reglas del issue #11: creado==editado o uno null → un solo @;
 *  difieren → @ a ambos (creador responsable, editor contexto);
 *  updated_at >30d → pesa el creador. Puro y testeable. */
export function resolveMentions(
  createdBy: string | null | undefined,
  updatedBy: string | null | undefined,
  updatedAt: string | null | undefined,
  nowMs = Date.now(),
): string[] {
  const clean = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const e = v.trim().toLowerCase();
    return e.length >= 5 && e.includes("@") ? e : null;
  };
  const c = clean(createdBy);
  const u = clean(updatedBy);
  if (!c && !u) return [];
  if (!c) return [u!];
  if (!u || u === c) return [c];
  const t = typeof updatedAt === "string" && updatedAt ? Date.parse(updatedAt) : NaN;
  if (Number.isFinite(t) && nowMs - (t as number) > 30 * DAY_MS) return [c];
  return [c, u];
}

/** Mapea emails → membresías (user_ids) para audience_json. Puro. */
export function mapAudience(
  emails: string[],
  members: Array<{ user_id: string; email: string | null }>,
  roles: string[] = [],
): { user_ids: string[]; emails: string[]; roles: string[] } {
  const byEmail = new Map(
    members
      .filter((m) => typeof m.email === "string" && m.email)
      .map((m) => [(m.email as string).trim().toLowerCase(), m.user_id]),
  );
  const user_ids = [...new Set(emails.map((e) => byEmail.get(e.trim().toLowerCase())).filter((v): v is string => Boolean(v)))];
  return { user_ids, emails: [...new Set(emails.map((e) => e.trim().toLowerCase()))], roles: [...new Set(roles)] };
}

export interface WallInsight {
  id: string;
  kind: string;
  title: string;
  body: string;
  links: string[];
  audience: { user_ids: string[]; emails: string[]; roles: string[] };
  severity: string;
  scopeKind: InsightScopeKind | null;
  scopeId: string | null;
  context: BriefContext | null;
  createdAt: string;
  dismissed: boolean;
  mine: boolean;
}

/** Lee el muro del tenant (últimos 20) con dismiss + `mine` resueltos. */
export async function listWallInsights(
  storeId: string,
  me: { userId: string | null; email: string | null; role: string | null },
): Promise<WallInsight[]> {
  const rows = await listInsights(storeId, 20);
  const list = rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind ?? ""),
    title: String(r.title ?? ""),
    body: String(r.body ?? ""),
    links: Array.isArray(r.links_json) ? (r.links_json as unknown[]).map(String) : [],
    audience: ((): { user_ids: string[]; emails: string[]; roles: string[] } => {
      const a = r.audience_json as Record<string, unknown> | null;
      return {
        user_ids: Array.isArray(a?.user_ids) ? (a?.user_ids as unknown[]).map(String) : [],
        emails: Array.isArray(a?.emails) ? (a?.emails as unknown[]).map(String) : [],
        roles: Array.isArray(a?.roles) ? (a?.roles as unknown[]).map(String) : [],
      };
    })(),
    severity: String(r.severity ?? "info"),
    scopeKind: (r.scope_kind as InsightScopeKind | null) ?? null,
    scopeId: (r.scope_id as string | null) ?? null,
    context: ((): BriefContext | null => {
      const c = r.context_json as Record<string, unknown> | null;
      if (!c || typeof c !== "object") return null;
      const metrics = Array.isArray(c.metrics)
        ? (c.metrics as Array<unknown>)
            .filter((m) => m && typeof m === "object")
            .map((m) => ({
              label: String((m as { label?: unknown }).label ?? ""),
              value: String((m as { value?: unknown }).value ?? ""),
            }))
            .filter((m) => m.label && m.value)
            .slice(0, 4)
        : null;
      return {
        company: (c.company as string | null) ?? null,
        brand: (c.brand as string | null) ?? null,
        screens: typeof c.screens === "number" ? c.screens : null,
        amountMinor: typeof c.amountMinor === "number" ? c.amountMinor : null,
        currency: (c.currency as string | null) ?? null,
        startsAt: (c.startsAt as string | null) ?? null,
        endsAt: (c.endsAt as string | null) ?? null,
        metrics,
      };
    })(),
    createdAt: String(r.created_at ?? ""),
  }));
  let readIds = new Set<string>();
  if (me.userId && list.length > 0) {
    readIds = await readInsightIds(me.userId, list.map((i) => i.id));
  }
  return list.map((i) => ({
    ...i,
    dismissed: readIds.has(i.id),
    mine: isMine(i.audience, me),
  }));
}

function fallbackBody(f: BriefFact): string {
  const ctx = describeContextShort(f.context);
  // Sin rutas crudas: el CTA de la card ya lleva el deep-link.
  const action = insightCta({ kind: f.kind, scopeKind: f.scopeKind, scopeId: f.scopeId, links: [f.link] }).label;
  return stripBodyLinks(`${f.detail}${ctx ? ` ${ctx}` : ""} Acción: ${action}.`);
}

/** Enriquece hechos con scope (OI) con contexto exacto de la DB
 *  (empresa, pantallas, monto, vigencia). Un batch por tabla. */
async function enrichOrderContext(
  storeId: string,
  facts: BriefFact[],
): Promise<Map<string, BriefContext>> {
  const out = new Map<string, BriefContext>();
  const orderIds = [...new Set(facts.filter((f) => f.scopeKind === "order" && f.scopeId).map((f) => f.scopeId as string))];
  if (orderIds.length === 0) return out;
  const [orders, lines] = await Promise.all([selectOrders(storeId, { ids: orderIds }), selectLines(storeId, orderIds)]);
  const orderById = new Map(orders.map((r) => [String(r.id), r]));
  const coIds = [
    ...new Set(
      [...orderById.values()].flatMap((r) => [r.advertiser_company_id, r.billing_company_id]).filter(Boolean),
    ),
  ] as string[];
  let nameBy = new Map<string, string>();
  if (coIds.length > 0) {
    nameBy = new Map((await listCompanies(storeId, coIds)).map((c) => [String(c.id), String(c.name ?? "—")]));
  }
  const screensBy = new Map<string, Set<string>>();
  const amountBy = new Map<string, number>();
  for (const l of lines) {
    const k = String(l.io_id);
    const set = screensBy.get(k) ?? new Set<string>();
    set.add(String(l.screen_id));
    screensBy.set(k, set);
    amountBy.set(k, (amountBy.get(k) ?? 0) + Number(l.rate_minor ?? 0));
  }
  for (const id of orderIds) {
    const r = orderById.get(id);
    if (!r) continue;
    const adv = (r.advertiser_company_id as string | null) ?? null;
    const bil = (r.billing_company_id as string | null) ?? null;
    const coId = adv ?? bil;
    out.set(id, {
      company: coId ? (nameBy.get(coId) ?? null) : null,
      brand: (r.brand as string | null) ?? null,
      screens: screensBy.get(id)?.size ?? null,
      amountMinor: amountBy.has(id) ? Math.round(amountBy.get(id) as number) : null,
      currency: (r.currency as string | null) ?? null,
      startsAt: (r.starts_at as string | null) ?? null,
      endsAt: (r.ends_at as string | null) ?? null,
    });
  }
  return out;
}

/** Métricas de urgencia para el único kind global del inbox
 *  (por_certificar = OIs terminadas sin foto: días esperando + monto en
 *  juego). Ocupación/huecos/relevo viven en el dashboard, no aquí. */
async function enrichGlobalContext(
  storeId: string,
  snap: DashboardSnapshot,
  facts: BriefFact[],
): Promise<Map<string, Array<{ label: string; value: string }>>> {
  const out = new Map<string, Array<{ label: string; value: string }>>();
  const want = new Set(facts.filter((f) => f.scopeKind === "global").map((f) => f.kind));
  if (want.size === 0) return out;
  const { formatMoney, isoDayPart, isoDayToNum, todayIn } = await import("@/lib/format");
  // Días del tenant (como el dashboard y la capacidad): un "hoy" en UTC cruza de día antes que el negocio.
  const { getStoreTimeZone } = await import("@/lib/stores-db");
  const tz = await getStoreTimeZone(storeId);
  const todayISO = todayIn(tz);
  const todayNum = isoDayToNum(todayISO);
  const endedDayNum = (v: unknown): number => {
    const d = isoDayPart(v);
    return d ? isoDayToNum(d) : todayNum;
  };
  const DAY = DAY_MS;
  const t = (v: unknown): number | null => {
    const n = Date.parse(String(v ?? ""));
    return Number.isFinite(n) ? n : null;
  };

  if (want.has("por_certificar") && snap.porCertificar > 0) {
    const ended = await selectOrders(storeId, { live: true, endedBefore: todayISO, limit: 500 });
    const ids = ended.map((r) => String(r.id));
    if (ids.length > 0) {
      const withPhoto = await orderIdsWithPhotos(storeId, ids);
      const waiting = ended.filter((r) => !withPhoto.has(String(r.id)));
      if (waiting.length > 0) {
        const oldest = Math.max(...waiting.map((r) => todayNum - endedDayNum(r.ends_at)));
        const lines = await selectLines(storeId, waiting.map((r) => String(r.id)));
        const amount = lines.reduce((n, l) => n + Number(l.rate_minor ?? 0), 0);
        const m = [
          { label: "En riesgo", value: `${waiting.length} OI${waiting.length === 1 ? "" : "s"}` },
          { label: "Esperando", value: `${oldest}d (la más antigua)` },
        ];
        if (amount > 0) m.push({ label: "Monto", value: formatMoney(Math.round(amount), snap.currency) });
        out.set(dedupeKey("por_certificar", null), m);
      }
    }
  }

  return out;
}

/** Narrador único (brief_narrate): hechos → 3-5 posts con explicación +
 *  1 accionable con deep-link. Prohibido inventar cifras: el prompt lo exige
 *  y el fallback ni siquiera toca un LLM. Con metering en ai_llm_usage.
 *  Devuelve `degraded: true` cuando usó el fallback determinista. */
async function narrateFacts(storeId: string, facts: BriefFact[]): Promise<{
  posts: Array<Pick<InsightPost, "title" | "body" | "severity"> & { kind: string; scopeKind: InsightScopeKind; scopeId: string | null; link: string }>;
  degraded: boolean;
}> {
  try {
    const { getLlmConfig } = await import("@/lib/ai/llm-config");
    const { completeJson } = await import("@/lib/retrieval");
    const cfg = getLlmConfig(BRIEF_NARRATE_PROCESS);
    const system = [
      "Narras el muro diario de una comercializadora DOOH peruana.",
      "Recibes HECHOS con números exactos + contexto (cliente, marca,",
      "pantallas, monto, vigencia) y métricas de urgencia por kind global.",
      "PROHIBIDO inventar cifras, montos, porcentajes o nombres: nombra al",
      "cliente y usa sus cifras tal cual para que el aviso se lea humano,",
      "y da 1 accionable en texto plano. PROHIBIDO URLs, rutas (/orders…),",
      "queries (?order=…) o UUIDs en el body: la card ya tiene botón con",
      "el deep-link. Sin novedad no hay post",
      "El kind `material` significa sin URL registrada: PROHIBIDO mencionar",
      "QC/legal o aprobación; el accionable es registrar la URL del material.",
      "Responde SOLO JSON: {\"posts\": [{\"kind\": string, \"body\": string, \"severity\": \"info\"|\"warning\"|\"critical\"}]}.",
      "body: 1-2 frases de explicación con contexto + 1 accionable. Sin cifras nuevas.",
    ].join(" ");
    const user = JSON.stringify({ facts: facts.map((f) => ({ kind: f.kind, scope: f.scopeId ?? "global", title: f.title, detail: f.detail, context: f.context ?? null })) });
    const order = [cfg.primary, cfg.fallback, cfg.fallback].filter(Boolean);
    let raw = "";
    for (let i = 0; i < order.length; i++) {
      try {
        raw = await completeJson(order[i]!, cfg.temperature, cfg.maxTokens, cfg.reasoningEffort, system, user, {
          storeId,
          process: BRIEF_NARRATE_PROCESS,
          usedFallback: i > 0,
        });
        break;
      } catch {
        if (i === order.length - 1) throw new Error("narrate-fail");
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    const parsed = JSON.parse(raw) as { posts?: Array<{ kind?: unknown; body?: unknown; severity?: unknown }> };
    const allowed = new Map(facts.map((f) => [dedupeKey(f.kind, f.scopeId), f]));
    const out: Array<{ kind: string; scopeKind: InsightScopeKind; scopeId: string | null; title: string; body: string; severity: "info" | "warning" | "critical"; link: string }> = [];
    for (const p of parsed.posts ?? []) {
      if (typeof p?.kind !== "string" || typeof p?.body !== "string") continue;
      const fact = facts.find((f) => f.kind === p.kind);
      if (!fact) continue; // kind fuera de hechos = invento: se descarta
      const key = dedupeKey(fact.kind, fact.scopeId);
      if (!allowed.has(key)) continue;
      allowed.delete(key);
      // Cinturón y tirantes: el body nunca lleva rutas crudas (el CTA sí).
      const body = stripBodyLinks(p.body.trim()).slice(0, 600);
      if (!body) continue;
      const sev = p.severity === "critical" || p.severity === "warning" ? p.severity : "info";
      out.push({ kind: fact.kind, scopeKind: fact.scopeKind, scopeId: fact.scopeId, title: fact.title, body, severity: sev, link: fact.link });
      if (out.length >= MAX_POSTS_PER_DAY) break;
    }
    if (out.length > 0) return { posts: out, degraded: false };
    throw new Error("narrate-empty");
  } catch {
    return { posts: facts.map((f) => ({ kind: f.kind, scopeKind: f.scopeKind, scopeId: f.scopeId, title: f.title, body: fallbackBody(f), severity: "info" as const, link: f.link })), degraded: true };
  }
}

/** ¿El brief ya corrió hoy (sys_runs kind='brief' terminado)? Para throttle
 *  1x día compartido entre ruta manual y cron (ver scripts/run-brief.ts). */
export async function briefAlreadyRanToday(storeId: string): Promise<boolean> {
  try {
    const { getLastFinishedAt } = await import("@/lib/background");
    const { dayStartMs, todayIn } = await import("@/lib/format");
    const { getStoreTimeZone } = await import("@/lib/stores-db");
    const tz = await getStoreTimeZone(storeId);
    const last = await getLastFinishedAt(storeId, BRIEF_KIND).catch(() => null);
    const t = last ? Date.parse(last) : NaN;
    return Number.isFinite(t) && t >= dayStartMs(todayIn(tz), tz);
  } catch {
    return false;
  }
}

/** Job determinista 1x día (sys_runs kind='brief'): snapshot → hechos →
 *  narrador → sys_insights. Silencio si sin cambios; tope 5/día. */
export async function runBriefJob(
  storeId: string,
  opts: { force?: boolean; actor?: string } = {},
): Promise<{ inserted: number; runId: string | null; summary: string }> {
  const { createLogger } = await import("@/lib/log");
  const log = createLogger("brief", { storeId, actor: opts.actor ?? null, force: opts.force ?? false });
  const t0 = Date.now();
  const { claimRunSlot, finishRun } = await import("@/lib/background");
  const { getDashboardSnapshot } = await import("@/lib/dashboard");
  const { dayStartMs, todayIn } = await import("@/lib/format");
  const { getStoreTimeZone } = await import("@/lib/stores-db");
  const notes: string[] = [];
  if (opts.force && opts.actor) notes.push(`forzado por ${opts.actor}`);
  let runId: string | null = null;
  try {
    runId = await claimRunSlot(storeId, BRIEF_KIND, "Muro diario", 1).catch(() => null);
  } catch {
    runId = null;
  }
  if (!runId) notes.push("sin slot de corrida (sys_runs sin tracking)");
  const done = async (summary: string, status: "done" | "error" = "done") => {
    if (runId) await finishRun(runId, { status, processed: 1, failed: 0, summary }).catch(() => undefined);
    log.info("runBriefJob done", { runId, summary, ms: Date.now() - t0 });
    return { inserted: 0, runId, summary };
  };
  log.debug("runBriefJob start", { runId });
  try {
    if (!opts.force && (await briefAlreadyRanToday(storeId))) {
      return done("Muro: ya corrió hoy.");
    }
    const tz = await getStoreTimeZone(storeId);
    const today00 = dayStartMs(todayIn(tz), tz);
    const today = await listInsightKeysSince(storeId, new Date(today00).toISOString());
    const existing = new Set(today.map((r) => dedupeKey(String(r.kind ?? ""), (r.scope_id as string | null) ?? null)));
    if (existing.size >= MAX_POSTS_PER_DAY) return done(`Muro: techo ${MAX_POSTS_PER_DAY}/día alcanzado, silencio.`);
    const snap = await getDashboardSnapshot(storeId);
    const fresh = buildBriefFacts(snap, MAX_POSTS_PER_DAY)
      .filter((f) => !existing.has(dedupeKey(f.kind, f.scopeId)))
      .slice(0, Math.max(0, MAX_POSTS_PER_DAY - existing.size));
    if (fresh.length === 0) return done("Muro: sin cambios, silencio.");
    // Arrobas desde auditoría de las OIs con scope (issue #11).
    const orderIds = [...new Set(fresh.filter((f) => f.scopeKind === "order" && f.scopeId).map((f) => f.scopeId as string))];
    let audit = new Map<string, { created_by: string | null; updated_by: string | null; updated_at: string | null }>();
    if (orderIds.length > 0) {
      const data = await selectOrders(storeId, { ids: orderIds });
      audit = new Map(data.map((r) => [String(r.id), {
        created_by: (r.created_by as string | null) ?? null,
        updated_by: (r.updated_by as string | null) ?? null,
        updated_at: (r.updated_at as string | null) ?? null,
      }]));
      const missing = orderIds.filter((id) => !audit.has(id));
      if (missing.length > 0) notes.push(`sin auditoría en ${missing.length} orden(es): menciones vacías`);
    }
    let members: Array<{ user_id: string; email: string | null }> = [];
    try {
      const { listStoreMembers } = await import("@/lib/members");
      members = await listStoreMembers(storeId);
    } catch {
      members = [];
      notes.push("sin miembros: audiencia sin user_ids");
    }
    // Contexto humano exacto (cliente, pantallas, monto, vigencia) para el
    // narrador y la card. Determinista, un batch por tabla.
    const ctxBy = await enrichOrderContext(storeId, fresh).catch(() => {
      notes.push("sin contexto de OI: cards sin cliente/monto");
      return new Map<string, BriefContext>();
    });
    for (const f of fresh) {
      if (f.scopeKind === "order" && f.scopeId && ctxBy.has(f.scopeId)) {
        f.context = ctxBy.get(f.scopeId);
      }
    }
    // Métricas de urgencia para kinds globales (mismas cifras, otro ángulo).
    const gctx = await enrichGlobalContext(storeId, snap, fresh).catch(() => {
      notes.push("sin métricas globales: cards sin urgencia");
      return new Map<string, Array<{ label: string; value: string }>>();
    });
    for (const f of fresh) {
      if (f.scopeKind !== "global") continue;
      const m = gctx.get(dedupeKey(f.kind, f.scopeId));
      if (m) {
        f.context = {
          company: null,
          brand: null,
          screens: null,
          amountMinor: null,
          currency: null,
          startsAt: null,
          endsAt: null,
          metrics: m,
        };
      }
    }
    const narrated = await narrateFacts(storeId, fresh);
    if (narrated.degraded) notes.push("LLM caído: cuerpos deterministas sin narración");
    const ctxOf = (kind: string, scopeId: string | null): BriefContext | null => {
      if (scopeId && ctxBy.has(scopeId)) return ctxBy.get(scopeId) as BriefContext;
      const f = fresh.find((x) => x.kind === kind && x.scopeId === scopeId);
      return f?.context ?? null;
    };
    const rows = narrated.posts.map((p) => {
      const a = p.scopeKind === "order" && p.scopeId ? audit.get(p.scopeId) : undefined;
      const emails = a ? resolveMentions(a.created_by, a.updated_by, a.updated_at) : [];
      const roles = p.scopeKind === "global" ? ["seller", "admin"] : [];
      return {
        kind: p.kind,
        title: p.title,
        body: p.body,
        links_json: [p.link],
        audience_json: mapAudience(emails, members, roles),
        severity: p.severity,
        scope_kind: p.scopeKind,
        scope_id: p.scopeId,
        context_json: ctxOf(p.kind, p.scopeId),
      };
    });
    if (rows.length === 0) return done("Muro: sin cambios, silencio.");
    await insertInsights(storeId, rows);
    const degraded = notes.length > 0 ? ` Avisos: ${notes.join("; ")}.` : "";
    const summary = `Muro: ${rows.length} post(s) (hechos deterministas + ${BRIEF_NARRATE_PROCESS}).${degraded}`;
    if (runId) await finishRun(runId, { status: "done", processed: 1, failed: 0, summary }).catch(() => undefined);
    log.info("runBriefJob done", { runId, inserted: rows.length, summary, ms: Date.now() - t0 });
    return { inserted: rows.length, runId, summary };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Fallo el muro diario.";
    log.error(e instanceof Error ? e : msg, { runId, ms: Date.now() - t0 });
    if (runId) {
      const { finishRun: fr, formatRunError } = await import("@/lib/background");
      await fr(runId, { status: "error", processed: 0, failed: 1, error: formatRunError(e) }).catch(() => undefined);
    }
    return { inserted: 0, runId, summary: msg };
  }
}

/** Restaura un aviso descartado (borra el dismiss per-user). */
export async function restoreInsight(insightId: string, userId: string): Promise<void> {
  await restoreInsightRead(insightId, userId);
}
