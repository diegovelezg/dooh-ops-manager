"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { toastFormError } from "@/components/ui/form-feedback";
import { SectionHeading } from "@/components/section-heading";
import { useTz } from "@/components/tenant-time";
import { formatDate } from "@/lib/format";
import { createAgentTokenAction, revokeAgentTokenAction } from "@/lib/agent-token-actions";
import type { AgentTokenRow } from "@/lib/agent-tokens";

export function AgentPanel({ tokens }: { tokens: AgentTokenRow[] }) {
  const tz = useTz();
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const endpoint = typeof window === "undefined" ? "/mcp" : `${window.location.origin}/mcp`;

  function create() {
    start(async () => {
      const res = await createAgentTokenAction({ label }).catch(() => ({ ok: false, message: "Error.", key: undefined }));
      if (!res.ok || !res.key) {
        toastFormError("No se pudo crear la clave", res.message);
        return;
      }
      setFresh(res.key);
      setLabel("");
      router.refresh();
    });
  }

  function revoke(id: string) {
    start(async () => {
      const res = await revokeAgentTokenAction({ id }).catch(() => ({ ok: false, message: "Error." }));
      if (!res.ok) {
        toastFormError("No se pudo revocar", res.message);
        return;
      }
      toast.add({ title: "Clave revocada", description: res.message, type: "success" });
      router.refresh();
    });
  }

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    } catch {
      toastFormError("No se pudo copiar", "Selecciona el texto y cópialo a mano.");
    }
  }

  const cli = fresh ? `claude mcp add --transport http dooh ${endpoint} --header "Authorization: Bearer ${fresh}"` : "";
  const json = fresh
    ? JSON.stringify({ mcpServers: { dooh: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${fresh}` } } } }, null, 2)
    : "";

  return (
    <section aria-label="Conectar un agente de IA" className="flex w-full max-w-2xl flex-col gap-4">
      <SectionHeading
        title="Conectar un agente de IA"
        hint="Claude Code, Claude Desktop, Cursor y otros clientes MCP podrán consultar tus datos con tu misma visibilidad, solo lectura."
        tone="primary"
      />
      <AppCard
        title="Claves de acceso"
        description="Cada clave es personal y vale 90 días. El agente ve lo mismo que tú ves aquí (tiendas y campos según tu rol) y no puede modificar nada. Revócala cuando quieras."
      >
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <label className="grid min-w-0 flex-1 content-start gap-1.5 text-xs" htmlFor="agent-label">
            Nombre de la clave
            <Input
              id="agent-label"
              value={label}
              maxLength={60}
              placeholder="Claude Desktop, Cursor…"
              disabled={pending}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={pending || label.trim() === ""}>
            <KeyRound aria-hidden />
            {pending ? "Creando…" : "Generar clave"}
          </Button>
        </form>

        {fresh && (
          <div role="status" className="grid gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <p className="font-medium">Cópiala ahora: no se vuelve a mostrar.</p>
            {[
              { id: "key", title: "Clave", text: fresh },
              { id: "cli", title: "Claude Code (terminal)", text: cli },
              { id: "json", title: "Otros clientes (JSON de MCP)", text: json },
            ].map((b) => (
              <div key={b.id} className="grid gap-1">
                <span className="text-muted-foreground">{b.title}</span>
                <div className="flex items-start gap-2">
                  <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-background/60 p-2 font-mono text-[11px] whitespace-pre-wrap break-all">{b.text}</pre>
                  <Button type="button" size="sm" variant="outline" onClick={() => copy(b.id, b.text)} aria-label={`Copiar ${b.title}`}>
                    {copied === b.id ? <Check aria-hidden /> : <Copy aria-hidden />}
                  </Button>
                </div>
              </div>
            ))}
            <Button type="button" size="sm" variant="ghost" className="justify-self-start" onClick={() => setFresh(null)}>
              Ya la copié
            </Button>
          </div>
        )}

        {tokens.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aún no tienes claves activas.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {t.label} <span className="font-mono text-xs text-muted-foreground">…{t.hint}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Creada {formatDate(t.created_at, tz)} · vence {formatDate(t.expires_at, tz)} ·{" "}
                    {t.last_used_at ? `último uso ${formatDate(t.last_used_at, tz)}` : "sin uso"}
                  </p>
                </div>
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => revoke(t.id)} aria-label={`Revocar ${t.label}`}>
                  <Trash2 aria-hidden />
                  Revocar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </AppCard>
    </section>
  );
}
