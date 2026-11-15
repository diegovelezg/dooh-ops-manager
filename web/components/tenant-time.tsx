"use client";

import { createContext, useContext, type ReactNode } from "react";

// Zona IANA del tenant activo para componentes cliente. La BD guarda UTC; todo "día"
// visible o calculado en el cliente se resuelve con esta zona (nunca una global).
const TenantTimeContext = createContext<string | null>(null);

export function TenantTimeProvider({ tz, children }: { tz: string | null; children: ReactNode }) {
  return <TenantTimeContext.Provider value={tz}>{children}</TenantTimeContext.Provider>;
}

/** Zona del tenant activo. Falla si no hay tienda activa: ninguna vista con fechas existe sin ella. */
export function useTz(): string {
  const tz = useContext(TenantTimeContext);
  if (!tz) throw new Error("Sin zona horaria: falta la tienda activa (TenantTimeProvider).");
  return tz;
}
