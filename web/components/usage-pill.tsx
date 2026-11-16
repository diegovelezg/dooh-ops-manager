"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { formatDecimal, formatNumber, todayIn } from "@/lib/format";
import { useTz } from "@/components/tenant-time";

/** Compacta 1200 -> "1,2K", 2300000 -> "2,3M" (es-PE: decimal ","). */
function compact(n: number): string {
  const short = (v: number, suffix: string) => {
    const s = formatDecimal(v, 1);
    return `${s.endsWith(",0") ? s.slice(0, -2) : s}${suffix}`;
  };
  if (n >= 1_000_000) return short(n / 1_000_000, "M");
  if (n >= 1_000) return short(n / 1_000, "K");
  return formatNumber(n);
}

/**
 * Pill sutil de consumo LLM del tenant activo (issue #15).
 * A la izquierda del MarketSelector: total de hoy + total histórico en texto,
 * detalle de llamadas en tooltip. Solo informativo, sin link.
 * Sin tienda no se consulta. Un fallo de la API se distingue del consumo cero.
 */
export function UsagePill({ stores }: { stores: Array<{ id: string }> }) {
  const sp = useSearchParams();
  const param = sp.get("store");
  const activeId = stores.some((s) => s.id === param) ? (param as string) : (stores[0]?.id ?? null);
  return activeId ? <StoreUsagePill key={activeId} storeId={activeId} /> : null;
}

function StoreUsagePill({ storeId }: { storeId: string }) {
  const tz = useTz();
  const [todayTokens, setTodayTokens] = useState<number | null>(null);
  const [allTokens, setAllTokens] = useState<number | null>(null);
  const [todayCalls, setTodayCalls] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    // Un solo request: el día + `all_tokens` (histórico). Antes eran dos, cada 30 s por pestaña.
    const load = () => {
      if (document.visibilityState !== "visible") return; // pestaña oculta: no consulta
      fetch(`/api/usage?store=${encodeURIComponent(storeId)}&from=${todayIn(tz)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!alive) return;
          setLoaded(true);
          const ok = typeof d?.total_tokens === "number" && typeof d?.all_tokens === "number";
          setFailed(!ok);
          if (ok) {
            setTodayTokens(d.total_tokens as number);
            setTodayCalls(typeof d.calls === "number" ? d.calls : 0);
            setAllTokens(d.all_tokens as number);
          }
        })
        .catch(() => {
          if (alive) {
            setLoaded(true);
            setFailed(true);
          }
        });
    };
    load();
    // El pill monta una vez; los chats ocurren despues: revalida cada 60s (solo visible) y al volver el foco.
    const t = setInterval(load, 60_000);
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
      ctrl.abort();
    };
  }, [storeId, tz]);

  // Siempre visible para probar: mientras carga "● … hoy · … total", sin datos "● 0 hoy · 0 total".
  const day = todayTokens ?? (loaded ? 0 : null);
  const all = allTokens ?? (loaded ? 0 : null);
  const label = failed ? "● Uso no disponible" : `● ${day === null ? "…" : compact(day)} hoy · ${all === null ? "…" : compact(all)} total`;
  const title = failed ? "No se pudo cargar el consumo de tokens. Se reintentará automáticamente." :
    day !== null && all !== null
      ? `${compact(day)} tokens hoy · ${compact(all)} tokens en total · ${formatNumber(todayCalls ?? 0)} llamadas hoy`
      : null;
  return (
    <AppTooltip tip={title ?? "Sin llamadas LLM registradas"}>
      <span
        role="status"
        aria-label={title ?? "Uso de tokens: hoy e histórico"}
        className="hidden cursor-default items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground md:inline-flex"
      >
        <span className={`size-1.5 rounded-full ${failed ? "bg-amber-500/70" : "bg-emerald-500/70"}`} aria-hidden />
        {label}
      </span>
    </AppTooltip>
  );
}
