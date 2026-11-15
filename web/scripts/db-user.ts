// Crea o actualiza un usuario (login email+password) y opcionalmente lo asocia a una tienda.
// Uso: USER_PASSWORD=... npx tsx --env-file=.env.local scripts/db-user.ts --email=a@b.c [--store=<id>] [--role=owner|admin|seller|viewer]
// El password se lee de la env (no por argv: queda fuera del historial del shell).
import { surql } from "@/lib/surreal";
import { isMemberRole } from "@/lib/roles";
import { randomUUID } from "node:crypto";

const opt = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() || null : null;
};

async function main(): Promise<void> {
  const email = opt("email")?.toLowerCase();
  const password = process.env.USER_PASSWORD;
  if (!email) throw new Error("Falta --email=");
  if (!password || password.length < 8) throw new Error("Define USER_PASSWORD (mínimo 8 caracteres).");
  const storeId = opt("store");
  const role = opt("role") ?? "seller";
  if (!isMemberRole(role)) throw new Error(`Rol inválido: ${role}`);

  const existing = await surql<Array<{ id: string }>>(
    "SELECT record::id(id) AS id FROM user WHERE email = $email",
    { email },
  );
  const id = existing[0]?.id ?? randomUUID();
  await surql(
    `UPSERT type::record('user', $id) SET email = $email, password = crypto::bcrypt::generate($password)`,
    { id, email, password },
  );
  console.log(`${existing[0] ? "Actualizado" : "Creado"}: ${email} (${id})`);

  if (storeId) {
    await surql(
      `LET $u = type::record('user', $id);
       LET $s = type::record('sys_store', $store);
       IF !record::exists($s) { THROW "La tienda no existe" };
       IF array::len(SELECT id FROM member_of WHERE in = $u AND out = $s) > 0 {
         UPDATE member_of SET role = $role WHERE in = $u AND out = $s;
       } ELSE {
         RELATE $u->member_of->$s SET role = $role;
       };`,
      { id, store: storeId, role },
    );
    console.log(`Membresía: ${storeId} como ${role}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
