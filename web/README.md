# MEOW — web

> **Fase 2 (2026-11-07):** gestión comercial DOOH. Motor de retención
> extirpado (`20261122000000_drop_retention_engine.sql`): sin morning
> pipeline, sin cron (worker no-op). Chat DOOH en vivo (ADK `dooh_agent`,
> 6 tools read-only, streaming SSE).

Dashboard merchant multi-tenant (inventario DOOH vía Sheet/CSV) sobre SurrealDB.
Las vistas leen desde BD.

## Stack

- Next.js 16 (App Router) + React 19 + TailwindCSS 4 + shadcn/ui
- SurrealDB 4.0 (base única: datos, sesión/auth y permisos por tenant). Esquema versionado en
  `surreal/migrations/*.surql` (8 migraciones; ver `surreal/README.md`)
- Ingesta DOOH vía Sheet/CSV (`lib/sheet-import.ts` + `lib/dooh-import.ts`)
- ADK `@google/adk@^2.3.0` (chat DOOH en vivo: `dooh_agent` + 6 tools
  read-only + Runner SSE en `lib/api/chat-route.ts`), modelos en
  `config/llm_models.json`
- Worker `worker.ts`: no-op intencional (sale 0 sin hacer nada); **sin cron**.

## Quickstart

```bash
# 1. SurrealDB local (una vez; API en :8000, datos persistentes en un volumen Docker)
cd infra/surrealdb && SURREAL_ROOT_PASS=<pass> docker compose up -d

# 2. Env (una vez): web/.env.local — ver web/.env.example (SURREAL_*)

# 3. Esquema, tienda y usuario
cd ../../web
npm install
npm run db:migrate
npm run db:store -- --name="Mi tienda" --prefix=MT
USER_PASSWORD=<pass> npm run db:user -- --email=tu@correo.com --store=<id> --role=owner

# 4. App
npm run dev               # :3000
```

## Ingesta DOOH

- `/screens` → Importar desde Google Sheet URL o CSV (kinds: companies → contacts → venues → screens → slots).
- Prod: **sin cron** (worker no-op).

## Modelo de datos

Fuente de verdad: `surreal/migrations/*.surql` (convenciones, concurrencia y operación en
`surreal/README.md`). Tablas vivas:

- identidad/tenencia: `user`, `sys_store`, `member_of` (arista user→tienda con rol), `sys_store_profile`
- operación: `sys_run` (cinta de corridas), `sys_insight` + `insight_read` (muro), `io_counter`
- órdenes: `io_order`, `io_line`, `io_agency_order`, `io_creative`, `io_photo_check`, `io_play_log`,
  `io_invoice`, `io_invoice_payment`, `io_campaign`
- inventario: `inv_venue`, `inv_screen` (con embedding HNSW), `inv_slot`, `inv_booking`
- CRM: `crm_company`, `crm_contact`, `crm_company_link`, `crm_contact_account` (estas dos, aristas)
- IA: `ai_llm_usage`, `ai_vertical_profile`, `ai_domain_cache`

País/moneda del tenant en `sys_store.shop_country` + `sys_store.shop_currency` (single-país).

> **Histórico (extirpado):** el motor de retención, el ecommerce legacy y toda la capa Postgres/Supabase
> (migrada a SurrealDB; ver `docs/architecture.md` § histórico).

Detalle del diseño en `docs/architecture.md` §§2,5.

## Pipeline morning — HISTÓRICO (no ejecutar)

> Extirpado 2026-11-07. `lib/morning-run.ts:runMorningPipeline` ya no existe;
> `worker.ts` es no-op; no hay `scout→strategist→copywriter→prospect`, ni
> `GEN retention:v3 / scout:v2 / copywriter:v16 / prospect:v7`. Se conserva el
> nombre como registro; no programar cron sobre esto.

## Páginas

- `/` Hoy (DOOH operativo).
- `/orders`: órdenes de inserción y flujo orden→cobro.
- `/finance`: KPIs + finanzas.
- `/screens`: inventario + importación Sheet/CSV.
- `/companies`, `/contacts`: base comercial.
- `/brands`: marcas.
- `/settings`, `/help`, `/login`.

## SearXNG local (histórico del prospector extirpado)

> El prospector (`prospect:v7`) se extirpó con el motor. SearXNG queda como
> infra opcional sin consumidor vigente; no es requisito del quickstart.

## Comandos

```bash
npm run dev     # desarrollo
npm run build && npm run start
npm run lint
npm run worker  # no-op Fase 2 (sale 0)
npm test        # incluye pruebas de integración contra SurrealDB (requiere el contenedor)
npm run db:migrate   # aplica surreal/migrations pendientes
```
