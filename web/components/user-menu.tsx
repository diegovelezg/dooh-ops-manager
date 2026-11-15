"use client";

import { useRef, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { LogOut, Store } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AttributeBadge } from "@/components/badges";
import { signOutAction } from "@/lib/auth-actions";
import { toast } from "@/components/ui/toast";
import { MEMBER_ROLE_LABELS, type MemberRole } from "@/lib/roles";

/** displayStoreName puro (lib/tenant es server-only: no importar en cliente). */
function displayTenantName(s: { name?: string | null }): string {
  return s.name?.trim() ?? "";
}

export interface UserMenuStore {
  id: string;
  name?: string | null;
}

/**
 * Avatar del merchant + dropdown de cuenta.
 * - `initialEmail` viene del servidor (layout dashboard): pinta email + avatar
 *   en el primer paint.
 * - `stores` + `initialRoles` vienen del servidor: resuelven tenant activo
 *   (?store= válido > primero) y rol del user sin fetch extra.
 * - Login/logout navegan (redirect) y el layout se re-renderiza: no hay estado
 *   de sesión en el cliente que sincronizar.
 * - Silencioso si no hay sesión.
 */
export function UserMenu({
  initialEmail = null,
  stores = [],
  initialRoles = {},
}: {
  initialEmail?: string | null;
  stores?: UserMenuStore[];
  initialRoles?: Record<string, MemberRole>;
}) {
  const email = initialEmail;
  const roles = initialRoles;
  const [pending, startSignOut] = useTransition();
  // Doble-submit: la transición cubre el await, pero un segundo clic en la
  // ventana previa redirigiría dos veces; el ref lo frena en seco.
  const signingOutRef = useRef(false);
  const sp = useSearchParams();

  if (!email) return null;

  const initial = (email.trim()[0] ?? "?").toUpperCase();
  // Tenant activo igual que lib/tenant en servidor (?store= válido > primera).
  const param = sp.get("store");
  const active = stores.some((s) => s.id === param)
    ? (stores.find((s) => s.id === param) ?? null)
    : (stores[0] ?? null);
  const tenantName = active ? displayTenantName(active) : null;
  const role: MemberRole | null = active ? (roles[active.id] ?? null) : null;
  const roleLabel = role ? MEMBER_ROLE_LABELS[role] : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Cuenta ${email}`}
            title={email}
            className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground ring-offset-background transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {initial}
          </button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={8} className="w-72 p-2">
        {/* Identidad: avatar + email, con aire */}
        <div className="flex items-center gap-3 px-2 pt-1.5 pb-3">
          <span
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
          >
            {initial}
          </span>
          <span className="min-w-0">
            <span className="block text-[11px] tracking-wide text-muted-foreground uppercase">
              Sesión iniciada
            </span>
            <span
              className="block truncate text-sm font-medium leading-snug"
              title={email}
            >
              {email}
            </span>
          </span>
        </div>
        {/* Tenant activo: tarjeta sutil separada del resto */}
        {tenantName ? (
          <div className="mb-1 flex items-center gap-2.5 rounded-lg bg-muted/60 px-3 py-2.5">
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground"
            >
              <Store className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] tracking-wide text-muted-foreground uppercase">
                Tienda
              </span>
              <span
                className="block truncate text-sm font-medium leading-snug"
                title={tenantName}
              >
                {tenantName}
              </span>
            </span>
            {roleLabel ? (
              <AttributeBadge label={roleLabel} title="Rol del miembro" className="shrink-0" />
            ) : null}
          </div>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={pending}
          onClick={() => {
            if (signingOutRef.current) return;
            signingOutRef.current = true;
            startSignOut(async () => {
              // By the book Next.js: la action hace signOut + redirect("/login").
              // redirect() viaja como NEXT_REDIRECT y el router navega solo:
              // no se captura, no se hace window.location, no hay signOut
              // duplicado en browser (la cookie la limpia la action vía Set-Cookie).
              try {
                await signOutAction();
              } catch (err) {
                const digest = err instanceof Error ? (err as { digest?: unknown }).digest : null;
                if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) throw err;
                signingOutRef.current = false;
                toast.add({
                  title: "No se pudo cerrar sesión",
                  description: err instanceof Error ? err.message : "Error inesperado.",
                  type: "error",
                });
              }
            });
          }}
        >
          <LogOut aria-hidden />
          {pending ? "Cerrando sesión…" : "Cerrar sesión"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
