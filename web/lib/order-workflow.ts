// Reglas compartidas del MVP híbrido. Puras: UI, listados, Inbox y servidor usan la misma interpretación.
export type WorkflowRow = Record<string, unknown>;
export type AuthorizationKind = "OM" | "OC" | "CONTRACT";
export const AUTHORIZATION_LABELS = { OM: "Orden de medios", OC: "Orden de compra", CONTRACT: "Contrato / aceptación" };

export function authorizationKind(order: WorkflowRow): AuthorizationKind | null {
  const k = order.authorization_kind;
  if (k === "OM" || k === "OC" || k === "CONTRACT") return k;
  if (order.doc_contrato) return "CONTRACT";
  if (order.doc_orden_compra) return "OC";
  if (order.doc_orden_medios) return "OM";
  return null;
}
export function isAuthorized(order: WorkflowRow, documents: WorkflowRow[]): boolean {
  const kind = authorizationKind(order);
  return kind !== null && documents.some((d) => d.kind === kind && Number(d.agreement_revision ?? 0) === Number(order.agreement_revision ?? 0) && typeof d.document_url === "string" && /^https?:\/\//i.test(d.document_url));
}
export function consumesCapacity(order: WorkflowRow, now = Date.now()): boolean {
  if (order.status === "signed") return true;
  return order.status === "draft" && typeof order.reservation_expires_at === "string" && Date.parse(order.reservation_expires_at) > now;
}
export function commercialState(order: WorkflowRow, now = Date.now()): string {
  return order.status === "cancelled" ? "Cancelada" : order.status === "signed" ? "Confirmada" : consumesCapacity(order, now) ? "Reservada" : "Cotizada";
}
export function materialCovers(lineId: string, creatives: WorkflowRow[]): boolean {
  return creatives.some((c) => !c.superseded_at && c.qc_status === "approved" && c.legal_status === "approved"
    && !!c.qc_reviewed_at && !!c.legal_reviewed_at && Array.isArray(c.line_ids) && c.line_ids.includes(lineId));
}
export function materialsCovered(lines: WorkflowRow[], creatives: WorkflowRow[]): boolean {
  return lines.length > 0 && lines.every((l) => materialCovers(String(l.id), creatives));
}
export function lineTerms(line: WorkflowRow): Record<string, unknown> {
  return { screen_id: String(line.screen_id), starts_at: new Date(String(line.starts_at)).toISOString(),
    ends_at: new Date(String(line.ends_at)).toISOString(), cant_slots: Number(line.cant_slots), cant_dias: Number(line.cant_dias) };
}
export function sameLineTerms(a: unknown, line: WorkflowRow): boolean {
  if (!a || typeof a !== "object") return false;
  const expected = lineTerms(line);
  return Object.entries(expected).every(([k, v]) => (a as WorkflowRow)[k] === v);
}
export function latestForLine(rows: WorkflowRow[], id: string): WorkflowRow | undefined {
  return rows.filter((r) => r.line_id === id).sort((a, b) => Number(b.sequence) - Number(a.sequence))[0];
}
export function supplierConfirmed(line: WorkflowRow, purchases: WorkflowRow[]): boolean {
  if (!line.supplier_company_id) return true;
  const p = latestForLine(purchases, String(line.id));
  return p?.status === "confirmed" && p.supplier_id === line.supplier_company_id && sameLineTerms(p.terms, line);
}
export function deliveryCovered(line: WorkflowRow, deliveries: WorkflowRow[], evidence: WorkflowRow[]): boolean {
  const d = latestForLine(deliveries, String(line.id));
  if (!d || !sameLineTerms(d.terms, line)) return false;
  if (d.status === "resolved") return typeof d.resolution === "string" && d.resolution.trim().length > 0;
  if (d.status !== "fulfilled" || Number(d.delivered_slots_days) < Number(line.cant_dias) * Number(line.cant_slots)) return false;
  const e = evidence.find((e) => e.id === d.evidence_id && e.line_id === line.id);
  return !!e && Date.parse(String(e.coverage_from)) <= Date.parse(String(line.starts_at))
    && Date.parse(String(e.coverage_to)) >= Date.parse(String(line.ends_at));
}
export function deliveriesCovered(lines: WorkflowRow[], deliveries: WorkflowRow[], evidence: WorkflowRow[]): boolean {
  return lines.length > 0 && lines.every((l) => deliveryCovered(l, deliveries, evidence));
}
export function purchaseMargin(order: WorkflowRow, lines: WorkflowRow[], purchases: WorkflowRow[]) {
  const salesMinor = lines.reduce((n, l) => n + Number(l.rate_minor ?? 0), 0);
  let costMinor = 0;
  const missing: string[] = [];
  for (const l of lines.filter((l) => l.supplier_company_id)) {
    const p = latestForLine(purchases, String(l.id));
    if (!p || p.status !== "confirmed" || !sameLineTerms(p.terms, l) || p.supplier_id !== l.supplier_company_id || !Number.isSafeInteger(p.cost_minor)) {
      missing.push(`Costo/confirmación pendiente: ${String(l.screen_name ?? l.screen_id)}`); continue;
    }
    if (p.currency !== order.currency) { missing.push(`Compra ${String(p.currency)} incompatible con venta ${String(order.currency)}; sin conversión`); continue; }
    costMinor += Number(p.cost_minor);
  }
  const costsKnown = missing.length === 0;
  const pct = order.agency_company_id ? order.commission_pct : 0;
  const commissionMinor = typeof pct === "number" && pct >= 0 && pct <= 100 ? Math.round(salesMinor * pct / 100) : null;
  if (commissionMinor === null) missing.push("Comisión de agencia sin definir");
  return { salesMinor, externalCostMinor: costsKnown ? costMinor : null, commissionMinor,
    marginMinor: missing.length || commissionMinor === null ? null : salesMinor - costMinor - commissionMinor, missing };
}

export interface OperationalTask {
  key: string; kind: string; title: string; context?: string; orderId: string; lineId: string | null;
  responsible: string | null; dueAt: string | null; overdue: boolean; href: string;
}
export function operationalTasks(order: WorkflowRow, lines: WorkflowRow[], documents: WorkflowRow[], creatives: WorkflowRow[], evidence: WorkflowRow[], purchases: WorkflowRow[], deliveries: WorkflowRow[], now = Date.now()): OperationalTask[] {
  const out: OperationalTask[] = [];
  const orderId = String(order.id);
  const responsible = typeof order.responsible_email === "string" ? order.responsible_email : null;
  const push = (kind: string, title: string, line: WorkflowRow | null, dueAt: string | null) => {
    const lineId = line ? String(line.id) : null;
    out.push({ key: `${orderId}:${kind}:${lineId ?? "order"}`, kind, title, orderId, lineId, responsible, dueAt,
      overdue: dueAt !== null && Date.parse(dueAt) < now, href: `/orders/${encodeURIComponent(orderId)}${lineId ? `?line=${encodeURIComponent(lineId)}#line-${encodeURIComponent(lineId)}` : ""}` });
  };
  if (order.status === "cancelled") {
    for (const l of lines.filter(l => l.supplier_company_id)) {
      const p = latestForLine(purchases, String(l.id));
      if (p && ["requested", "confirmed"].includes(String(p.status))) push("supplier_cancel", "Resolver compromiso de proveedor tras cancelación", l, null);
    }
    return out;
  }
  if (order.status === "draft") {
    if (consumesCapacity(order, now)) push("reservation", "Confirmar o liberar reserva", null, String(order.reservation_expires_at));
    return out;
  }
  const first = lines.map((l) => String(l.starts_at)).sort()[0] ?? null;
  if (!isAuthorized(order, documents)) push("authorization", `Registrar ${AUTHORIZATION_LABELS[authorizationKind(order) ?? "OM"]}`, null, first);
  for (const l of lines) {
    if (!supplierConfirmed(l, purchases)) push("supplier", "Confirmar proveedor y costo", l, String(l.starts_at));
    if (!deliveryCovered(l, deliveries, evidence) && !materialCovers(String(l.id), creatives)) push("material", "Asignar y aprobar material", l, String(l.starts_at));
    if (Date.parse(String(l.ends_at)) <= now && !deliveryCovered(l, deliveries, evidence)) push("delivery", "Certificar entrega o resolver incidencia", l, String(l.ends_at));
  }
  return out;
}

export function confirmationRequirements(order:WorkflowRow):string[] {
  const missing:string[]=[];
  if(!order.billing_company_id)missing.push("Contratante");
  if(!order.billing_contact_id)missing.push("Contacto de facturación");
  if(!order.signer_contact_id)missing.push("Firmante");
  if(order.payment_terms_days==null)missing.push("Plazo de pago");
  if(!authorizationKind(order))missing.push("Documento de autorización requerido");
  if(!order.responsible_email)missing.push("Responsable del equipo");
  if(order.agency_company_id&&order.commission_pct==null)missing.push("Comisión de agencia explícita");
  return missing;
}
