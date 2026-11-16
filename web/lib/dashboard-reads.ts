// Lecturas del tablero (Hoy / Inbox / agente): órdenes vigentes + hijas desde `order-reads`, más la
// tienda y las pantallas activas (con su capacidad), todo en UNA ronda paralela.
import { surql } from "@/lib/surreal";
import { key } from "@/lib/surql-cols";
import { readOrderBundle, S, type OrderBundle } from "@/lib/order-reads";
import type { Row } from "@/lib/orders-store";

export interface DashboardData extends Omit<OrderBundle, "supplierOf"> {
  store: Row | null;
  screens: Array<{ id: string; name: string; capacity: number }>;
}

export async function readDashboardData(storeId: string): Promise<DashboardData> {
  const v = { store: storeId };
  const [bundle, store, screens] = await Promise.all([
    readOrderBundle(storeId, { live: true, order: "ASC" }),
    surql<Row | null>(`SELECT shop_currency FROM ONLY ${S}`, v),
    // Capacidad por pantalla con la regla única de la DB (`fn::screen_capacity`), una vez por pantalla activa.
    surql<Row[]>(
      `SELECT record::id(id) AS id, name, ${key("supplier")} AS supplier_company_id,
         fn::screen_capacity(id) AS capacity
       FROM inv_screen WHERE store = ${S} AND is_active = true ORDER BY name ASC`,
      v,
    ),
  ]);
  const { supplierOf: _supplierOf, ...rest } = bundle;
  return {
    ...rest,
    store,
    screens: screens.map((s) => ({ id: String(s.id), name: String(s.name ?? "—"), capacity: Number(s.capacity ?? 0) })),
  };
}
