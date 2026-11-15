"use server";

import { revalidatePath } from "next/cache";
import * as inv from "@/lib/screens-store";
import { getCompany } from "@/lib/crm-store";
import { resolveTenantStoreAction as resolveTenantStore } from "@/lib/tenant";
import { createLogger } from "@/lib/log";

const log = createLogger("screens");

export interface ScreensState {
  ok: boolean;
  message: string;
}

// SSOT: resolveTenantStore = resolveTenantStoreAction (ver lib/tenant.ts).

function cleanStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  if (!s) return null;
  if (s.length > max) return null;
  return s;
}

/** Coordenada opcional dentro de rango. null = vacío. undefined = inválida. */
function optCoordinate(raw: unknown, min: number, max: number): number | null | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

/** Entero positivo opcional (medidas px). null = vacío. undefined = inválido. */
function optPositiveInt(raw: unknown): number | null | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  return n;
}

/** Medida opcional en metros (decimales con . o ,). null = vacío. undefined = inválida. */
function optPositiveMeters(raw: unknown): number | null | undefined {
  const s = String(raw ?? "").trim().replace(",", ".");
  if (!s) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) return undefined;
  return Math.round(n * 100) / 100;
}

/** Precio opcional en PEN (entero ≥ 0). null = vacío. undefined = inválido. */
function optPrice(raw: unknown): number | null | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0) return undefined;
  return n;
}

export async function createScreenAction(form: FormData): Promise<ScreensState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const { denyRole } = await import("@/lib/tenant");
  const denied = await denyRole(t.storeId, "seller");
  if (denied) return { ok: false, message: denied };

  const name = cleanStr(form.get("name"), 200);
  if (!name) return { ok: false, message: "Nombre de pantalla requerido (máx 200)." };

  const modalityRaw = String(form.get("modality") ?? "").trim().toLowerCase();
  const modality = modalityRaw === "static" ? "static" : "digital";
  const isStatic = modality === "static";

  const width = optPositiveMeters(form.get("width_m"));
  if (width === undefined) return { ok: false, message: "Medida inválida: ancho en metros (> 0)." };
  const height = optPositiveMeters(form.get("height_m"));
  if (height === undefined) return { ok: false, message: "Medida inválida: alto en metros (> 0)." };
  const widthPx = isStatic ? null : optPositiveInt(form.get("width_px"));
  if (widthPx === undefined) return { ok: false, message: "Resolución inválida: ancho en px (entero > 0)." };
  const heightPx = isStatic ? null : optPositiveInt(form.get("height_px"));
  if (heightPx === undefined) return { ok: false, message: "Resolución inválida: alto en px (entero > 0)." };
  const oW = width ?? widthPx;
  const oH = height ?? heightPx;
  const orientation =
    oW !== null && oH !== null
      ? oW > oH
        ? "landscape"
        : oW < oH
          ? "portrait"
          : "square"
      : null;

  // Impresa: sin pauta ni resolución (se fuerzan a null aunque vengan datos).
  // Tecnología solo aplica a video (digital); en impresa va null.
  const technologyRaw = String(form.get("technology") ?? "").trim().toUpperCase();
  const technology = isStatic
    ? null
    : technologyRaw === "" || technologyRaw === "__NONE"
      ? null
      : technologyRaw;
  if (technology !== null && !["LED", "LCD", "OLED"].includes(technology)) {
    return { ok: false, message: "Tecnología inválida: LED, LCD u OLED." };
  }
  const price = optPrice(form.get("price_pen"));
  if (price === undefined) return { ok: false, message: "Precio inválido (entero ≥ 0)." };
  const duration = isStatic ? null : optPositiveInt(form.get("duration_sec"));
  if (duration === undefined) return { ok: false, message: "Duración inválida: segundos del spot (entero > 0)." };
  const plays = isStatic ? null : optPositiveInt(form.get("plays_per_day"));
  if (plays === undefined) return { ok: false, message: "Reproducciones inválidas: cantidad por día (entero > 0)." };
  const impact = optPositiveInt(form.get("impact_day"));
  if (impact === undefined) return { ok: false, message: "Impactos inválidos: cantidad por día (entero > 0)." };

  const supplierRaw = String(form.get("supplier_id") ?? "").trim();
  const supplierId = supplierRaw === "" || supplierRaw === "__none" ? null : supplierRaw;
  const ownership = String(form.get("ownership") ?? "");
  if (ownership !== "own" && ownership !== "supplier") return { ok: false, message: "Define la propiedad de la pantalla." };
  if (ownership === "own" && supplierId) return { ok: false, message: "Una pantalla propia no lleva proveedor." };
  if (ownership === "supplier" && !supplierId) return { ok: false, message: "Selecciona un proveedor para inventario externo." };

  try {
    if (supplierId) {
      const supplier = await getCompany(t.storeId, supplierId);
      if (!supplier || supplier.kind !== "proveedor" || supplier.deleted_at) return { ok: false, message: "Proveedor activo no encontrado en esta tienda." };
    }

    // Patrón de datos: 1 pantalla = 1 ubicación propia (el lado B es otra
    // pantalla con su propia ubicación). El nombre se compone desde
    // dirección + distrito + ciudad + país (no se pide aparte).
    const venueAddress = cleanStr(form.get("venue_address"), 300);
    if (!venueAddress) return { ok: false, message: "Dirección requerida (p. ej. Av. Pardo 793)." };
    const venueCity = cleanStr(form.get("venue_city"), 120);
    if (form.get("venue_city") && !venueCity) {
      return { ok: false, message: "Ciudad de la ubicación muy larga (máx 120)." };
    }
    const venueDistrict = cleanStr(form.get("venue_district"), 120);
    if (form.get("venue_district") && !venueDistrict) {
      return { ok: false, message: "Distrito de la ubicación muy largo (máx 120)." };
    }
    const venueLat = optCoordinate(form.get("venue_latitude"), -90, 90);
    if (venueLat === undefined) return { ok: false, message: "Latitud inválida (-90…90)." };
    const venueLng = optCoordinate(form.get("venue_longitude"), -180, 180);
    if (venueLng === undefined) return { ok: false, message: "Longitud inválida (-180…180)." };
    const venueCountryRaw = String(form.get("venue_country") ?? "").trim().toUpperCase();
    const venueCountry =
      venueCountryRaw === "" || venueCountryRaw === "__NONE" ? null : venueCountryRaw;
    if (venueCountry !== null && !/^[A-Z]{2}$/.test(venueCountry)) {
      return { ok: false, message: "País de la ubicación inválido (ISO2, p. ej. PE)." };
    }
    const { COUNTRIES } = await import("@/lib/countries");
    const countryName = venueCountry
      ? (COUNTRIES.find((c) => c.code === venueCountry)?.name ?? venueCountry)
      : null;
    const venueName = [venueAddress, venueDistrict, venueCity, countryName]
      .filter((x): x is string => typeof x === "string" && x.trim() !== "")
      .join(", ")
      .slice(0, 200);
    // Ubicación + pantalla en una sola transacción (antes: dos inserts sueltos).
    const screenId = await inv.createScreenWithVenue(
      t.storeId,
      {
        name: venueName,
        city: venueCity,
        district: venueDistrict,
        address: venueAddress,
        latitude: venueLat,
        longitude: venueLng,
        country: venueCountry,
        ownership,
        supplier_company_id: supplierId,
      },
      {
        name,
        width_m: width,
        height_m: height,
        width_px: widthPx,
        height_px: heightPx,
        orientation,
        modality,
        technology,
        ownership,
        supplier_company_id: supplierId,
        price_pen: price,
        duration_sec: duration,
        plays_per_day: plays,
        impact_day: impact,
        is_active: true,
        source: "manual",
        enrichment_status: "pending",
      },
    );
    // Enriquecimiento geoespacial + comercial best-effort (no bloquea la
    // creación): Mapbox → métricas → tags/narrativa/embedding.
    // `after()` lo agenda tras la respuesta; sin él, fire-and-forget.
    try {
      const { after } = await import("next/server");
      after(async () => {
        const { enrichScreen } = await import("@/lib/screens-enrich");
        await enrichScreen(t.storeId, screenId);
      });
    } catch {
      const { enrichScreen } = await import("@/lib/screens-enrich");
      void enrichScreen(t.storeId, screenId);
    }
    revalidatePath("/screens");
    return { ok: true, message: "Generando información inteligente en segundo plano (zona, tráfico y narrativa)." };
  } catch (e) {
    log.error("createScreenAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Edición inline de pauta en la ficha (drawer): duración del spot y
 *  reproducciones por día. Requiere rol vendedor o superior. */
export async function updateScreenPlaybackAction(input: {
  screenId: string;
  duration_sec: number | null;
  plays_per_day: number | null;
  impact_day: number | null;
}): Promise<ScreensState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const { denyRole } = await import("@/lib/tenant");
  const denied = await denyRole(t.storeId, "seller");
  if (denied) return { ok: false, message: denied };
  const screenId = String(input.screenId ?? "").trim();
  if (!screenId) return { ok: false, message: "Falta la pantalla." };
  const { duration_sec, plays_per_day, impact_day } = input;
  if (duration_sec !== null && (!Number.isSafeInteger(duration_sec) || duration_sec <= 0)) {
    return { ok: false, message: "Duración inválida: segundos del spot (entero > 0)." };
  }
  if (plays_per_day !== null && (!Number.isSafeInteger(plays_per_day) || plays_per_day <= 0)) {
    return { ok: false, message: "Reproducciones inválidas: cantidad por día (entero > 0)." };
  }
  if (impact_day !== null && (!Number.isSafeInteger(impact_day) || impact_day <= 0)) {
    return { ok: false, message: "Impactos inválidos: cantidad por día (entero > 0)." };
  }
  try {
    const cur = await inv.getScreenState(t.storeId, screenId);
    if (!cur) return { ok: false, message: "Pantalla no encontrada en esta tienda." };
    if (cur.enrichment_status === "pending") {
      return { ok: false, message: "Generando información inteligente, espera unos segundos e inténtalo de nuevo." };
    }
    await inv.patchScreen(t.storeId, screenId, { duration_sec, plays_per_day, impact_day });
    revalidatePath("/screens");
    return { ok: true, message: "Pauta actualizada." };
  } catch (e) {
    log.error("updateScreenPlaybackAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

export async function createScreenSubmitAction(_prev: ScreensState, form: FormData): Promise<ScreensState> {
  return createScreenAction(form);
}

/** Elimina una pantalla y su ubicación propia (1:1). Solo owner.
 *  Bloqueado si tiene historia comercial (líneas de orden o reservas):
 *  RESTRICT en BD. */
export async function deleteScreenAction(input: { screenId: string }): Promise<ScreensState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const { denyRole } = await import("@/lib/tenant");
  const denied = await denyRole(t.storeId, "owner", "Solo el propietario puede eliminar pantallas.");
  if (denied) return { ok: false, message: denied };
  const screenId = String(input.screenId ?? "").trim();
  if (!screenId) return { ok: false, message: "Falta la pantalla." };
  try {
    if (!(await inv.getScreenState(t.storeId, screenId))) return { ok: false, message: "Pantalla no encontrada en esta tienda." };
    // Historia comercial: la DB también lo impide (REFERENCE … ON DELETE REJECT en io_line.screen);
    // este chequeo da el mensaje claro antes de intentar.
    const history = await inv.screenHistory(t.storeId, screenId);
    if (history.lines > 0) {
      return { ok: false, message: `No se puede eliminar: tiene ${history.lines} línea(s) en órdenes.` };
    }
    if (history.bookings > 0) {
      return { ok: false, message: `No se puede eliminar: tiene ${history.bookings} reserva(s).` };
    }
    // La ubicación propia se elimina con la pantalla si ninguna otra la usa (transacción).
    await inv.deleteScreenAndOrphanVenue(t.storeId, screenId);
    revalidatePath("/screens");
    return { ok: true, message: "Pantalla eliminada." };
  } catch (e) {
    log.error("deleteScreenAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Activa/desactiva una pantalla (alternativa a eliminar cuando tiene
 *  historia comercial). Requiere rol vendedor o superior. */
export async function setScreenActiveAction(input: {
  screenId: string;
  isActive: boolean;
}): Promise<ScreensState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const { denyRole } = await import("@/lib/tenant");
  const denied = await denyRole(t.storeId, "seller");
  if (denied) return { ok: false, message: denied };
  const screenId = String(input.screenId ?? "").trim();
  if (!screenId) return { ok: false, message: "Falta la pantalla." };
  try {
    const cur = await inv.getScreenState(t.storeId, screenId);
    if (!cur) return { ok: false, message: "Pantalla no encontrada en esta tienda." };
    if (cur.enrichment_status === "pending") {
      return { ok: false, message: "Generando información inteligente, espera unos segundos e inténtalo de nuevo." };
    }
    await inv.patchScreen(t.storeId, screenId, { is_active: input.isActive });
    revalidatePath("/screens");
    return { ok: true, message: input.isActive ? "Pantalla habilitada." : "Pantalla deshabilitada." };
  } catch (e) {
    log.error("setScreenActiveAction", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}
