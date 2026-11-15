// Research de empresa por dominio(s): homepage → LLM firmographics → tabla `domains`.
// Candidatos: companies.domain + dominio de companies.email + dominios de emails
// de contactos (collectCandidateDomains) + fallback web por nombre si no hay nada.
import { surql } from "@/lib/surreal";
import { extractFirmographics } from "@/lib/ai/enrich";
import {
  collectCandidateDomains,
  normalizeDomain,
  type DomainCandidate,
} from "@/lib/company-domains";
import { fetchHomepageText } from "@/lib/fetch-text";
import { createLogger } from "@/lib/log";

const log = createLogger("company-research");

export interface DomainProfile {
  domain: string;
  domain_type: string | null;
  company_name: string | null;
  industry: string | null;
  description: string | null;
  size: string | null;
  location: string | null;
  source_url: string | null;
  model: string | null;
  confidence: number | null;
  enriched_at: string | null;
}

function mapProfile(domain: string, r: Record<string, unknown> | null): DomainProfile | null {
  if (!r) return null;
  return {
    domain,
    domain_type: (r.domain_type as string) ?? null,
    company_name: (r.company_name as string) ?? null,
    industry: (r.industry as string) ?? null,
    description: (r.description as string) ?? null,
    size: (r.size as string) ?? null,
    location: (r.location as string) ?? null,
    source_url: (r.source_url as string) ?? null,
    model: (r.model as string) ?? null,
    confidence: r.confidence == null ? null : Number(r.confidence),
    enriched_at: (r.enriched_at as string) ?? null,
  };
}

const PROFILE_COLS = `record::id(id) AS domain, domain_type, company_name, industry, description, size, location,
  source_url, model, confidence, fn::iso(enriched_at) AS enriched_at`;

async function getDomainProfile(domain: string): Promise<DomainProfile | null> {
  const d = normalizeDomain(domain);
  if (!d) return null;
  const row = await surql<Record<string, unknown> | null>(
    `SELECT ${PROFILE_COLS} FROM ONLY type::record('ai_domain_cache', $d)`,
    { d },
  );
  return mapProfile(d, row ?? null);
}

export async function getDomainProfiles(domains: string[]): Promise<Map<string, DomainProfile>> {
  const out = new Map<string, DomainProfile>();
  const clean = [...new Set(domains.map(normalizeDomain).filter(Boolean))];
  if (clean.length === 0) return out;
  const rows = await surql<Array<Record<string, unknown>>>(
    `LET $r = $ds.map(|$d| type::record('ai_domain_cache', $d));
     SELECT ${PROFILE_COLS} FROM ai_domain_cache WHERE id IN $r`,
    { ds: clean },
  );
  for (const r of rows) {
    const d = String(r.domain ?? "");
    const p = mapProfile(d, r);
    if (p) out.set(d, p);
  }
  return out;
}

export type ResearchStatus = "ok" | "cached" | "no-homepage" | "error";

/** Investiga un dominio y lo persiste en `domains` (upsert por PK).
 *  Caché global por diseño: solo guarda firmographics públicos de la homepage
 *  (company/industry/description/size/location/source/model/confidence).
 *  Nunca persiste emails de contactos ni PII del tenant (los candidatos por
 *  email solo derivan el dominio y se descartan). Por eso la lectura global
 *  `authenticated` no filtra por store_id. */
export async function researchDomain(
  domain: string,
  opts: { storeId?: string | null; force?: boolean } = {},
): Promise<{ status: ResearchStatus; profile: DomainProfile | null; error?: string }> {
  const d = normalizeDomain(domain);
  if (!d) return { status: "error", profile: null, error: "Dominio inválido." };
  if (!opts.force) {
    const cached = await getDomainProfile(d).catch(() => null);
    if (cached) return { status: "cached", profile: cached };
  }
  const page = await fetchHomepageText(d);
  if (!page) return { status: "no-homepage", profile: await getDomainProfile(d).catch(() => null) };
  let firm: Awaited<ReturnType<typeof extractFirmographics>>;
  try {
    firm = await extractFirmographics(d, page.text, opts.storeId ? { storeId: opts.storeId } : {});
  } catch (e) {
    log.error(e instanceof Error ? e : String(e), { storeId: opts.storeId ?? null, domain: d });
    return { status: "error", profile: null, error: e instanceof Error ? e.message : "LLM falló." };
  }
  try {
    await surql(
      `UPSERT type::record('ai_domain_cache', $d) SET domain_type = 'business', company_name = $company ?? NONE,
         industry = $industry ?? NONE, description = $description ?? NONE, size = $size ?? NONE,
         location = $location ?? NONE, source_url = $source ?? NONE, model = $model ?? NONE,
         confidence = $confidence ?? NONE, enriched_at = time::now()`,
      {
        d, company: firm.companyName, industry: firm.industry, description: firm.description, size: firm.size,
        location: firm.location, source: page.url, model: firm.model, confidence: firm.confidence,
      },
    );
  } catch (e) {
    return { status: "error", profile: null, error: `Domains upsert: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { status: "ok", profile: await getDomainProfile(d).catch(() => null) };
}

export interface CompanyResearchInput {
  name: string;
  domain: string | null;
  email: string | null;
  country: string | null;
  contacts: Array<{ email: string | null }>;
}

/** Candidatos para una empresa + perfiles ya guardados. Incluye fallback web. */
export async function describeCompanyCandidates(input: CompanyResearchInput): Promise<{
  candidates: DomainCandidate[];
  profiles: DomainProfile[];
  discoveredFromWeb: string | null;
}> {
  let candidates = collectCandidateDomains(
    { domain: input.domain, email: input.email },
    input.contacts,
  );
  let discoveredFromWeb: string | null = null;

  if (candidates.length === 0) {
    const found = await discoverDomainFromWeb(input.name, input.country).catch(() => null);
    if (found) {
      discoveredFromWeb = found;
      candidates = [{ domain: found, source: "web", count: 1 }];
    }
  }
  const profiles = [...(await getDomainProfiles(candidates.map((c) => c.domain))).values()];
  return { candidates, profiles, discoveredFromWeb };
}

/** Fallback: SearXNG por nombre → primer host scrapeable (descubierto, no inventado). */
export async function discoverDomainFromWeb(name: string, country: string | null): Promise<string | null> {
  const q = `${name} empresa ${country === "PE" ? "Perú" : (country ?? "")} sitio oficial`.trim();
  if (q.replace(/\s/g, "").length < 6) return null;
  const { searchSearxng, rankHits, hostOf, scrapable } = await import("@/lib/retrieval");
  const hits = await searchSearxng(q, 5);
  const ranked = rankHits(hits);
  const { ok } = scrapable(ranked.map((h) => h.url));
  for (const u of ok) {
    const h = hostOf(u);
    const d = normalizeDomain(h);
    if (!d) continue;
    const { isEnrichableDomain } = await import("@/lib/company-domains");
    if (isEnrichableDomain(d)) return d;
  }
  return null;
}
