# SurrealDB — esquema y operación

Base de datos única del proyecto (reemplaza a Supabase). Versión del servidor: **4.0.1**
(`infra/surrealdb/compose.yaml`).

```bash
cd infra/surrealdb && SURREAL_ROOT_PASS=<pass> docker compose up -d   # servidor persistente
cd web && npm run db:migrate                                          # aplica surreal/migrations/*.surql
USER_PASSWORD=<pass> npm run db:user -- --email=a@b.c --store=<id> --role=owner
```

## Convenciones
- **Migraciones** `surreal/migrations/NNNN_nombre.surql`: se aplican una vez, en orden, cada una en una
  transacción junto con su registro en `_migration` (con checksum: una migración aplicada no se edita).
  Los secretos se inyectan con `{{PLACEHOLDER}}` desde el entorno del migrador (nunca en el repo).
- **Ids**: clave de registro = UUID histórico (`sys_store:⟨uuid⟩`). La app maneja strings planos:
  `record::id(id)` al leer, `type::record('tabla', $id)` al filtrar/escribir.
- **Identidades de conexión**: `app_server` (EDITOR; jobs/scripts/lecturas de servidor) y el token del
  usuario (`surqlAs`), donde aplican las `PERMISSIONS` de cada tabla.
- **Integridad en la DB**: tipos literales, `ASSERT`, `READONLY`, `REFERENCE`, `EVENT`. Las invariantes que
  cruzan filas bajo OCC escriben un registro compartido para convertir write-skew en conflicto reintentable
  (ver `0002_member_invariants.surql` y `0006_orders.surql`). El reintento del conflicto es opt-in del SDK:
  `surql`/`surqlAs` (`lib/surreal.ts`) llaman `.retry()`; por eso toda query con varias escrituras va en
  `BEGIN…COMMIT` (el reintento reenvía la query completa).
- **Tests de integración** (`tests/surreal-*.test.ts`) crean una DB efímera con todas las migraciones.
- **Tiempo y zona horaria.** La BD guarda **instantes en UTC** (`datetime`). El "día" de negocio existe solo en la zona
  IANA del tenant (`sys_store.timezone`, editable en Ajustes; default `America/Lima` solo para tiendas nuevas) y
  SurrealDB no resuelve zonas IANA ni DST, así que **toda conversión día↔instante la hace la app**
  (`dayOf/dayStart/todayIn(tz)` en `lib/format.ts`, siempre con la zona explícita; ninguna zona global) y llega a
  las funciones de la BD ya resuelta: las líneas viajan con sus días como ventanas UTC `[from, to)` (un día con DST
  dura 23/25 h), y el año del correlativo y el "hoy" de un cobro los calcula la app con la zona del tenant.
  `io_order.starts_at/ends_at` son instantes (fin exclusivo); `lib/orders-store.ts` los traduce a días del tenant al
  leerlos (`withOrderDays`). Solo son `yyyy-mm-dd` los campos que son fechas de calendario sin hora (emisión/vencimiento
  de factura, fecha de cobro, deadline de material, campaña). Cambiar la zona se bloquea (EVENT) si la tienda ya tiene
  órdenes o reservas. Los clientes leen la zona con `useTz()` (`components/tenant-time.tsx`).

## Despliegue en VPS (Coolify)
1. Servicio con `infra/surrealdb/compose.vps.yaml`; define `SURREAL_ROOT_PASS` en sus variables. El puerto
   publicado (18101) queda abierto en el host: restríngelo con firewall.
2. Desde `web/`, con un `.env.vps.local` (ignorado por git; `SURREAL_URL`, `SURREAL_NS=dooh`, `SURREAL_DB=ops`,
   `SURREAL_ROOT_USER/PASS`, `SURREAL_APP_USER=app_server`, `SURREAL_APP_PASSWORD`):
   `npx tsx --env-file=.env.vps.local scripts/db-migrate.ts`.
3. Copiar datos entre instancias (solo registros; el esquema y `app_server` los crea la migración):
   `surreal export --only --records true --tables-exclude _migration - > datos.surql` en el origen y
   `surreal import` en el destino. El archivo lleva datos de negocio y hashes: no se commitea.
4. La app en Coolify debe construirse desde la rama `surrealdb` con `SURREAL_URL` alcanzable desde su contenedor
   (no `127.0.0.1`), `SURREAL_APP_USER/PASSWORD` y `SECRETS_ENCRYPTION_KEY`.
