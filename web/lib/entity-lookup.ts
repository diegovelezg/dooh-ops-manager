// Búsqueda de una entidad por id SIN conocer su tienda (rutas `/:id` y chat): el
// caller resuelve después la membresía con el `store_id` devuelto (anti-IDOR).
import { surql } from "@/lib/surreal";
import { findOwned } from "@/lib/orders-store";

export type EntityTable = "crm_company" | "inv_screen" | "crm_contact" | "io_order";

const LABEL_COLS: Record<Exclude<EntityTable, "io_order">, string> = {
  crm_company: "name",
  inv_screen: "name",
  crm_contact: "first_name, last_name",
};

/** Fila (`id`, `store_id` + columnas de etiqueta; la orden completa) o null si no existe. */
export async function findEntity(table: EntityTable, id: string): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  if (table === "io_order") return findOwned("io_order", id);
  const row = await surql<Record<string, unknown> | null>(
    `SELECT record::id(id) AS id, record::id(store) AS store_id, ${LABEL_COLS[table]} FROM ONLY type::record('${table}', $id)`,
    { id },
  );
  return row ?? null;
}
