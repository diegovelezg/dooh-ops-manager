"use server";
import { revalidatePath } from "next/cache";
import { resolveTenantStoreAction, denyRole } from "@/lib/tenant";
import { resolveActor } from "@/lib/actor";
import { workflowCommandSchema } from "@/lib/order-workflow-validation";
import * as workflow from "@/lib/order-workflow-store";
import { getOrder } from "@/lib/orders-store";
import { thrownMessage } from "@/lib/surreal";

export async function runOrderWorkflowAction(input:{orderId:string;revision:number;command:unknown}):Promise<{ok:boolean;message:string;fields?:string[]}> {
  const t=await resolveTenantStoreAction("seller");
  if("error" in t)return {ok:false,message:t.error};
  if(!input.orderId||!Number.isSafeInteger(input.revision)||input.revision<0)return {ok:false,message:"Orden o versión inválida."};
  const parsed=workflowCommandSchema.safeParse(input.command);
  if(!parsed.success)return {ok:false,message:"Revisa los campos de la operación.",fields:parsed.error.issues.map(e=>String(e.path[0]??""))};
  const p=parsed.data;
  if((p.kind==="review"&&p.review==="content")||(p.kind==="delivery"&&p.status==="resolved")){
    const denied=await denyRole(t.storeId,"admin");if(denied)return {ok:false,message:denied};
  }
  if(p.kind==="configure"||p.kind==="amend"){
    const order=await getOrder(t.storeId,input.orderId);
    if(!order)return {ok:false,message:"Orden no encontrada en esta tienda."};
    if(p.commissionPct!==(order.commission_pct??null)){
      const denied=await denyRole(t.storeId,"admin","La comisión por orden requiere rol admin o propietario.");
      if(denied)return {ok:false,message:denied};
    }
  }
  const actor=await resolveActor();
  if(!actor)return {ok:false,message:"Se requiere una identidad de usuario para registrar la operación."};
  const {storeId}=t,{orderId,revision}=input;
  try {
    switch(p.kind){
      case "assign":await workflow.assignOrderResponsible(storeId,orderId,revision,p.email,actor);break;
      case "reserve":await workflow.reserveOrder(storeId,orderId,revision,p.expires,actor);break;
      case "release":await workflow.releaseOrder(storeId,orderId,actor);break;
      case "configure":await workflow.configureOrder(storeId,orderId,revision,p,actor);break;
      case "confirm":await workflow.confirmOrder(storeId,orderId,revision,actor);break;
      case "authorize":await workflow.registerAuthorization(storeId,orderId,revision,p.url,actor);break;
      case "purchase":await workflow.recordPurchase(storeId,orderId,revision,actor,p);break;
      case "receive":await workflow.receiveMaterial(storeId,orderId,revision,actor,p);break;
      case "review":await workflow.reviewMaterial(storeId,orderId,revision,actor,p);break;
      case "evidence":await workflow.recordEvidence(storeId,orderId,revision,actor,{...p,kind:p.evidenceKind});break;
      case "delivery":await workflow.certifyDelivery(storeId,orderId,revision,actor,p);break;
      case "amend":await workflow.amendOrder(storeId,orderId,revision,actor,p);break;
    }
    for(const path of ["/","/inbox","/orders","/occupancy","/screens","/finance",`/orders/${orderId}`])revalidatePath(path);
    return {ok:true,message:"Operación registrada con responsable e historial."};
  } catch(e){return {ok:false,message:thrownMessage(e)};}
}
