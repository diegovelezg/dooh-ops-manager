import { surql } from "@/lib/surreal";
import { requireApiUser, requireStoreMember } from "@/lib/api/guard";
import { dayStart, isISODateShape } from "@/lib/format";
import { getStoreTimeZone } from "@/lib/stores-db";
import { apiLog } from "@/lib/log";

/**
 * GET /api/usage?store=<uuid>[&from=YYYY-MM-DD] — consumo LLM del tenant.
 * Lo consume `components/usage-pill.tsx`: `{ total_tokens, calls }` del día
 * (`from`) o histórico. Sin ruta el pill fallaba en silencio con 404.
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
    // Agregado en la DB (sin tope de 10k filas): suma y conteo exactos.
    const [agg] = await surql<Array<{ total_tokens: number; calls: number }>>(
      `SELECT math::sum(total_tokens) AS total_tokens, count() AS calls FROM ai_llm_usage
       WHERE store = type::record('sys_store', $store) AND ($from = NONE OR created_at >= <datetime> $from) GROUP ALL`,
      { store: storeId, from: from ? dayStart(from, await getStoreTimeZone(storeId)) : undefined },
    );
    return Response.json({ total_tokens: agg?.total_tokens ?? 0, calls: agg?.calls ?? 0 });
  } catch (e) {
    apiLog("usage", "usage fail", { error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: e instanceof Error ? e.message : "DB read failed." }, { status: 500 });
  }
}
