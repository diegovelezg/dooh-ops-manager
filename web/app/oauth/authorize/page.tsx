import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ShieldCheck } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { getSessionUser } from "@/lib/auth";
import { checkAuthorizeRequest, clientRedirect, decodeAuthorizeQuery, encodeAuthorizeQuery, publicOrigin } from "@/lib/oauth";
import { decideAction } from "./actions";

export const instant = false;

type SP = Record<string, string | string[] | undefined>;

// Pantalla de consentimiento OAuth: el agente pide acceso de solo lectura a los datos del usuario.
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<SP> }) {
  await connection();
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const packed = first(sp.q);
  const params = packed
    ? decodeAuthorizeQuery(packed)
    : new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (first(v) !== undefined ? [[k, first(v) as string]] : [])));
  const origin = publicOrigin(await headers());
  const check = await checkAuthorizeRequest((k) => params.get(k), origin);

  if (!check.ok && check.kind === "redirect") {
    redirect(clientRedirect(check.redirectUri, check.state, origin, { error: check.error, error_description: check.description }));
  }
  if (!check.ok) {
    return (
      <Shell>
        <AppCard title="No se puede autorizar" description={check.message}>
          <p className="text-xs text-muted-foreground">Vuelve a la aplicación e inténtalo de nuevo. No se ha concedido ningún acceso.</p>
        </AppCard>
      </Shell>
    );
  }

  const q = encodeAuthorizeQuery(params.toString());
  const returnHost = new URL(check.params.redirectUri).host;
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?q=${q}`)}`);

  return (
    <Shell>
      <form action={decideAction} className="w-full">
        <input type="hidden" name="q" value={q} />
        <AppCard
          headerClassName="[&_[data-slot=card-title]]:text-xl"
          title={
            <span className="flex flex-col gap-2">
              <span className="mb-1 flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <ShieldCheck className="size-5" strokeWidth={2} />
              </span>
              {check.params.client.name} quiere acceder a tus datos
            </span>
          }
          description={`Has iniciado sesión como ${user.email}.`}
          footer={
            <div className="flex w-full gap-2">
              <Button type="submit" name="decision" value="deny" variant="outline" className="flex-1">
                Cancelar
              </Button>
              <Button type="submit" name="decision" value="approve" className="flex-1">
                Permitir
              </Button>
            </div>
          }
        >
          <ul className="grid gap-2 text-sm">
            <li>✅ Podrá consultar los datos que tú ves en la aplicación (tus tiendas y los campos según tu rol).</li>
            <li>🔒 Solo lectura: no podrá crear, cambiar ni borrar nada.</li>
            <li>↩️ Puedes revocar el acceso cuando quieras en Ajustes.</li>
            <li className="text-xs text-muted-foreground">
              «{check.params.client.name}» es el nombre que la propia aplicación declaró (no está verificado). Al permitir, volverás a{" "}
              <strong className="text-foreground">{returnHost}</strong>: solo continúa si lo reconoces.
            </li>
          </ul>
        </AppCard>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh w-full items-center justify-center overflow-hidden bg-gradient-to-br from-primary/[0.06] via-background to-background p-6">
      <div className="relative w-full max-w-md">
        {children}
      </div>
    </div>
  );
}
