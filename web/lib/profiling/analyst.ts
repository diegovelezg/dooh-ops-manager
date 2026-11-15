// Data analyst del set perfilador: números de la tienda, determinista.
// Sin LLM para los números; el synthesizer los interpreta.
// Fase 2 DOOH: lee companies/contacts/io_orders, no customers/orders.
import { countCompanies } from "@/lib/crm-store";
import { selectLines, selectOrders } from "@/lib/orders-store";
import { DAY_MS } from "@/lib/format";

export interface TenantStats {
  customers: number;
  buyers: number;
  companyRate: number;
  customDomainRate: number;
  repeatRate: number;
  /** Ticket mediano en moneda de la tienda (minor units tal cual). */
  ticketMedian: number | null;
  ticketCurrency: string | null;
  /** Top dominios propios por nº de empresas. */
  topDomains: Array<{ domain: string; customers: number }>;
  /** Muestra de empresas (sin enriquecimiento externo en Fase 2). */
  enrichedSample: Array<{ domain: string; company: string | null; industry: string | null }>;
  /** Mediana de intervalos entre IOs por empresa (días). */
  intervalMedian: number | null;
  intervalCoverage: number;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Stats del tenant para confrontar sector vs realidad. Lanza si falla (sin ceros falsos). */
export async function tenantStats(storeId: string): Promise<TenantStats & { sampleN: number; truncated: boolean }> {
  const total = await countCompanies(storeId);

  // Empresas con al menos 1 IO firmada = compradoras; ≥2 = recurrentes.
  const ios = await selectOrders(storeId, { limit: 5000 });
  const byCompany = new Map<string, string[]>();
  for (const io of ios) {
    const cid = (io.billing_company_id as string | null) ?? (io.advertiser_company_id as string | null);
    if (!cid) continue;
    if (!byCompany.has(cid)) byCompany.set(cid, []);
    if (typeof io.starts_at === "string") byCompany.get(cid)!.push(io.starts_at);
  }
  const buyers = byCompany.size;
  let repeat = 0;
  const medians: number[] = [];
  for (const dates of byCompany.values()) {
    if (dates.length >= 2) repeat += 1;
    if (dates.length < 2) continue;
    const ts = dates.map((d) => Date.parse(d)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
    if (ts.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i += 1) gaps.push((ts[i] - ts[i - 1]) / DAY_MS);
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    medians.push(gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2);
  }
  medians.sort((a, b) => a - b);
  const mid = Math.floor(medians.length / 2);
  const intervalMedian =
    medians.length > 0
      ? Math.max(1, Math.round(medians.length % 2 === 1 ? medians[mid] : (medians[mid - 1] + medians[mid]) / 2))
      : null;

  // Ticket mediano desde líneas de IO.
  let ticketMedian: number | null = null;
  try {
    const ioIds = ios.map((r) => String(r.id)).filter(Boolean);
    if (ioIds.length > 0) {
      const lines = await selectLines(storeId, ioIds.slice(0, 500));
      const rates = lines
        .map((l) => Number(l.rate_minor ?? NaN))
        .filter((v) => Number.isFinite(v) && v > 0);
      ticketMedian = median(rates);
    }
  } catch {
    ticketMedian = null;
  }

  return {
    customers: total,
    buyers,
    companyRate: 1,
    customDomainRate: 0,
    repeatRate: total > 0 ? repeat / total : 0,
    ticketMedian,
    ticketCurrency: null,
    topDomains: [],
    enrichedSample: [],
    intervalMedian,
    intervalCoverage: buyers > 0 ? medians.length / buyers : 0,
    sampleN: total,
    truncated: false,
  };
}
