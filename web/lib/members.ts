// Miembros del tenant (lecturas con identidad de servidor). Escrituras en members-actions.ts.
import { surql } from "@/lib/surreal";
import { isMemberRole, type MemberRole } from "@/lib/roles";

export interface StoreMember {
  user_id: string;
  email: string | null;
  role: MemberRole;
  created_at: string | null;
}

/** Miembros de la tienda ordenados por antigüedad. El email viaja en el
 *  propio registro `user` (sin Admin API aparte). */
export async function listStoreMembers(storeId: string): Promise<StoreMember[]> {
  const rows = await surql<
    Array<{ user_id: string; email: string | null; role: unknown; created_at: string | null }>
  >(
    `SELECT record::id(in) AS user_id, in.email AS email, role, <string> created_at AS created_at
     FROM member_of WHERE out = type::record('sys_store', $store) ORDER BY created_at ASC`,
    { store: storeId },
  );
  return rows.map((r) => ({
    user_id: r.user_id,
    email: r.email ?? null,
    role: isMemberRole(r.role) ? r.role : ("seller" as MemberRole),
    created_at: r.created_at ?? null,
  }));
}
