// Crea (o actualiza) una tienda/tenant. Uso:
//   npm run db:store -- --name="Smart Media" [--currency=PEN] [--country=PE] [--prefix=SM] [--id=<uuid>]
// Luego: USER_PASSWORD=... npm run db:user -- --email=a@b.c --store=<id> --role=owner
import { randomUUID } from "node:crypto";
import { closeDb, surql } from "@/lib/surreal";

const opt = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() || null : null;
};

async function main(): Promise<void> {
  const name = opt("name");
  if (!name) throw new Error("Falta --name=");
  const id = opt("id") ?? randomUUID();
  await surql(
    `UPSERT type::record('sys_store', $id) SET name = $name, shop_currency = $currency, shop_country = $country, io_prefix = $prefix`,
    { id, name, currency: (opt("currency") ?? "PEN").toUpperCase(), country: opt("country")?.toUpperCase(), prefix: (opt("prefix") ?? "OI").toUpperCase() },
  );
  console.log(`Tienda: ${name} (${id})`);
  await closeDb();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
