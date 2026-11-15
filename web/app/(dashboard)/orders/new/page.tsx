import { connection } from "next/server";
import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { loadPageData } from "@/lib/page-data";
import { listCrmCompanies } from "@/lib/crm-db";
import { DEFAULT_COMPANY_KINDS } from "@/lib/crm";
import { normalizeCurrency } from "@/lib/currency";
import { NuevaOrdenForm } from "./nueva-form";

// Request-time: lee sesión (cookies) y DB por request.
// Cache Components no lo difiere con `instant = false`; ver nota en
// app/(dashboard)/page.tsx.
export const instant = false;

export default async function NuevaOrdenPage() {
  await connection();
  const { data, connected, dbReady, error } = await loadPageData(
    async (storeId) => {
      // Contratante = agencia o anunciante (nunca proveedor ni casa):
      // el filtro vive en la query para no traer de más al picker.
      const res = await listCrmCompanies(storeId, { pageSize: 200, kinds: [...DEFAULT_COMPANY_KINDS] });
      const companies = res.rows.map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
      const { getStore } = await import("@/lib/stores-db");
      const defaultCurrency = normalizeCurrency((await getStore(storeId))?.shop_currency ?? "PEN");
      const { listScreensBrief } = await import("@/lib/screens-store");
      const screenRows = await listScreensBrief(storeId, { activeOnly: true });
      const screens = screenRows.map((s) => {
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
      const { listDistinctBrands } = await import("@/lib/orders-store");
      const brands = (await listDistinctBrands(storeId, 200)).map((b) => b.trim()).filter(Boolean).sort((a, b) =>
        a.localeCompare(b, "es"),
      );
      return { companies, screens, brands, defaultCurrency };
    },
    {
      companies: [] as Array<{ id: string; name: string; kind: string | null }>,
      screens: [] as Array<{ id: string; name: string; detail: string | null; code: string | null; price_pen: number | null }>,
      brands: [] as string[],
      defaultCurrency: "PEN",
    },
  );
  const { companies, screens, brands, defaultCurrency } = data;

  return (
    <div className="page-shell max-w-[860px]">
      <PageHeader
        eyebrow="DOOH"
        title="Nueva cotización"
        description="Guarda anunciante, marca y líneas sin retener inventario. Completa los datos administrativos al confirmar; reserva capacidad de forma explícita."
        backHref="/orders"
      />
      {!connected && <AppCardState>Sin tienda conectada.</AppCardState>}
      {connected && !dbReady && <AppCardState>Base de datos no disponible.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}
      {connected && dbReady && !error && (
        <NuevaOrdenForm companies={companies} brands={brands} screens={screens} defaultCurrency={defaultCurrency} />
      )}
    </div>
  );
}
