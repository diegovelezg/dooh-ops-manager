import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { before, after, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, pointAppAt, type TestDb } from "./helpers/surreal-test-db";
import * as rules from "../lib/order-workflow";
import { fromTenantDateTimeInput, toTenantDateTimeInput } from "../lib/format";
let t:TestDb,orders:typeof import('../lib/orders-store'),flow:typeof import('../lib/order-workflow-store'),reads:typeof import('../lib/orders-db'),db:typeof import('../lib/surreal'),screens:typeof import('../lib/screens-store');
const store='a',actor='owner@x.pe';
const q=async(sql:string,vars?:Record<string,unknown>)=>{const result=await t.root.query(sql,vars).collect();return result.at(-1);};
const rev=async(id:string)=>Number((await orders.getOrder(store,id))?.workflow_rev);
const screen=async(name:string,external=false)=>screens.createScreenWithVenue(store,{name,city:'Lima',district:null,address:null,latitude:null,longitude:null,country:'PE',ownership:external?'supplier':'own',supplier_company_id:external?'provider':null},{name,source:'manual',width_px:1920,height_px:1080,duration_sec:10});
const quote=async(s:string,slots=1,day='2026-10-01')=>orders.createOrderWithLines(store,{advertiser_company_id:'advertiser',brand:'Brand',currency:'PEN'},[{screen_id:s,starts:day,ends:day,slots,total:100}],actor);
const configure=async(id:string,auth:rules.AuthorizationKind='CONTRACT')=>flow.configureOrder(store,id,await rev(id),{billingId:'advertiser',billingContactId:'contact',signerContactId:'contact',paymentTermsDays:30,authorizationKind:auth,responsibleEmail:actor,commissionPct:null},actor);
const confirm=async(id:string)=>{await configure(id);await flow.confirmOrder(store,id,await rev(id),actor);};
before(async()=>{
 t=await createTestDb();pointAppAt(t);
 [orders,flow,reads,db,screens]=await Promise.all([import('../lib/orders-store'),import('../lib/order-workflow-store'),import('../lib/orders-db'),import('../lib/surreal'),import('../lib/screens-store')]);
 await q(`CREATE sys_store:a SET name='A'; CREATE sys_store:b SET name='B'; CREATE user:u SET email=$actor,password='x'; RELATE user:u->member_of->sys_store:a SET role='owner'; CREATE crm_company:advertiser SET store=sys_store:a,name='Advertiser',kind='anunciante'; CREATE crm_company:provider SET store=sys_store:a,name='Provider',kind='proveedor'; CREATE crm_contact:contact SET store=sys_store:a,company=crm_company:advertiser,first_name='Person',email='contact@x.pe';`,{actor});
});
after(async()=>{await db?.closeDb();await t?.drop();});
it('cotizaciones no consumen; reserva explícita sí; confirmar revalida y no duplica el propio cupo',async()=>{
 const s=await screen('capacity'),a=await quote(s,10),b=await quote(s,10);
 assert.equal(rules.consumesCapacity((await orders.getOrder(store,a))!),false);
 await flow.reserveOrder(store,a,await rev(a),new Date(Date.now()+86400000).toISOString(),actor);
 await assert.rejects(flow.reserveOrder(store,b,await rev(b),new Date(Date.now()+86400000).toISOString(),actor),e=>/sin slots/.test(db.thrownMessage(e)));
 await configure(b);await assert.rejects(flow.confirmOrder(store,b,await rev(b),actor),e=>/sin slots/.test(db.thrownMessage(e)));
 await confirm(a);assert.equal((await orders.getOrder(store,a))?.status,'signed');
 assert.equal((await reads.getOrderDetail(store,a))?.workflow.versions.length,1);
});
it('reservas concurrentes comparten bloqueo por pantalla; exactamente dos de 4 slots en cupo 10',async()=>{
 const s=await screen('race');const ids=await Promise.all(Array.from({length:8},()=>quote(s,4)));
 const results=await Promise.allSettled(ids.map(async id=>flow.reserveOrder(store,id,await rev(id),new Date(Date.now()+86400000).toISOString(),actor)));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,2);
});
it('expiración libera inventario; revisión obsoleta y tenant ajeno no escriben',async()=>{
 const s=await screen('expiry'),id=await quote(s,10),other=await quote(s,10);
 await flow.reserveOrder(store,id,await rev(id),new Date(Date.now()+86400000).toISOString(),actor);
 await q("UPDATE type::record('io_order',$id) SET reservation_expires_at=time::now()-1s",{id});
 await flow.reserveOrder(store,other,await rev(other),new Date(Date.now()+86400000).toISOString(),actor);
 await assert.rejects(flow.reserveOrder(store,other,0,new Date(Date.now()+86400000).toISOString(),actor));
 await assert.rejects(flow.releaseOrder('b',other,actor));
});
it('confirmación exige datos administrativos y contraparte activa',async()=>{
 const id=await quote(await screen('required'));
 await assert.rejects(flow.confirmOrder(store,id,await rev(id),actor));
 await configure(id);await q('UPDATE crm_contact:contact SET deleted_at=time::now()');
 await assert.rejects(flow.confirmOrder(store,id,await rev(id),actor));
 await q('UPDATE crm_contact:contact SET deleted_at=NONE');
 await flow.confirmOrder(store,id,await rev(id),actor);
});
it('compras externas son explícitas, moneda distinta deja margen desconocido y cada cambio se conserva',async()=>{
 const id=await quote(await screen('external',true));await confirm(id);
 const d=(await reads.getOrderDetail(store,id))!,line=d.lines[0],lid=String(line.id);
 assert.equal(rules.purchaseMargin(d.order,d.lines,[]).marginMinor,null);
 await assert.rejects(flow.recordPurchase(store,id,await rev(id),actor,{lineId:lid,status:'confirmed',costMinor:null,currency:null,reference:'mail-1',reason:''}));
 await flow.recordPurchase(store,id,await rev(id),actor,{lineId:lid,status:'requested',costMinor:null,currency:null,reference:'request-1',reason:''});
 await flow.recordPurchase(store,id,await rev(id),actor,{lineId:lid,status:'confirmed',costMinor:2500,currency:'USD',reference:'accept-1',reason:''});
 let current=(await reads.getOrderDetail(store,id))!;assert.equal(rules.purchaseMargin(current.order,current.lines,current.workflow.purchases).marginMinor,null);
 await flow.recordPurchase(store,id,await rev(id),actor,{lineId:lid,status:'confirmed',costMinor:2500,currency:'PEN',reference:'accept-2',reason:''});
 current=(await reads.getOrderDetail(store,id))!;assert.equal(rules.purchaseMargin(current.order,current.lines,current.workflow.purchases).marginMinor,7500);assert.equal(current.workflow.purchases.length,3);
});
it('material entra pendiente, revisión técnica comprueba especificaciones; nueva versión no hereda aprobaciones',async()=>{
 const id=await quote(await screen('material'));await confirm(id);const line=(await reads.getOrderDetail(store,id))!.lines[0];
 await flow.receiveMaterial(store,id,await rev(id),actor,{url:'https://x.pe/video.mp4',lineIds:[String(line.id)],width:100,height:100,duration:20});
 let d=(await reads.getOrderDetail(store,id))!,material=String(d.creatives[0].id);assert.equal(d.creatives[0].qc_status,'pending');
 await assert.rejects(flow.reviewMaterial(store,id,await rev(id),actor,{materialId:material,review:'technical',status:'approved',reason:''}));
 await flow.receiveMaterial(store,id,await rev(id),actor,{url:'https://x.pe/v2.mp4',lineIds:[String(line.id)],width:1920,height:1080,duration:10,supersedes:material});
 d=(await reads.getOrderDetail(store,id))!;material=String(d.creatives.find(c=>!c.superseded_at)!.id);
 for(const review of ['technical','content'] as const)await flow.reviewMaterial(store,id,await rev(id),actor,{materialId:material,review,status:'approved',reason:''});
 d=(await reads.getOrderDetail(store,id))!;assert.equal(d.readiness.materials,true);
 await flow.receiveMaterial(store,id,await rev(id),actor,{url:'https://x.pe/v3.mp4',lineIds:[String(line.id)],supersedes:material});
 assert.equal((await reads.getOrderDetail(store,id))!.readiness.materials,false);
});
it('evidencia sola no certifica; certificación manual por línea y periodo; modificación invalida autorización y entrega previas',async()=>{
 const id=await quote(await screen('evidence'));await confirm(id);let d=(await reads.getOrderDetail(store,id))!;const l=d.lines[0],lid=String(l.id);
 await flow.registerAuthorization(store,id,await rev(id),'https://x.pe/contract.pdf',actor);
 d=(await reads.getOrderDetail(store,id))!;assert.equal(d.readiness.authorized,true);assert.equal(d.io_agency_orders[0].kind,'CONTRACT');
 await flow.recordEvidence(store,id,await rev(id),actor,{lineId:lid,url:'https://x.pe/report.pdf',kind:'supplier_report',from:String(l.starts_at),to:String(l.ends_at),takenAt:new Date().toISOString()});
 d=(await reads.getOrderDetail(store,id))!;assert.equal(d.readiness.certified,false);
 await flow.certifyDelivery(store,id,await rev(id),actor,{lineId:lid,evidenceId:String(d.photos[0].id),status:'fulfilled',quantity:1,resolution:''});
 d=(await reads.getOrderDetail(store,id))!;assert.equal(d.readiness.certified,true);
 const original=d.workflow.versions[0].snapshot;
 await flow.amendOrder(store,id,await rev(id),actor,{reason:'Extensión acordada',paymentTermsDays:30,notes:'Nuevo plazo',authorizationKind:'OC',commissionPct:null,lines:[{id:lid,starts:'2026-10-01',ends:'2026-10-02',slots:1,totalMinor:15000}]});
 d=(await reads.getOrderDetail(store,id))!;assert.equal(d.workflow.versions.length,2);assert.deepEqual(d.workflow.versions.find(v=>v.revision===1)!.snapshot,original);assert.equal(d.readiness.authorized,false);assert.equal(d.readiness.certified,false);
 await assert.rejects(q("UPDATE io_order_version SET reason='edit'"));
 await assert.rejects(q("DELETE io_delivery"));
});
it('una foto y una aprobación no cubren otra línea; tareas desaparecen al resolver y no se duplican',()=>{
 const l={id:'l',screen_id:'s',cant_slots:1,cant_dias:1,starts_at:'2026-01-01T00:00:00Z',ends_at:'2026-01-02T00:00:00Z'},l2={...l,id:'l2'};
 const o={id:'o',status:'signed',authorization_kind:'OC',agreement_revision:1,responsible_email:actor};
 const doc={kind:'OC',agreement_revision:1,document_url:'https://x.pe/doc'};
 const c={line_ids:['l'],qc_status:'approved',legal_status:'approved',qc_reviewed_at:'date',legal_reviewed_at:'date'};
 const e={id:'e',line_id:'l',coverage_from:l.starts_at,coverage_to:l.ends_at};
 const d={line_id:'l',status:'fulfilled',evidence_id:'e',delivered_slots_days:1,terms:rules.lineTerms(l),sequence:1};
 assert.equal(rules.deliveriesCovered([l,l2],[d],[e]),false);
 assert.equal(rules.deliveriesCovered([l,...Array.from({length:9},(_,i)=>({...l,id:`other-${i}`}))],[d],[e]),false);
 assert.deepEqual(rules.operationalTasks(o,[l],[doc],[c],[e],[],[d]),[]);
 const tasks=rules.operationalTasks(o,[l,l2],[doc],[c],[e],[],[d]);assert.equal(tasks.length,2);assert.equal(new Set(tasks.map(t=>t.key)).size,tasks.length);assert.ok(tasks.every(t=>t.lineId==='l2'&&t.responsible===actor&&t.overdue));
});
it('horarios de reserva respetan zona del tenant y rechazan horas DST inexistentes o ambiguas',()=>{
 assert.equal(fromTenantDateTimeInput('2026-11-15T14:30','America/Lima'),'2026-11-15T19:30:00.000Z');
 assert.equal(toTenantDateTimeInput('2026-11-15T19:30:00Z','America/Lima'),'2026-11-15T14:30');
 assert.throws(()=>fromTenantDateTimeInput('2026-03-08T02:30','America/New_York'));
 assert.throws(()=>fromTenantDateTimeInput('2026-11-01T01:30','America/New_York'));
});

it('acciones con sesiones reales: viewer no escribe, seller no aprueba contenido y admin sí; tenant ajeno se rechaza',async()=>{
 const id=await quote(await screen('roles'));await confirm(id);
 const lid=String((await reads.getOrderDetail(store,id))!.lines[0].id);
 await flow.receiveMaterial(store,id,await rev(id),actor,{url:'https://x.pe/roles.mp4',lineIds:[lid],width:1920,height:1080,duration:10});
 const material=String((await reads.getOrderDetail(store,id))!.creatives[0].id);
 const tokens:Record<string,string>={};
 for(const role of ['viewer','seller','admin']){
   await q("CREATE type::record('user',$role) SET email=string::concat($role,'@roles.pe'),password=crypto::bcrypt::generate('test-role-pass'); LET $u=type::record('user',$role); RELATE $u->member_of->sys_store:a SET role=$role",{role});
   tokens[role]=(await t.signin(`${role}@roles.pe`,'test-role-pass')).access;
 }
 const web=resolve(import.meta.dirname,'..');
 const script=`
 import assert from 'node:assert/strict';
 import { createRequire } from 'node:module';
 const require=createRequire(${JSON.stringify(resolve(web,'package.json'))});
 const headers=require('next/headers');
 let token='';headers.cookies=async()=>({get:()=>({value:token})});
 require.cache[require.resolve('next/cache')]={exports:{revalidatePath(){}}};
 const {runOrderWorkflowAction:run}=await import(${JSON.stringify(resolve(web,'lib/order-workflow-actions.ts'))});
 const {getOrder}=await import(${JSON.stringify(resolve(web,'lib/orders-store.ts'))});
 const {closeDb}=await import(${JSON.stringify(resolve(web,'lib/surreal.ts'))});
 const tokens=JSON.parse(process.env.ROLE_TOKENS);
 const input={orderId:process.env.ROLE_ORDER,revision:0,command:{kind:'review',materialId:process.env.ROLE_MATERIAL,review:'content',status:'approved',reason:''}};
 try {
   token=tokens.viewer;assert.equal((await run({...input,command:{kind:'release'}})).ok,false);
   token=tokens.seller;assert.equal((await run(input)).ok,false);
   token=tokens.admin;input.revision=Number((await getOrder('a',input.orderId)).workflow_rev);const approved=await run(input);assert.equal(approved.ok,true,approved.message);
   const other=await run({...input,orderId:'foreign'});assert.equal(other.ok,false);
 }finally{await closeDb();}
 `;
 const child=spawnSync(process.execPath,['--conditions=react-server','--import=tsx','--input-type=module','-e',script],{cwd:web,env:{...process.env,ROLE_TOKENS:JSON.stringify(tokens),ROLE_ORDER:id,ROLE_MATERIAL:material},encoding:'utf8',timeout:30000});
 assert.equal(child.status,0,child.stderr||String(child.error));
});
it('orden mixta cancelada conserva compras, versiones, facturas y abonos; mantiene pendientes de resolución y cobro',async()=>{
 const own=await screen('cancel-own'),external=await screen('cancel-external',true);
 const id=await orders.createOrderWithLines(store,{advertiser_company_id:'advertiser',brand:'Mixta',currency:'PEN'},[own,external].map(screen_id=>({screen_id,starts:'2026-10-01',ends:'2026-10-01',slots:1,total:100})),actor);
 await confirm(id);let d=(await reads.getOrderDetail(store,id))!;const externalLine=d.lines.find(l=>l.supplier_company_id)!;
 await flow.recordPurchase(store,id,await rev(id),actor,{lineId:String(externalLine.id),status:'confirmed',costMinor:2000,currency:'PEN',reference:'compromiso externo',reason:''});
 const invoice=await orders.createInvoice(store,id,{number:'CANCEL-F1',amount_minor:10000,currency:'PEN',status:'issued',issue_date:'2026-10-01',due_date:'2026-10-31'});
 await orders.recordInvoicePayment(invoice,{requestId:'cancel-pay',amountMinor:3000,paidOn:'2026-11-01',reference:'abono'},actor);
 await flow.cancelOrder(store,id,await rev(id),actor);
 d=(await reads.getOrderDetail(store,id))!;
 assert.equal(d.order.status,'cancelled');assert.equal(d.lines.length,2);assert.equal(d.workflow.purchases.length,1);assert.equal(d.workflow.versions.length,1);assert.equal(d.invoices.length,1);
 assert.ok(d.workflow.events.some(e=>e.kind==='cancelled'&&e.created_by===actor));
 const tasks=await (await import('../lib/order-tasks')).listOperationalTasks(store);
 assert.ok(tasks.some(t=>t.orderId===id&&t.kind==='supplier_cancel'));
 assert.ok(tasks.some(t=>t.orderId===id&&t.kind==='payment'&&t.overdue&&t.title.includes('70.00')));
 await flow.recordPurchase(store,id,await rev(id),actor,{lineId:String(externalLine.id),status:'cancelled',costMinor:null,currency:null,reference:'proveedor libera',reason:'Cancelación aceptada sin penalidad'});
 assert.equal((await (await import('../lib/order-tasks')).listOperationalTasks(store)).some(t=>t.orderId===id&&t.kind==='supplier_cancel'),false);
});
