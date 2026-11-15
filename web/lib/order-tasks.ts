import { selectOrders, listChildrenOf } from "@/lib/orders-store";
import { workflowRows } from "@/lib/order-workflow-reads";
import { operationalTasks, type OperationalTask } from "@/lib/order-workflow";
import { billingStatus, toBillingInvoice, invoiceDueDay } from "@/lib/billing-status";
import { dayStart } from "@/lib/format";
import { getStoreTimeZone } from "@/lib/stores-db";
/** Derivadas del estado actual: sin persistencia duplicada ni generación por LLM. */
export async function listOperationalTasks(store:string):Promise<OperationalTask[]> {
  const orders=await selectOrders(store);
  const ids=orders.map(o=>String(o.id));
  const [children,w,tz]=await Promise.all([listChildrenOf(store,ids),workflowRows(store,ids),getStoreTimeZone(store)]);
  const {lines,oms,creatives,photos,invoices}=children,now=Date.now();
  const tasks:OperationalTask[]=[];
  for(const o of orders){
    const id=String(o.id),own=lines.filter(l=>l.io_id===id);
    tasks.push(...operationalTasks(o,own,oms.filter(x=>x.io_id===id),creatives.filter(x=>x.io_id===id),photos.filter(x=>x.io_id===id),w.purchases,w.deliveries,now));
    if(o.status==="draft")continue;
    for(const inv of invoices.filter(i=>i.io_id===id)){
      const bill=billingStatus({gross_minor:Number(inv.amount_minor),invoices:[toBillingInvoice(inv)],payment_terms_days:typeof o.payment_terms_days==="number"?o.payment_terms_days:null,now,tz});
      if(bill.pending_minor<=0)continue;
      const due=invoiceDueDay(toBillingInvoice(inv),typeof o.payment_terms_days==="number"?o.payment_terms_days:null);
      tasks.push({key:`${id}:payment:${String(inv.id)}`,kind:"payment",title:`Cobrar factura ${String(inv.number)} · ${String(inv.currency)} ${(bill.pending_minor/100).toFixed(2)}`,orderId:id,lineId:null,responsible:typeof o.responsible_email==="string"?o.responsible_email:null,dueAt:due?dayStart(due,tz):null,overdue:bill.overdue_minor>0,href:`/orders?order=${encodeURIComponent(id)}&tab=cobranza`});
    }
  }
  for (const task of tasks) {
    const o=orders.find(o=>o.id===task.orderId);
    const line=lines.find(l=>l.id===task.lineId);
    task.context=[String(o?.io_number??task.orderId),String(o?.brand??""),line?String(line.screen_name??line.screen_id):""].filter(Boolean).join(" · ");
  }
  return tasks.sort((a,b)=>Number(b.overdue)-Number(a.overdue)||(a.dueAt??"9999").localeCompare(b.dueAt??"9999")||a.key.localeCompare(b.key));
}
