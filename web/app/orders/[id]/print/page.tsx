import { connection } from "next/server";
import type { Metadata } from "next";
import { isDbConfigured } from "@/lib/surreal";
import { getOrderDetail } from "@/lib/orders-db";
import {
  displayStoreName,
  getMyActiveStore,
  requireMyStoreAccess,
} from "@/lib/tenant";
import { normalizeCurrency } from "@/lib/currency";
import {
  diffDaysInclusive,
  displayEndOfSafe,
  formatDate,
  formatDateTime,
  formatMoneyParts,
  formatNumber,
  paymentTermsLabel,
  splitIgv,
  toTitleCase,
} from "@/lib/format";
import { parseOrderSnapshot } from "@/lib/order-snapshot";
import { taxIdLabel } from "@/lib/tax-id";
import { taxNameForCountry, vatRateForCountry } from "@/lib/tax-rate";
import { PrintButton } from "./print-button";

export const instant = false;

/** Título para la pestaña y el nombre sugerido al guardar el PDF. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  try {
    const { id } = await params;
    const { findOwned } = await import("@/lib/orders-store");
    const data = await findOwned("io_order", id);
    if (!data) return { title: "Nota de pedido" };
    const storeId = String(data.store_id ?? "");
    if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
      return { title: "Nota de pedido" };
    }
    return { title: `Nota de pedido ${String(data.io_number ?? "")}` };
  } catch {
    return { title: "Nota de pedido" };
  }
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Cotización",
  signed: "Confirmada",
  cancelled: "Cancelada",
};

function str(v: unknown): string {
  return typeof v === "string" && v ? v : "—";
}

/** Mismo tratamiento que `<Money>` de la web: código ISO más pequeño, gris y sin negrita. */
function money(minor: unknown, currency: string): React.ReactNode {
  const n = Number(minor);
  if (!Number.isFinite(n)) return "—";
  const { code, body } = formatMoneyParts(n, currency);
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ fontSize: "0.7em", fontWeight: 400, color: "#555", letterSpacing: "0.02em", marginRight: "0.35em" }}>{code}</span>
      {body}
    </span>
  );
}

/** GET visual: /orders/:id/print — Nota de Pedido lista para "Exportar
 *  PDF" (diálogo de impresión del navegador → Guardar como PDF). Fuera del
 *  grupo (dashboard): sin sidebar/header para que el papel salga limpio.
 *  Solo lectura: exige membresía a la tienda (404 idéntico sin acceso,
 *  como /api/orders/:id). Estructura y wording según la Nota de Pedido de
 *  alquiler y producción vigente (secciones I–X). Solo campos con dato
 *  real: lo ausente se muestra "—", nunca se inventa. */
export default async function OrderPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ store?: string }>;
}) {
  await connection();
  const { id } = await params;
  const sp = await searchParams;

  if (!isDbConfigured()) {
    return <PrintError message="Base de datos no disponible." />;
  }
  const { active } = await getMyActiveStore(sp.store ?? null);
  const storeId = active?.id ?? null;
  if (!storeId || !active) return <PrintError message="Sin tienda conectada." />;
  const tz = active.timezone;
  if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
    return <PrintError message="Orden no encontrada." />;
  }
  let detail: Awaited<ReturnType<typeof getOrderDetail>>;
  try {
    detail = await getOrderDetail(storeId, id);
  } catch {
    return <PrintError message="No se pudo cargar la orden." />;
  }
  if (!detail) return <PrintError message="Orden no encontrada." />;

  const storeName = active ? displayStoreName(active) : "—";
  const o = detail.order;
  // Snapshot al firmar gana al dato vivo (documento inmutable; resiste archivo
  // o cambio de empresas/contactos). Sin snapshot: dato vivo.
  const snap = parseOrderSnapshot(o.snapshot_json);
  const currency = normalizeCurrency(
    (snap?.currency ?? (o.currency as string | null | undefined) ?? "PEN"),
  );
  const lines = detail.lines;
  const liveGross = lines.reduce((a, l) => a + Number(l.rate_minor ?? 0), 0);
  const gross = snap?.gross_minor ?? liveGross;
  const tenantCountry = active?.shop_country ?? null;
  const { net, igv, total } = splitIgv(gross, tenantCountry);
  const taxName = taxNameForCountry(tenantCountry);
  const taxPct = Math.round(vatRateForCountry(tenantCountry) * 100);
  const status = String(o.status ?? "");
  const isDraft = status === "draft";
  const ioNumber = String(o.io_number ?? "Orden");
  const brand =
    typeof o.brand === "string" && o.brand ? toTitleCase(o.brand) : "—";
  const advertiser = toTitleCase(snap ? snap.advertiser.name : detail.advertiser_name);
  const billing = toTitleCase(snap ? snap.billing.name : detail.billing_name);
  const billingTax = snap ? snap.billing.tax_id : detail.billing_tax_id;
  const billingCountry = snap ? snap.billing.country : detail.billing_country;
  const fiscalLabel = taxIdLabel(billingCountry);
  const cityLine = [
    snap ? snap.billing.city : detail.billing_city,
    snap ? snap.billing.country : detail.billing_country,
  ]
    .filter(Boolean)
    .join(" · ");
  const termsDays = snap
    ? snap.payment_terms_days
    : typeof o.payment_terms_days === "number"
      ? (o.payment_terms_days as number)
      : null;
  const terms = termsDays !== null ? paymentTermsLabel(termsDays) : snap ? "—" : str(o.payment_terms);
  const frozenTerms = o.snapshot_json && typeof o.snapshot_json === "object" && typeof (o.snapshot_json as Record<string, unknown>).commercial_terms === "object"
    ? (o.snapshot_json as Record<string, unknown>).commercial_terms as Record<string, unknown> : null;
  const notesRaw = frozenTerms ? frozenTerms.notes : o.notes;
  const notes = typeof notesRaw === "string" && notesRaw.trim() ? notesRaw.trim() : null;
  const txt = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  // Opción B: solo intermediaria vinculada (columnas de texto eliminadas).
  const linkedAgencyName = (snap ? snap.agency?.name : detail.agency_name) ?? null;
  const linkedAgencyTax = (snap ? snap.agency?.tax_id : detail.agency_tax_id) ?? null;
  const hasIntermediary = Boolean(linkedAgencyName);
  // Dirección: solo lectura desde la empresa (sin columna en la orden).
  const billingAddress = frozenTerms ? txt(frozenTerms.billing_address) : detail.billing_company_address;
  // Solo contactos vinculados (columnas de texto eliminadas).
  const snapContacts = snap?.contacts ?? null;
  const pocRef = snapContacts?.billing ?? detail.contacts.billing;
  const pocName = pocRef?.name ?? null;
  const pocPhone = pocRef?.phone ?? null;
  const pocEmail = pocRef?.email ?? null;
  const signerRef = snapContacts?.signer ?? detail.contacts.signer;
  const signerName = signerRef?.name ?? null;
  const signerRole = signerRef?.role ?? null;
  const signerEmail = signerRef?.email ?? null;
  const managerRef = snapContacts?.manager ?? detail.contacts.manager;
  const managerName = managerRef?.name ?? null;
  const managerRole = managerRef?.role ?? null;
  const managerEmail = managerRef?.email ?? null;
  // Sin responsable si la intermediaria es el contratante.
  const orderAgencyId = typeof o.agency_company_id === "string" && o.agency_company_id ? o.agency_company_id : null;
  const orderBillingId = typeof o.billing_company_id === "string" && o.billing_company_id ? o.billing_company_id : null;
  const paymentLink = snapContacts?.payment ?? detail.contacts.payment;
  const paymentLine = paymentLink
    ? [paymentLink.name, paymentLink.email].filter(Boolean).join(" ")
    : null;
  const billingKindLabel =
    detail.billing_kind === "agencia" ? "Agencia" : detail.billing_kind === "anunciante" ? "Anunciante" : null;
  const billingDocLabel = o.doc_orden_medios === true ? "Orden de Medios" : o.doc_orden_compra === true ? "Orden de Compra" : o.doc_contrato === true ? "Contrato" : null;
  const agencyIsContratante = hasIntermediary && !!orderAgencyId && orderAgencyId === orderBillingId;
  const contactLine = (...parts: Array<string | null>): string => parts.filter(Boolean).join(" · ") || "—";
  const now = formatDateTime(new Date().toISOString(), tz);
  const moneyLabel =
    currency === "PEN"
      ? "Soles"
      : currency === "USD"
        ? "Dólares americanos"
        : currency;

  return (
    <main
      aria-label={`Nota de pedido ${ioNumber}`}
      style={{
        maxWidth: "820px",
        margin: "0 auto",
        padding: "32px 28px",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        color: "#111",
        fontSize: "12.5px",
        lineHeight: 1.5,
        background: "#fff",
      }}
    >
      <div className="print:hidden" style={{ marginBottom: "20px" }}>
        <PrintButton />
      </div>

      <header style={{ marginBottom: "14px" }}>
        <p style={{ fontSize: "11px", color: "#555", margin: 0 }}>
          {storeName} · Orden {ioNumber} · {STATUS_LABEL[status] ?? status}
        </p>
        <h1
          style={{
            fontSize: "20px",
            margin: "4px 0",
            textTransform: "uppercase",
            letterSpacing: "0.02em",
          }}
        >
          Nota de pedido de alquiler de espacios de publicidad
        </h1>
        {isDraft && (
          <p style={{ margin: "4px 0 0", fontSize: "12px", fontWeight: 600 }}>
            Cotización pendiente de confirmación — no válida como comprobante.
          </p>
        )}
        <dl style={{ display: "flex", gap: "24px", margin: "8px 0 0" }}>
          <div>
            <dt style={headDt}>Fecha </dt>
            <dd style={{ display: "inline", margin: 0, fontWeight: 600 }}>
              {formatDate(o.created_at, tz)}
            </dd>
          </div>
          <div>
            <dt style={headDt}>Anunciante </dt>
            <dd style={{ display: "inline", margin: 0, fontWeight: 600 }}>
              {advertiser}
            </dd>
          </div>
          <div>
            <dt style={headDt}>Marca </dt>
            <dd style={{ display: "inline", margin: 0, fontWeight: 600 }}>
              {brand}
            </dd>
          </div>
        </dl>
      </header>

      <NpSection n="I" title="Anunciante">
        <NpGrid
          rows={[
            ["Anunciante", advertiser],
            ["Marca", brand],
          ]}
        />
      </NpSection>

      <NpSection n="II" title="Contratante">
        <NpGrid
          rows={[
            ["Razón social", billing + (billingKindLabel ? ` · ${billingKindLabel}` : "")],
            [fiscalLabel, billingTax ?? "—"],
            ["Ciudad", cityLine || "—"],
            ["Dirección", billingAddress ?? "—"],
            ["Contacto contratante", contactLine(pocName, pocPhone, pocEmail)],
            ["Firmante", contactLine(signerName, signerRole, signerEmail)],
            ["Condición de pago", terms],
            ["Moneda", moneyLabel],
          ]}
        />
      </NpSection>

      <NpSection n="III" title="Facturación">
        <NpGrid
          rows={[
            [
              "Documento para facturación",
              billingDocLabel ?? "—",
            ],
            ["Indicaciones para facturación", txt(o.billing_detail) ?? "—"],
            ["Observaciones para registro de factura", txt(o.invoice_registration) ?? "—"],
            ["Contacto de pago", paymentLine ?? "—"],
            ["Correo electrónico y/o portal", txt(o.billing_portal_email) ?? "—"],
          ]}
        />
      </NpSection>

      <NpSection n="IV" title="Intermediario">
        <NpGrid
          rows={[
            ["Agencia / central de medios", hasIntermediary ? "Sí" : "No"],
            ...(hasIntermediary
              ? ([
                  ["Empresa intermediaria", toTitleCase(linkedAgencyName) + (agencyIsContratante ? " · es el contratante" : "")],
                  ...(agencyIsContratante
                    ? []
                    : ([
                        [taxIdLabel(detail.agency_country ?? billingCountry), linkedAgencyTax ?? "—"],
                        ["Persona responsable", contactLine(managerName, managerRole, managerEmail)],
                      ] as Array<[string, React.ReactNode]>)),
                ] as Array<[string, React.ReactNode]>)
              : []),
          ]}
        />
      </NpSection>

      <NpSection
        n="V"
        title={`Pantallas (${formatNumber(lines.length)})`}
      >
        {lines.length === 0 ? (
          <p style={{ margin: 0, color: "#555" }}>
            Sin pantallas en esta orden.
          </p>
        ) : (
          <>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "11.5px",
              }}
            >
              <thead>
                <tr>
                  {[
                    "Pantalla",
                    "Ubicación",
                    "Periodo",
                    `Precio/día (${currency})`,
                    "Días",
                    "Slots",
                    `Subtotal (${currency})`,
                  ].map((h, i, all) => (
                    <th
                      key={h}
                      align={i >= all.length - 4 ? "right" : "left"}
                      style={{
                        borderBottom: "1px solid #111",
                        padding: "6px 6px",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const fin = displayEndOfSafe(l.ends_at, tz);
                  const dd =
                    typeof l.cant_dias === "number" && l.cant_dias > 0
                      ? l.cant_dias
                      : diffDaysInclusive(
                          typeof l.starts_at === "string"
                            ? l.starts_at
                            : null,
                          fin,
                        );
                  const slots = typeof l.cant_slots === "number" && l.cant_slots >= 1 ? l.cant_slots : 1;
                  const perDay = dd && dd > 0 ? Math.round(Number(l.rate_minor) / (dd * slots)) : null;
                  const place = [l.screen_venue, l.screen_district].map(txt).filter(Boolean).join(" · ");
                  return (
                    <tr key={String(l.id)}>
                      <td style={cell}>
                        <b>{str(l.screen_name)}</b>
                        {txt(l.screen_code) && <div style={{ color: "#555", fontSize: "10px" }}>{txt(l.screen_code)}</div>}
                      </td>
                      <td style={cell}>{place || "—"}</td>
                                              <td style={{ ...cell, whiteSpace: "nowrap" }}>
                          {formatDate(l.starts_at, tz)} → {fin ? formatDate(fin, tz) : "—"}
                        </td>

                      <td align="right" style={{ ...cell, whiteSpace: "nowrap" }}>
                        {perDay !== null ? money(perDay, currency) : "—"}
                      </td>
                      <td align="right" style={cell}>
                        {dd ?? "—"}
                      </td>
                      <td align="right" style={cell}>
                        {slots}
                      </td>
                      <td align="right" style={{ ...cell, whiteSpace: "nowrap" }}>
                        {money(l.rate_minor, currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <dl
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "2px",
                alignItems: "flex-end",
                margin: "8px 0 0",
              }}
            >
              <NpTotal label={`Total sin ${taxName}`} value={money(net, currency)} />
              <NpTotal label={`${taxName} (${taxPct} %)`} value={money(igv, currency)} />
              <NpTotal label="Total" value={money(total, currency)} strong />
            </dl>
          </>
        )}
      </NpSection>

      <NpSection n="VI" title="Condiciones del servicio">
        <p style={{ margin: 0 }}>
          {txt(frozenTerms ? frozenTerms.service_clauses : o.service_clauses) ??
            `${storeName} podrá reubicar la pauta por fuerza mayor, siempre y cuando el cliente esté conforme con la reubicación. Todo arte pasa por aprobación de ${storeName}.`}
        </p>
      </NpSection>

      <NpSection n="VII" title="Notas">
        <p style={{ margin: 0 }}>{notes ?? "Sin notas."}</p>
      </NpSection>

      <NpSection n="VIII" title="Firmas" last>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "32px",
            marginTop: "8px",
          }}
        >
          <div>
            <p style={{ fontWeight: 700, margin: "0 0 2px" }}>{billing}</p>
            <p style={{ margin: "0 0 40px", color: "#555" }}>{signerName ?? "Firmante"}{signerRole ? ` · ${signerRole}` : ""}</p>
            <p style={{ margin: 0, color: "#555" }}>
              Firma:{" "}
              <span aria-hidden style={signLine}>
                &nbsp;
              </span>
            </p>
          </div>
          <div>
            <p style={{ fontWeight: 700, margin: "0 0 2px" }}>{storeName}</p>
            <p style={{ margin: "0 0 40px", color: "#555" }}>&nbsp;</p>
            <p style={{ margin: 0, color: "#555" }}>
              Firma:{" "}
              <span aria-hidden style={signLine}>
                &nbsp;
              </span>
            </p>
          </div>
        </div>
      </NpSection>

      <footer
        style={{
          borderTop: "1px solid #999",
          marginTop: "16px",
          paddingTop: "8px",
          color: "#555",
          fontSize: "11px",
        }}
      >
        Generado el {now} · Moneda {currency} · Montos sin {taxName} salvo
        indicación.
      </footer>

      <style>{`@media print { .print\\:hidden { display: none !important; } thead { display: table-header-group; } tr { break-inside: avoid; } }`}</style>
    </main>
  );
}

const headDt: React.CSSProperties = {
  display: "inline",
  color: "#555",
  fontSize: "11px",
  textTransform: "uppercase",
};

const cell: React.CSSProperties = {
  borderBottom: "1px solid #ddd",
  padding: "6px",
  verticalAlign: "top",
};

const signLine: React.CSSProperties = {
  display: "inline-block",
  minWidth: "200px",
  borderBottom: "1px solid #111",
};

function NpSection({
  n,
  title,
  last,
  children,
}: {
  n: string;
  title: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={`${n}. ${title}`}
      style={{ marginBottom: last ? 0 : "14px" }}
    >
      <h2
        style={{
          fontSize: "13px",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          borderBottom: "1px solid #111",
          paddingBottom: "3px",
          margin: "0 0 8px",
        }}
      >
        {n}. {title}
      </h2>
      {children}
    </section>
  );
}

function NpGrid({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl
      style={{
        display: "grid",
        gridTemplateColumns: "220px 1fr",
        gap: "4px 12px",
        margin: 0,
      }}
    >
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt style={{ color: "#555" }}>{k}</dt>
          <dd style={{ margin: 0, fontWeight: 500 }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function NpTotal({
  label,
  value,
  strong,
}: {
  label: string;
  value: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: "16px" }}>
      <dt style={{ color: "#555" }}>{label}</dt>
      <dd
        style={{
          margin: 0,
          minWidth: "160px",
          textAlign: "right",
          fontWeight: strong ? 700 : 500,
        }}
      >
        {value}
      </dd>
    </div>
  );
}

function PrintError({ message }: { message: string }) {
  return (
    <main
      style={{
        maxWidth: "640px",
        margin: "48px auto",
        padding: "0 24px",
        fontFamily: "system-ui, sans-serif",
        fontSize: "14px",
      }}
    >
      <p>{message}</p>
    </main>
  );
}
