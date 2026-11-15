// Finanzas DOOH: tendencia 12m + KPIs del mes (alineados con Hoy).
// Puro cálculo sobre líneas de IO mapeadas a FinanceOrder
// (total_amount = rate_minor, placed_at = starts_at).
// Ventana por mes calendario: mes en curso a la fecha vs mismo tramo del
// mes anterior. La tendencia 12m ya era mensual.
// Regla de moneda: solo la moneda de la vista (siempre explícita, nunca null).
// El resto se ignora (nunca se suman PEN+USD).
import { normalizeCurrency } from "@/lib/currency";
import { dayStartMs, MONTH_SHORT_ES, monthFirstISO, todayIn } from "@/lib/format";
export interface FinanceOrder {
  order_id: string;
  total_amount: number;
  currency: string | null;
  placed_at: string | null;
}

export interface MonthBucket {
  /** "2026-10" para key. */
  key: string;
  /** "oct" etiqueta corta en español. */
  label: string;
  salesMinor: number;
  orders: number;
}

export interface FinanceKpis {
  salesMesMinor: number;
  ordersMes: number;
  ticketMesMinor: number;
  /** % base 100 vs mismo tramo del mes anterior. null si no hay base. */
  salesDeltaPct: number | null;
  ordersDeltaPct: number | null;
}

function sameCurrency(orderCur: string | null, viewCurrency: string): boolean {
  if (orderCur == null || String(orderCur).trim() === "") return true;
  return normalizeCurrency(orderCur, "") === normalizeCurrency(viewCurrency, "");
}

/** Mes calendario del tenant ("2026-10") de un instante. */
function monthKeyOf(t: number, tz: string): string {
  return monthFirstISO(todayIn(tz, t)).slice(0, 7);
}

/** Últimos 12 meses calendario del tenant incluyendo el mes actual. */
function last12MonthKeys(tz: string, now: number): Array<{ key: string; label: string }> {
  const today = todayIn(tz, now);
  const out: Array<{ key: string; label: string }> = [];
  for (let i = 11; i >= 0; i -= 1) {
    const first = monthFirstISO(today, -i);
    out.push({ key: first.slice(0, 7), label: MONTH_SHORT_ES[Number(first.slice(5, 7)) - 1] ?? "—" });
  }
  return out;
}

export function bucketMonthly(
  orders: FinanceOrder[],
  viewCurrency: string,
  tz: string,
  now = Date.now(),
): MonthBucket[] {
  const keys = last12MonthKeys(tz, now);
  const map = new Map(keys.map((k) => [k.key, { salesMinor: 0, orders: new Set<string>() }]));
  for (const o of orders) {
    if (!sameCurrency(o.currency, viewCurrency)) continue;
    if (!o.placed_at) continue;
    const t = Date.parse(o.placed_at);
    if (Number.isNaN(t)) continue;
    const b = map.get(monthKeyOf(t, tz));
    if (!b) continue; // fuera de la ventana 12m
    b.salesMinor += Number(o.total_amount ?? 0);
    b.orders.add(o.order_id);
  }
  return keys.map((k) => ({
    ...k,
    salesMinor: map.get(k.key)?.salesMinor ?? 0,
    orders: map.get(k.key)?.orders.size ?? 0,
  }));
}

function deltaPct(cur: number, prev: number): number | null {
  if (prev <= 0) return cur > 0 ? null : 0;
  return Math.round(((cur - prev) / prev) * 100);
}

export function computeFinanceKpis(
  orders: FinanceOrder[],
  viewCurrency: string,
  tz: string,
  now = Date.now(),
): FinanceKpis {
  // Ventana por mes calendario (alineada con Hoy): mes en curso a la fecha
  // vs el mismo tramo del mes anterior (igual cantidad de días, comparable
  // a inicio de mes). Importes por línea; órdenes distintas dentro de cada tramo.
  const today = todayIn(tz, now);
  const monthStart = dayStartMs(monthFirstISO(today, 0), tz);
  const prevStart = dayStartMs(monthFirstISO(today, -1), tz);
  // Tramo comparable, acotado al mes anterior (mes corto: 30-mar vs feb).
  const prevEnd = Math.min(prevStart + Math.max(0, now - monthStart), monthStart);
  let salesCur = 0;
  const ordersCur = new Set<string>();
  let salesPrev = 0;
  const ordersPrev = new Set<string>();
  for (const o of orders) {
    if (!sameCurrency(o.currency, viewCurrency)) continue;
    if (!o.placed_at) continue;
    const t = Date.parse(o.placed_at);
    if (Number.isNaN(t) || t > now) continue;
    const amt = Number(o.total_amount ?? 0);
    if (t >= monthStart) {
      salesCur += amt;
      ordersCur.add(o.order_id);
    } else if (t >= prevStart && t < prevEnd) {
      salesPrev += amt;
      ordersPrev.add(o.order_id);
    }
  }
  return {
    salesMesMinor: salesCur,
    ordersMes: ordersCur.size,
    ticketMesMinor: ordersCur.size > 0 ? Math.round(salesCur / ordersCur.size) : 0,
    salesDeltaPct: deltaPct(salesCur, salesPrev),
    ordersDeltaPct: deltaPct(ordersCur.size, ordersPrev.size),
  };
}
