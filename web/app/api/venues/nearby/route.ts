import { surql } from "@/lib/surreal";
import { requireActiveStoreAccess } from "@/lib/api/guard";
import { apiLog } from "@/lib/log";

/**
 * GET /api/venues/nearby?lat=&lng=&radius_m= — ubicación existente más cercana.
 * La convención ciudad/distrito se hereda del dato propio (ya validado en BD)
 * en vez de inferirla de la jerarquía administrativa de Mapbox, que en Perú
 * es inconsistente (el distrito a veces viene como `place`, a veces como
 * `locality`, y la región no siempre nombra la ciudad).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const radius = Math.min(Math.max(Number(url.searchParams.get("radius_m")) || 1000, 50), 50000);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return Response.json({ error: "lat/lng inválidos." }, { status: 400 });
  }
  try {
    const gated = await requireActiveStoreAccess();
    if (gated instanceof Response) return gated;
    const { storeId } = gated;
    // Cercanía nativa: `geo::distance` sobre el punto geoespacial del venue.
    const [best] = await surql<Array<{ id: string; name: string; city?: string; district?: string; distance_m: number }>>(
      `SELECT record::id(id) AS id, name, city, district, geo::distance(location, type::point([$lng, $lat])) AS distance_m
       FROM inv_venue
       WHERE store = type::record('sys_store', $store) AND location != NONE
         AND geo::distance(location, type::point([$lng, $lat])) <= $radius
       ORDER BY distance_m ASC LIMIT 1`,
      { store: storeId, lat, lng, radius },
    );
    if (!best) return Response.json({ match: null });
    return Response.json({
      match: {
        id: best.id,
        name: String(best.name ?? ""),
        city: typeof best.city === "string" ? best.city : null,
        district: typeof best.district === "string" ? best.district : null,
        distance_m: Math.round(best.distance_m),
      },
    });
  } catch (e) {
    apiLog("venues-nearby", "venues-nearby fail", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
