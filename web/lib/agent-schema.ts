// Guía del modelo de datos para agentes. Un usuario normal NO puede introspeccionar el esquema
// (`info`/`list`/`INFO FOR …` dan IAM error), así que el servidor se la entrega al agente en el campo
// `instructions` de `initialize` (lib/mcp-proxy.ts). Es curada a mano (solo lo útil para consultar; sin campos ocultos por rol como la
// comisión) y un test la compara con el esquema real para que no se desactualice.
// Puro, sin `next/*`.
export interface AgentTable {
  table: string;
  about: string;
  fields: string[];
}

export const AGENT_SCHEMA: AgentTable[] = [
  { table: "sys_store", about: "tienda (tenant) del usuario", fields: ["name", "shop_currency", "timezone", "io_prefix"] },
  { table: "crm_company", about: "empresas: kind = 'agencia' | 'anunciante' | 'proveedor'; archivada si deleted_at != NONE", fields: ["name", "legal_name", "kind", "tax_id", "domain", "email", "phone", "city", "country", "deleted_at"] },
  { table: "crm_contact", about: "contactos de una empresa", fields: ["company", "first_name", "last_name", "email", "phone", "job_title", "deleted_at"] },
  { table: "inv_venue", about: "locales donde hay pantallas", fields: ["name", "venue_type", "address", "district", "city", "region", "country", "company"] },
  { table: "inv_screen", about: "pantallas DOOH", fields: ["name", "venue", "ownership", "modality", "is_active", "width_px", "height_px", "orientation", "technology"] },
  { table: "inv_slot", about: "espacios vendibles de una pantalla", fields: ["screen", "slot_index", "is_active"] },
  { table: "inv_booking", about: "reservas de espacios", fields: ["slot", "order", "campaign", "starts_at", "ends_at", "status"] },
  { table: "io_order", about: "órdenes de inserción (IO)", fields: ["number", "status", "brand", "currency", "advertiser", "billing", "agency", "starts_at", "ends_at", "payment_terms_days"] },
  { table: "io_line", about: "líneas de una orden (pantalla y periodo)", fields: ["order", "screen", "slot", "starts_at", "ends_at", "rate_minor", "cant_dias", "cant_slots"] },
  { table: "io_campaign", about: "campañas", fields: ["name", "status", "advertiser", "order", "starts_at", "ends_at", "budget_minor"] },
  { table: "io_invoice", about: "facturas de una orden", fields: ["order", "number", "amount_minor", "paid_minor", "currency", "issue_date", "due_date", "status"] },
  { table: "io_invoice_payment", about: "cobros de una factura (anulado si voided_at != NONE)", fields: ["invoice", "amount_minor", "paid_on", "voided_at"] },
  { table: "io_creative", about: "creativos de una orden", fields: ["order", "name", "qc_status", "legal_status", "duration_s"] },
  { table: "io_play_log", about: "registro de reproducciones", fields: ["order", "screen", "played_at", "duration_s", "error_code"] },
];

/** Texto para el mensaje del agente. */
export function renderAgentSchema(): string {
  return [
    "Modelo de datos (SurrealDB; tablas y campos útiles, el esquema completo no es consultable con tu usuario):",
    ...AGENT_SCHEMA.map((t) => `- ${t.table}(${t.fields.join(", ")}): ${t.about}`),
    "Notas: toda tabla salvo sys_store lleva `store`; solo ves tu(s) tienda(s), el filtro es automático.",
    "Los campos que apuntan a otra tabla son enlaces y se recorren con punto: SELECT number, advertiser.name FROM io_order.",
    "Importes en `*_minor`: unidad menor de la moneda (divide entre 100). Fechas y horas en UTC. Para mostrar un id: record::id(id).",
  ].join("\n");
}

/** `instructions` del servidor MCP: qué es, reglas y modelo de datos. */
export function agentInstructions(): string {
  return [
    "Servidor de datos de la operación comercial (DOOH) del usuario. Solo lectura: usa `query` (SurrealQL) y `select`.",
    "No hay introspección de esquema (INFO FOR…, info, list dan error de permisos): usa el modelo de datos de abajo.",
    "Ves únicamente lo que el usuario ve en la aplicación; un campo oculto por su rol llega como null.",
    "",
    renderAgentSchema(),
  ].join("\n");
}
