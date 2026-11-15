# MEOW

> Sistema de **gestión comercial DOOH**: empresas, inventario (venues/pantallas/slots),
> órdenes de inserción (contrato → hard hold → autorización → materiales → emisión →
> certificación → cobranza) y marcas.
>
> **Fase 2 (2026-11-07):** se extirpó el motor de retención original
> (modelo probabilístico + loop scout→strategist→copywriter→dispatcher→analyst).
> Migración `20261122000000_drop_retention_engine.sql`. Sin morning pipeline,
> sin cron (worker no-op). Chat DOOH en vivo (`dooh_agent`, streaming SSE).

## Qué es (y qué no es)

MEOW es un sistema de **gestión comercial DOOH**: empresas, inventario
(venues/pantallas/slots), órdenes de inserción (contrato → hard hold →
autorización → materiales → emisión → certificación → cobranza) y marcas.

> **Histórico (Fase 1, extirpado en 2026-11-07):** MEOW fue un *motor de
> decisión y acción* sobre ecommerce (recompra probabilística + loop
> scout→strategist→copywriter→dispatcher→analyst). Ver
> `docs/architecture.md` § histórico y migración
> `20261122000000_drop_retention_engine.sql`. Nada de lo que sigue en esta
> sección aplica al sistema vigente.

## El problema (Fase 2: gestión DOOH)

La venta de publicidad en vía pública se gestiona en hojas y chats: inventario
(pantallas/slots) sin disponibilidad única, órdenes sin trazabilidad
contractual y cobranza sin conciliación. MEOW centraliza empresas, inventario,
órdenes de inserción y marcas en un solo multi-tenant con RLS.

> **Histórico (Fase 1):** churn silencioso en ecommerce recurrente + mensajes
> de recupero. Extirpado en 20261122.

## El loop — HISTÓRICO (extirpado 2026-11-07, no ejecutar)

> Fase 2: sin `morning pipeline`, sin cron (worker no-op, `web/worker.ts`),
> sin `runMorningPipeline` / `runSyncOnce` / `claimRunSlot` programados, sin
> `retention:v3`, sin `scout→strategist→copywriter→analyst`, sin `TenantBrain`
> (`brain_json`), sin `/customers` / `/review` / `/products` del motor viejo,
> sin `connectors/`, sin `retain-tools.ts`, sin cron `morning`. Lo que sigue
> se conserva solo como registro histórico; el código ya no existe.

1. ~~Detectar — `scout`…~~ 2. ~~Decidir — `strategist`…~~ 3. ~~Proponer —
   `copywriter`…~~ 4. ~~Aprobar en `/review`…~~ 5. ~~Ejecutar —
   `dispatcher`…~~ 6. ~~Medir — `analyst`…~~ Pipeline ~~diario~~ eliminado;
   `background_runs` renombrada a `sys_runs` (cinta de import/perfil, no del
   loop).

## Primer caso: tupantalla.com

[TuPantalla](https://tupantalla.com) es un marketplace de **publicidad digital en vía pública
(DOOH) en Perú**: los anunciantes reservan pantallas (Cusco, Arequipa, Lima, etc.), pagan con
tarjeta o Yape, suben su arte y se publica.

Es el primer caso (dogfooding) porque: los datos son propios (cero fricción de integración),
es B2B (anunciantes = negocios), WhatsApp-first, y el ciclo de recompra es claro y medible.

Mapeo:

| Concepto | En tupantalla |
|---|---|
| Cliente | Anunciante (negocio/emprendimiento) |
| Recompra | Nueva campaña reservada |
| Señal | `sin comprar hace {t}d (ciclo ~{c}d, p25–p75)` |
| Canal | WhatsApp (Perú), email |
| Medición | ¿Reservó otra campaña? (`revenue_attributed`) |

## Estado actual del repo

**Existe (Fase 2 DOOH vigente):**

- **SurrealDB 4 como base única** (datos, sesión y permisos por tenant): 8 migraciones en
  `surreal/migrations/` (ver `surreal/README.md`). Tablas vivas: `sys_` (store, member_of, store_profile,
  run, insight), `io_` (order + line, agency_order, creative, photo_check, play_log, invoice + payment,
  campaign, counter), `inv_` (venue, screen con embedding HNSW, slot, booking), `crm_` (company, contact y
  aristas link/account), `ai_` (domain_cache, vertical_profile, llm_usage). País/moneda del tenant en
  `sys_store.shop_country` + `sys_store.shop_currency` (single-país).
- **Gestión comercial DOOH**: ingesta Sheet/CSV (`sheet-import` +
  `dooh-import`), hard hold anti-sobreventa (evento `inv_booking_hard_hold`),
  capacidad por día-pantalla transaccional (`fn::assert_capacity`), autonumeración de IOs (`fn::mint_io_number`), flujo orden→cobro, marcas.
- **Dashboard Next.js 16 (App Router)**: Hoy, Órdenes, Finanzas, Inventario,
  Empresas, Contactos, Marcas, Settings, Ayuda. Chat DOOH en vivo
  (`dooh_agent`, 6 tools read-only, SSE); worker no-op sin cron.
- **Transversales vivos**: metering LLM por tenant (`ai_llm_usage`),
  perfiles de tienda, matriz de conflictos `operations.ts` (kind+scope),
  slot atómico `fn::run_start`, schema-guard, i18n pendiente (issue #1).

> **Histórico (motor extirpado, solo registro):** conector Medusa,
> `retention:v3:episodes-mixture`, loop
> `scout:v2→strategist:v2→copywriter:v16→prospect→dispatcher→analyst`,
> `TenantBrain` (`brain_json`), `runStaleRefresh`, chat ADK con 22 tools,
> `store_secrets`, `conversations/messages`, `jobs`/`run_slot`. Borrado en
> `20261122000000_drop_retention_engine.sql` y siguientes.

**No existe todavía / deliberadamente retenido:**

- Envío real de **WhatsApp** (decisión comercial pendiente, issue #4): el dispatcher retiene
  en `approved` sin proveedor; email sí envía.
- Conectores **Shopify/Woo** (stubs con error explícito) y adaptador de **tupantalla**
  (hoy opera vía Medusa como tenant de prueba).
- Auto-aplicación del tune (#22) y SSOT total scope/moneda (#28, parcialmente atacado):
  specs cerrados, implementación acotada a `buyers honestos + scope sin fallbacks`.
- Multilenguaje ES/EN/PT (issue #1 abierto).

## Issues: estado real

24 cerrados (#2–#6, #8–#26, #28), 2 abiertos (#1 i18n, #27 episodios+mezcla — ya mergeado en
`main` como `retention:v3:episodes-mixture`, queda seguimiento de calibración).
Hitos cerrados e implementados: loop retención (#2), motor probabilístico (#5), vigilante
perfil (#6), consola diaria (#8), copywriter v8 (#9), math P1 (#10), kind/objective + mira
(#11), analyst (#12), pre-envío (#13), ejes GUI (#14), metering (#15), ops-status (#16),
envelope (#17). Specs cerrados sin implementación total: #20 secrets-DB (existe tabla pero
convive con JSON), #21 vigilar/tenant/market, #22 autoadaptativo, #23 coherencia, #24 jobs,
#25 TenantBrain-padre (Hito 1 hecho), #26 stale-refresh (implementado `runStaleRefresh`),
#28 SSOT (parcial).

## Fuera de alcance (por ahora)

- **No mezclar con el bot de respuestas** (sistema existente, se mantiene separado).
- **Solo customers ya conectados**: trabajamos únicamente con los datos que ya tenemos.
- Multi-plataforma (Shopify/Woo) y multi-idioma: se retoman si tupantalla valida.

## Documentación

- Blueprint técnico y motores: [`docs/architecture.md`](docs/architecture.md).
- Web (stack, quickstart, sync, worker): [`web/README.md`](web/README.md).
