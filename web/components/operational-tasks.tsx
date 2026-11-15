import { formatDateTime } from "@/lib/format";
import Link from "next/link";
import type { OperationalTask } from "@/lib/order-workflow";
export function OperationalTasks({tasks,tz}:{tasks:OperationalTask[];tz:string}) {
  return <section className="my-5 space-y-3 rounded-lg border p-4"><h2 className="text-lg font-semibold">Pendientes operativos ({tasks.length})</h2><p className="text-sm text-muted-foreground">Se actualizan al resolver cada operación.</p>
    {tasks.length===0?<p className="text-sm">Sin pendientes abiertos.</p>:<ul className="divide-y">{tasks.map(t=><li key={t.key} className="py-3 text-sm"><Link className="font-medium underline" href={t.href}>{t.title}</Link><p>{t.context}</p><p className={t.overdue?"text-destructive":"text-muted-foreground"}>{t.responsible??"Sin responsable asignado"} · {t.dueAt?formatDateTime(t.dueAt,tz):"Sin vencimiento definido"}{t.overdue?" · Vencida":""}</p></li>)}</ul>}
  </section>;
}
