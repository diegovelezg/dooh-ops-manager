# Auditoría de datos: Supabase → SurrealDB

Fecha: 2026-11-14T17:56:03.944039-05:00 (America/Lima).

## Dictamen

**Datos de negocio: completos en el entorno local auditado. Copia íntegra de todos los datos: no certificable, por las excepciones siguientes.**

Los 473 registros de las 29 tablas `public` de PostgreSQL y los 5 usuarios de `auth.users` existen en SurrealDB. Se compararon identificadores, relaciones y valores, incluidos objetos JSON, arrays, importes y fechas. No hay registros de origen faltantes ni diferencias en los valores de negocio comparados. Los 5 hashes bcrypt de contraseña coinciden exactamente.

Sí hay 452 diferencias en `updated_at`. Además, SurrealDB no conserva todos los campos de `auth.users` ni las tablas de identidad, sesiones e historial de Supabase. Por tanto, «todos los datos» requiere distinguir la información de negocio de estos metadatos históricos y operativos.

## Alcance y método

- Origen: contenedor `supabase_db_dooh-ops-manager`, base PostgreSQL `postgres`, configurado en `.env.local` mediante Supabase local (`127.0.0.1:54321`). Se arrancó únicamente PostgreSQL y se volvió a detener al terminar.
- Destino: SurrealDB `http://127.0.0.1:8000`, namespace `dooh`, database `ops`, usando acceso administrativo para evitar que permisos ocultaran filas.
- Las 29 tablas `public` se exportaron en una transacción PostgreSQL `REPEATABLE READ READ ONLY`. Destino leído mediante `INFO` y `SELECT` en una única transacción. Origen y destino no comparten una instantánea distribuida; SurrealDB permaneció disponible para la aplicación.
- Correspondencia por UUID histórico; membresías por `(store_id,user_id)` y correlativos por `(store_id,year)`. Se revisaron todos los registros, sin muestreo ni límites de paginación.
- Se normalizaron los nombres de tablas y campos, UUID → record links, SQL NULL → campo ausente/NONE y timestamps equivalentes en UTC. Coordenadas `latitude/longitude` se compararon con `location.coordinates`.
- En `crm_contact_account`, `contact_id` y `advertiser_company_id` se compararon con `in/out`; `agency_company_id` se comprobó contra la empresa del contacto enlazado. En `crm_company_link`, agencia/anunciante se compararon con `in/out`.
- Los días inclusivos de `io_orders` se compararon con las ventanas UTC de SurrealDB en la zona explícita del tenant, `America/Lima`; el fin UTC es exclusivo. Las fechas de las líneas se compararon como instantes UTC.
- Resultado: **17 607 comparaciones de campos**, 17 155 iguales y 452 diferencias, todas en `updated_at`. Para los usuarios, esta cifra incluye email y creación; las 5 comparaciones de hashes se realizaron aparte en memoria, sin guardar hashes en el informe.
- Se contaron también las tablas de los esquemas de plataforma de Supabase. La vista pública `ai_llm_usage_daily` es un resultado derivado, no una tabla con datos almacenados independiente.
- No se modificaron datos, esquema ni código de aplicación. No se hicieron commits ni pushes.

## Cobertura por tabla

| Origen | Destino | Filas origen | Filas destino | Faltantes |
|---|---|---:|---:|---:|
| `ai_domain_cache` | `ai_domain_cache` | 0 | 0 | 0 |
| `ai_llm_usage` | `ai_llm_usage` | 12 | 15 | 0 |
| `ai_vertical_profiles` | `ai_vertical_profile` | 0 | 0 | 0 |
| `crm_companies` | `crm_company` | 21 | 21 | 0 |
| `crm_company_links` | `crm_company_link` | 2 | 2 | 0 |
| `crm_contact_accounts` | `crm_contact_account` | 9 | 9 | 0 |
| `crm_contacts` | `crm_contact` | 11 | 11 | 0 |
| `inv_bookings` | `inv_booking` | 0 | 0 | 0 |
| `inv_loop_templates` | `inv_loop_template` | 0 | 0 | 0 |
| `inv_screen_embeddings` | `inv_screen_embedding` | 0 | 0 | 0 |
| `inv_screens` | `inv_screen` | 203 | 203 | 0 |
| `inv_slots` | `inv_slot` | 0 | 0 | 0 |
| `inv_venues` | `inv_venue` | 203 | 203 | 0 |
| `io_agency_orders` | `io_agency_order` | 1 | 1 | 0 |
| `io_campaigns` | `io_campaign` | 0 | 0 | 0 |
| `io_counters` | `io_counter` | 1 | 1 | 0 |
| `io_creatives` | `io_creative` | 0 | 0 | 0 |
| `io_invoice_payments` | `io_invoice_payment` | 0 | 0 | 0 |
| `io_invoices` | `io_invoice` | 0 | 0 | 0 |
| `io_lines` | `io_line` | 2 | 2 | 0 |
| `io_orders` | `io_order` | 1 | 1 | 0 |
| `io_photo_checks` | `io_photo_check` | 0 | 0 | 0 |
| `io_play_logs` | `io_play_log` | 0 | 0 | 0 |
| `sys_insight_reads` | `insight_read` | 0 | 0 | 0 |
| `sys_insights` | `sys_insight` | 1 | 1 | 0 |
| `sys_memberships` | `member_of` | 4 | 5 | 0 |
| `sys_runs` | `sys_run` | 1 | 1 | 0 |
| `sys_store_profiles` | `sys_store_profile` | 0 | 0 | 0 |
| `sys_stores` | `sys_store` | 1 | 1 | 0 |
| `auth_users` | `user` | 5 | 6 | 0 |

`inv_loop_templates` e `inv_screen_embeddings` no tienen tabla equivalente en destino, pero ambas contienen cero filas en origen. No hay pérdida de registros por esa omisión.

## Integridad y controles de negocio

- **1 135 referencias** de registro comprobadas: cero destinos inexistentes y cero cruces de tenant detectados entre filas con tienda. Solo existe un tenant en el origen auditado; esto no certifica el aislamiento de permisos bajo múltiples tenants.
- Roles y fechas de creación de las 4 membresías originales: iguales.
- IDs, emails, fechas de creación y hashes de los 5 usuarios originales: iguales. No se probó un login real porque crearía una sesión nueva.
- Las 2 líneas de la orden suman **449 982 unidades menores = S/ 4 499,82** en ambos motores. El snapshot JSON de la orden coincide, incluido `gross_minor`.
- La orden conserva su número, estado firmado, contactos, empresas, documentos y periodo de negocio: **04/11/2026–30/11/2026**. El destino lo representa como `[2026-11-04T05:00:00Z, 2026-12-01T05:00:00Z)`.
- Los 203 precios de pantallas coinciden individualmente; suma de control `price_pen`: **72 440** en ambos motores.
- Los 10 registros de `_migration` coinciden en checksum con los archivos locales de `surreal/migrations/`.
- Facturas, cobros, reservas, slots, creatividades y logs de reproducción: cero filas en origen y destino. No hay datos de esas entidades cuya conservación pueda verificarse con este conjunto.
- Storage: cero buckets y cero objetos registrados en PostgreSQL. Las URL almacenadas se compararon como valores; no se verificó la disponibilidad del contenido en servidores externos ni archivos huérfanos fuera del catálogo de Storage.

## Excepciones que impiden afirmar una copia íntegra

### 1. Fechas históricas de modificación sustituidas: 452 filas

| Tabla de origen | `updated_at` diferentes |
|---|---:|
| `crm_companies` | 21 |
| `crm_company_links` | 2 |
| `crm_contact_accounts` | 9 |
| `crm_contacts` | 11 |
| `inv_screens` | 203 |
| `inv_venues` | 203 |
| `io_agency_orders` | 1 |
| `io_orders` | 1 |
| `sys_runs` | 1 |

Causa verificada en el esquema: estos campos se definen con `VALUE time::now()`, que sella la escritura en SurrealDB en lugar de conservar el timestamp de origen. Las fechas de creación sí coinciden. La comparación prueba la diferencia actual; no permite atribuir cada fecha exclusivamente a la importación, porque también hubo escrituras posteriores.

Consecuencia: el destino no conserva el valor histórico original de última modificación de estas filas. No se propone sobrescribir las fechas actuales sin separar las modificaciones reales posteriores de las fechas impuestas por la importación. Si se exige fidelidad histórica, debe conservarse el timestamp de origen explícitamente o archivarse junto al registro, mediante un cambio separado.

### 2. Metadatos e historial de autenticación fuera del modelo nuevo

`user` conserva ID, email, password y creación. No conserva los campos originales de `auth.users` como `updated_at`, `last_sign_in_at`, `raw_app_meta_data` y `raw_user_meta_data`, ni otros campos operativos de GoTrue. Los 5 usuarios tienen metadatos no vacíos; existe un nombre en metadata de un usuario y `email_verified` en los 5.

También existen en el origen y no tienen copia equivalente en las tablas del destino:

| Tabla de Supabase | Filas |
|---|---:|
| `auth.audit_log_entries` | 68 |
| `auth.identities` (provider `email`) | 1 |
| `auth.sessions` | 1 |
| `auth.refresh_tokens` | 8 |
| `auth.mfa_amr_claims` | 1 |

El nuevo mecanismo de sesión no implica que estos registros históricos hayan sido migrados. Si se requiere retenerlos, deben archivarse explícitamente; no basta con conservar los usuarios. Las tablas de migraciones, configuración y funcionamiento interno de Supabase tampoco se consideran datos de negocio migrados. `vault.secrets` tiene cero filas.

### 3. Datos adicionales en SurrealDB

Se detectaron **3 usos de IA, 1 usuario y 1 membresía adicionales**. No reemplazan ni hacen faltar registros originales. La nueva membresía tiene rol `owner` y corresponde al usuario `c0999a02-ecdd-4e24-981e-542647512c71`; se creó el 14/11/2026 a las 17:18:40 (America/Lima). El origen no permite establecer si estas altas fueron previstas: su autorización y procedencia no se certifican en esta auditoría.

## Evidencia y límites

El archivo [2026-11-14-surrealdb-data-audit.json](2026-11-14-surrealdb-data-audit.json) incluye conteos completos, IDs adicionales, las 452 diferencias con sus timestamps de origen/destino, controles de integridad y checksums SHA-256 de las instantáneas. No contiene contraseñas, hashes bcrypt ni el volcado de datos de negocio.

Los scripts de extracción/comparación y las instantáneas locales se conservaron en `/tmp/dooh-data-audit/`, con directorio accesible solo para el usuario. Son artefactos temporales, no un backup permanente. No se usó una herramienta de importación para inferir completitud: se contrastaron directamente los datos de los dos motores.

**Este resultado certifica únicamente el conjunto local leído.** No se accedió a una base remota de producción, a otros volúmenes de PostgreSQL ni a un respaldo anterior al estado actual del origen. No puede detectar datos eliminados del origen antes de esta auditoría. La conservación de los metadatos históricos señalados queda pendiente si el criterio de aceptación es «todos los datos» sin excepciones.
