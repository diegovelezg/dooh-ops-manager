import { listAccountsOfContacts, listAgencies, listContactsOfCompanies } from "@/lib/crm-store";
import { toContactRef } from "@/lib/orders-db";
import { requireRouteEntity } from "@/lib/api/guard";
import { apiLog } from "@/lib/log";

/** GET /api/orders/:id/meta — agencias + contactos para el editor de ficha.
 *  Separado del detalle (perf 2026-11-09): el drawer abre sin estos datos
 *  (hasta 200+200 filas); el editor los pide al montar. Mismo guard que el
 *  detalle: 404 idéntico sin membresía (nunca 403 oráculo). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const loaded = await requireRouteEntity(
      "io_order",
      id,
      "Orden no encontrada.",
    );
    if (loaded instanceof Response) return loaded;
    const { storeId, row: o } = loaded;
    // Agencias del tenant para vincular intermediaria (Opción B) + % default.
    const agencies = await listAgencies(storeId, 200);
    // Contactos de las empresas del caso (facturador + anunciante +
    // intermediaria) para los pickers de POC/firmante/pago/responsable.
    const caseCompanyIds = [...new Set(
      [o.billing_company_id, o.advertiser_company_id, o.agency_company_id]
        .filter((x): x is string => typeof x === "string" && !!x),
    )];
    let orderContacts: ReturnType<typeof toContactRef>[] = [];
    let contactAccounts: Array<{ contact_id: string; advertiser_company_id: string; advertiser_name: string }> = [];
    if (caseCompanyIds.length > 0) {
      orderContacts = (await listContactsOfCompanies(storeId, caseCompanyIds, 200)).map(toContactRef);
      contactAccounts = await listAccountsOfContacts(storeId, orderContacts.map((c) => c.id));
    }
    return Response.json({
      advertiser_company_id: typeof o.advertiser_company_id === "string" ? o.advertiser_company_id : null,
      order_contacts: orderContacts,
      contact_accounts: contactAccounts,
      agencies: agencies.map((a) => ({
        id: String(a.id),
        name: String(a.name ?? ""),
        tax_id: typeof a.tax_id === "string" && a.tax_id.trim() ? a.tax_id.trim() : null,
        commission_pct: Number.isFinite(Number(a.agency_commission_pct)) ? Number(a.agency_commission_pct) : null,
      })),
    });
  } catch (e) {
    apiLog("orders-meta", "orders-meta fail", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
