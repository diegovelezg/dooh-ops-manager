// Disponibilidad de pantallas por periodo (anti-sobreventa en la venta).
// La unidad ocupable es el slot/día: cada línea reserva `cant_slots` y cada
// booking 1 slot. La capacidad la define la DB (`fn::screen_capacity`): slots propios
// activos o el default del tenant (`sys_store.default_slots_per_screen`). Una pantalla
// bloquea solo los días donde reservados + solicitados > capacidad; el resto
// visible (slots libres por día) viaja en `remaining`/`capacities`.
// Fuentes: líneas de órdenes vigentes + bookings vigentes.
// Solo apartan las reservas explícitas vigentes y las órdenes confirmadas.
import { consumesCapacity } from "@/lib/order-workflow";
import { surql } from "@/lib/surreal";
import { DEFAULT_SLOTS_PER_SCREEN } from "@/lib/store-slots";
import { normalizeLineSlots } from "@/lib/order-lines";
import type { OccupiedRange } from "@/lib/availability-utils";
import { addDays, DAY_MS, dayOf, dayStart, displayEndOf, isValidISODate, dayNumToISO, isoDayToNum } from "@/lib/format";
import { getStoreTimeZone } from "@/lib/stores-db";
import { iso, key } from "@/lib/surql-cols";

export { displayEndOf };

/** Días que un borrador aparta pantallas. Vencido, libera automáticamente. */
export const HOLD_DAYS = 7;

export interface ScreenConflict {
  screen_id: string;
  io_number: string | null;
  brand: string | null;
  starts: string;
  ends: string;
  source: "order" | "booking";
  /** Días del periodo pedido sin cupo para los slots solicitados. */
  blockedDays?: string[];
  /** Capacidad slots/día de la pantalla. */
  capacity?: number;
  /** Slots solicitados en la evaluación. */
  requested?: number;
  /** Mínimo de slots libres en el periodo pedido. */
  remaining?: number;
}

/** Solape de rangos semiabiertos [aStart,aEnd) vs [bStart,bEnd) (ISO ordenable). */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Compatibilidad de históricos y pruebas antiguas; las lecturas usan consumesCapacity. */
export function isHoldFresh(createdAt: string | null | undefined, now = Date.now()): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  return t + HOLD_DAYS * DAY_MS > now;
}

/** Regla pura de bloqueo día-pantalla (issue #13, testeable sin BD).
 *  Exclusiva = convención sin campo: pedir `slots == capacidad` ocupa toda
 *  la pantalla (exige día vacío y bloquea el resto por pura suma). */
export function dayBlocked(opts: {
  reserved: number;
  capacity: number;
  reqSlots: number;
}): boolean {
  return opts.capacity - opts.reserved < opts.reqSlots;
}

/** Fecha UI "yyyy-mm-dd" válida o throw (fail-closed: nunca {} libre). */
function assertDateStr(v: string, field: string): string {
  if (!isValidISODate(v)) {
    throw new Error(`Fecha inválida en ${field}: ${v}`);
  }
  return v;
}

/** Periodo UI (inicio/fin inclusivos "yyyy-mm-dd" del tenant) → rango semiabierto en instantes UTC. */
export function periodBounds(starts: string, ends: string, tz: string): { qStart: string; qEnd: string } {
  assertDateStr(starts, "starts");
  assertDateStr(ends, "ends");
  if (ends < starts) throw new Error(`Rango inválido: ${starts} > ${ends}`);
  return {
    qStart: dayStart(starts, tz),
    qEnd: dayStart(addDays(ends, 1), tz),
  };
}

/** Pantallas ocupadas en [starts, ends] (fechas UI inclusivas).
 *  Slot-aware: solo bloquean los días donde reservados + solicitados >
 *  capacidad. `slots`: cantidad pedida (una para todas o por pantalla,
 *  default 1). Pedir `slots == capacidad` = exclusiva (ocupa la pantalla).
 *  `excludeIoId`: ignora líneas y bookings de esa orden (editar
 *  sin chocar consigo misma). */
export async function getScreenConflicts(
  storeId: string,
  starts: string,
  ends: string,
  opts: { excludeIoId?: string | null; slots?: number | Record<string, number> } = {},
): Promise<ScreenConflict[]> {
  return (await getPeriodAvailability(storeId, null, starts, ends, opts)).conflicts;
}

/** Con más pantallas que esto la regla se evalúa por lote: una pasada sobre los slots de la tienda en vez de
 *  3 consultas por pantalla (~0,15 ms c/u: 240 ms con 1 600 pantallas). El lote cuesta ~45 ms fijos: por pantalla
 *  gana hasta unas 300 (umbral conservador: 200). */
const BULK_CAPACITY_FROM = 200;

/** Capacidad slots/día de TODAS las pantallas de la tienda en una pasada. Misma regla que
 *  `fn::screen_capacity` (0007): slots activos propios; con slots pero todos inactivos, 0 (pausada); sin slots
 *  definidos, el default de la tienda (10). Va INLINE y no como `fn::`: el mismo cuerpo envuelto en una función de
 *  usuario tarda ~2,6× más (122 ms vs 46 ms con 1 600 pantallas, SurrealDB 4.0.1). La prueba
 *  "capacidad en lote = por pantalla" (tests/surreal-orders.test.ts) garantiza que ambas coinciden. */
const STORE_CAPACITIES = `
  LET $store = type::record('sys_store', $store);
  LET $def = (SELECT VALUE default_slots_per_screen FROM ONLY $store) ?? 10;
  LET $act = object::from_entries((SELECT screen, count() AS n FROM inv_slot WHERE store = $store AND is_active != false GROUP BY screen).map(|$x| [<string> $x.screen, $x.n]));
  LET $any = (SELECT VALUE screen FROM inv_slot WHERE store = $store GROUP BY screen).map(|$s| <string> $s);
  RETURN (SELECT record::id(id) AS id,
    IF ($act[<string> id] ?? 0) > 0 { $act[<string> id] } ELSE IF <string> id IN $any { 0 } ELSE { $def } AS capacity
    FROM inv_screen WHERE store = $store);`;

/** Capacidad slots/día por pantalla (regla única en la DB: `fn::screen_capacity`; el lote aplica la misma). */
export async function getScreenCapacities(
  storeId: string,
  screenIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (screenIds.length === 0) return out;
  if (screenIds.length > BULK_CAPACITY_FROM) {
    const all = await surql<Array<{ id: string; capacity: number }>>(STORE_CAPACITIES, { store: storeId });
    const byId = new Map(all.map((r) => [r.id, r.capacity]));
    // Ids ajenos o inexistentes: sin pantalla no hay capacidad que vender.
    for (const id of screenIds) out.set(id, byId.get(id) ?? 0);
    return out;
  }
  const rows = await surql<Array<{ id: string; capacity: number }>>(
    `LET $r = $ids.map(|$i| type::record('inv_screen', $i));
     SELECT record::id(id) AS id, fn::screen_capacity(id) AS capacity FROM inv_screen
     WHERE store = type::record('sys_store', $store) AND id IN $r`,
    { store: storeId, ids: screenIds },
  );
  for (const r of rows) out.set(r.id, r.capacity);
  // Ids ajenos o inexistentes: sin pantalla no hay capacidad que vender.
  for (const id of screenIds) if (!out.has(id)) out.set(id, 0);
  return out;
}

interface AvailabilityGrid {
  ids: string[];
  capacities: Map<string, number>;
  reserved: Map<string, Map<number, number>>;
  info: Map<string, { io_number: string | null; brand: string | null; source: "order" | "booking" }>;
  /** Días con al menos un hold/borrador vigente (punto indicador). */
  holds: Map<string, Set<number>>;
}

/** Grilla reservados/día por pantalla en [fromNum, toNumExcl) (ordinales).
 *  `screenIds` null = descubre por actividad en la ventana (vía legacy). */
async function loadAvailabilityGrid(
  storeId: string,
  screenIds: string[] | null,
  fromNum: number,
  toNumExcl: number,
  opts: { excludeIoId?: string | null } = {},
): Promise<AvailabilityGrid> {
  const excluded = typeof opts.excludeIoId === "string" && opts.excludeIoId ? opts.excludeIoId : null;
  const tz = await getStoreTimeZone(storeId);
  const winStart = dayStart(dayNumToISO(fromNum), tz);
  const winEnd = dayStart(dayNumToISO(toNumExcl), tz);
  const reserved = new Map<string, Map<number, number>>();
  const info = new Map<string, { io_number: string | null; brand: string | null; source: "order" | "booking" }>();
  const holds = new Map<string, Set<number>>();
  const add = (id: string, day: number, qty: number) => {
    if (day < fromNum || day >= toNumExcl || qty <= 0) return;
    let m = reserved.get(id);
    if (!m) reserved.set(id, (m = new Map()));
    m.set(day, (m.get(day) ?? 0) + qty);
  };
  const note = (id: string, io_number: string | null, brand: string | null, source: "order" | "booking") => {
    if (!info.has(id)) info.set(id, { io_number, brand, source });
  };

  // Sin paginación ni `limit` mudo: SurrealDB devuelve la ventana completa (truncar en silencio
  // sería sobreestimar disponibilidad = sobreventa). `screenIds` null = descubre por actividad.
  const idsLet = screenIds ? "LET $r = $ids.map(|$i| type::record('inv_screen', $i));" : "";
  const scope = screenIds ? "AND screen IN $r" : "";
  const bookScope = screenIds ? "AND slot.screen IN $r" : "";
  const vars = { store: storeId, ids: screenIds ?? undefined, from: winStart, to: winEnd };
  // Las líneas viajan SIN joins (`order.*` por línea costaba ~220 ms con 14 000 líneas); sus órdenes se leen
  // una vez por id (SurrealDB 4 resuelve `id IN [...]` por clave) en el mismo viaje y se unen en JS.
  const [{ lines: rawLines, orders }, books] = await Promise.all([
    surql<{ lines: Array<Record<string, unknown>>; orders: Array<Record<string, unknown>> }>(
      `${idsLet}
       LET $ln = SELECT record::id(order) AS io_id, order AS o, record::id(screen) AS screen_id, ${iso("starts_at")} AS starts_at,
              ${iso("ends_at")} AS ends_at, cant_slots
         FROM io_line WHERE store = type::record('sys_store', $store) ${scope}
           AND starts_at < <datetime> $to AND ends_at > <datetime> $from;
       LET $oids = array::distinct($ln.map(|$l| $l.o));
       RETURN {
         lines: $ln.map(|$l| { io_id: $l.io_id, screen_id: $l.screen_id, starts_at: $l.starts_at, ends_at: $l.ends_at, cant_slots: $l.cant_slots }),
         orders: SELECT record::id(id) AS id, number AS io_number, brand, status, ${iso("reservation_expires_at")} AS reservation_expires_at
           FROM io_order WHERE id IN $oids
       };`,
      vars,
    ),
    surql<Array<Record<string, unknown>>>(
      `${idsLet} SELECT record::id(slot.screen) AS screen_id, ${key("order")} AS io_id, order.number AS io_number, order.brand AS brand,
              ${iso("starts_at")} AS starts_at, ${iso("ends_at")} AS ends_at, status
       FROM inv_booking WHERE store = type::record('sys_store', $store) ${bookScope} AND status != 'cancelled'
         AND starts_at < <datetime> $to AND ends_at > <datetime> $from`,
      vars,
    ),
  ]);
  const orderById = new Map(orders.map((o) => [String(o.id), o]));
  const lines: Array<Record<string, unknown>> = rawLines.map((l) => {
    const o = orderById.get(String(l.io_id));
    return { ...l, io_number: o?.io_number, brand: o?.brand, status: o?.status, reservation_expires_at: o?.reservation_expires_at };
  });
  // `dayOf` (Intl) cuesta ~10 µs: muchas líneas comparten inicio/fin, se resuelve una vez por instante.
  const dayNumCache = new Map<string, number>();
  const dayNum = (instant: string): number => {
    let n = dayNumCache.get(instant);
    if (n === undefined) dayNumCache.set(instant, (n = isoDayToNum(dayOf(instant, tz))));
    return n;
  };
  for (const l of lines) {
    if (excluded && String(l.io_id ?? "") === excluded) continue;
    if (l.status === "cancelled") continue;
    if (!consumesCapacity(l)) continue;
    const id = String(l.screen_id ?? "");
    if (!id) continue;
    const qtyRaw = Number(l.cant_slots ?? 1);
    const qty = Number.isFinite(qtyRaw) && qtyRaw >= 1 ? Math.floor(qtyRaw) : 1;
    const s = Math.max(dayNum(String(l.starts_at)), fromNum);
    const e = Math.min(dayNum(String(l.ends_at)), toNumExcl);
    const isHold = l.status === "draft";
    for (let d = s; d < e; d++) {
      add(id, d, qty);
      if (isHold) {
        let h = holds.get(id);
        if (!h) holds.set(id, (h = new Set()));
        h.add(d);
      }
    }
    note(id, typeof l.io_number === "string" ? l.io_number : null, typeof l.brand === "string" ? l.brand : null, "order");
  }
  for (const b of books) {
    if (excluded && b.io_id != null && String(b.io_id) === excluded) continue;
    const screenId = String(b.screen_id ?? "");
    if (!screenId) continue;
    const s = Math.max(dayNum(String(b.starts_at)), fromNum);
    const e = Math.min(dayNum(String(b.ends_at)), toNumExcl);
    const isHold = String(b.status ?? "") === "hold";
    for (let d = s; d < e; d++) {
      add(screenId, d, 1);
      if (isHold) {
        let h = holds.get(screenId);
        if (!h) holds.set(screenId, (h = new Set()));
        h.add(d);
      }
    }
    note(screenId, typeof b.io_number === "string" ? b.io_number : null, typeof b.brand === "string" ? b.brand : null, "booking");
  }

  const ids = screenIds ?? [...new Set([...reserved.keys()])];
  const capacities = await getScreenCapacities(storeId, ids);
  return { ids, capacities, reserved, info, holds };
}

/** Días consecutivos → rangos inclusivos (para calendarios). */
function mergeDayNums(days: number[]): OccupiedRange[] {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const out: OccupiedRange[] = [];
  let s = -1;
  let p = -1;
  for (const d of sorted) {
    if (s === -1) {
      s = p = d;
      continue;
    }
    if (d === p + 1) {
      p = d;
      continue;
    }
    out.push({ starts: dayNumToISO(s), ends: dayNumToISO(p) });
    s = p = d;
  }
  if (s !== -1) out.push({ starts: dayNumToISO(s), ends: dayNumToISO(p) });
  return out;
}

export interface PeriodAvailability {
  conflicts: ScreenConflict[];
  /** screenId → día "yyyy-mm-dd" → slots libres ese día (clampado a ≥0). */
  remaining: Record<string, Record<string, number>>;
  /** screenId → día "yyyy-mm-dd" → slots reservados ese día (sin clampar: revela sobreventa). */
  taken: Record<string, Record<string, number>>;
  capacities: Record<string, number>;
  /** screenId → días "yyyy-mm-dd" con hold/borrador vigente. */
  holds: Record<string, string[]>;
}

/** Disponibilidad slot-aware de un periodo UI (inclusivo).
 *  `screenIds` null = solo pantallas con actividad (vía legacy).
 *  `remaining`/`capacities` viajan para el resto visible; `conflicts`
 *  marca las pantallas sin cupo en algún día del periodo. */
export async function getPeriodAvailability(
  storeId: string,
  screenIds: string[] | null,
  starts: string,
  ends: string,
  opts: { excludeIoId?: string | null; slots?: number | Record<string, number> } = {},
): Promise<PeriodAvailability> {
  const startNum = isoDayToNum(assertDateStr(starts, "starts"));
  const endNum = isoDayToNum(assertDateStr(ends, "ends"));
  if (endNum < startNum) throw new Error(`Rango inválido: ${starts} > ${ends}`);
  const grid = await loadAvailabilityGrid(storeId, screenIds, startNum, endNum + 1, opts);
  const conflicts: ScreenConflict[] = [];
  const remaining: Record<string, Record<string, number>> = {};
  const taken: Record<string, Record<string, number>> = {};
  const capacities: Record<string, number> = {};
  const holds: Record<string, string[]> = {};
  const wanted = (id: string): number => {
    const raw = typeof opts.slots === "number" ? opts.slots : opts.slots?.[id];
    return normalizeLineSlots(raw) ?? 1;
  };
  for (const id of grid.ids) {
    const capacity = grid.capacities.get(id) ?? DEFAULT_SLOTS_PER_SCREEN;
    capacities[id] = capacity;
    const q = wanted(id);
    const days: Record<string, number> = {};
    const sold: Record<string, number> = {};
    const blocked: string[] = [];
    let minFree = capacity;
    for (let d = startNum; d <= endNum; d++) {
      const raw = grid.reserved.get(id)?.get(d) ?? 0;
      const day = dayNumToISO(d);
      sold[day] = Math.max(0, raw);
      const free = Math.max(0, capacity - raw);
      days[day] = free;
      if (free < minFree) minFree = free;
      if (dayBlocked({ reserved: raw, capacity, reqSlots: q })) blocked.push(day);
    }
    remaining[id] = days;
    taken[id] = sold;
    const holdDays: string[] = [];
    const hs = grid.holds.get(id);
    if (hs) {
      for (let d = startNum; d <= endNum; d++) {
        if (hs.has(d)) holdDays.push(dayNumToISO(d));
      }
    }
    if (holdDays.length > 0) holds[id] = holdDays;
    if (blocked.length > 0) {
      const hit = grid.info.get(id);
      conflicts.push({
        screen_id: id,
        io_number: hit?.io_number ?? null,
        brand: hit?.brand ?? null,
        starts: blocked[0],
        ends: blocked[blocked.length - 1],
        source: hit?.source ?? "order",
        blockedDays: blocked,
        capacity,
        requested: q,
        remaining: minFree,
      });
    }
  }
  return { conflicts, remaining, taken, capacities, holds };
}

/** Línea pedida para evaluación de cupo (fechas UI inclusivas). */
export interface LineRequest {
  screen_id: string;
  starts: string;
  ends: string;
  slots: number;
}

/** Evalúa cupo por línea (su periodo × su `q`): fail-closed ante forma
 *  inválida. Devuelve el primer choque con `blockedDays` recortados a la
 *  línea (comparación inclusiva, sin `rangesOverlap` semiabierto). */
export async function findLineConflicts(
  storeId: string,
  lines: LineRequest[],
  opts: { excludeIoId?: string | null } = {},
): Promise<{ index: number; conflict: ScreenConflict } | null> {
  const clean = lines.map((l, i) => {
    const screen_id = String(l.screen_id ?? "").trim();
    const starts = String(l.starts ?? "").trim();
    const ends = String(l.ends ?? "").trim();
    const q = normalizeLineSlots(l.slots);
    if (!screen_id || !isValidISODate(starts) || !isValidISODate(ends) || ends < starts || q === null) {
      throw new Error(`Línea ${i + 1}: periodo o slots inválidos.`);
    }
    return { screen_id, starts, ends, q };
  });
  if (clean.length === 0) return null;
  const from = clean.reduce((a, l) => (a < l.starts ? a : l.starts), clean[0].starts);
  const to = clean.reduce((a, l) => (a > l.ends ? a : l.ends), clean[0].ends);
  const ids = [...new Set(clean.map((l) => l.screen_id))];
  const grid = await loadAvailabilityGrid(storeId, ids, isoDayToNum(from), isoDayToNum(to) + 1, opts);
  for (let i = 0; i < clean.length; i++) {
    const l = clean[i];
    const capacity = grid.capacities.get(l.screen_id) ?? DEFAULT_SLOTS_PER_SCREEN;
    const blocked: string[] = [];
    for (let d = isoDayToNum(l.starts); d <= isoDayToNum(l.ends); d++) {
      const raw = grid.reserved.get(l.screen_id)?.get(d) ?? 0;
      if (dayBlocked({ reserved: raw, capacity, reqSlots: l.q })) blocked.push(dayNumToISO(d));
    }
    if (blocked.length > 0) {
      const hit = grid.info.get(l.screen_id);
      return {
        index: i,
        conflict: {
          screen_id: l.screen_id,
          io_number: hit?.io_number ?? null,
          brand: hit?.brand ?? null,
          starts: blocked[0],
          ends: blocked[blocked.length - 1],
          source: hit?.source ?? "order",
          blockedDays: blocked,
          capacity,
          requested: l.q,
          remaining: Math.max(0, Math.min(...blocked.map((b) => capacity - (grid.reserved.get(l.screen_id)?.get(isoDayToNum(b)) ?? 0)))),
        },
      };
    }
  }
  return null;
}

/** Rangos sin cupo por pantalla desde `from` (400 días), días inclusivos.
 *  Para calendarios de disponibilidad y cálculo del próximo hueco.
 *  `slots`: cupo pedido por pantalla (default 1 = día totalmente reservado);
 *  los días con resto parcial no entran al rango pero sí a `remaining`
 *  cuando el caller lo pide vía `getPeriodAvailability`. */
export async function getScreenOccupancy(
  storeId: string,
  screenIds: string[],
  from: string,
  opts: { excludeIoId?: string | null; slots?: number | Record<string, number> } = {},
): Promise<Record<string, OccupiedRange[]>> {
  assertDateStr(from, "from");
  const out: Record<string, OccupiedRange[]> = {};
  if (screenIds.length === 0) return out;
  const fromNum = isoDayToNum(from);
  const grid = await loadAvailabilityGrid(storeId, screenIds, fromNum, fromNum + 400, opts);
  const wanted = (id: string): number => {
    const raw = typeof opts.slots === "number" ? opts.slots : opts.slots?.[id];
    return normalizeLineSlots(raw) ?? 1;
  };
  for (const id of grid.ids) {
    const capacity = grid.capacities.get(id) ?? DEFAULT_SLOTS_PER_SCREEN;
    const q = wanted(id);
    const full: number[] = [];
    for (let d = fromNum; d < fromNum + 400; d++) {
      const raw = grid.reserved.get(id)?.get(d) ?? 0;
      if (dayBlocked({ reserved: raw, capacity, reqSlots: q })) full.push(d);
    }
    out[id] = mergeDayNums(full);
  }
  return out;
}
