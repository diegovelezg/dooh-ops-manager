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

## Agentes de IA (MCP de solo lectura, OAuth)
El usuario añade la URL `<app>/mcp` como servidor MCP remoto en su agente (ChatGPT, Claude, Antigravity, Cursor…); el agente
abre el navegador, el usuario inicia sesión y pulsa **Permitir** (OAuth 2.1 con PKCE S256 y registro dinámico de clientes, sin
refresh tokens). **Ajustes → Conectar un agente de IA** lista los agentes con acceso y permite revocarlos al instante.
- Flujo: `/mcp` responde 401 con `resource_metadata` → `/.well-known/oauth-protected-resource[/mcp]` y
  `/.well-known/oauth-authorization-server` → `/oauth/register` (DCR) → `/oauth/authorize` (login + consentimiento) →
  `/oauth/token` (código de un solo uso + PKCE → token que no caduca). Código en `lib/oauth.ts` y `app/oauth/*`
  (migraciones 0020/0021; el token es un `agent_token`, migraciones 0018/0019). El canje es una transacción serializada por usuario
  (`agent_lock`): reclama el código, aplica el límite de 10 accesos, reemplaza el token anterior del cliente y emite el nuevo.
- `app/mcp/route.ts` canjea el token por el JWT de 10 min del propio usuario (acceso `agent`) y reenvía al `/mcp` embebido de
  SurrealDB (≥ 3.1): el agente ve exactamente lo que el usuario ve en la web (PERMISSIONS por tienda y por campo, p. ej. la
  comisión solo owner/admin, migración 0017). Nunca usa `app_server`.
- Solo lectura: el proxy publica únicamente `query` y `select` y reenvía una lista cerrada de métodos (`lib/mcp-proxy.ts`):
  sin `resources/*`, `prompts/*`, `notifications/cancelled`, `GET` (SSE) ni `DELETE` (405), y sin argumentos `namespace`/`database`. El transporte de Surreal
  resuelve GET, DELETE y las cancelaciones por id de sesión sin comprobar la identidad, por eso no se exponen.
  Por el mismo motivo el proxy **vincula cada sesión a la credencial que la abrió** (`lib/mcp-sessions.ts`, en memoria y por
  instancia, 1 h de inactividad) y corta con 404 cualquier POST con una sesión ajena o desconocida antes de reenviarlo; el cliente
  reinicia sesión. Con varias réplicas de la web, una sesión abierta en otra devuelve 404 y el cliente reinicia (falla cerrado). `info`/`list` dan IAM error a un usuario
  normal, así que el proxy sustituye las `instructions` del servidor por la guía de datos de `lib/agent-schema.ts` (un test la
  compara con el esquema real). Se valida `Origin` (solo el propio origen).
- `PUBLIC_APP_URL` (origen https, sin ruta ni `/` final; se valida) es **obligatorio en producción** (sin ella `/mcp` y `/oauth/*` fallan): es el
  `issuer`/`resource` de los metadatos y no se infiere de cabeceras que controla el cliente. El límite de registro (DCR) toma la IP
  de la entrada MÁS A LA DERECHA de `X-Forwarded-For` (la añade el proxy de confianza; asume un solo proxy, ajústalo si hay más). ChatGPT y los
  conectores web de Claude exigen una URL pública HTTPS en el puerto 443; Claude Code y Antigravity funcionan también en local.
- Surreal solo acepta `/mcp` con `Host` de loopback: si la web lo alcanza por otro nombre (VPS/Coolify), define
  `SURREAL_MCP_ALLOWED_HOSTS=<host:puerto que usa SURREAL_URL>` en el servicio de SurrealDB. El puerto de SurrealDB no debe estar
  expuesto a internet: los agentes entran por `<app>/mcp`.
- Pendiente: límite de tasa por token en `/mcp`, y probar el flujo con ChatGPT y claude.ai en un entorno público.

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
