import Link from "next/link";
import { connection } from "next/server";
import { AppCardState } from "@/components/app-card";
import { loadPageData } from "@/lib/page-data";
import { getMyStoreRole } from "@/lib/tenant";
import { getStoreTimeZone } from "@/lib/stores-db";
import { getOrderDetail } from "@/lib/orders-db";
import { surql } from "@/lib/surreal";
import { hasMinRole } from "@/lib/roles";
import { OrderWorkspace, type WorkspaceOptions } from "./workspace";
export const instant = false;
const requestNow=()=>Date.now();
export default async function OrderPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{line?:string}>}) {
  await connection();
  const {id}=await params,sp=await searchParams;
  const {data,error,connected,dbReady}=await loadPageData(async store=>{
    const [detail,tz,role,companies,contacts,members]=await Promise.all([
      getOrderDetail(store,id),getStoreTimeZone(store),getMyStoreRole(store),
      surql<WorkspaceOptions["companies"]>("SELECT record::id(id) AS id, name, kind FROM crm_company WHERE store=type::record('sys_store',$store) AND deleted_at=NONE AND kind IN ['anunciante','agencia'] ORDER BY name",{store}),
      surql<WorkspaceOptions["contacts"]>("SELECT record::id(id) AS id, record::id(company) AS company_id, string::trim(string::concat(first_name??'', ' ', last_name??'')) AS name FROM crm_contact WHERE store=type::record('sys_store',$store) AND deleted_at=NONE",{store}),
      surql<WorkspaceOptions["members"]>("SELECT in.email AS email FROM member_of WHERE out=type::record('sys_store',$store)",{store}),
    ]);
    return {now:requestNow(),detail,tz,companies,contacts,members,canEdit:hasMinRole(role,'seller'),canReview:hasMinRole(role,'admin')};
  },null);
  return <div className="page-shell max-w-[1200px]"><Link href="/orders" className="text-sm underline">← Órdenes</Link>
    {error||!connected||!dbReady?<AppCardState>{error??"Conecta tu tienda y la base de datos."}</AppCardState>:data?.detail?<OrderWorkspace key={`${id}:${data.detail.order.workflow_rev}`} detail={data.detail} options={data} selectedLine={sp.line}/>:<AppCardState>Orden no encontrada.</AppCardState>}
  </div>;
}
