"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Trash2 } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { toastFormError } from "@/components/ui/form-feedback";
import { SectionHeading } from "@/components/section-heading";
import { useTz } from "@/components/tenant-time";
import { formatDate } from "@/lib/format";
import { revokeAgentTokenAction } from "@/lib/agent-token-actions";
import type { AgentTokenRow } from "@/lib/agent-tokens";

const noopSubscribe = () => () => {};
/** Origen del navegador sin desajuste de hidratación: "" en el servidor y en la hidratación, el real después. */
const useOrigin = (): string => useSyncExternalStore(noopSubscribe, () => window.location.origin, () => "");

/** Conexión de agentes de IA por OAuth: el usuario solo pega la URL del servidor MCP en su agente. */
export function AgentPanel({ tokens, loadFailed }: { tokens: AgentTokenRow[]; loadFailed: boolean }) {
  const tz = useTz();
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const endpoint = `${useOrigin()}/mcp`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toastFormError("No se pudo copiar", "Selecciona la dirección y cópiala a mano.");
    }
  }

  function revoke(id: string) {
    start(async () => {
      const res = await revokeAgentTokenAction({ id }).catch(() => ({ ok: false, message: "Error." }));
      if (!res.ok) {
        toastFormError("No se pudo revocar", res.message);
        return;
      }
      toast.add({ title: "Acceso revocado", description: res.message, type: "success" });
      router.refresh();
    });
  }

  return (
    <section aria-label="Conectar un agente de IA" className="flex w-full max-w-2xl flex-col gap-4">
      <SectionHeading
        title="Conectar un agente de IA"
        hint="ChatGPT, Claude, Antigravity y otros agentes podrán consultar tus datos con tu misma visibilidad, solo lectura."
        tone="primary"
      />
      <AppCard
        title="Dirección del servidor MCP"
        description="Añádela como servidor MCP remoto en tu agente y, cuando te lo pida, inicia sesión y pulsa Permitir. No hay claves que copiar."
      >
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded bg-background/60 px-2 py-1.5 font-mono text-xs">{endpoint}</code>
          <Button type="button" size="sm" variant="outline" onClick={copy} aria-label="Copiar dirección">
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </Button>
        </div>

        <div className="grid gap-1">
          <p className="text-xs font-medium">Agentes con acceso</p>
          {loadFailed ? (
            <p role="alert" className="text-xs text-destructive">No se pudo cargar la lista de accesos. Recarga la página; si persiste, avisa a un administrador.</p>
          ) : tokens.length === 0 ? (
            <p className="text-xs text-muted-foreground">Ninguno todavía.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {tokens.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.label}</p>
                    <p className="text-xs text-muted-foreground">
                      Conectado {formatDate(t.created_at, tz)} · {t.last_used_at ? `último uso ${formatDate(t.last_used_at, tz)}` : "sin uso"}
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
        </div>
      </AppCard>
    </section>
  );
}
