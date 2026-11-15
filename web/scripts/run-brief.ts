// Brief matutino del inbox (issue #11): corre runBriefJob por tienda.
// Headless con el usuario de sistema `app_server` (sin sesión): apto para cron.
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/run-brief.ts [--store=<id>] [--force] [--actor=cron] [--limit=50] [--dry-run]
// Cron sugerido (6:00 Lima = 11:00 UTC): 0 11 * * * / npm run brief -- --actor=cron
// Exit 0 si al menos una tienda terminó ok (incluye "ya corrió"/"sin cambios");
// exit 1 si no hay tiendas o todas fallaron.
import { listInsightKeysSince } from "@/lib/insights-store";
import { closeDb } from "@/lib/surreal";
import { listStores } from "@/lib/stores-db";
import { createLogger } from "@/lib/log";
import { fail } from "./lib/run-once";

const log = createLogger("brief");

const args = process.argv.slice(2);
const opt = (name: string): string | null => {
  const p = `--${name}=`;
  const hit = args.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length).trim() || null : null;
};
const has = (name: string): boolean => args.includes(`--${name}`);

async function listStoreIds(limit: number): Promise<string[]> {
  return (await listStores({ limit: Math.max(1, limit) })).map((s) => s.id);
}

async function main(): Promise<void> {
  const { runBriefJob, briefAlreadyRanToday, buildBriefFacts, dedupeKey, MAX_POSTS_PER_DAY } = await import("@/lib/insights");
  const only = opt("store");
  const force = has("force");
  const dry = has("dry-run");
  const actor = opt("actor") ?? "cron";
  const limit = Math.max(1, Number.parseInt(opt("limit") ?? "50", 10) || 50);
  const ids = only ? [only] : await listStoreIds(limit);
  if (ids.length === 0) throw new Error("Sin tiendas en SurrealDB.");
  log.info("brief start", { tiendas: ids.length, force: force ? 1 : 0, dry: dry ? 1 : 0, actor });

  if (dry) {
    const { getDashboardSnapshot } = await import("@/lib/dashboard");
    const { dayStartMs, todayIn } = await import("@/lib/format");
    const { getStoreTimeZone } = await import("@/lib/stores-db");
    for (const storeId of ids) {
      const snap = await getDashboardSnapshot(storeId);
      const tz = await getStoreTimeZone(storeId);
      const today00 = dayStartMs(todayIn(tz), tz);
      const today = await listInsightKeysSince(storeId, new Date(today00).toISOString());
      const existing = new Set(today.map((r) => dedupeKey(String(r.kind ?? ""), (r.scope_id as string | null) ?? null)));
      const fresh = buildBriefFacts(snap, MAX_POSTS_PER_DAY)
        .filter((f) => !existing.has(dedupeKey(f.kind, f.scopeId)))
        .slice(0, Math.max(0, MAX_POSTS_PER_DAY - existing.size));
      log.debug("brief dry", { storeId, hechos: fresh.length });
    }
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const storeId of ids) {
    try {
      if (!force && (await briefAlreadyRanToday(storeId))) {
        log.info("brief skip", { storeId, reason: "ya-corrio-hoy" });
        ok += 1;
        continue;
      }
      const r = await runBriefJob(storeId, { force, actor });
      log.info("brief store ok", { storeId, inserted: r.inserted, summary: r.summary });
      ok += 1;
    } catch (e) {
      failed += 1;
      log.error(e instanceof Error ? e : String(e), { storeId });
    }
  }
  log.info("brief fin", { ok, failed });
  if (ok === 0) throw new Error("Ninguna tienda terminó ok.");
}

main()
  .then(() => closeDb())
  .catch((e) => fail("BRIEF", e));
