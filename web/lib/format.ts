// Formato único del sitio (SSOT): números + fechas.
// Números: separador de miles ".", separador decimal "," y 0 decimales por
// defecto. Todo valor numérico visible debe pasar por estos helpers (no
// formatear a mano).
//
// Fechas: display (`formatDate`, `formatDateTime`, `formatDayMonth`,
// `formatTimeAgo`) + parse/canon (`parseISODate`, `toISODateLocal/UTC`,
// `addDays`, `displayEndOf`…). Cero inlines: ningún otro archivo formatea,
// parsea ni construye días a mano. Lo impone `tests/date-ssot.test.ts`.
//
// Unidades: los montos de la DB/API viajan en MINOR units (céntimos) y
// `formatMoney` divide ÷100. Nunca pasar soles/pesos ya divididos.
// Ratio vs puntos: `formatPercent` recibe ratio 0–1, `formatPercentPoints`
// recibe 0–100. No intercambiar.

import { normalizeCurrency } from "@/lib/currency";
import { vatRateForCountry } from "@/lib/tax-rate";

/** Locale de formateo. `es-ES` ≡ `es-PE` en agrupación/decimal ("."/","); se
 *  fija `es-ES` por disponibilidad garantizada en ICU de Node. La moneda se
 *  muestra siempre en código ISO (PEN, USD…), nunca con símbolo. */
const FORMAT_LOCALE = "es-ES";

type NumberFormatOptions = {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
};

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(min: number, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  const created = new Intl.NumberFormat(FORMAT_LOCALE, {
    useGrouping: true,
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  });
  formatters.set(key, created);
  return created;
}

/** 1234567.89 → "1.234.568" (0 decimales por defecto). */
export function formatNumber(
  value: number | string | null | undefined,
  options: NumberFormatOptions = {},
): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  const min = Math.max(0, Math.floor(options.minimumFractionDigits ?? 0));
  const max = Math.max(min, Math.floor(options.maximumFractionDigits ?? 0));
  return formatter(min, max).format(n);
}

/** Igual que formatNumber pero siempre con la cantidad de decimales indicada. */
export function formatDecimal(value: number | string | null | undefined, decimals = 0): string {
  const d = Math.max(0, Math.floor(decimals));
  return formatNumber(value, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

/** Ratio 0–1 → "87%" (0 decimales por defecto). No-finito → "—" (sin "%"). */
export function formatPercent(ratio: number | string | null | undefined, decimals = 0): string {
  if (ratio === null || ratio === undefined) return "—";
  const n = Number(ratio);
  if (!Number.isFinite(n)) return "—";
  const out = formatDecimal(n * 100, decimals);
  return out === "—" ? "—" : `${out}%`;
}

/** Porcentaje ya expresado en base 100: 87.4 → "87%". */
export function formatPercentPoints(
  value: number | string | null | undefined,
  decimals = 0,
): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const out = formatDecimal(value, decimals);
  return out === "—" ? "—" : `${out}%`;
}

/**
 * Minor units → partes de moneda legible, siempre en código ISO (PEN, USD…).
 * Ej.: formatMoneyParts(36461777, "PEN") → { code: "PEN", body: "364.618",
 * text: "PEN 364.618" }.
 * Ej. con céntimos: formatMoneyParts(1999, "PEN", 2) → body "19,99".
 * Monto no-finito/null → body/text "—". Moneda null/vacía → PEN (default
 * histórico de la tienda); desconocida → código ISO tal cual.
 *
 * SSOT visual: el render con estilo (ISO sutil) vive en `<Money/>`
 * (`components/money.tsx`), que consume estas partes. `formatMoney` queda
 * para contextos solo-texto: aria-labels, tooltips en string, CSV, print
 * y concatenaciones multi-moneda ("PEN … + USD …").
 */
export function formatMoneyParts(
  amountMinor: number | string | null | undefined,
  currency: string | null | undefined,
  decimals = 0,
): { code: string; body: string; text: string } {
  if (amountMinor === null || amountMinor === undefined)
    return { code: "PEN", body: "—", text: "—" };
  const minor = Number(amountMinor);
  if (!Number.isFinite(minor)) return { code: "PEN", body: "—", text: "—" };
  const code = normalizeCurrency(currency, "PEN");
  const d = Math.max(0, Math.floor(decimals));
  const major = minor / 100;
  const body =
    d === 0 ? formatNumber(Math.round(major)) : formatDecimal(major, d);
  if (body === "—") return { code, body: "—", text: "—" };
  return { code, body, text: `${code} ${body}` };
}

/**
 * Minor units → moneda legible, siempre en código ISO (PEN, USD…).
 * Ej.: formatMoney(36461777, "PEN") → "PEN 364.618".
 * Ej. con céntimos: formatMoney(1999, "PEN", 2) → "PEN 19,99".
 * Monto no-finito/null → "—". Moneda null/vacía → PEN (default histórico
 * de la tienda); desconocida → código ISO tal cual.
 *
 * Solo-texto (ver `formatMoneyParts`). Para UI visible usar `<Money/>`.
 */
export function formatMoney(
  amountMinor: number | string | null | undefined,
  currency: string | null | undefined,
  decimals = 0,
): string {
  return formatMoneyParts(amountMinor, currency, decimals).text;
}

/** Etiqueta de condición de pago desde días (fuente numérica).
 *  0 → "Contado", N → "N días", null → "—". El cálculo (vencimientos)
 *  usa el entero; el texto es solo display. */
export function paymentTermsLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return "—";
  return days === 0 ? "Contado" : `${formatNumber(days)} días`;
}

/** Tasa del impuesto del tenant (SSOT en `lib/tax-rate.ts`, por `shop_country`).
 *  Los montos se guardan SIN impuesto. */
export function splitIgv(
  grossMinor: number,
  country?: unknown,
): { net: number; igv: number; total: number } {
  const net = Number.isFinite(grossMinor) ? Math.max(0, Math.round(grossMinor)) : 0;
  const igv = Math.round(net * vatRateForCountry(country));
  return { net, igv, total: net + igv };
}

/** Siglas que se conservan en mayúsculas en `toTitleCase` (con o sin puntos). */
const TITLE_ACRONYMS = new Set(["SAC", "SA", "SRL", "EIRL", "SAA", "ID", "DNI"]);

/** Palabras que van en minúscula salvo al inicio (títulos en español). */
const TITLE_MINORS = new Set(["de", "del", "la", "el", "los", "las", "y", "e", "en", "con", "por", "para", "al", "a"]);

/**
 * Nombre propio en Title Case para presentar razones sociales.
 * "ESPECIALIDADES DIGITALES INTERNACIONALES S.A.C" →
 * "Especialidades Digitales Internacionales S.A.C".
 * Respeta siglas (S.A.C., SAC, ID) y minúsculas españolas (de, la, y…).
 * Solo presentación: en BD se guarda el nombre tal cual figura en el ID fiscal.
 */
export function toTitleCase(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const words = value.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (words.length === 0) return "—";
  return words
    .map((w, i) => {
      const bare = w.replace(/\./g, "").toUpperCase();
      if (TITLE_ACRONYMS.has(bare)) {
        // Con puntos se respeta la forma original (S.A.C.); sin puntos, upper.
        return w.includes(".") ? w.toUpperCase() : bare;
      }
      const lower = w.toLowerCase();
      if (i > 0 && TITLE_MINORS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/** Tiempo relativo corto (es) para feeds: "ahora mismo" · "hace N min/h" ·
 *  "hace N d" · "dd/mm". Inválido o futuro → "—" / "ahora mismo". */
export function formatTimeAgo(iso: string | null | undefined, tz: string, nowMs = Date.now()): string {
  if (typeof iso !== "string" || !iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const min = Math.floor(Math.max(0, nowMs - t) / 60_000);
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(min / 60 / 24);
  if (d < 7) return `hace ${d} d`;
  return formatDayMonth(dayOf(t, tz));
}

// ---------------- Fechas (SSOT display + parse/canon) ----------------
// Estilo único de fechas del sitio (ver encabezado: cero inlines fuera de
// aquí). Display "dd/mm/yyyy" ("03/11/2026"), con hora "dd/mm/yyyy hh:mm"
// en la zona del tenant ("03/11/2026 14:05"), corto "dd/mm" ("03/11"). Vacío/
// inválido → "—" (mismo vacío que números).
// Canon: la BD guarda INSTANTES en UTC. El día es texto "yyyy-mm-dd" (comparable con
// `<`) y existe solo en la zona IANA del tenant (`sys_store.timezone`): toda
// conversión instante↔día pasa por `dayOf/dayStart/todayIn(tz)` con la zona
// EXPLÍCITA (nunca una zona global). `DEFAULT_TIME_ZONE` solo siembra tiendas nuevas.

/** Locale de display. Solo `formatDateTime`/`displayEndOf` usan `Intl`;
 *  el resto se construye manual (dd/mm) para no depender del ICU. */
export const DATE_LOCALE = "es-PE";

/** Zona con la que nace un tenant nuevo (editable en Ajustes). NO es un fallback de runtime. */
export const DEFAULT_TIME_ZONE = "America/Lima";

/** Día en ms. Aritmética de calendario siempre en UTC (sin DST). */
export const DAY_MS = 86_400_000;

/** Etiquetas cortas de mes en español (tendencia 12m). */
export const MONTH_SHORT_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "2026-11-03" exacto (validación) y prefijo (display tolerante a ISO). */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})/;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Medianoche UTC del día de `t` (comparaciones día a día, jobs diarios). */
export function startOfDayUTC(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Primer día del mes (UTC) de `t` (ventanas mensuales). */
export function startOfMonthUTC(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** ¿Forma "yyyy-mm-dd"? (sin validar calendario: para revalidar en server). */
export function isISODateShape(v: unknown): boolean {
  return typeof v === "string" && ISO_DATE_RE.test(v);
}

/** ¿Día calendario real "yyyy-mm-dd"? Rechaza 2026-02-30 (sin rollover). */
export function isValidISODate(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = ISO_DATE_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Prefijo día "yyyy-mm-dd" de un ISO (fecha o timestamptz). null si no hay. */
export function isoDayPart(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const m = ISO_DATE_PREFIX_RE.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** "2026-11-03" → Date local sin desfase (para pickers). Con round-trip:
 *  rechaza 2026-02-30 (`new Date` hace rollover a 02-mar). */
export function parseISODate(v: unknown): Date | undefined {
  if (typeof v !== "string") return undefined;
  const m = ISO_DATE_RE.exec(v);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(y, mo - 1, d);
  if (Number.isNaN(dt.getTime())) return undefined;
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return undefined;
  return dt;
}

/** Date → "yyyy-mm-dd" en hora local (round-trip de pickers). */
export function toISODateLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Date → "yyyy-mm-dd" en UTC (canon para cómputo y sellos). */
export function toISODateUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Día 1 del mes (hora local) de `d`. Base segura para `addMonths`. */
export function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Suma N meses (sobre día 1 nunca hay rollover). */
export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
}

/** Clave de bucket mensual "2026-10" (hora local, como la UI). */
export function toMonthKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** Etiqueta corta de mes en español ("oct"). */
export function monthLabelES(d: Date): string {
  return MONTH_SHORT_ES[d.getMonth()] ?? "—";
}

/** "yyyy-mm-dd" → ordinal (UTC/DAY_MS) para aritmética de rangos. */
export function isoDayToNum(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** Ordinal → "yyyy-mm-dd". */
/** Día 1 del mes de `isoDay` desplazado `delta` meses ("2026-11-14", 1 → "2026-12-01"). Calendario puro, sin zonas. */
export function monthFirstISO(isoDay: string, delta = 0): string {
  const [y, m] = isoDay.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}-01`;
}
export function dayNumToISO(num: number): string {
  const d = new Date(num * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Suma N días a un "yyyy-mm-dd" (cruza mes/año). */
export function addDays(day: string, n: number): string {
  return dayNumToISO(isoDayToNum(day) + n);
}

/** Días inclusivos entre inicio y fin (null si incompleto o invertido).
 *  Acepta fecha o ISO (toma el prefijo): el fin exclusivo de BD
 *  ("…T00:00:00-05:00") cuenta igual que su día inclusivo. */
export function diffDaysInclusive(starts: unknown, ends: unknown): number | null {
  const a = typeof starts === "string" ? ISO_DATE_PREFIX_RE.exec(starts) : null;
  const b = typeof ends === "string" ? ISO_DATE_PREFIX_RE.exec(ends) : null;
  if (!a || !b) return null;
  const da = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const db = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  const n = Math.round((db - da) / DAY_MS) + 1;
  return n >= 1 ? n : null;
}

// ── Zona horaria por tenant (IANA) ─────────────────────────────────────────
const dayFmts = new Map<string, Intl.DateTimeFormat>();
const wallFmts = new Map<string, Intl.DateTimeFormat>();

/** ¿Nombre IANA que el runtime reconoce? ("America/Lima"). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length < 3 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function wallParts(tz: string, t: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  let f = wallFmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    wallFmts.set(tz, f);
  }
  const parts = f.formatToParts(new Date(t));
  const n = (type: string) => Number(parts.find((x) => x.type === type)?.value ?? NaN);
  return { y: n("year"), mo: n("month"), d: n("day"), h: n("hour"), mi: n("minute"), s: n("second") };
}

/** Desfase de `tz` respecto a UTC en el instante `t` (ms; incluye DST). */
function offsetMs(tz: string, t: number): number {
  const w = wallParts(tz, t);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
}

/** Día "yyyy-mm-dd" que `v` (instante) ocupa en la zona `tz`. */
export function dayOf(v: string | number | Date, tz: string): string {
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`Fecha inválida: ${String(v)}`);
  let f = dayFmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFmts.set(tz, f);
  }
  const parts = f.formatToParts(new Date(t));
  const n = (type: string) => parts.find((x) => x.type === type)?.value ?? "00";
  return `${n("year")}-${n("month")}-${n("day")}`;
}

/** Hoy en la zona `tz` como "yyyy-mm-dd". */
export function todayIn(tz: string, now: Date | number = new Date()): string {
  return dayOf(now, tz);
}

/** Inicio del día `day` en `tz` como instante (ms UTC). Respeta DST. */
export function dayStartMs(day: string, tz: string): number {
  const key = `${tz}|${day}`;
  const hit = dayStartCache.get(key);
  if (hit !== undefined) return hit;
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(tz, guess);
  const ms = guess - offsetMs(tz, first);
  // Cada cálculo son 2 `Intl.formatToParts` (~10 µs): los bucles por línea × día lo repetían millones de veces.
  // Función pura de (día, zona): memoizable; el tope evita crecer sin límite con fechas arbitrarias.
  if (dayStartCache.size >= 20_000) dayStartCache.clear();
  dayStartCache.set(key, ms);
  return ms;
}
const dayStartCache = new Map<string, number>();

/** Inicio del día `day` en `tz` como ISO UTC ("2026-11-03T05:00:00.000Z"): lo que va a la BD. */
export function dayStart(day: string, tz: string): string {
  return new Date(dayStartMs(day, tz)).toISOString();
}

/** "2026-11-03" → "03/11/2026"; un instante se convierte antes al día de `tz`. */
export function formatDate(v: unknown, tz: string): string {
  if (typeof v !== "string" || !v) return "—";
  if (ISO_DATE_RE.test(v)) return `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}`;
  if (!Number.isFinite(Date.parse(v))) return "—";
  const d = dayOf(v, tz);
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
}

const dateTimeFmts = new Map<string, Intl.DateTimeFormat>();

/** Instante → "03/11/2026 14:05" en `tz`. Fecha sola → solo fecha. */
export function formatDateTime(v: unknown, tz: string): string {
  if (typeof v !== "string" || !v) return "—";
  if (ISO_DATE_RE.test(v)) return formatDate(v, tz);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return "—";
  let f = dateTimeFmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat(DATE_LOCALE, { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    dateTimeFmts.set(tz, f);
  }
  return f.format(new Date(t)).replace(",", "");
}

/** Día/mes corto para vigencias ("2026-11-08" → "08/11"). Inválido → "—". */
export function formatDayMonth(iso: string | null | undefined): string {
  if (typeof iso !== "string") return "—";
  const m = ISO_DATE_PREFIX_RE.exec(iso);
  return m ? `${m[3]}/${m[2]}` : "—";
}

/** Fin exclusivo (instante) → último día inclusivo "yyyy-mm-dd" en `tz`: se resta 1 ms (nunca 24 h,
 *  que fallaría en días de DST). Falla cerrado (throw); el display usa `displayEndOfSafe`. */
export function displayEndOf(exclusiveIso: string, tz: string): string {
  const t = Date.parse(exclusiveIso);
  if (!Number.isFinite(t)) throw new Error(`Fecha inválida: ${exclusiveIso}`);
  return dayOf(t - 1, tz);
}

/** Contrato display de `displayEndOf`: null si no hay día válido
 *  (drawers/tablas), en vez de lanzar. */
export function displayEndOfSafe(v: unknown, tz: string): string | null {
  if (typeof v !== "string" || !v) return null;
  try {
    return displayEndOf(v, tz);
  } catch {
    return null;
  }
}

/** Valor de un control datetime-local, expresado en la zona explícita del tenant. */
export function toTenantDateTimeInput(instant: string | number, tz: string): string {
  const w = wallParts(tz, typeof instant === "number" ? instant : Date.parse(instant));
  return `${w.y}-${pad2(w.mo)}-${pad2(w.d)}T${pad2(w.h)}:${pad2(w.mi)}`;
}
/** Hora local del tenant → instante. Rechaza horas inexistentes o ambiguas por DST. */
export function fromTenantDateTimeInput(value: string, tz: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !isValidISODate(value.slice(0,10))) throw new Error("Fecha y hora inválidas.");
  const [day,clock] = value.split("T"), [y,m,d] = day.split("-").map(Number), [h,mi] = clock.split(":").map(Number);
  if(h>23||mi>59)throw new Error("Hora inválida.");
  const wall = Date.UTC(y,m-1,d,h,mi);
  const offsets = new Set([-86_400_000,0,86_400_000].map(delta=>offsetMs(tz,wall+delta)));
  const candidates = [...offsets].map(offset=>wall-offset).filter(t=>toTenantDateTimeInput(t,tz)===value);
  if(candidates.length!==1)throw new Error("Hora inexistente o ambigua por cambio horario: elige otra hora.");
  return new Date(candidates[0]).toISOString();
}
