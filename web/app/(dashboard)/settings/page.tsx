import { PageHeader } from "@/components/page-header";
import { connection } from "next/server";
import { isDbConfigured } from "@/lib/surreal";
import { DEFAULT_SLOTS_PER_SCREEN, getMyStoreRole, requireMyStoreAccess } from "@/lib/tenant";
import { getSessionUser } from "@/lib/auth";
import { TeamPanel } from "./team-panel";
import { InventoryPanel } from "./inventory-panel";
import { TimeZonePanel } from "./timezone-panel";
import { AgentPanel } from "./agent-panel";
import { SettingsTabs } from "./settings-tabs";
import { listAgentTokens } from "@/lib/agent-tokens";

export const instant = false;

// Settings simplificado: solo Equipo. Negocio eliminado (el perfil del
// tenant lo escribe el profiler; nadie lo consumía en UI) y Email oculto
// por ahora (el sender no tiene llamadas; se conserva
// components/settings-form.tsx para reactivarlo).
export default async function SettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ store?: string }>;
}) {
  await connection();
  const sp = searchParams ? await searchParams : null;
  const requestedStore = sp?.store ?? null;
  let activeStoreId: string | null = null;
  let initialSlots = DEFAULT_SLOTS_PER_SCREEN;
  let initialTimeZone: string | null = null;
  if (isDbConfigured()) {
    try {
      const { getMyActiveStore } = await import("@/lib/tenant");
      const got = await getMyActiveStore(requestedStore).catch(() => null);
      activeStoreId = got?.active?.id ?? null;
      if (got?.active) {
        initialSlots = got.active.default_slots_per_screen;
        initialTimeZone = got.active.timezone;
      }
    } catch {
      activeStoreId = null;
    }
  }
  const resolvedId = activeStoreId;
  const storeId =
    resolvedId && (await requireMyStoreAccess(resolvedId).catch(() => null)) === false
      ? null
      : resolvedId;
  const accessDenied = Boolean(resolvedId && !storeId);
  const membersData = storeId
    ? await import("@/lib/members")
        .then((m) => m.listStoreMembers(storeId))
        .catch(() => [])
    : [];
  const myRole = storeId ? await getMyStoreRole(storeId).catch(() => null) : null;
  let myUserId: string | null = null;
  try {
    myUserId = (await getSessionUser())?.id ?? null;
  } catch {
    myUserId = null;
  }
  let agentTokens: Awaited<ReturnType<typeof listAgentTokens>> = [];
  let agentTokensFailed = false;
  if (myUserId) {
    try {
      agentTokens = await listAgentTokens(myUserId);
    } catch {
      agentTokensFailed = true; // no se oculta como "sin agentes": el panel avisa
    }
  }
  return (
    <div className="page-shell max-w-[1200px]">
      <PageHeader
        eyebrow="Configuración"
        title="Ajustes"
        description="Equipo, inventario de esta tienda y conexión de agentes de IA."
      />
      {accessDenied ? (
        <p className="text-sm text-muted-foreground">
          Sin acceso a esta tienda. Pide a un administrador que te dé acceso.
        </p>
      ) : (
        <SettingsTabs
          tabs={[
            {
              id: "equipo",
              label: "Equipo",
              content: (
                <TeamPanel
                  members={membersData ?? []}
                  myRole={myRole}
                  myUserId={myUserId}
                  storeId={storeId}
                />
              ),
            },
            {
              id: "tienda",
              label: "Tienda",
              content: (
                <>
                  <InventoryPanel
                    storeId={storeId}
                    initialSlots={initialSlots}
                    canEdit={myRole === "owner" || myRole === "admin"}
                  />
                  {initialTimeZone && (
                    <TimeZonePanel
                      storeId={storeId}
                      initialTimeZone={initialTimeZone}
                      canEdit={myRole === "owner" || myRole === "admin"}
                    />
                  )}
                </>
              ),
            },
            ...(myUserId
              ? [
                  {
                    id: "agentes",
                    label: "Agentes de IA",
                    content: <AgentPanel tokens={agentTokens} loadFailed={agentTokensFailed} />,
                  },
                ]
              : []),
          ]}
        />
      )}
    </div>
  );
}
