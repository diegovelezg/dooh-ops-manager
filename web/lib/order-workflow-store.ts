// Escrituras y lecturas del flujo híbrido. Cada cambio opera sobre la orden como registro
// compartido OCC y valida store + workflow_rev en la misma transacción.
import { randomUUID } from "node:crypto";
import { surql } from "@/lib/surreal";
import { getOrderDetail } from "@/lib/orders-db";
import { getStoreTimeZone } from "@/lib/stores-db";
import { DAY_MS, isValidISODate, addDays, dayStart, dayOf, displayEndOf } from "@/lib/format";
import { isValidCurrency } from "@/lib/currency";
import { buildOrderSnapshot } from "@/lib/order-snapshot";
import { authorizationKind, lineTerms, type WorkflowRow as Row } from "@/lib/order-workflow";

const O = "type::record('io_order', $id)";
const S = "type::record('sys_store', $store)";
const own = `LET $o = (SELECT * FROM ONLY ${O}); IF !$o OR $o.store != ${S} { THROW 'Orden no encontrada' };`;
const lock = `${own} IF $o.workflow_rev != $rev { THROW 'La orden cambió; recarga para continuar' }; UPDATE ${O} SET workflow_rev += 1, updated_by = $actor;`;
const event = `CREATE io_order_event SET store = ${S}, order = ${O}, kind = $kind, payload = $payload, created_by = $actor;`;
const vars = (store: string, id: string, rev: number, actor: string) => ({ store, id, rev, actor });
const url = (v: string) => { if (!/^https?:\/\//i.test(v)) throw new Error("Indica una URL http(s)."); return v.trim(); };
const text = (v: string, max = 1000) => { if (!v.trim() || v.length > max) throw new Error(`Texto requerido (máx ${max}).`); return v.trim(); };

export { workflowRows } from "@/lib/order-workflow-reads";

async function capacityLines(store: string, id: string) {
  const detail = await getOrderDetail(store, id);
  if (!detail) throw new Error("Orden no encontrada.");
  const tz = await getStoreTimeZone(store);
  const lines = detail.lines.map((l) => {
    const days = [];
    for (let d = dayOf(String(l.starts_at), tz); d <= displayEndOf(String(l.ends_at), tz); d = addDays(d, 1)) {
      days.push({ d, from: dayStart(d, tz), to: dayStart(addDays(d, 1), tz) });
    }
    return { screen_id: String(l.screen_id), slots: Number(l.cant_slots), days };
  });
  return { detail, lines, tz };
}

export async function reserveOrder(store: string, id: string, rev: number, expires: string, actor: string) {
  const until = new Date(expires);
  if (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now()) throw new Error("El vencimiento debe estar en el futuro.");
  const { lines } = await capacityLines(store, id);
  await surql(`BEGIN; ${own} fn::reserve_order(${O}, $rev, <datetime> $until, $lines, $actor); COMMIT;`, { ...vars(store, id, rev, actor), until, lines });
}
export async function releaseOrder(store: string, id: string, actor: string) {
  await surql(`BEGIN; ${own} fn::release_order(${O}, $actor); COMMIT;`, { store, id, actor });
}

export interface OrderConfiguration { billingId: string; billingContactId: string; signerContactId: string; paymentTermsDays: number; authorizationKind: "OM" | "OC" | "CONTRACT"; responsibleEmail: string; commissionPct: number | null }
export async function configureOrder(store: string, id: string, rev: number, c: OrderConfiguration, actor: string) {
  if (!Number.isSafeInteger(c.paymentTermsDays) || c.paymentTermsDays < 0 || !["OM", "OC", "CONTRACT"].includes(c.authorizationKind)) throw new Error("Condición de pago o documento inválido.");
  if (c.commissionPct !== null && (!Number.isFinite(c.commissionPct) || c.commissionPct < 0 || c.commissionPct > 100)) throw new Error("Comisión inválida (0–100).");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.responsibleEmail)) throw new Error("Indica el email del responsable.");
  await surql(`BEGIN; ${lock}
    IF $o.status != 'draft' { THROW 'Usa una modificación para cambiar una orden confirmada' };
    LET $b = type::record('crm_company', $billing);
    LET $contact = type::record('crm_contact', $contact);
    LET $signer = type::record('crm_contact', $signer);
    IF !record::exists($b) OR $b.store != ${S} OR $b.deleted_at != NONE OR $b.kind NOT IN ['agencia', 'anunciante'] { THROW 'Contratante inválido' };
    IF $b.kind = 'anunciante' AND $b != $o.advertiser { THROW 'El contratante directo debe ser el anunciante' };
    IF !record::exists($contact) OR !record::exists($signer) OR $contact.company != $b OR $signer.company != $b OR $contact.deleted_at != NONE OR $signer.deleted_at != NONE { THROW 'Contactos activos del contratante requeridos' };
    IF array::len(SELECT id FROM member_of WHERE out = ${S} AND in.email = $responsible) = 0 { THROW 'Responsable fuera del equipo' };
    UPDATE ${O} SET billing = $b, billing_contact = $contact, signer_contact = $signer,
      agency = IF $b.kind = 'agencia' { $b } ELSE { $o.agency }, payment_terms_days = $days, authorization_kind = $authKind, responsible_email = $responsible, commission_pct = $commission ?? NONE,
      doc_orden_medios = $authKind = 'OM', doc_orden_compra = $authKind = 'OC', doc_contrato = $authKind = 'CONTRACT';
    ${event} COMMIT;`, { ...vars(store,id,rev,actor), billing:c.billingId, contact:c.billingContactId, signer:c.signerContactId, days:c.paymentTermsDays, authKind:c.authorizationKind, responsible:c.responsibleEmail.trim().toLowerCase(), commission:c.commissionPct??undefined, kind:"configured",payload:{ authorization_kind:c.authorizationKind } });
}

async function snapshot(store: string, id: string) {
  const { detail: d, lines, tz } = await capacityLines(store, id);
  const o = d.order;
  const contact = (c: typeof d.contacts.billing) => c ? { name:c.name, role:c.role, email:c.email, phone:c.phone } : null;
  const snap = buildOrderSnapshot({ signed_at: new Date().toISOString(), currency:String(o.currency), payment_terms_days:typeof o.payment_terms_days==="number"?o.payment_terms_days:null,
    gross_minor:d.lines.reduce((n,l)=>n+Number(l.rate_minor??0),0), advertiser_name:d.advertiser_name,billing_name:d.billing_name,billing_tax_id:d.billing_tax_id,billing_city:d.billing_city,billing_country:d.billing_country,
    agency_name:d.agency_name,agency_tax_id:d.agency_tax_id,agency_commission_pct:typeof o.commission_pct==="number"?o.commission_pct:d.agency_commission_pct,
    billing_contact:contact(d.contacts.billing),signer_contact:contact(d.contacts.signer),payment_contact:contact(d.contacts.payment),manager_contact:contact(d.contacts.manager),
    lines:d.lines.map(l=>({screen_name:String(l.screen_name??""),starts:dayOf(String(l.starts_at),tz),ends:displayEndOf(String(l.ends_at),tz),days:Number(l.cant_dias),slots:Number(l.cant_slots),total_minor:Number(l.rate_minor)})) });
  return { detail:d, lines, snap:{ ...snap, commercial_terms:{ brand:o.brand??null, billing_address:d.billing_company_address, parties:{advertiser_id:o.advertiser_company_id,billing_id:o.billing_company_id,agency_id:o.agency_company_id??null}, line_ids:d.lines.map(l=>l.id), payment_terms:o.payment_terms??null, service_clauses:o.service_clauses??null, notes:o.notes??null, authorization_kind:authorizationKind(o), commission_pct:o.commission_pct??null } } };
}
export async function confirmOrder(store:string,id:string,rev:number,actor:string) {
  const {lines,snap,detail}=await snapshot(store,id);
  if (!detail.order.responsible_email) throw new Error("Asigna responsable antes de confirmar.");
  for (const r of [detail.order.advertiser_company_id,detail.order.billing_company_id]) {
    const [c]=await surql<Row[]>("SELECT deleted_at FROM crm_company WHERE id=type::record('crm_company',$id) AND store=type::record('sys_store',$store)",{id:r,store});
    if (!c || c.deleted_at) throw new Error("Contrapartes activas requeridas.");
  }
  await surql(`BEGIN; ${own} fn::confirm_order(${O}, $rev, $snapshot, $lines, $actor); COMMIT;`,{...vars(store,id,rev,actor),snapshot:snap,lines});
}

export async function registerAuthorization(store:string,id:string,rev:number,documentUrl:string,actor:string) {
  const document=url(documentUrl);
  await surql(`BEGIN; ${lock} IF $o.status != 'signed' OR $o.authorization_kind = NONE { THROW 'Confirma y define el documento requerido primero' };
    CREATE io_agency_order SET store=${S}, order=${O}, kind=$o.authorization_kind, agreement_revision=$o.agreement_revision, code=$document, document_url=$document, created_by=$actor;
    ${event} COMMIT;`,{...vars(store,id,rev,actor),document,kind:"authorized",payload:{document_url:document}});
}

export async function recordPurchase(store:string,id:string,rev:number,actor:string,p:{lineId:string;status:"requested"|"confirmed"|"rejected"|"cancelled";costMinor:number|null;currency:string|null;reference:string;reason:string}) {
  if (!["requested","confirmed","rejected","cancelled"].includes(p.status)) throw new Error("Estado de compra inválido.");
  const reference=text(p.reference);
  if(p.status==="confirmed" && (!Number.isSafeInteger(p.costMinor)||Number(p.costMinor)<0||!p.currency||!isValidCurrency(p.currency))) throw new Error("La confirmación exige costo y moneda explícitos.");
  if(["rejected","cancelled"].includes(p.status)) text(p.reason);
  const [line]=await surql<Row[]>(`SELECT record::id(id) AS id, record::id(screen) AS screen_id, fn::iso(starts_at) AS starts_at, fn::iso(ends_at) AS ends_at, cant_slots, cant_dias FROM io_line WHERE id=type::record('io_line',$line) AND order=${O} AND store=${S}`,{store,id,line:p.lineId});
  if(!line)throw new Error("Línea fuera de la orden.");
  const terms=lineTerms(line);
  await surql(`BEGIN; ${lock} LET $l=type::record('io_line',$line);
    IF $l.order != ${O} OR $l.store != ${S} OR $l.screen.supplier = NONE { THROW 'La línea no tiene proveedor externo' };
    IF $status IN ['requested','confirmed'] AND ($l.screen.supplier.kind != 'proveedor' OR $l.screen.supplier.deleted_at != NONE) { THROW 'Proveedor activo requerido para un nuevo compromiso' };
    IF $o.status = 'cancelled' AND $status NOT IN ['cancelled','rejected'] { THROW 'Orden cancelada: registra la resolución del compromiso' };
    CREATE io_purchase SET store=${S}, order=${O}, line=$l, supplier=$l.screen.supplier, status=$status,
      cost_minor=$cost??NONE, currency=$currency??NONE, reference=$reference, reason=$reason??NONE, terms=$terms, sequence=$o.workflow_rev+1, created_by=$actor;
    ${event} COMMIT;`,{...vars(store,id,rev,actor),line:p.lineId,status:p.status,cost:p.costMinor??undefined,currency:p.currency??undefined,reference,reason:p.reason||undefined,terms,kind:"purchase",payload:{line_id:p.lineId,status:p.status,reference}});
}

export async function receiveMaterial(store:string,id:string,rev:number,actor:string,p:{url:string;lineIds:string[];supersedes?:string;duration?:number|null;width?:number|null;height?:number|null}) {
  const file=url(p.url); if(!p.lineIds.length)throw new Error("Asocia el material a sus líneas de pauta.");
  await surql(`BEGIN; ${lock} IF $o.status != 'signed' { THROW 'Confirma la orden antes de recibir material' };
    LET $lines=$lines.map(|$l| type::record('io_line',$l));
    FOR $l IN $lines { IF !record::exists($l) OR $l.order != ${O} { THROW 'Línea fuera de la orden' }; };
    IF $previous != NONE {
      LET $old=type::record('io_creative',$previous);
      IF !record::exists($old) OR $old.order != ${O} { THROW 'Versión anterior fuera de la orden' };
      UPDATE $old SET superseded_at=time::now();
    };
    CREATE type::record('io_creative',$material) SET store=${S}, order=${O}, name=$file, file_url=$file,
      lines=$lines, qc_status='pending', legal_status='pending', supersedes=IF $previous != NONE { type::record('io_creative',$previous) } ELSE { NONE },
      duration_s=$duration??NONE, width_px=$width??NONE, height_px=$height??NONE, created_by=$actor;
    ${event} COMMIT;`,{...vars(store,id,rev,actor),lines:[...new Set(p.lineIds)],file,material:randomUUID(),previous:p.supersedes??undefined,duration:p.duration??undefined,width:p.width??undefined,height:p.height??undefined,kind:"material_received",payload:{line_ids:p.lineIds,file_url:file}});
}
export async function reviewMaterial(store:string,id:string,rev:number,actor:string,p:{materialId:string;review:"technical"|"content";status:"approved"|"rejected";reason:string}) {
  if(!["technical","content"].includes(p.review)||!["approved","rejected"].includes(p.status))throw new Error("Revisión inválida.");
  if(p.status==="rejected")text(p.reason);
  const field=p.review==="technical"?"qc":"legal";
  await surql(`BEGIN; ${lock} LET $c=type::record('io_creative',$material);
    IF !record::exists($c) OR $c.order != ${O} OR $c.superseded_at != NONE OR $o.status != 'signed' { THROW 'Material vigente no encontrado' };
    IF array::len($c.lines)=0 { THROW 'Asocia las líneas antes de aprobar' };
    IF $technical AND $status = 'approved' {
      FOR $l IN $c.lines {
        IF ($l.screen.width_px != NONE AND ($c.width_px = NONE OR $c.width_px != $l.screen.width_px)) OR ($l.screen.height_px != NONE AND ($c.height_px = NONE OR $c.height_px != $l.screen.height_px)) OR ($l.screen.duration_sec != NONE AND ($c.duration_s = NONE OR $c.duration_s > $l.screen.duration_sec)) { THROW 'Material incompatible con resolución o duración de la pantalla' };
      };
    };
    UPDATE $c SET ${field}_status=$status, ${field}_notes=$reason??NONE, ${field}_reviewed_at=time::now(), ${field}_reviewed_by=$actor;
    ${event} COMMIT;`,{...vars(store,id,rev,actor),material:p.materialId,technical:p.review==="technical",status:p.status,reason:p.reason||undefined,kind:"material_reviewed",payload:p});
}

export async function recordEvidence(store:string,id:string,rev:number,actor:string,p:{lineId:string;url:string;kind:"photo"|"supplier_report"|"play_log";from:string;to:string;takenAt:string}) {
  const media=url(p.url);const from=new Date(p.from),to=new Date(p.to),taken=new Date(p.takenAt);
  if(!["photo","supplier_report","play_log"].includes(p.kind)||![from,to,taken].every(d=>Number.isFinite(d.getTime()))||to<=from||taken.getTime()>Date.now())throw new Error("Tipo, fecha real o cobertura inválidos.");
  if(to.getTime()>Date.now())throw new Error("La cobertura debe corresponder a un periodo ya transcurrido.");
  if(p.kind==="photo" && (taken<from||taken>to))throw new Error("La fecha de la foto debe estar dentro de su cobertura puntual.");
  if(p.kind==="photo" && to.getTime()-from.getTime()>DAY_MS)throw new Error("La foto es evidencia puntual: usa reporte o resolución explícita para un periodo mayor.");
  await surql(`BEGIN; ${lock} LET $l=type::record('io_line',$line);
    IF !record::exists($l) OR $l.order != ${O} OR $o.status != 'signed' { THROW 'Línea no disponible' };
    IF <datetime>$from < $l.starts_at OR <datetime>$to > $l.ends_at { THROW 'Cobertura fuera de la pauta contratada' };
    CREATE io_photo_check SET store=${S}, order=${O}, line=$l, screen=$l.screen, photo_url=$media, evidence_kind=$type,
      coverage_from=<datetime>$from, coverage_to=<datetime>$to, taken_at=<datetime>$taken, created_by=$actor;
    ${event} COMMIT;`,{...vars(store,id,rev,actor),line:p.lineId,media,type:p.kind,from,to,taken,kind:"evidence",payload:{line_id:p.lineId,evidence_kind:p.kind,url:media}});
}
export async function certifyDelivery(store:string,id:string,rev:number,actor:string,p:{lineId:string;evidenceId:string|null;status:"fulfilled"|"partial"|"incident"|"resolved";quantity:number;resolution:string}) {
  if(!["fulfilled","partial","incident","resolved"].includes(p.status)||!Number.isSafeInteger(p.quantity)||p.quantity<0)throw new Error("Cumplimiento o cantidad inválida.");
  if(p.status!=="fulfilled")text(p.resolution);
  const [line]=await surql<Row[]>(`SELECT record::id(screen) AS screen_id, fn::iso(starts_at) AS starts_at, fn::iso(ends_at) AS ends_at, cant_slots, cant_dias FROM io_line WHERE id=type::record('io_line',$line) AND order=${O} AND store=${S}`,{store,id,line:p.lineId});
  if(!line)throw new Error("Línea fuera de la orden.");
  const terms=lineTerms(line);
  await surql(`BEGIN; ${lock} LET $l=type::record('io_line',$line);
    IF !record::exists($l) OR $l.order != ${O} OR $o.status != 'signed' { THROW 'Línea no disponible' };
    LET $e=IF $evidence != NONE { type::record('io_photo_check',$evidence) } ELSE { NONE };
    IF $quantity > $l.cant_dias*$l.cant_slots { THROW 'Cantidad mayor que el compromiso contratado' };
    IF $e != NONE AND (!record::exists($e) OR $e.line != $l OR $e.order != ${O}) { THROW 'Evidencia de otra línea' };
    IF $status = 'fulfilled' AND ($l.ends_at > time::now() OR $e = NONE OR $e.coverage_from > $l.starts_at OR $e.coverage_to < $l.ends_at OR $quantity != $l.cant_dias*$l.cant_slots) { THROW 'Falta cobertura completa del periodo finalizado; registra parcial/incidencia o una resolución explícita' };
    CREATE io_delivery SET store=${S}, order=${O}, line=$l, evidence=$e, status=$status, delivered_slots_days=$quantity,
      resolution=$resolution??NONE, terms=$terms, sequence=$o.workflow_rev+1, created_by=$actor;
    ${event} COMMIT;`,{...vars(store,id,rev,actor),line:p.lineId,evidence:p.evidenceId??undefined,status:p.status,quantity:p.quantity,resolution:p.resolution||undefined,terms,kind:"delivery",payload:p});
}

export interface AgreementLineChange { id:string; starts:string; ends:string; slots:number; totalMinor:number }
export async function amendOrder(store:string,id:string,rev:number,actor:string,p:{reason:string;paymentTermsDays:number;notes:string;authorizationKind:"OM"|"OC"|"CONTRACT";commissionPct:number|null;lines:AgreementLineChange[]}) {
  const reason=text(p.reason);
  const {detail, snap, tz}= { ...(await snapshot(store,id)), tz:await getStoreTimeZone(store) };
  if(detail.order.status!=="signed")throw new Error("Solo se modifica un acuerdo confirmado.");
  if(p.lines.length!==detail.lines.length||new Set(p.lines.map(l=>l.id)).size!==p.lines.length||!detail.lines.every(l=>p.lines.some(x=>x.id===l.id)))throw new Error("La modificación debe incluir todas las líneas actuales; no elimina el historial.");
  if(!Number.isSafeInteger(p.paymentTermsDays)||p.paymentTermsDays<0||!["OM","OC","CONTRACT"].includes(p.authorizationKind))throw new Error("Pago o documento inválido.");
  if(p.commissionPct!==null&&(!Number.isFinite(p.commissionPct)||p.commissionPct<0||p.commissionPct>100))throw new Error("Comisión inválida.");
  const lines=p.lines.map(l=>{
    if(!isValidISODate(l.starts)||!isValidISODate(l.ends)||l.ends<l.starts||!Number.isSafeInteger(l.slots)||l.slots<1||l.slots>100||!Number.isSafeInteger(l.totalMinor)||l.totalMinor<=0)throw new Error("Línea inválida.");
    const previous=detail.lines.find(x=>x.id===l.id)!;const days=[];
    for(let d=l.starts;d<=l.ends;d=addDays(d,1))days.push({d,from:dayStart(d,tz),to:dayStart(addDays(d,1),tz)});
    return {...l,screen_id:String(previous.screen_id),screen_name:String(previous.screen_name??""),days};
  });
  const accepted = detail.order.snapshot_json as Row | undefined;
  if(!accepted)throw new Error("El acuerdo histórico no tiene snapshot aceptado; documenta una nueva contratación.");
  const revised={...snap,...accepted,signed_at:snap.signed_at,agency:accepted.agency?{...(accepted.agency as Row),commission_pct:p.commissionPct}:null,payment_terms_days:p.paymentTermsDays,gross_minor:lines.reduce((n,l)=>n+l.totalMinor,0),
    lines:lines.map(l=>({screen_name:l.screen_name,starts:l.starts,ends:l.ends,days:l.days.length,slots:l.slots,total_minor:l.totalMinor})),
    commercial_terms:{...(accepted.commercial_terms as Row??snap.commercial_terms),notes:p.notes,commission_pct:p.commissionPct,authorization_kind:p.authorizationKind}};
  await surql(`BEGIN; ${lock} IF $o.status != 'signed' { THROW 'Acuerdo no confirmado' };
    fn::assert_capacity(${S},${O},$lines);
    FOR $l IN $lines {
      LET $record=type::record('io_line',$l.id);
      IF $record.order != ${O} { THROW 'Línea ajena' };
      UPDATE $record SET starts_at=<datetime>array::first($l.days).from, ends_at=<datetime>array::last($l.days).to,
        cant_slots=$l.slots,cant_dias=array::len($l.days),rate_minor=$l.totalMinor;
    };
    LET $version=$o.agreement_revision+1;
    CREATE io_order_version SET store=${S},order=${O},revision=$version,snapshot=$snapshot,reason=$reason,created_by=$actor;
    UPDATE ${O} SET starts_at=<datetime>$start,ends_at=<datetime>$end,payment_terms_days=$days,notes=$notes??NONE,
      commission_pct=$commission??NONE,authorization_kind=$authKind,doc_orden_medios=$authKind='OM',doc_orden_compra=$authKind='OC',doc_contrato=$authKind='CONTRACT',snapshot_json=$snapshot,agreement_revision=$version;
    ${event} COMMIT;`,{...vars(store,id,rev,actor),lines,snapshot:revised,reason,start:lines.map(l=>l.days[0].from).sort()[0],end:lines.map(l=>l.days[l.days.length-1].to).sort().at(-1),days:p.paymentTermsDays,notes:p.notes||undefined,commission:p.commissionPct??undefined,authKind:p.authorizationKind,kind:"amended",payload:{reason}});
}

export async function assignOrderResponsible(store:string,id:string,rev:number,email:string,actor:string) {
  await surql(`BEGIN; ${lock}
    IF array::len(SELECT id FROM member_of WHERE out=${S} AND in.email=$email)=0 { THROW 'Responsable fuera del equipo' };
    UPDATE ${O} SET responsible_email=$email;
    ${event} COMMIT;`,{...vars(store,id,rev,actor),email:email.trim().toLowerCase(),kind:"assigned",payload:{responsible_email:email}});
}

export async function cancelOrder(store:string,id:string,rev:number,actor:string) {
  await surql(`BEGIN; ${lock}
    IF $o.status='cancelled' { THROW 'La orden ya está cancelada' };
    UPDATE ${O} SET status='cancelled',reservation_expires_at=NONE;
    ${event} COMMIT;`,{...vars(store,id,rev,actor),kind:"cancelled",payload:{reason:"Cancelación explícita; obligaciones e historial conservados"}});
}
