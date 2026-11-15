// Gate de esquema en runtime: sondea que las tablas del flujo comercial existan (`INFO FOR DB`).
// El esquema lo crean surreal/migrations/*.surql con `npm run db:migrate`.
import { surql } from "@/lib/surreal";

export interface SchemaGap {
  relation: string;
  hint: string;
}

const REQUIRED_TABLES = [
  "user",
  "sys_store",
  "member_of",
  "crm_company",
  "crm_contact",
  "crm_company_link",
  "crm_contact_account",
  "inv_venue",
  "inv_screen",
  "inv_slot",
  "inv_booking",
  "io_order",
  "io_line",
  "io_invoice",
  "io_invoice_payment",
] as const;

export async function checkSchema(): Promise<SchemaGap[]> {
  const info = await surql<{ tables: Record<string, unknown> }>("INFO FOR DB");
  return REQUIRED_TABLES.filter((t) => !(t in info.tables)).map((t) => ({
    relation: `surreal.${t}`,
    hint: "Falta la tabla: ejecuta `npm run db:migrate`.",
  }));
}
