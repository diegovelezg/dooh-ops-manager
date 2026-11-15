import { getCustomerAgent } from "@/lib/adk/agents/customer-agent";

// Entrypoint para `@google/adk-devtools` (adk web / adk run).
// Contexto generalista: ADK_DEV_CUSTOMER_ID fija la ficha (opcional),
// ADK_DEV_STORE_ID la tienda (requerida para el ámbito tienda).
// ADK_DEV_TIMEZONE: zona IANA del tenant (obligatoria: define "hoy" para el agente).
// Ej.: ADK_DEV_STORE_ID=<uuid> ADK_DEV_TIMEZONE=<IANA> npm run adk
const storeId = process.env.ADK_DEV_STORE_ID ?? null;
const customerId = process.env.ADK_DEV_CUSTOMER_ID ?? null;
const timezone = process.env.ADK_DEV_TIMEZONE;
if (!timezone) throw new Error("ADK_DEV_TIMEZONE no definido (zona IANA del tenant, p. ej. Asia/Tokyo).");

if (!storeId) {
  console.warn(
    "[agent] ADK_DEV_STORE_ID no definido: las tools de tienda no tendrán ámbito. " +
      "Ej.: ADK_DEV_STORE_ID=<uuid> npm run adk",
  );
}

export const rootAgent = getCustomerAgent({ storeId, timezone, customerId, view: "adk" });
