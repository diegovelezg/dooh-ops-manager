import { workflowRows } from "@/lib/order-workflow-reads";
import { AUTHORIZATION_LABELS, authorizationKind, isAuthorized, materialsCovered, deliveriesCovered, supplierConfirmed, consumesCapacity } from "@/lib/order-workflow";
// Dashboard Hoy v1 — solo desde la OI (sin facturación).
// Fuente: io_orders + lines + io_agency_orders + creatives + io_photo_checks.
// Sin prorrateo inventado más allá de lineal por tiempo solapado; sin
// impresiones/GRP (io_play_logs del CMS vive fuera).
// El snapshot alimenta dos superficies con propósitos distintos, sin
// redundancia: la página Hoy pinta solo KPIs de negocio (comprometido con
// delta, cobranza con delta, ocupación, al aire con delta, relevo, huecos);
// los bloqueos (alerts) y por_certificar viven solo en el Inbox vía
// buildBriefFacts.
import { orderStage, orderTiming } from "@/lib/order-stage";
import { getStore } from "@/lib/stores-db";
import { countOrders, listChildrenOf, selectInvoices, selectOrders } from "@/lib/orders-store";
import { listCompanies } from "@/lib/crm-store";
import { countScreens, listScreensBrief } from "@/lib/screens-store";
import { normalizeCurrency } from "@/lib/currency";
import { aggregateCobranza, toBillingInvoice, type BillingInvoice, type CobranzaTotals } from "@/lib/billing-status";
import { addDays, DAY_MS, dayStartMs, isoDayPart, isoDayToNum, monthFirstISO, todayIn } from "@/lib/format";
import { getStoreTimeZone } from "@/lib/stores-db";
import { getScreenCapacities } from "@/lib/availability";
import { DEFAULT_SLOTS_PER_SCREEN } from "@/lib/store-slots";

export type AlertKind = "sin_om" | "material" | "sin_evidencia" | "termina_sin_relevo";

export interface DashboardAlert {
  kind: AlertKind;
  ioId: string;
  ioNumber: string;
  brand: string | null;
  company: string | null;
  detail: string;
  startsAt: string | null;
  endsAt: string | null;
}

export interface Hueco {
  screenId: string;
  screenName: string;
  /** Días totalmente libres en la ventana (sin slots vendidos). */
  diasLibres: number;
  /** Slots-día libres en la ventana (capacidad − vendidos). */
  slotsLibres: number;
}

export interface CurrencyTotals {
  comprometidoMesMinor: number;
  firmadoMesMinor: number;
  draftMesMinor: number;
}

export interface DashboardSnapshot {
  currency: string;
  comprometidoMesMinor: number;
  firmadoMesMinor: number;
  draftMesMinor: number;
  /** Totales por moneda de IO (nunca sumar mixto). */
  byCurrency: Record<string, CurrencyTotals>;
  /** Cartera abierta (facturas emitidas no anuladas/borrador). */
  cobranza: CobranzaTotals;
  /** Cobranza por moneda de factura (nunca sumar mixto). */
  cobranzaByCurrency: Record<string, CobranzaTotals>;
  /** Cobranza por moneda de factura (nunca sumar mixto). */
  /** Variación en puntos (base 100, como MetricDelta) vs periodo previo.
   *  null = sin base. Deltas honestos: se calculan con la data actual,
   *  sin historia almacenada. */
  deltas: {
    /** Comprometido mes actual vs mes anterior (moneda de la tienda). */
    comprometido: number | null;
    /** Pendiente de cobro (cartera) vs cierre del mes anterior
     *  (bajar es bueno: la UI lo muestra invertido). */
    cobranzaPendiente: number | null;
    /** OIs al aire hoy vs ayer. */
    alAireOis: number | null;
  };
  /** Bases de comparación de los deltas (misma moneda/unidad que el KPI). */
  prev: { comprometidoMinor: number; cobranzaPendingMinor: number; alAireOis: number };
  ocupacion14d: { ratio: number | null; slotsVendidos: number; slotsDisponibles: number };
  alAire: { ois: number; pantallas: number };
  porCertificar: number;
  renovacion30d: { conRelevo: number; total: number; ratio: number | null };
  alerts: DashboardAlert[];
  huecos: Hueco[];
  counts: { ois: number; screens: number; truncated: boolean };
  /** true si alguna fuente se truncó por límite (muestra parcial, no total exacto). */
  truncated: boolean;
}

// SSOT: primitivos de fecha en lib/format.ts.

function parseMs(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function fmtCorta(v: string | null): string {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null;
  return m ? `${m[3]}/${m[2]}` : "—";
}

/** Día ISO del tenant → número de día (comparable entre sí; fechas de cabecera son días inclusivos del tenant). */
function dayNumOf(v: unknown): number | null {
  const d = isoDayPart(v);
  return d ? isoDayToNum(d) : null;
}

/** Agrupa por orden en un solo recorrido (evita `filter` por orden: O(órdenes × filas)). */
function groupByIo<T extends Record<string, unknown>>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = String(r.io_id);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export async function getDashboardSnapshot(storeId: string): Promise<DashboardSnapshot> {
  const now = Date.now();
  // Todo el tablero opera en días del TENANT (`sys_store.timezone`), igual que la capacidad y las líneas
  // (guardadas como instantes UTC): un día/mes en UTC recortaría o desplazaría horas de cada línea.
  const tz = await getStoreTimeZone(storeId);
  const todayISO = todayIn(tz, now);
  const todayNum = isoDayToNum(todayISO);
  const today00 = dayStartMs(todayISO, tz);

  const [store, screens, screensTotal, ois, oisTotal, invoices] = await Promise.all([
    getStore(storeId),
    listScreensBrief(storeId, { activeOnly: true, limit: 500 }),
    countScreens(storeId, { activeOnly: true }),
    selectOrders(storeId, { live: true, order: "starts_asc" }),
    countOrders(storeId, { live: true }),
    selectInvoices(storeId),
  ]);
  const truncated = (screensTotal ?? 0) > 500 || (oisTotal ?? 0) > 500;

  const currency = normalizeCurrency(store?.shop_currency ?? "PEN");
  const screenRows = ((screens ?? []) as Array<Record<string, unknown>>).map((s) => ({
    id: String(s.id),
    name: String(s.name ?? "—"),
  }));
  const oiRows = ois.map((o) => ({
    ...o,
    id: String(o.id),
    io_number: String(o.io_number ?? "—"),
    brand: (o.brand as string | null) ?? null,
    status: String(o.status ?? ""),
    created_at: (o.created_at as string | null) ?? null,
    starts_at: (o.starts_at as string | null) ?? null,
    ends_at: (o.ends_at as string | null) ?? null,
    currency: normalizeCurrency(o.currency, currency),
    key: String(o.advertiser_company_id ?? o.billing_company_id ?? ""),
    advertiser_id: (o.advertiser_company_id as string | null) ?? null,
    billing_id: (o.billing_company_id as string | null) ?? null,
  }));
  const oiIds = oiRows.map((o) => o.id);

  let lineRows: Array<{
    io_id: string;
    screen_id: string;
    rate_minor: number;
    cant_slots: number;
    starts_at: string;
    ends_at: string;
    starts_ms: number | null;
    ends_ms: number | null;
  }> = [];
  const omBy = new Set<string>();
  const creaBy = new Map<string, { any: boolean; pending: boolean }>();
  const photoBy = new Set<string>();
  let nameBy = new Map<string, string>();

  if (oiIds.length > 0) {
    const { lines, oms, creatives: creas, photos } = await listChildrenOf(storeId, oiIds);
    lineRows = lines.map((l) => ({
      io_id: String(l.io_id),
      screen_id: String(l.screen_id),
      rate_minor: Number(l.rate_minor ?? 0),
      cant_slots: (() => {
        const n = Number(l.cant_slots ?? 1);
        return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
      })(),
      starts_at: String(l.starts_at),
      ends_at: String(l.ends_at),
      starts_ms: parseMs(l.starts_at),
      ends_ms: parseMs(l.ends_at),
    }));
    const workflow = await workflowRows(storeId, oiIds);
    const linesOf = groupByIo(lines), omsOf = groupByIo(oms), creasOf = groupByIo(creas);
    for (const o of oiRows) {
      const ownLines = linesOf.get(o.id) ?? [];
      if (isAuthorized(o, omsOf.get(o.id) ?? [])) omBy.add(o.id);
      const ready = materialsCovered(ownLines, creasOf.get(o.id) ?? []) && ownLines.every(l => supplierConfirmed(l, workflow.purchases));
      creaBy.set(o.id, { any: ready, pending: !ready });
      if (deliveriesCovered(ownLines, workflow.deliveries, photos)) photoBy.add(o.id);
    }
    const coIds = [...new Set(oiRows.flatMap((o) => [o.advertiser_id, o.billing_id]).filter(Boolean))] as string[];
    if (coIds.length > 0) {
      const cos = await listCompanies(storeId, coIds);
      nameBy = new Map(
        cos.map((c) => [
          String(c.id),
          String(c.name ?? "—"),
        ]),
      );
    }
  }

  const oiById = new Map(oiRows.map((o) => [o.id, o]));
  const companyOf = (o: (typeof oiRows)[number]): string | null => {
    const id = o.advertiser_id ?? o.billing_id;
    return id ? (nameBy.get(id) ?? null) : null;
  };
  const materialsOk = (ioId: string): boolean => {
    const c = creaBy.get(ioId);
    return Boolean(c?.any && !c.pending);
  };

  // 1. Comprometido mes (prorrateo lineal por tiempo solapado, por moneda)
  // + base mes anterior para el delta (mismo método, ventana previa).
  const monthStart = dayStartMs(monthFirstISO(todayISO, 0), tz);
  const monthEnd = dayStartMs(monthFirstISO(todayISO, 1), tz);
  const prevStart = dayStartMs(monthFirstISO(todayISO, -1), tz);
  let comprometido = 0;
  let firmado = 0;
  let draft = 0;
  let prevComprometido = 0;
  const byCurrency: Record<string, CurrencyTotals> = {};
  const bump = (cur: string, part: number, signed: boolean) => {
    const c = normalizeCurrency(cur, currency);
    const t = (byCurrency[c] ??= { comprometidoMesMinor: 0, firmadoMesMinor: 0, draftMesMinor: 0 });
    // Comprometido = solo firmado (el draft va aparte en draftMesMinor, no infla KPI).
    if (signed) t.firmadoMesMinor += part;
    else t.draftMesMinor += part;
    t.comprometidoMesMinor = t.firmadoMesMinor;
    if (c === currency) {
      if (signed) {
        comprometido += part;
        firmado += part;
      } else draft += part;
    }
  };
  for (const l of lineRows) {
    if (l.starts_ms === null || l.ends_ms === null || l.ends_ms <= l.starts_ms) continue;
    if (!(l.rate_minor > 0)) continue;
    const io = oiById.get(l.io_id);
    const st = io?.status;
    const overlap = Math.max(0, Math.min(l.ends_ms, monthEnd) - Math.max(l.starts_ms, monthStart));
    if (overlap > 0) {
      const part = (overlap / (l.ends_ms - l.starts_ms)) * l.rate_minor;
      bump(io?.currency ?? currency, part, st === "signed");
    }
    // Delta honesto con la data actual (sin historia almacenada): misma
    // fórmula sobre el mes previo. Solo moneda de la tienda.
    const overlapPrev = Math.max(0, Math.min(l.ends_ms, monthStart) - Math.max(l.starts_ms, prevStart));
    if (overlapPrev > 0 && st === "signed" && normalizeCurrency(io?.currency, currency) === currency) {
      prevComprometido += (overlapPrev / (l.ends_ms - l.starts_ms)) * l.rate_minor;
    }
  }

  // 1b. Cobranza: cartera abierta (emitidas no anuladas/borrador con
  // issue_date <= corte). Sin due_date no se presume vencido (los términos
  // viven en la orden). Base del delta: misma cartera al cierre del mes
  // anterior (issue_date < monthStart, corte = monthStart).
  const issuedBy = (iso: unknown): number | null => {
    const day = isoDayPart(iso);
    return day ? dayStartMs(day, tz) : null;
  };
  const invRows = ((invoices ?? []) as Array<Record<string, unknown>>).map((v) => ({
    inv: toBillingInvoice(v),
    currency: normalizeCurrency(v.currency, currency),
  }));
  const curGroups = new Map<string, BillingInvoice[]>();
  const prevGroups = new Map<string, BillingInvoice[]>();
  for (const v of invRows) {
    const issued = issuedBy(v.inv.issue_date);
    if (issued === null) continue;
    if (issued <= Math.min(now, monthEnd)) {
      const g = curGroups.get(v.currency) ?? [];
      g.push(v.inv);
      curGroups.set(v.currency, g);
    }
    if (issued < monthStart) {
      const g = prevGroups.get(v.currency) ?? [];
      g.push(v.inv);
      prevGroups.set(v.currency, g);
    }
  }
  const cobranzaByCurrency: Record<string, CobranzaTotals> = {};
  for (const [c, list] of curGroups) cobranzaByCurrency[c] = aggregateCobranza(list, Math.min(now, monthEnd), tz);
  const prevByCurrency: Record<string, CobranzaTotals> = {};
  // Corte al cierre del mes anterior: lo vencido después no contaba aún.
  for (const [c, list] of prevGroups) prevByCurrency[c] = aggregateCobranza(list, monthStart, tz);

  // 2. Ocupación 14d en slots-día (capacidad por pantalla × ventana).
  // Pondera cada línea por su cant_slots; la capacidad es slots propios
  // activos o el default del tenant (SSOT lib/availability).
  // Misma vigencia que la matriz: excluye borradores vencidos (el hold aparta
  // reservas explícitas vigentes); bookings no entran al KPI (ver matriz).
  const WIN = 14;
  const winEnd = dayStartMs(addDays(todayISO, WIN), tz);
  // Sin red de seguridad: si la capacidad falla, el tablero falla (nunca un 10 inventado en silencio).
  const capacities = await getScreenCapacities(storeId, screenRows.map((s) => s.id));
  const capOf = (id: string): number => capacities.get(id) ?? DEFAULT_SLOTS_PER_SCREEN;
  // Solo pantallas activas: numerador y denominador sobre el mismo universo (nunca > 100%).
  const activeScreens = new Set(screenRows.map((s) => s.id));
  const perScreen = new Map<string, Set<number>>();
  const soldByScreen = new Map<string, number>();
  for (const l of lineRows) {
    if (l.starts_ms === null || l.ends_ms === null || l.ends_ms <= l.starts_ms) continue;
    if (!activeScreens.has(l.screen_id)) continue;
    const io = oiById.get(l.io_id);
    if (!io || !consumesCapacity(io, now)) continue;
    const s = Math.max(l.starts_ms, today00);
    const e = Math.min(l.ends_ms, winEnd);
    if (e <= s) continue;
    for (let d = 0; d < WIN; d++) {
      const dayFrom = dayStartMs(addDays(todayISO, d), tz);
      const dayEnd = dayStartMs(addDays(todayISO, d + 1), tz);
      if (s < dayEnd && dayFrom < e) {
        let set = perScreen.get(l.screen_id);
        if (!set) {
          set = new Set();
          perScreen.set(l.screen_id, set);
        }
        set.add(d);
        soldByScreen.set(l.screen_id, (soldByScreen.get(l.screen_id) ?? 0) + l.cant_slots);
      }
    }
  }
  let slotsDisponibles = 0;
  for (const s of screenRows) slotsDisponibles += capOf(s.id) * WIN;
  let slotsVendidos = 0;
  for (const v of soldByScreen.values()) slotsVendidos += v;
  const ocupacionRatio = slotsDisponibles > 0 ? slotsVendidos / slotsDisponibles : null;

  // 3. Al aire hoy (y ayer, para el delta; misma data, corte distinto).
  const stageAt = (o: (typeof oiRows)[number], ref: number) => orderStage({
    status: o.status, signed: o.status === "signed", hasOm: omBy.has(o.id),
    materialsOk: materialsOk(o.id), certified: photoBy.has(o.id),
    ...orderTiming(o, lineRowsOf.get(o.id) ?? [], ref, tz),
  }).stage;
  const lineRowsOf = groupByIo(lineRows);
  const alAireAt = (ref: number): typeof oiRows => oiRows.filter((o) => stageAt(o, ref) === "al_aire");
  const alAireOis = alAireAt(now);
  const prevAlAireOis = alAireAt(now - DAY_MS).length;
  const alAireIds = new Set(alAireOis.map((o) => o.id));
  const alAireScreens = new Set(lineRows.filter((l) =>
    alAireIds.has(l.io_id) && l.starts_ms !== null && l.ends_ms !== null
    && l.starts_ms <= now && now < l.ends_ms,
  ).map((l) => l.screen_id));
  const porCertificar = oiRows.filter((o) => stageAt(o, now) === "por_certificar").length;

  // 5. Renovación 30d por anunciante (advertiser ?? billing): órdenes FIRMADAS que terminan en
  // los próximos 30 días (un borrador aún no vendido no "vence"); el relevo puede ser cualquier
  // orden vigente (también borrador) del mismo anunciante que empiece después del fin.
  const in30 = oiRows.filter((o) => {
    const e = dayNumOf(o.ends_at);
    return o.status === "signed" && e !== null && e >= todayNum && e <= todayNum + 30;
  });
  const hasRelevo = (o: (typeof oiRows)[number]): boolean => {
    if (!o.key) return false;
    const e = dayNumOf(o.ends_at);
    if (e === null) return false;
    return oiRows.some((other) => {
      if (other.id === o.id || !other.key || other.key !== o.key) return false;
      const s2 = dayNumOf(other.starts_at);
      return s2 !== null && s2 > e;
    });
  };
  const conRelevo = in30.filter(hasRelevo).length;

  // Días calendario del tenant entre hoy y una fecha de cabecera (inclusiva).
  const daysUntil = (iso: string | null): number | null => {
    const d = dayNumOf(iso);
    return d === null ? null : d - todayNum;
  };
  const daysSinceStart = (iso: string | null): number | null => {
    const d = dayNumOf(iso);
    return d === null ? null : todayNum - d;
  };

  const alerts: DashboardAlert[] = [];
  for (const o of oiRows) {
    const du = daysUntil(o.starts_at);
    const ds = daysSinceStart(o.starts_at);
    const co = companyOf(o);
    const doc = authorizationKind(o);
    const docLabel = doc ? AUTHORIZATION_LABELS[doc] : "autorización comercial";
    if (o.status === "signed" && !omBy.has(o.id) && du !== null && du <= 7) {
      alerts.push({
        kind: "sin_om",
        ioId: o.id,
        ioNumber: o.io_number,
        brand: o.brand,
        company: co,
        detail:
          du < 0
            ? `Empezó hace ${Math.abs(du)}d y sigue sin ${docLabel} de la versión vigente.`
            : du === 0
              ? `Empieza hoy y falta ${docLabel} de la versión vigente.`
              : `Empieza en ${du}d y falta ${docLabel} de la versión vigente.`,
        startsAt: o.starts_at,
        endsAt: o.ends_at,
      });
    }
    const ended = orderTiming(o, lineRowsOf.get(o.id) ?? [], now, tz).ended;
    if (o.status === "signed" && !materialsOk(o.id) && !ended && du !== null && du <= 5) {
      alerts.push({
        kind: "material",
        ioId: o.id,
        ioNumber: o.io_number,
        brand: o.brand,
        company: co,
        detail:
          du < 0
            ? `Salida atrasada: sin materiales aprobados o compra externa confirmada.`
            : `Empieza en ${du}d sin materiales aprobados o compra externa confirmada.`,
        startsAt: o.starts_at,
        endsAt: o.ends_at,
      });
    }
    const alAire = alAireIds.has(o.id);
    if (alAire && !photoBy.has(o.id) && ds !== null && ds >= 3) {
      alerts.push({
        kind: "sin_evidencia",
        ioId: o.id,
        ioNumber: o.io_number,
        brand: o.brand,
        company: co,
        detail: `Al aire hace ${ds}d sin foto-check — riesgo de disputa al cobrar.`,
        startsAt: o.starts_at,
        endsAt: o.ends_at,
      });
    }
    const due = daysUntil(o.ends_at);
    if (o.status === "signed" && due !== null && due >= 0 && due <= 7 && !hasRelevo(o)) {
      alerts.push({
        kind: "termina_sin_relevo",
        ioId: o.id,
        ioNumber: o.io_number,
        brand: o.brand,
        company: co,
        detail: `Termina ${fmtCorta(o.ends_at)} sin relevo del mismo anunciante.`,
        startsAt: o.starts_at,
        endsAt: o.ends_at,
      });
    }
  }
  const KIND_ORDER: Record<AlertKind, number> = {
    sin_om: 0,
    material: 1,
    sin_evidencia: 2,
    termina_sin_relevo: 3,
  };
  alerts.sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || String(a.startsAt).localeCompare(String(b.startsAt)),
  );

  const huecos: Hueco[] = screenRows
    .map((s) => {
      const cap = capOf(s.id);
      const sold = soldByScreen.get(s.id) ?? 0;
      return {
        screenId: s.id,
        screenName: s.name,
        diasLibres: WIN - (perScreen.get(s.id)?.size ?? 0),
        slotsLibres: cap * WIN - sold,
      };
    })
    .sort((a, b) => b.slotsLibres - a.slotsLibres)
    .slice(0, 5);

  for (const k of Object.keys(byCurrency)) {
    byCurrency[k] = {
      comprometidoMesMinor: Math.round(byCurrency[k].comprometidoMesMinor),
      firmadoMesMinor: Math.round(byCurrency[k].firmadoMesMinor),
      draftMesMinor: Math.round(byCurrency[k].draftMesMinor),
    };
  }
  for (const k of Object.keys(cobranzaByCurrency)) {
    const t = cobranzaByCurrency[k];
    cobranzaByCurrency[k] = {
      invoicedMinor: Math.round(t.invoicedMinor),
      paidMinor: Math.round(t.paidMinor),
      pendingMinor: Math.round(t.pendingMinor),
      overdueMinor: Math.round(t.overdueMinor),
    };
  }
  const cobranza = cobranzaByCurrency[currency] ?? { invoicedMinor: 0, paidMinor: 0, pendingMinor: 0, overdueMinor: 0 };
  const prevCobranzaPending = Math.round(prevByCurrency[currency]?.pendingMinor ?? 0);
  prevComprometido = Math.round(prevComprometido);

  /** Variación en puntos (base 100); null = sin base previa (mes anterior en 0). */
  const pct = (cur: number, prev: number): number | null =>
    prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? null : 0;

  return {
    currency,
    comprometidoMesMinor: Math.round(comprometido),
    firmadoMesMinor: Math.round(firmado),
    draftMesMinor: Math.round(draft),
    byCurrency,
    cobranza,
    cobranzaByCurrency,
    deltas: {
      comprometido: pct(Math.round(comprometido), prevComprometido),
      cobranzaPendiente: pct(cobranza.pendingMinor, prevCobranzaPending),
      alAireOis: pct(alAireOis.length, prevAlAireOis),
    },
    prev: {
      comprometidoMinor: prevComprometido,
      cobranzaPendingMinor: prevCobranzaPending,
      alAireOis: prevAlAireOis,
    },
    ocupacion14d: { ratio: ocupacionRatio, slotsVendidos, slotsDisponibles },
    alAire: { ois: alAireOis.length, pantallas: alAireScreens.size },
    porCertificar,
    renovacion30d: {
      conRelevo,
      total: in30.length,
      ratio: in30.length > 0 ? conRelevo / in30.length : null,
    },
    alerts: alerts.slice(0, 20),
    huecos,
    counts: { ois: oiRows.length, screens: screenRows.length, truncated },
    truncated,
  };
}
