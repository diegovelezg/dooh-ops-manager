import { getMyActiveStore, requireMyStoreAccess } from "@/lib/tenant";
import { isDbConfigured } from "@/lib/surreal";
import { apiLog } from "@/lib/log";

// GET /api/screens?store= — picker de pantallas activas para editar líneas
// de borradores. Misma forma que `ScreenPick` de nueva orden (SSOT:
// id, nombre, detalle, código, precio). Todas las pantallas activas del tenant.
export async function GET(req: Request) {
  if (!isDbConfigured()) {
    return Response.json({ error: "Base de datos no disponible." }, { status: 500 });
  }
  const url = new URL(req.url);
  const sp = url.searchParams;
  try {
    const { active } = await getMyActiveStore(sp.get("store"));
    if (!active) return Response.json({ error: "Sin tienda." }, { status: 400 });
    if ((await requireMyStoreAccess(active.id).catch(() => false)) === false) {
      return Response.json({ error: "Sin acceso a esta tienda." }, { status: 403 });
    }
    const { listScreensBrief } = await import("@/lib/screens-store");
    const screenRows = await listScreensBrief(active.id, { activeOnly: true });
    const out = screenRows.map((s) => {
      const venue = typeof s.venue_name === "string" ? s.venue_name : "";
      const district = typeof s.district === "string" ? s.district : "";
      const city = typeof s.city === "string" ? s.city : "";
      const supplier = typeof s.supplier_name === "string" ? s.supplier_name : "";
      const w = Number(s.width_px);
      const h = Number(s.height_px);
      const res = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? `${w}×${h}` : "";
      const detail = [venue, district, city, supplier, s.technology, res]
        .map((x) => String(x ?? "").trim())
        .filter(Boolean)
        .join(" · ");
      return {
        id: String(s.id),
        name: String(s.name ?? ""),
        detail: detail || null,
        code: String(s.external_ref ?? "").trim() || null,
        price_pen: s.price_pen === null || s.price_pen === undefined ? null : Number(s.price_pen),
      };
    });
    return Response.json(
      { screens: out },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    apiLog("screens", "screens fail", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "No se pudieron cargar las pantallas." }, { status: 500 });
  }
}
