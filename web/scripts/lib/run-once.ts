// Bootstrap compartido de los scripts `*-once.ts` (ejecución manual con tsx).
import { firstStoreId } from "@/lib/stores-db";

/** Resuelve la primera tienda (sin ecommerce). */
export async function resolveStoreId(): Promise<string | null> {
  return firstStoreId();
}

/** Lee la primera tienda. Falla si no hay. */
export async function loadStoreId(): Promise<string> {
  const storeId = await resolveStoreId();
  if (!storeId) throw new Error("Sin tiendas en SurrealDB.");
  return storeId;
}

/** Catch final estándar: `<TAG> FAIL:` + exit 1. Uso: `main().catch((e) => fail("SCOUT", e))`. */
export function fail(tag: string, e: unknown): never {
  console.error(`${tag} FAIL:`, e instanceof Error ? e.message : e);
  process.exit(1);
}
