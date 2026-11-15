// Perfil del tenant: lecturas/escrituras a SurrealDB (solo servidor,
// nunca importar este módulo en Client Components). Lo puro (tipos, ARCHETYPES, heurísticas de slots)
// vive en `lib/store-profile-defs.ts`, apto para clientes y tests.
// Este módulo re-exporta lo puro por compatibilidad: el código servidor
// puede seguir importando de `@/lib/store-profiles`.
// (Sin `import "server-only"` a propósito: los tests `tsx --test` corren en
// node plano y el paquete lanza fuera de React Server Components.)

import { isDbConfigured, surql } from "@/lib/surreal";
import { getStore } from "@/lib/stores-db";
import { countCompanies } from "@/lib/crm-store";

export * from "./store-profile-defs";
import {
  BAND_CUTS_BY_ARCHETYPE,
  type ArchetypeId,
  type BusinessModel,
  type CatalogType,
  type ProfileSignals,
  type StoreProfile,
} from "./store-profile-defs";

export async function getProfileSignals(storeId: string): Promise<(ProfileSignals & { truncated: boolean }) | null> {
  // Fase 2: señales desde CRM DOOH (companies), no desde customers ecommerce.
  if (!isDbConfigured()) return null;
  return { customers: await countCompanies(storeId), companyRate: 1, customDomainRate: 0, repeatRate: 0, truncated: false };
}

function toProfile(storeId: string, r: Record<string, unknown>): StoreProfile {
  return {
    storeId,
    businessModel: (r.business_model as BusinessModel) ?? "b2b",
    verticalDetected: (r.vertical_detected as string | null) ?? null,
    taxonomyId: (r.taxonomy_id as string | null) ?? null,
    buyerType: (r.buyer_type as string | null) ?? null,
    industry: (r.industry as string | null) ?? null,
    catalogType: (r.catalog_type as CatalogType) ?? null,
    archetype: (r.archetype as ArchetypeId) ?? "b2b_recurrente",
    companyRequired: Boolean(r.company_required),
    description: (r.description as string | null) ?? null,
  };
}

const STORE = "type::record('sys_store', $store)";

export async function getStoreProfile(storeId: string): Promise<StoreProfile | null> {
  if (!isDbConfigured()) return null;
  const rows = await surql<Array<Record<string, unknown>>>(
    `SELECT * FROM sys_store_profile WHERE store = ${STORE}`,
    { store: storeId },
  );
  return rows[0] ? toProfile(storeId, rows[0]) : null;
}

/** Crea o reemplaza el perfil (1:1 con la tienda, índice único sobre `store`). */
export async function upsertStoreProfile(p: StoreProfile): Promise<void> {
  await surql(
    `UPSERT sys_store_profile SET store = ${STORE},
       business_model = $business_model, vertical_detected = $vertical_detected,
       taxonomy_id = $taxonomy_id, buyer_type = $buyer_type, industry = $industry,
       catalog_type = $catalog_type, archetype = $archetype,
       company_required = $company_required, description = $description
     WHERE store = ${STORE}`,
    {
      store: p.storeId,
      business_model: p.businessModel,
      vertical_detected: p.verticalDetected,
      taxonomy_id: p.taxonomyId,
      buyer_type: p.buyerType,
      industry: p.industry,
      catalog_type: p.catalogType,
      archetype: p.archetype,
      company_required: p.companyRequired,
      description: p.description,
    },
  );
}

/** Moneda de la tienda (universo monetario: nunca mezclar PEN con MXN). */
export async function resolveShopCurrency(storeId: string): Promise<string | null> {
  if (!isDbConfigured()) return null;
  return (await getStore(storeId))?.shop_currency ?? null;
}

/** Cortes de banda_p por tenant (issue #21 Paso 5).
 *  Las columnas p_band_high/low se extirparon en 20261122: siempre default
 *  del arquetipo (hoy 0.6/0.15 en todos ⇒ reproduce v2). */
export async function resolveBandCuts(
  storeId: string,
): Promise<{ high: number; low: number }> {
  const profile = await getStoreProfile(storeId).catch(() => null);
  const arch = profile?.archetype ?? "b2b_recurrente";
  return BAND_CUTS_BY_ARCHETYPE[arch] ?? { high: 0.6, low: 0.15 };
}
