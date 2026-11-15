"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { toastFormError } from "@/components/ui/form-feedback";
import { SectionHeading } from "@/components/section-heading";
import { updateTimeZoneAction } from "@/lib/store-settings-actions";

export function TimeZonePanel({
  storeId,
  initialTimeZone,
  canEdit,
}: {
  storeId: string | null;
  initialTimeZone: string;
  canEdit: boolean;
}) {
  const [tz, setTz] = useState(initialTimeZone);
  const [pending, start] = useTransition();
  const router = useRouter();
  const zones = useMemo(() => {
    const all = Intl.supportedValuesOf("timeZone");
    return all.includes(initialTimeZone) ? all : [initialTimeZone, ...all];
  }, [initialTimeZone]);
  const changed = tz !== initialTimeZone;
  const disabled = pending || !canEdit || !storeId || !changed;

  function save() {
    if (!storeId) return;
    start(async () => {
      const res = await updateTimeZoneAction({ storeId, timezone: tz }).catch(() => ({ ok: false, message: "Error." }));
      if (!res.ok) {
        toastFormError("No se pudo guardar", res.message);
        return;
      }
      toast.add({ title: "Zona horaria actualizada", description: res.message, type: "success" });
      router.refresh();
    });
  }

  return (
    <section aria-label="Zona horaria" className="flex w-full max-w-2xl flex-col gap-4">
      <SectionHeading
        title="Zona horaria"
        hint="Define cuándo empieza y termina cada día para esta tienda: ocupación, periodos, cobros y reportes. Los datos se guardan en UTC."
        tone="primary"
      />
      <AppCard
        title="Zona horaria de la tienda"
        description="Solo se puede cambiar mientras la tienda no tenga órdenes ni reservas."
      >
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <label className="grid min-w-0 content-start gap-1.5 text-xs" htmlFor="store-timezone">
            Zona horaria (IANA)
            <select
              id="store-timezone"
              disabled={pending || !canEdit}
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              className="h-9 w-72 rounded-md border border-input bg-input/20 px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={disabled} title={canEdit ? "Guardar zona horaria" : "Requiere rol admin o propietario."}>
            <Save aria-hidden />
            {pending ? "Guardando…" : "Guardar"}
          </Button>
        </form>
        {!canEdit && <p className="text-xs text-muted-foreground">Solo lectura: requiere admin o propietario.</p>}
      </AppCard>
    </section>
  );
}
