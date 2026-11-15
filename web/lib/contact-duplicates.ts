// Duplicados de contactos (CRM DOOH): detección + datos para merge.
// Criterio: mismo email (case-insensitive) o mismo teléfono (dígitos, sin +51).
// El matching es agnóstico al estado (canónico CRM: HubSpot deduce por email,
// Salesforce/Dynamics matchean activos e inactivos): el archivado también se
// detecta —es lo que se quiere fusionar— y la UI lo marca con badge.
// Puro y testeable; la escritura vive en crm-actions.ts (mergeContactsAction).
import { listCompanies, listContactsForDuplicates } from "@/lib/crm-store";

export interface DuplicateContactRow {
  id: string;
  company_id: string | null;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  is_primary: boolean;
  /** Archivado (borrado lógico): se detecta igual —es el candidato a fusionar—,
   *  y la UI lo marca con badge para no confundirlo con el vigente. */
  archived: boolean;
}

export interface DuplicateGroup {
  /** ids ordenados para estabilidad */
  ids: string[];
  rows: DuplicateContactRow[];
  reasons: Array<"email" | "phone">;
}

/** Email canónico: minúsculas + trim (igual que el `ilike` de importación). */
export function normalizeContactEmail(email: string | null): string | null {
  const v = (email ?? "").trim().toLowerCase();
  return v === "" ? null : v;
}

/**
 * Teléfono canónico: solo dígitos; si trae código país 51 y sobra,
 * se recorta (móvil PE = 9 dígitos). `+51 999 888 777` == `999888777`.
 */
export function normalizeContactPhone(phone: string | null): string | null {
  let d = (phone ?? "").replace(/\D/g, "");
  if (d.length > 9 && d.startsWith("51")) d = d.slice(2);
  return d === "" ? null : d;
}

/**
 * Agrupa por email y por teléfono con union-find: si A comparte email con B
 * y teléfono con C, los tres van al mismo grupo. Solo grupos de 2+.
 * Orden determinista (por email/teléfono canónico, luego id).
 */
export function findContactDuplicateGroups(rows: DuplicateContactRow[]): DuplicateGroup[] {
  const parent = new Map<string, string>();
  const root = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // Compresión de camino.
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = root(a);
    const rb = root(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const r of rows) parent.set(r.id, r.id);
  const byKey = new Map<string, string[]>();
  const link = (key: string, id: string): void => {
    const l = byKey.get(key);
    if (l) for (const o of l) union(o, id);
    byKey.set(key, [...(l ?? []), id]);
  };
  for (const r of rows) {
    const e = normalizeContactEmail(r.email);
    if (e) link(`e:${e}`, r.id);
    const p = normalizeContactPhone(r.phone);
    if (p) link(`p:${p}`, r.id);
  }
  const groups = new Map<string, DuplicateContactRow[]>();
  for (const r of rows) {
    const g = groups.get(root(r.id));
    if (g) g.push(r);
    else groups.set(root(r.id), [r]);
  }
  const out: DuplicateGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.id.localeCompare(b.id));
    const reasons: Array<"email" | "phone"> = [];
    const emails = new Map<string, number>();
    const phones = new Map<string, number>();
    for (const m of members) {
      const e = normalizeContactEmail(m.email);
      if (e) emails.set(e, (emails.get(e) ?? 0) + 1);
      const p = normalizeContactPhone(m.phone);
      if (p) phones.set(p, (phones.get(p) ?? 0) + 1);
    }
    if ([...emails.values()].some((n) => n >= 2)) reasons.push("email");
    if ([...phones.values()].some((n) => n >= 2)) reasons.push("phone");
    out.push({ ids: members.map((m) => m.id), rows: members, reasons });
  }
  out.sort((a, b) => a.ids[0].localeCompare(b.ids[0]));
  return out;
}

const CAP = 2000;

/** Grupos de duplicados del tenant (paginado; `truncated` si supera el tope). */
export async function listContactDuplicateGroups(
  storeId: string,
): Promise<{ groups: DuplicateGroup[]; total: number; truncated: boolean }> {
  // Una lectura con tope (+1 fila para detectar el corte); el nombre de empresa
  // viaja en un mapa aparte (mismo patrón que listCrmContacts).
  const page = await listContactsForDuplicates(storeId, CAP + 1);
  const truncated = page.length > CAP;
  const rows: DuplicateContactRow[] = page.slice(0, CAP).map((c) => ({
    id: String(c.id),
    company_id: (c.company_id as string | null) ?? null,
    company_name: null,
    first_name: (c.first_name as string | null) ?? null,
    last_name: (c.last_name as string | null) ?? null,
    email: (c.email as string | null) ?? null,
    phone: (c.phone as string | null) ?? null,
    job_title: (c.job_title as string | null) ?? null,
    is_primary: c.is_primary === true,
    archived: (c.deleted_at as string | null | undefined) != null,
  }));
  const companyIds = [...new Set(rows.map((r) => r.company_id).filter((v): v is string => !!v))];
  if (companyIds.length > 0) {
    const names = new Map((await listCompanies(storeId, companyIds)).map((c) => [String(c.id), String(c.name ?? "")]));
    for (const r of rows) if (r.company_id) r.company_name = names.get(r.company_id) ?? null;
  }
  return { groups: findContactDuplicateGroups(rows), total: rows.length, truncated };
}
