import { getMyActiveStore } from "@/lib/tenant";
import { countCompanies, countContacts } from "@/lib/crm-store";
import { countScreens } from "@/lib/screens-store";
import { isDbConfigured } from "@/lib/surreal";
import { countOrders } from "@/lib/orders-store";
import { apiLog } from "@/lib/log";

/**
 * GET /api/health?store=<uuid>
 * Fase 2 DOOH: conteos vivos (empresas, contactos, IOs, pantallas).
 */
export async function GET(req: Request) {
  if (!isDbConfigured()) {
    return Response.json({ error: "Base de datos no configurada." }, { status: 500 });
  }
  const url = new URL(req.url);
  const sp = url.searchParams;
  let active: Awaited<ReturnType<typeof getMyActiveStore>>["active"] = null;
  try {
    const resolved = await getMyActiveStore(sp.get("store"));
    active = resolved.active;
  } catch (e) {
    apiLog("health", "health fail", { error: e instanceof Error ? e.message : String(e) });
    return Response.json(
      { error: e instanceof Error ? e.message : "DB read failed" },
      { status: 500 },
    );
  }
  if (!active) {
    return Response.json({ store_id: null, companies: 0, contacts: 0, orders: 0, screens: 0 });
  }
  const { requireStoreAccess } = await import("@/lib/api/guard");
  const access = await requireStoreAccess(active.id);
  if (access instanceof Response) return access;
  try {
    const [comp, cont, ios, scr, schema] = await Promise.all([
      countCompanies(active.id),
      countContacts(active.id),
      countOrders(active.id),
      countScreens(active.id),
      (async () => {
        const { checkSchema } = await import("@/lib/schema-guard");
        const gaps = await checkSchema();
        return { ok: gaps.length === 0, gaps: gaps.map((g) => g.relation) };
      })().catch(() => ({ ok: true, gaps: [] as string[] })),
    ]);
    return Response.json({
      store_id: active.id,
      companies: comp,
      contacts: cont,
      orders: ios,
      screens: scr,
      schemaOk: schema.ok,
      schemaGaps: schema.gaps,
    });
  } catch (e) {
    apiLog("health", "health fail", { error: e instanceof Error ? e.message : String(e) });
    return Response.json(
      { error: e instanceof Error ? e.message : "DB read failed" },
      { status: 500 },
    );
  }
}
