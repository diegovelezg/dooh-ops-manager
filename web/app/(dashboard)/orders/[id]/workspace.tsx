"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { toastFormError, useInvalidFields } from "@/components/ui/form-feedback";
import { runOrderWorkflowAction } from "@/lib/order-workflow-actions";
import { workflowCommandSchema } from "@/lib/order-workflow-validation";
import type { OrderDetail } from "@/lib/orders-db";
import { confirmationRequirements, AUTHORIZATION_LABELS, authorizationKind, commercialState, consumesCapacity, operationalTasks, purchaseMargin, supplierConfirmed, materialCovers, deliveryCovered, type WorkflowRow } from "@/lib/order-workflow";
import { DAY_MS, formatMoney, formatDate, formatDateTime, dayOf, displayEndOf, toTenantDateTimeInput, fromTenantDateTimeInput } from "@/lib/format";
export interface WorkspaceOptions {
  now:number; tz:string; canEdit:boolean; canReview:boolean;
  companies:Array<{id:string;name:string;kind:string}>;
  contacts:Array<{id:string;company_id:string;name:string}>;
  members:Array<{email:string}>;
}
type Choice={value:string;label:string};
type Field={name:string;label:string;value?:string;type?:string;optional?:boolean;requiredWhen?:{field:string;values:string[]};disabled?:boolean;choices?:Choice[];multiple?:boolean};
const str=(v:unknown)=>v==null?"":String(v);
const numberOrNull=(v:unknown)=>v===""||v==null?null:Number(v);
const minor=(v:unknown)=>{const x=String(v);if(!/^\d+(\.\d{1,2})?$/.test(x))throw new Error("Importe inválido: usa hasta dos decimales.");return Math.round(Number(x)*100);};
function CommandForm({title,fields=[],build,orderId,revision,disabled=false,children}:{title:string;fields?:Field[];build:(v:Record<string,unknown>)=>unknown;orderId:string;revision:number;disabled?:boolean;children?:ReactNode}) {
  const [values,setValues]=useState<Record<string,unknown>>(()=>Object.fromEntries(fields.map(f=>[f.name,f.multiple?[]:f.value??""])));
  const [pending,start]=useTransition(),router=useRouter(),root=useRef<HTMLFormElement>(null);
  const {bad,mark,clear,focusFirst}=useInvalidFields<string>();
  const mandatory=(f:Field)=>!f.optional||!!f.requiredWhen?.values.includes(str(values[f.requiredWhen.field]));
  const missing=fields.filter(f=>mandatory(f)&&(Array.isArray(values[f.name])?!(values[f.name] as unknown[]).length:!str(values[f.name]).trim()));
  return <form ref={root} noValidate className="space-y-3 rounded-lg border p-4" onSubmit={e=>{
    e.preventDefault();
    try{
      const command=build(values),parsed=workflowCommandSchema.safeParse(command);
      if(!parsed.success){const keys=parsed.error.issues.map(i=>str(i.path[0]));mark(keys);focusFirst(root,keys);toastFormError("Revisa los campos","Completa los datos de la operación.");return;}
      start(async()=>{try {const result=await runOrderWorkflowAction({orderId,revision,command:parsed.data});if(!result.ok){mark(result.fields??fields.map(f=>f.name));focusFirst(root,result.fields??fields.map(f=>f.name));toastFormError("No se pudo guardar",result.message);}else{toast.add({title:"Guardado",description:result.message,type:"success"});router.refresh();}}catch(err){toastFormError("No se pudo guardar",err instanceof Error?err.message:"Error de conexión.");}});
    }catch(err){mark(fields.map(f=>f.name));toastFormError("Revisa los datos",err instanceof Error?err.message:"Datos inválidos.");}
  }}>
    <h3 className="font-medium">{title}</h3>{children}
    <div className="grid gap-3 sm:grid-cols-2">{fields.map(f=><label key={f.name} className="grid gap-1 text-sm">{f.label}{mandatory(f)?"":" (opcional)"}
      {f.choices?<select name={f.name} multiple={f.multiple} value={values[f.name] as string|string[]} disabled={disabled||pending||f.disabled} className={`rounded-md border bg-background px-3 py-2${bad(f.name)}`} onChange={e=>{setValues({...values,[f.name]:f.multiple?Array.from(e.target.selectedOptions,o=>o.value):e.target.value});clear(f.name);}}>
        {!f.multiple&&<option value="">Selecciona…</option>}{f.choices.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
      </select>:<Input name={f.name} type={f.type??"text"} step={f.type==="number"?"any":undefined} value={str(values[f.name])} disabled={disabled||pending||f.disabled} className={bad(f.name)} onChange={e=>{setValues({...values,[f.name]:e.target.value});clear(f.name);}}/>}
    </label>)}</div>
    <Button type="submit" size="sm" disabled={disabled||pending||missing.length>0}>{pending?"Guardando…":title}</Button>
  </form>;
}
const authChoices=Object.entries(AUTHORIZATION_LABELS).map(([value,label])=>({value,label}));
function History({title,rows,tz}:{title:string;rows:WorkflowRow[];tz:string}) {
  const labels:Record<string,string>={requested:"Solicitada",confirmed:"Confirmada",rejected:"Rechazada",cancelled:"Cancelada",fulfilled:"Cumplida",partial:"Parcial",incident:"Incidencia",resolved:"Resuelta",reserved:"Reserva registrada",released:"Reserva liberada",configured:"Datos comerciales guardados",authorized:"Autorización registrada",assigned:"Responsable asignado",purchase:"Cambio de compra",material_received:"Material recibido",material_reviewed:"Revisión de material",evidence:"Evidencia registrada",delivery:"Cumplimiento registrado",amended:"Acuerdo modificado"};
  return <details className="rounded border p-3"><summary className="cursor-pointer text-sm">{title} ({rows.length})</summary><div className="max-h-96 space-y-3 overflow-auto">{rows.map(r=>{
    const snap=r.snapshot as WorkflowRow|undefined,payload=r.payload as WorkflowRow|undefined;
    const value=(k:string)=>str(r[k]??payload?.[k]);
    const state=value("status")||value("kind");
    return <article key={str(r.id)} className="space-y-1 border-t py-3 text-sm">
      <p className="text-xs text-muted-foreground">{formatDateTime(str(r.created_at),tz)} · {str(r.created_by)||"Actor histórico no registrado"}</p>
      {state&&<p>{labels[state]??state}</p>}
      {r.revision!=null&&<p>Versión {str(r.revision)}</p>}
      {value("reference")&&<p>Referencia: {value("reference")}</p>}
      {r.cost_minor!=null&&<p>Costo: {formatMoney(Number(r.cost_minor),str(r.currency))}</p>}
      {value("reason")&&<p>Motivo: {value("reason")}</p>}
      {value("resolution")&&<p>Resolución: {value("resolution")}</p>}
      {r.delivered_slots_days!=null&&<p>Cumplido: {str(r.delivered_slots_days)} slots-día</p>}
      {r.coverage_from!=null&&<p>Cobertura: {formatDateTime(str(r.coverage_from),tz)} → {formatDateTime(str(r.coverage_to),tz)} · {str(r.evidence_kind)}</p>}
      {r.photo_url!=null&&<a className="underline" href={str(r.photo_url)} target="_blank" rel="noreferrer">Abrir soporte</a>}
      {value("responsible_email")&&<p>Responsable: {value("responsible_email")}</p>}
      {payload?.review!=null&&<p>Revisión: {payload.review==="technical"?"Técnica":"Contenido"} · {labels[str(payload.status)]??str(payload.status)}</p>}
      {snap&&<div className="space-y-1"><p>Anunciante: {str((snap.advertiser as WorkflowRow)?.name)} · Contratante: {str((snap.billing as WorkflowRow)?.name)}</p><p>Venta: {formatMoney(Number(snap.gross_minor),str(snap.currency))} · Plazo de pago: {str(snap.payment_terms_days)} días</p>
        {Array.isArray(snap.lines)&&snap.lines.map((l:WorkflowRow,i:number)=><p key={i}>{str(l.screen_name)} · {formatDate(str(l.starts),tz)} → {formatDate(str(l.ends),tz)} · {str(l.days)} días × {str(l.slots)} slots · {formatMoney(Number(l.total_minor),str(snap.currency))}</p>)}
        {snap.commercial_terms!=null&&<p>Condiciones: {str((snap.commercial_terms as WorkflowRow).notes)||"Sin observaciones"} · {str((snap.commercial_terms as WorkflowRow).service_clauses)}</p>}
      </div>}
    </article>;
  })}</div></details>;
}
export function OrderWorkspace({detail:d,options,selectedLine}:{detail:OrderDetail;options:WorkspaceOptions;selectedLine?:string}) {
  const {order:o,lines,workflow:w}=d,{tz,canEdit,canReview}=options;
  const id=str(o.id),rev=Number(o.workflow_rev??0),draft=o.status==="draft",signed=o.status==="signed";
  const auth=authorizationKind(o),tasks=operationalTasks(o,lines,d.io_agency_orders,d.creatives,d.photos,w.purchases,w.deliveries,options.now);
  const missingConfirmation=confirmationRequirements(o);
  const money=purchaseMargin(o,lines,w.purchases);
  const base={orderId:id,revision:rev};
  const local=(instant:unknown)=>toTenantDateTimeInput(str(instant),tz);
  const instant=(v:unknown)=>fromTenantDateTimeInput(str(v),tz);
  const contactChoices=options.contacts.map(c=>({value:c.id,label:`${c.name} · ${options.companies.find(b=>b.id===c.company_id)?.name??c.company_id}`}));
  const lineChoices=lines.map(l=>({value:str(l.id),label:`${str(l.screen_name)} · ${formatDate(dayOf(str(l.starts_at),tz),tz)} → ${formatDate(displayEndOf(str(l.ends_at),tz),tz)}`}));
  return <div className="space-y-6 py-5">
    <header><h1 className="text-2xl font-semibold">{str(o.io_number)} · {str(o.brand)}</h1><p className="text-muted-foreground">{commercialState(o,options.now)} · {d.advertiser_name} · {str(o.currency)} · Zona horaria: {tz}</p><Link className="text-sm underline" href={`/orders/${id}/print`}>Documento comercial</Link></header>
    <nav className="flex flex-wrap gap-4 text-sm underline">{["comercial","lineas","materiales","versiones","facturacion"].map(a=><a key={a} href={`#${a}`}>{a}</a>)}</nav>
    <section className="rounded-lg border p-4"><h2 className="font-semibold">Pendientes de esta orden</h2>{tasks.length?tasks.map(t=><p key={t.key} className={t.overdue?"text-destructive":""}><a className="underline" href={t.lineId?`#line-${t.lineId}`:"#comercial"}>{t.title}</a> · {t.responsible??"Sin responsable"} · {t.dueAt?formatDateTime(t.dueAt,tz):"Sin vencimiento"}{t.overdue?" · Vencida":""}</p>):<p>Sin pendientes operativos abiertos.</p>}</section>
    <section id="comercial" className="space-y-3"><h2 className="text-lg font-semibold">Acuerdo y reserva</h2>
      <p>Responsable: {str(o.responsible_email)||"Sin asignar"}. Documento requerido: {auth?AUTHORIZATION_LABELS[auth]:"Sin definir"}. Autorización: {d.readiness.authorized?"Registrada para versión vigente":"Pendiente"}.</p>
      {canEdit&&<CommandForm {...base} title="Asignar responsable" fields={[{name:"email",label:"Responsable del equipo",value:str(o.responsible_email),choices:options.members.map(m=>({value:m.email,label:m.email}))}]} build={v=>({...v,kind:"assign"})}/>}
      {draft&&canEdit&&<>
        <Link className="text-sm underline" href={`/orders?order=${id}`}>Editar pantallas y datos de la cotización</Link>
        {missingConfirmation.length>0&&<p className="text-sm">Falta para confirmar: {missingConfirmation.join(", ")}.</p>}
        <p>La cotización no aparta inventario. La reserva es local; la compra al proveedor se confirma por separado.</p>
        <CommandForm {...base} title={consumesCapacity(o,options.now)?"Cambiar vencimiento de reserva":"Reservar inventario"} fields={[{name:"expires",label:"Vence (24 horas por defecto, editable)",type:"datetime-local",value:local(consumesCapacity(o,options.now)?o.reservation_expires_at:new Date(options.now+DAY_MS).toISOString())}]} build={v=>({kind:"reserve",expires:instant(v.expires)})}/>
        {consumesCapacity(o,options.now)&&<CommandForm {...base} title="Liberar reserva" build={()=>({kind:"release"})}/>}
        <CommandForm {...base} title="Guardar datos para confirmar" fields={[
          {name:"billingId",label:"Contratante",value:str(o.billing_company_id),choices:options.companies.map(c=>({value:c.id,label:c.name}))},
          {name:"billingContactId",label:"Contacto de facturación (del contratante)",value:str(o.billing_contact_id),choices:contactChoices},
          {name:"signerContactId",label:"Firmante (del contratante)",value:str(o.signer_contact_id),choices:contactChoices},
          {name:"paymentTermsDays",label:"Plazo de pago (días; 0 = contado)",type:"number",value:str(o.payment_terms_days)},
          {name:"authorizationKind",label:"Documento de autorización",value:auth??"",choices:authChoices},
          {name:"responsibleEmail",label:"Responsable del equipo",value:str(o.responsible_email),choices:options.members.map(m=>({value:m.email,label:m.email}))},
          {name:"commissionPct",label:"Comisión de agencia (%)",type:"number",value:str(o.commission_pct),optional:true,disabled:!canReview},
        ]} build={v=>({...v,kind:"configure",paymentTermsDays:Number(v.paymentTermsDays),commissionPct:numberOrNull(v.commissionPct)})}/>
        <CommandForm {...base} title="Confirmar acuerdo" disabled={missingConfirmation.length>0} build={()=>({kind:"confirm"})}><p className="text-sm text-muted-foreground">Valida capacidad de nuevo y conserva una versión inmutable de precios, cantidades, fechas, contactos y condiciones.</p></CommandForm>
      </>}
      {signed&&canEdit&&<CommandForm {...base} title={`Registrar ${auth?AUTHORIZATION_LABELS[auth]:"autorización"} · versión ${str(o.agreement_revision)}`} fields={[{name:"url",label:"Documento / aceptación (URL)",type:"url"}]} build={v=>({...v,kind:"authorize"})}/>}
    </section>
    <section id="lineas" className="space-y-4"><h2 className="text-lg font-semibold">Líneas, proveedores y cumplimiento</h2>
      <div className="rounded border p-4 text-sm">Venta: {formatMoney(money.salesMinor,str(o.currency))} · Costo externo: {money.externalCostMinor===null?"Pendiente":formatMoney(money.externalCostMinor,str(o.currency))} · Comisión: {money.commissionMinor===null?"Pendiente":formatMoney(money.commissionMinor,str(o.currency))} · Margen: {money.marginMinor===null?"Sin determinar":formatMoney(money.marginMinor,str(o.currency))}{money.missing.map(m=><p key={m}>{m}</p>)}</div>
      {lines.map(l=>{const lid=str(l.id),external=!!l.supplier_company_id,ev=d.photos.filter(e=>e.line_id===lid);return <article key={lid} id={`line-${lid}`} className={`scroll-mt-6 space-y-3 rounded-lg border p-4 ${selectedLine===lid?"ring-2 ring-primary":""}`}>
        <h3 className="font-medium">{str(l.screen_name)}</h3><p className="text-sm">{formatDate(dayOf(str(l.starts_at),tz),tz)} → {formatDate(displayEndOf(str(l.ends_at),tz),tz)} · {str(l.cant_dias)} días × {str(l.cant_slots)} slots · {formatMoney(Number(l.rate_minor),str(o.currency))}</p>
        <p className="text-sm">{external?`Proveedor externo: ${supplierConfirmed(l,w.purchases)?"confirmado":"pendiente"}`:"Pantalla propia"} · Material {materialCovers(lid,d.creatives)?"aprobado":"pendiente"} · Entrega {deliveryCovered(l,w.deliveries,d.photos)?"certificada / resuelta":"pendiente"}</p>
        {external&&canEdit&&o.status!=="draft"&&<CommandForm {...base} title="Registrar estado de compra" fields={[
          {name:"status",label:"Estado",choices:["requested","confirmed","rejected","cancelled"].map((value,i)=>({value,label:["Solicitada","Confirmada","Rechazada","Cancelada"][i]}))},
          {name:"costMinor",label:"Costo total externo (importe)",optional:true,requiredWhen:{field:"status",values:["confirmed"]}},{name:"currency",label:"Moneda ISO del costo",value:str(o.currency),optional:true,requiredWhen:{field:"status",values:["confirmed"]}},
          {name:"reference",label:"Referencia de la solicitud / confirmación"},{name:"reason",label:"Motivo",optional:true,requiredWhen:{field:"status",values:["rejected","cancelled"]}},
        ]} build={v=>({...v,kind:"purchase",lineId:lid,costMinor:str(v.costMinor)?minor(v.costMinor):null,currency:str(v.currency)||null})}/>}
        {signed&&canEdit&&<>
          <CommandForm {...base} title="Añadir evidencia de esta línea" fields={[
            {name:"url",label:"URL del archivo",type:"url"},{name:"evidenceKind",label:"Tipo",choices:[{value:"photo",label:"Foto puntual (máx. 24 h)"},{value:"supplier_report",label:"Reporte del proveedor"},{value:"play_log",label:"Registro de emisión"}]},
            {name:"from",label:"Cobertura desde",type:"datetime-local",value:local(l.starts_at)},{name:"to",label:"Cobertura hasta (fin exclusivo)",type:"datetime-local",value:local(new Date(Math.min(Date.parse(str(l.ends_at)),options.now)).toISOString())},
            {name:"takenAt",label:"Fecha real de la evidencia",type:"datetime-local",value:local(new Date(options.now).toISOString())},
          ]} build={v=>({...v,kind:"evidence",lineId:lid,from:instant(v.from),to:instant(v.to),takenAt:instant(v.takenAt)})}/>
          <CommandForm {...base} title="Confirmar cumplimiento manual" fields={[
            {name:"status",label:"Resultado",choices:[{value:"fulfilled",label:"Cumplida: exige evidencia completa"},{value:"partial",label:"Parcial"},{value:"incident",label:"Incidencia"},...(canReview?[{value:"resolved",label:"Resolución administrativa explícita"}]:[])]},
            {name:"evidenceId",label:"Evidencia de esta línea",optional:true,requiredWhen:{field:"status",values:["fulfilled"]},choices:ev.map(e=>({value:str(e.id),label:`${str(e.evidence_kind)} · ${formatDateTime(str(e.coverage_from),tz)} → ${formatDateTime(str(e.coverage_to),tz)}`}))},
            {name:"quantity",label:`Cantidad cumplida (slots × días; contratado ${Number(l.cant_slots)*Number(l.cant_dias)})`,type:"number"},
            {name:"resolution",label:"Motivo / resolución",optional:true,requiredWhen:{field:"status",values:["partial","incident","resolved"]}},
          ]} build={v=>({...v,kind:"delivery",lineId:lid,evidenceId:str(v.evidenceId)||null,quantity:Number(v.quantity)})}/>
        </>}
        <History tz={tz} title="Compras" rows={w.purchases.filter(p=>p.line_id===lid)}/><History tz={tz} title="Evidencias" rows={ev}/><History tz={tz} title="Confirmaciones e incidencias" rows={w.deliveries.filter(p=>p.line_id===lid)}/>
      </article>;})}
    </section>
    <section id="materiales" className="space-y-3"><h2 className="text-lg font-semibold">Materiales y revisiones</h2>
      {signed&&canEdit&&<CommandForm {...base} title="Recibir material pendiente de revisión" fields={[
        {name:"url",label:"URL del material",type:"url"},{name:"lineIds",label:"Líneas a las que aplica (selección múltiple)",choices:lineChoices,multiple:true},
        {name:"supersedes",label:"Reemplaza versión",optional:true,choices:d.creatives.filter(c=>!c.superseded_at).map(c=>({value:str(c.id),label:str(c.name)}))},
        {name:"duration",label:"Duración (segundos)",type:"number",optional:true},{name:"width",label:"Ancho (px)",type:"number",optional:true},{name:"height",label:"Alto (px)",type:"number",optional:true},
      ]} build={v=>({...v,kind:"receive",supersedes:str(v.supersedes)||undefined,duration:numberOrNull(v.duration),width:numberOrNull(v.width),height:numberOrNull(v.height)})}/>}
      {d.creatives.map(c=><article key={str(c.id)} className="space-y-2 rounded border p-4"><a className="underline" href={str(c.file_url)} target="_blank" rel="noreferrer">{str(c.name)}</a><p className="text-sm">{c.superseded_at?"Reemplazado":"Vigente"} · Técnica: {str(c.qc_status)} ({str(c.qc_reviewed_by)||"sin revisión explícita"}) · Contenido: {str(c.legal_status)} ({str(c.legal_reviewed_by)||"sin revisión explícita"})</p>
        <p className="text-xs">Líneas: {Array.isArray(c.line_ids)?c.line_ids.map(id=>lineChoices.find(l=>l.value===id)?.label??str(id)).join("; "):"Sin asignar"}</p>
        {signed&&canEdit&&!c.superseded_at&&<CommandForm {...base} title="Registrar revisión" fields={[
          {name:"review",label:"Revisión",choices:[{value:"technical",label:"Técnica"},...(canReview?[{value:"content",label:"Contenido / legal"}]:[])]},
          {name:"status",label:"Decisión",choices:[{value:"approved",label:"Aprobar"},{value:"rejected",label:"Rechazar"}]},{name:"reason",label:"Observación / motivo",optional:true,requiredWhen:{field:"status",values:["rejected"]}},
        ]} build={v=>({...v,kind:"review",materialId:str(c.id)})}/>}
      </article>)}
    </section>
    <section id="versiones" className="space-y-3"><h2 className="text-lg font-semibold">Versiones del acuerdo</h2><History tz={tz} title="Acuerdos aceptados (inmutables)" rows={w.versions}/>
      {signed&&canEdit&&<details><summary className="cursor-pointer underline">Modificar acuerdo con motivo y nueva versión</summary><CommandForm {...base} title="Aceptar modificación" fields={[
        {name:"reason",label:"Motivo del cambio"},{name:"paymentTermsDays",label:"Plazo de pago (días)",type:"number",value:str(o.payment_terms_days)},
        {name:"authorizationKind",label:"Documento requerido para la nueva versión",choices:authChoices,value:auth??""},
        {name:"commissionPct",label:"Comisión (%)",optional:true,type:"number",value:str(o.commission_pct),disabled:!canReview},{name:"notes",label:"Condiciones / notas",optional:true,value:str(o.notes)},
        ...lines.flatMap((l,i):Field[]=>[{name:`starts${i}`,label:`${str(l.screen_name)} · Desde`,type:"date",value:dayOf(str(l.starts_at),tz)},{name:`ends${i}`,label:"Hasta (inclusive)",type:"date",value:displayEndOf(str(l.ends_at),tz)},{name:`slots${i}`,label:"Slots diarios",type:"number",value:str(l.cant_slots)},{name:`total${i}`,label:"Importe total de venta",value:(Number(l.rate_minor)/100).toFixed(2)}]),
      ]} build={v=>({kind:"amend",reason:v.reason,notes:v.notes,paymentTermsDays:Number(v.paymentTermsDays),authorizationKind:v.authorizationKind,commissionPct:numberOrNull(v.commissionPct),lines:lines.map((l,i)=>({id:str(l.id),starts:v[`starts${i}`],ends:v[`ends${i}`],slots:Number(v[`slots${i}`]),totalMinor:minor(v[`total${i}`])}))})}><p className="text-sm">Conserva las versiones anteriores. Exige nueva autorización; las compras y certificaciones deben corresponder a las cantidades y fechas vigentes.</p></CommandForm></details>}
      <History tz={tz} title="Historial de operaciones" rows={w.events}/>
    </section>
    <section id="facturacion"><h2 className="text-lg font-semibold">Facturación y cobros</h2><p>{d.invoices.length} facturas. El cobro se administra por separado del cumplimiento.</p><Link className="underline" href={`/orders?order=${id}&tab=cobranza`}>Abrir facturas y pagos de esta orden</Link></section>
  </div>;
}
