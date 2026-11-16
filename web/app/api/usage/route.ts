import { surql } from "@/lib/surreal";
import { requireApiUser, requireStoreMember } from "@/lib/api/guard";
import { dayStart, isISODateShape } from "@/lib/format";
import { getStoreTimeZone } from "@/lib/stores-db";
import { apiLog } from "@/lib/log";

/**
 * GET /api/usage?store=<uuid>[&from=YYYY-MM-DD] — consumo LLM del tenant.
 * Lo consume `components/usage-pill.tsx`: `{ total_tokens, calls }` del día
 * (`from`) o histórico; con `from` devuelve además `all_tokens` (histórico) para no hacer 2 requests.
 * Sin ruta el pill fallaba en silencio con 404.
 * Fail-closed: exige sesión + membresía (anon-dev explícito permitido).
 */
export async function GET(req: Request) {
  const auth = await requireApiUser();
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const storeId = (url.searchParams.get("store") ?? "").trim();
  const from = (url.searchParams.get("from") ?? "").trim();
  if (!storeId) return Response.json({ error: "Falta store." }, { status: 400 });
  if (from && !isISODateShape(from)) {
    return Response.json({ error: "from inválido (YYYY-MM-DD)." }, { status: 400 });
  }
  const denied = await requireStoreMember(storeId, auth);
  if (denied) return denied;
  try {
    // Histórico: una fila por tienda en la vista `ai_llm_usage_total` (mantenida por la DB, migración 0015),
    // no una suma sobre toda la historia. El día (`from`) sigue siendo un agregado sobre el rango indexado
    // (store, created_at), que solo contiene las filas de hoy.
    const store = { store: storeId };
    const [all, day] = await Promise.all([
      surql<Array<{ total_tokens: number; calls: number }>>(
        `SELECT total_tokens, calls FROM ai_llm_usage_total WHERE store = type::record('sys_store', $store)`,
        store,
      ),
      from
        ? surql<Array<{ total_tokens: number; calls: number }>>(
            `SELECT math::sum(total_tokens) AS total_tokens, count() AS calls FROM ai_llm_usage
             WHERE store = type::record('sys_store', $store) AND created_at >= <datetime> $from GROUP ALL`,
            { ...store, from: dayStart(from, await getStoreTimeZone(storeId)) },
          )
        : Promise.resolve(null),
    ]);
    const total = all[0]?.total_tokens ?? 0;
    // Sin `from`: el histórico (forma original). Con `from`: el día + `all_tokens` (un solo request para el pill).
    if (!day) return Response.json({ total_tokens: total, calls: all[0]?.calls ?? 0 });
    return Response.json({ total_tokens: day[0]?.total_tokens ?? 0, calls: day[0]?.calls ?? 0, all_tokens: total });
  } catch (e) {
    apiLog("usage", "usage fail", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
