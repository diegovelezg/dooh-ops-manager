// Corridas, muro de avisos, uso de LLM y caches de IA sobre SurrealDB real (base efímera).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, pointAppAt, type TestDb } from "./helpers/surreal-test-db";

let t: TestDb;
let bg: typeof import("../lib/background");
let ins: typeof import("../lib/insights-store");
let surreal: typeof import("../lib/surreal");
const S = "store-a";

before(async () => {
  t = await createTestDb();
  pointAppAt(t);
  bg = await import("../lib/background");
  ins = await import("../lib/insights-store");
  surreal = await import("../lib/surreal");
  await t.root.query(`CREATE sys_store:⟨${S}⟩ SET name='A'; CREATE user:u1 SET email='u1@x.io', password='x'; CREATE user:u2 SET email='u2@x.io', password='x';`).collect();
});
after(async () => {
  await surreal?.closeDb();
  await t?.drop();
});

describe("corridas (sys_run)", () => {
  it("ciclo completo: slot, progreso con heartbeat y cierre tipado", async () => {
    const id = await bg.claimRunSlot(S, "profile", "Perfil", 3);
    assert.ok(id);
    assert.equal((await bg.getActiveRuns(S))[0].status, "running");
    await bg.advanceRun(id!, { processed: 2, failed: 0, current: "etapa 2" });
    const mid = (await bg.getLatestRun(S))!;
    assert.deepEqual([mid.processed, mid.current], [2, "etapa 2"]);
    await bg.finishRun(id!, { status: "error", processed: 2, failed: 1, error: "boom", errorCode: "llm_fail", pulseState: "needs" });
    const end = (await bg.getLatestRun(S))!;
    assert.deepEqual([end.status, end.errorCode, end.pulseState, end.current], ["error", "llm_fail", "needs", null]);
    assert.ok(end.finishedAt && (await bg.getLastFinishedAt(S, "profile")));
    assert.equal(await bg.getLastFinishedAt(S, "nunca"), null);
  });

  it("el mismo kind no se duplica; otro kind sí; `sync` choca con todo", async () => {
    const a = await bg.claimRunSlot(S, "import", "A", 1);
    assert.ok(a);
    assert.equal(await bg.claimRunSlot(S, "import", "B", 1), null);
    const other = await bg.claimRunSlot(S, "profile", "C", 1);
    assert.ok(other);
    assert.equal(await bg.claimRunSlot(S, "sync", "D", 1), null);
    await bg.finishRun(a!, { status: "done", processed: 1, failed: 0 });
    await bg.finishRun(other!, { status: "done", processed: 1, failed: 0 });
  });

  it("CONCURRENTES: 10 arranques del mismo kind → exactamente uno obtiene el slot", async () => {
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => bg.claimRunSlot(S, "brief", `W${i}`, 1)));
    assert.equal(res.filter(Boolean).length, 1);
  });

  it("una corrida sin heartbeat (30 min) se siega y libera el lock", async () => {
    await t.root.query(`DELETE sys_run`).collect();
    const id = await bg.startRun(S, "zombie", "Z", 1);
    // El heartbeat se sella solo (VALUE): en ESTA base de prueba lo quitamos para simular una corrida
    // abandonada hace una hora.
    await t.root.query(`DEFINE FIELD OVERWRITE updated_at ON sys_run TYPE datetime DEFAULT time::now();
      UPDATE type::record('sys_run', $id) SET updated_at = time::now() - 1h`, { id }).collect();
    const fresh = await bg.claimRunSlot(S, "zombie", "Z2", 1);
    assert.ok(fresh, "el colgado no debe bloquear");
    assert.equal((await bg.getActiveRuns(S, 5)).find((r) => r.id === id)?.status, "error");
  });
});

describe("muro (sys_insight / insight_read)", () => {
  const post = (kind: string, scope: string | null = null) => ({
    kind, title: "T", body: "B", links_json: ["/orders"], audience_json: { user_ids: ["u1"], emails: [], roles: ["admin"] },
    severity: "info", scope_kind: scope ? "order" : "global", scope_id: scope, context_json: { company: "Coca", metrics: [{ label: "a", value: "b" }] },
  });
  it("publica en lote como DTO y lista lo más reciente primero", async () => {
    await ins.insertInsights(S, [post("sin_cobrar"), post("relevo", "o1")]);
    const rows = await ins.listInsights(S, 20);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].links_json, ["/orders"]);
    assert.equal((rows[0].context_json as Record<string, unknown>).company, "Coca");
    assert.equal((await ins.listInsightKeysSince(S, "2020-01-01T00:00:00Z")).length, 2);
  });
  it("un lote inválido no publica nada (transacción)", async () => {
    const before = (await ins.listInsights(S, 50)).length;
    await assert.rejects(ins.insertInsights(S, [post("ok"), { ...post("mal"), severity: 5 as unknown as string }]));
    assert.equal((await ins.listInsights(S, 50)).length, before);
  });
  it("descartar es por usuario, idempotente y reversible; nunca borra el aviso", async () => {
    const [first] = await ins.listInsights(S, 1);
    const id = String(first.id);
    await ins.dismissInsight(id, "u1");
    await ins.dismissInsight(id, "u1");
    assert.deepEqual([...(await ins.readInsightIds("u1", [id]))], [id]);
    assert.equal((await ins.readInsightIds("u2", [id])).size, 0);
    await ins.restoreInsight(id, "u1");
    assert.equal((await ins.readInsightIds("u1", [id])).size, 0);
    assert.equal(await ins.insightStore(id), S);
    assert.equal(await ins.insightStore("no-existe"), null);
  });
});

describe("IA: uso, verticales y dominios", () => {
  it("logLlmUsage registra y el agregado suma exacto", async () => {
    const { logLlmUsage } = await import("../lib/ai/usage");
    for (let i = 0; i < 3; i++) {
      await logLlmUsage({ storeId: S, process: "brief", provider: "gemini", model: "m", promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    }
    const [agg] = await surreal.surql<Array<{ t: number; n: number }>>(
      `SELECT math::sum(total_tokens) AS t, count() AS n FROM ai_llm_usage WHERE store = sys_store:⟨${S}⟩ GROUP ALL`);
    assert.deepEqual([agg.t, agg.n], [45, 3]);
  });
  it("brief de vertical: upsert por clave natural (con y sin taxonomy_id)", async () => {
    const v = await import("../lib/verticals");
    const research = { brief: { confidence: "alta", resumen: "x" }, sources: [{ url: "https://a", title: "A", chars: 10 }] } as never;
    await v.saveVerticalProfile("tax/1", "Retail", research);
    await v.saveVerticalProfile("tax/1", "Retail", research);
    await v.saveVerticalProfile(null, " Moda  ", research);
    await v.saveVerticalProfile(null, "moda", research);
    assert.equal((await surreal.surql<number[]>("SELECT VALUE count() FROM ai_vertical_profile GROUP ALL"))[0], 2);
    assert.equal((await v.getVerticalProfile("tax/1", "x"))?.confidence, "alta");
    assert.equal((await v.getVerticalProfile(null, "Moda"))?.sources.length, 1);
    assert.equal(await v.getVerticalProfile("otra", "y"), null);
  });
  it("cache de dominios: lectura por lote", async () => {
    await surreal.surql(`UPSERT type::record('ai_domain_cache', 'coca-cola.com') SET company_name = 'Coca-Cola', confidence = 0.9`);
    const { getDomainProfiles } = await import("../lib/company-research");
    const m = await getDomainProfiles(["coca-cola.com", "nada.pe"]);
    assert.equal(m.size, 1);
    assert.equal(m.get("coca-cola.com")?.company_name, "Coca-Cola");
  });
});
