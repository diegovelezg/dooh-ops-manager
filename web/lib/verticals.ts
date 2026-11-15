// Fase A del perfilador: brief del SECTOR por vertical (prior compartido).
// Se investiga una vez (web + LLM), se cachea en `ai_vertical_profiles` y se
// reusa entre tenants. La precisión del tenant la pone la Fase B con datos.
// Solo server/scripts (usa Crawlee); sin "server-only" para
// que los smoke scripts (tsx) puedan importarlo. El retrieval web vive en
// lib/retrieval.ts (también sin server-only) por la misma razón.
import { surql } from "@/lib/surreal";
import { buildQueries, searchSearxng, scrapeCandidates, scrapable, type Scraped } from "@/lib/retrieval";
import { chatCompletionParams, getLlmConfig, reasoningBody, type ModelRef } from "@/lib/ai/llm-config";
import { createLogger } from "@/lib/log";

const log = createLogger("verticals");

export interface BuyerPersona {
  who: string;
  size: "micro" | "pequeña" | "mediana" | "grande" | "agencia" | null;
}

export interface VerticalBrief {
  buyerPersonas: BuyerPersona[];
  typicalCycle: string | null;
  typicalTicket: { range: string; currency: string } | null;
  decisionMaker: string | null;
  demandDrivers: string[];
  /** Lo que la web NO dice: la Fase B lo convierte en preguntas al dueño. */
  gaps: string[];
  confidence: "alta" | "media" | "baja";
}

export interface VerticalSource {
  url: string;
  title: string;
  chars: number;
}

export interface VerticalResearch {
  brief: VerticalBrief;
  sources: VerticalSource[];
  taxonomyId: string | null;
}

const SYSTEM = `Eres un analista de mercado. Con el texto web dado, arma el brief del SECTOR en Perú.
Responde SOLO JSON válido, sin markdown:
{"buyer_personas": [{"who": string, "size": "micro"|"pequeña"|"mediana"|"grande"|"agencia"|null}], "typical_cycle": string|null, "typical_ticket": {"range": string, "currency": string}|null, "decision_maker": string|null, "demand_drivers": string[], "gaps": string[], "confidence": "alta"|"media"|"baja"}
Reglas:
- buyer_personas: QUIÉN contrata, con granularidad de tamaño (2-5). Si el texto no distingue tamaños, size null (no lo adivines).
- typical_ticket: solo si hay precios/rangos en el texto; si no, null.
- decision_maker: quién decide la compra si se deduce.
- gaps: lo que el texto NO dice y habría que preguntarle al dueño del negocio (máx 3).
- Todo en español, corto. NO inventes.`;

const VALID_SIZES = new Set(["micro", "pequeña", "mediana", "grande", "agencia"]);
const VALID_CONF = new Set(["alta", "media", "baja"]);

async function briefOnce(ref: ModelRef, text: string, meter?: { storeId?: string | null; usedFallback?: boolean }): Promise<string> {
  const cfg = getLlmConfig("retrieval_queries");
  const apiKey = ref.apiKeyEnv ? process.env[ref.apiKeyEnv] : undefined;
  if (!apiKey) throw new Error(`Falta ${ref.apiKeyEnv}`);
  const base = (ref.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: ref.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text.slice(0, 8000) },
      ],
      ...chatCompletionParams(ref.provider, ref.model, cfg.temperature, cfg.maxTokens),
      response_format: { type: "json_object" },
      ...reasoningBody(ref.provider, ref.model, cfg.reasoningEffort),
    }),
  });
  if (!res.ok) throw new Error(`${ref.provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (meter?.storeId) {
    const { parseChatUsage, logLlmUsage } = await import("@/lib/ai/usage");
    const usage = parseChatUsage(data);
    if (usage) {
      void logLlmUsage({
        storeId: meter.storeId,
        process: "retrieval_queries",
        provider: ref.provider,
        model: ref.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        reasoningTokens: usage.reasoningTokens,
        latencyMs: Date.now() - t0,
        usedFallback: meter.usedFallback ?? false,
      });
    }
  }
  const c = data?.choices?.[0]?.message?.content;
  if (typeof c !== "string" || !c.trim()) throw new Error(`${ref.provider}: respuesta vacía`);
  return c;
}

/** Selección por riqueza: el largo predice brief útil; <1000 chars rara vez aporta. */
function selectRich(scraped: Scraped[], want = 6): Scraped[] {
  const rich = scraped
    .filter((s) => s.text.length >= 1000)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, want);
  return rich.length >= 3 ? rich : scraped.slice(0, want);
}

function peFirst(urls: string[]): string[] {
  return [...new Set(urls)].sort((a, b) => (a.includes(".pe") ? 0 : 1) - (b.includes(".pe") ? 0 : 1));
}

function parseBrief(raw: string): VerticalBrief {
  const p = JSON.parse(raw) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const strs = (v: unknown, n: number): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, n)
      : [];
  const personas = Array.isArray(p.buyer_personas)
    ? (p.buyer_personas as Array<Record<string, unknown>>)
        .map((b) => {
          const who = str(b.who);
          if (!who) return null;
          const size = str(b.size);
          return {
            who: who.slice(0, 120),
            size: size && VALID_SIZES.has(size) ? (size as BuyerPersona["size"]) : null,
          };
        })
        .filter((b): b is BuyerPersona => b !== null)
        .slice(0, 5)
    : [];
  const ticket = p.typical_ticket as Record<string, unknown> | null;
  const range = ticket ? str(ticket.range) : null;
  const conf = str(p.confidence);
  return {
    buyerPersonas: personas,
    typicalCycle: str(p.typical_cycle)?.slice(0, 120) ?? null,
    typicalTicket: range
      ? { range: range.slice(0, 120), currency: str(ticket?.currency) ?? "PEN" }
      : null,
    decisionMaker: str(p.decision_maker)?.slice(0, 120) ?? null,
    demandDrivers: strs(p.demand_drivers, 6),
    gaps: strs(p.gaps, 3),
    confidence: conf && VALID_CONF.has(conf) ? (conf as VerticalBrief["confidence"]) : "baja",
  };
}

/**
 * Investiga el sector de un vertical (sin cache): queries mixtas
 * (vendor/media-kit + pyme) → SearXNG → scrape (10, 2ª ronda si <3 ricos)
 * → brief LLM. Lanza si no hay texto útil (error honesto, sin brief vacío).
 */
export async function researchVertical(
  vertical: string,
  taxonomyId: string | null = null,
  opts: { storeId?: string | null } = {},
): Promise<VerticalResearch> {
  const v = (vertical ?? "").trim().slice(0, 120);
  if (v.length < 4) throw new Error("Vertical demasiado corto para investigar.");
  const seen = new Set<string>();
  const scraped: Scraped[] = [];

  const rounds = [
    { n: 4, focus: "Perú. Ángulos: 1) empresas del rubro y media kits, 2) precios y cuánto cuesta, 3) pymes y negocios pequeños que contratan" },
    { n: 2, focus: "Perú. Media kits, tarifas, precios y condiciones de contratación" },
  ];
  for (const [ri, round] of rounds.entries()) {
    if (ri > 0 && selectRich(scraped).length >= 3) break;
    const queries = await buildQueries(`Negocio de ${v} en Perú: quién contrata, precios, frecuencia`, round.n, round.focus, opts.storeId ? { storeId: opts.storeId } : undefined);
    const hits = (await Promise.all(queries.map((q) => searchSearxng(q, 5).catch(() => [])))).flat();
    const fresh = peFirst(hits.map((h) => h.url)).filter((u) => !seen.has(u)).slice(0, 10);
    fresh.forEach((u) => seen.add(u));
    const { ok } = scrapable(fresh);
    scraped.push(...(await scrapeCandidates(ok)));
  }
  const corpus = selectRich(scraped);
  if (corpus.length === 0) throw new Error("Sin texto útil en la web para este vertical.");

  const cfg = getLlmConfig("retrieval_queries");
  const text = `Vertical: ${v}\n\n${corpus.map((s, i) => `[${i}] ${s.url}\n${s.title}\n${s.text.slice(0, 1500)}`).join("\n\n")}`;
  let raw: string;
  try {
    raw = await briefOnce(cfg.primary, text, opts.storeId ? { storeId: opts.storeId } : undefined);
  } catch (e) {
    if (!cfg.fallback) {
      log.error(e instanceof Error ? e : String(e), { storeId: opts.storeId ?? null, vertical: v });
      throw e;
    }
    log.warn("researchVertical fallback", { storeId: opts.storeId ?? null, vertical: v });
    raw = await briefOnce(cfg.fallback, text, opts.storeId ? { storeId: opts.storeId, usedFallback: true } : { usedFallback: true });
  }
  return {
    brief: parseBrief(raw),
    sources: corpus.map((s) => ({ url: s.url, title: s.title, chars: s.text.length })),
    taxonomyId,
  };
}

/** Clave natural del brief: el taxonomy_id, o la vertical normalizada si no hay mapeo. */
function verticalKey(taxonomyId: string | null, vertical: string): string {
  return taxonomyId ?? `vertical:${vertical.trim().slice(0, 120).toLowerCase()}`;
}

/** Lee el brief cacheado (por taxonomy_id, o por vertical si no hay mapeo). */
export async function getVerticalProfile(
  taxonomyId: string | null,
  vertical: string,
): Promise<{ brief: VerticalBrief; sources: VerticalSource[]; confidence: string | null } | null> {
  const r = await surql<Record<string, unknown> | null>(
    `SELECT brief, sources, confidence FROM ONLY type::record('ai_vertical_profile', $key)`,
    { key: verticalKey(taxonomyId, vertical) },
  );
  if (!r) return null;
  return {
    brief: r.brief as VerticalBrief,
    sources: (r.sources as VerticalSource[]) ?? [],
    confidence: (r.confidence as string) ?? null,
  };
}

/** Guarda el brief investigado (upsert por clave natural: sin trucos de unique con NULL). */
export async function saveVerticalProfile(
  taxonomyId: string | null,
  vertical: string,
  research: VerticalResearch,
): Promise<void> {
  await surql(
    `UPSERT type::record('ai_vertical_profile', $key) SET taxonomy_id = $taxonomy ?? NONE,
       vertical_detected = $vertical, brief = $brief, sources = $sources, confidence = $confidence ?? NONE,
       researched_at = time::now()`,
    {
      key: verticalKey(taxonomyId, vertical), taxonomy: taxonomyId, vertical: vertical.trim().slice(0, 120),
      brief: research.brief, sources: research.sources, confidence: research.brief.confidence ?? null,
    },
  );
}
