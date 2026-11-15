import { consumesCapacity } from "@/lib/order-workflow";
import { findEntity } from "@/lib/entity-lookup";
import { listScreenDayBookings, listScreenDayLines } from "@/lib/orders-store";
import { requireStoreAccess } from "@/lib/api/guard";
import { addDays, dayOf, dayStart, displayEndOf, todayIn } from "@/lib/format";
import { getStoreTimeZone } from "@/lib/stores-db";
import { type OccupiedRange } from "@/lib/availability-utils";
import { DEFAULT_SLOTS_PER_SCREEN } from "@/lib/store-slots";
import { apiLog } from "@/lib/log";

interface OccupancyItem {
  starts: string;
  ends: string;
  io_number: string | null;
  brand: string | null;
  status: string;
  source: "order" | "booking";
  /** Slots que ocupa la pauta (línea: cant_slots; booking: 1). */
  slots: number;
}

/**
 * GET /api/screens/:id/occupancy?past=90&future=120 — ocupación de una pantalla.
 * Ventana [hoy-past, hoy+future] (días inclusivos). Misma semántica que
 * lib/availability: excluye canceladas; el borrador aparta solo 7 días.
 * `ranges` = días sin cupo (reservados >= capacidad); `remainingByDay` =
 * slots libres por día para el resto visible; `capacity` = slots/día.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: screenId } = await params;
  try {
    const screen = await findEntity("inv_screen", screenId);
    if (!screen) return Response.json({ error: "Pantalla no encontrada." }, { status: 404 });
    const storeId = String(screen.store_id ?? "");
    const access = await requireStoreAccess(storeId);
    if (access instanceof Response) return Response.json({ error: "Pantalla no encontrada." }, { status: 404 });

    const url = new URL(req.url);
    const clamp = (v: string | null, fb: number) => {
      if (v === null || v.trim() === "") return fb;
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 && n <= 365 ? n : fb;
    };
    const past = clamp(url.searchParams.get("past"), 90);
    const future = clamp(url.searchParams.get("future"), 120);
    const tz = await getStoreTimeZone(storeId);
    const today = todayIn(tz);
    const from = addDays(today, -past);
    const to = addDays(today, future);
    const qStart = dayStart(from, tz);
    const qEnd = dayStart(addDays(to, 1), tz);

    const items: OccupancyItem[] = [];

    for (const l of await listScreenDayLines(storeId, screenId, qStart, qEnd)) {
      if (l.status === "cancelled") continue;
      if (!consumesCapacity(l)) continue;
      const qty = Number(l.cant_slots ?? 1);
      items.push({
        starts: dayOf(String(l.starts_at), tz),
        ends: displayEndOf(String(l.ends_at), tz),
        io_number: typeof l.io_number === "string" ? l.io_number : null,
        brand: typeof l.brand === "string" ? l.brand : null,
        status: typeof l.status === "string" ? l.status : "—",
        source: "order",
        slots: Number.isFinite(qty) && qty >= 1 ? Math.floor(qty) : 1,
      });
    }

    for (const b of await listScreenDayBookings(storeId, screenId, qStart, qEnd)) {
      items.push({
        starts: dayOf(String(b.starts_at), tz),
        ends: displayEndOf(String(b.ends_at), tz),
        io_number: typeof b.io_number === "string" ? b.io_number : null,
        brand: typeof b.brand === "string" ? b.brand : null,
        status: typeof b.status === "string" ? b.status : "—",
        source: "booking",
        slots: 1,
      });
    }

    items.sort((a, b) => (a.starts < b.starts ? -1 : a.starts > b.starts ? 1 : 0));
    const { getPeriodAvailability } = await import("@/lib/availability");
    const avail = await getPeriodAvailability(storeId, [screenId], from, to, {});
    const capacity = avail.capacities[screenId] ?? DEFAULT_SLOTS_PER_SCREEN;
    const remainingByDay: Record<string, number> = avail.remaining[screenId] ?? {};
    // Días sin cupo (q=1) → rangos contiguos para el calendario.
    const fullDays = [...(avail.conflicts.find((c) => c.screen_id === screenId)?.blockedDays ?? [])].sort();
    const ranges: OccupiedRange[] = [];
    let rs: string | null = null;
    let rp: string | null = null;
    const bump = (d: string) => {
      if (rs === null || rp === null) {
        rs = rp = d;
        return;
      }
      if (d <= rp) return;
      const next = addDays(rp, 1);
      if (d === next) {
        rp = d;
        return;
      }
      ranges.push({ starts: rs, ends: rp });
      rs = rp = d;
    };
    for (const d of fullDays) bump(d);
    if (rs !== null && rp !== null) ranges.push({ starts: rs, ends: rp });
    return Response.json({ from, to, today, ranges, items, capacity, remainingByDay });
  } catch (e) {
    apiLog("screens-occupancy", "screens-occupancy fail", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
