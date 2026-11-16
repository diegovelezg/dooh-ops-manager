import type { ReactNode } from "react";
import { Suspense } from "react";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { BackgroundStatus } from "@/components/background-status";
import { ChatDockProvider, DashboardShell } from "@/components/chat/chat-dock";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppTooltipProvider } from "@/components/ui/app-tooltip";
import { displayStoreName, listMyStores, getMyStoreRoles, resolveActiveStoreId, type TenantStore } from "@/lib/tenant";
import { getSessionUser } from "@/lib/auth";

import { connection } from "next/server";
import { DrawerHost } from "@/components/drawer-host";
import { TenantTimeProvider } from "@/components/tenant-time";

// La chrome del dashboard es siempre dinámica (auth + tenant por request),
// así que se permite la ruta bloqueante. Sin esto, el `connection()` de
// abajo hace fallar el prerender con `blocking-prerender-dynamic`
// (p. ej. Route "/screens").
export const instant = false;

// Chrome del dashboard: sidebar + header + toasts de background.
// Solo aplica a las rutas del grupo (dashboard); /login no lo hereda.
// Siempre dinámico: UI autenticada multiuser por tenant (cookies + membresía
// por request). `connection()` detiene el prerender aquí (Cache Components);
// sin esto, Next intenta prerenderizar "/" y falla con
// `blocking-prerender-current-time`.

// El layout carga tiendas (single-país: sin filtro por market);
// si falla, el header sigue funcionando.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Todo lo de abajo solo corre a request-time (ver nota arriba).
  await connection();
  // Lecturas independientes en paralelo; cada una degrada sola (el header sigue funcionando si falla).
  // Email de la cuenta logueada en servidor: el UserMenu lo recibe como prop para pintar el avatar + email en el
  // primer paint, sin depender del fetch cliente (que fallaba y dejaba el dropdown sin email).
  const [stores, userEmail, userRoles, activeStoreId] = await Promise.all([
    listMyStores().catch((): TenantStore[] => []),
    getSessionUser().then((u) => u?.email ?? null).catch(() => null),
    getMyStoreRoles()
      .then((roles) => (roles ? (Object.fromEntries(roles.entries()) as Record<string, import("@/lib/roles").MemberRole>) : {}))
      .catch((): Record<string, import("@/lib/roles").MemberRole> => ({})),
    // Rol para los drawers del host central (misma resolución que las páginas).
    resolveActiveStoreId().catch(() => null),
  ]);
  const myRole = activeStoreId ? (userRoles[activeStoreId] ?? null) : null;
  const tz = stores.find((s) => s.id === activeStoreId)?.timezone ?? null;
  return (
    <BackgroundStatus>
      <TenantTimeProvider tz={tz}>
      <SidebarProvider defaultOpen={false}>
        <ChatDockProvider stores={stores.map((s) => ({ id: s.id, label: displayStoreName(s) }))}>
          <AppTooltipProvider>
            <AppSidebar />
            <SidebarInset className="min-w-0">
              <AppHeader stores={stores} userEmail={userEmail} userRoles={userRoles} />
              <DashboardShell>{children}</DashboardShell>
              <Suspense>
                <DrawerHost myRole={myRole} />
              </Suspense>
            </SidebarInset>
          </AppTooltipProvider>
        </ChatDockProvider>
      </SidebarProvider>
      </TenantTimeProvider>
    </BackgroundStatus>
  );
}
