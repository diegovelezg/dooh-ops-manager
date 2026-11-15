# Implementación de los diez issues abiertos — 14/11/2026

Repo: `diegovelezg/dooh-ops-manager`. Checkout: `surrealdb`, HEAD/base local `17c4b3cd8f99d51b79e10e894f11c5e71bb48075`.

Cambios locales sin commit, push ni despliegue. Este documento actualiza el diagnóstico inicial `2026-11-14-open-issues-review.md`: aquellos pendientes ahora tienen implementación y evidencia local para revisión; los issues permanecen abiertos hasta aceptación humana/integración.

## Cobertura de cada issue

| Issue | Implementación | Evidencia |
|---|---|---|
| #13 Capacidad | Cupo compartido, exclusiva por cantidad, comprobación transaccional al reservar/confirmar/modificar y documentos con slots. Barrido de intervalos y bloqueo OCC por pantalla. | `surreal-orders`, `surreal-timezone`, `hybrid-workflow`, `order-snapshot`; exactamente dos reservas concurrentes de 4 slots sobre cupo 10. ADR 0009 actualizado. |
| #14 Cotización/reserva/confirmación | Cotizar no retiene; reserva explícita con actor y vencimiento, 24 h editables; expiración efectiva sin abrir UI; confirmación revalida y excluye su propio consumo. Estado comercial visible. | Pruebas de reserva, expiración, carrera y confirmación. Formulario y ficha completa. Tratamiento legacy documentado. |
| #15 Inventario propio | Modalidad explícita; propio sin proveedor; externo exige proveedor activo propio del tenant. Venue y pantalla coherentes; cambio de modalidad limpia proveedor. Propiedad visible en ficha. | Pruebas de inventario/aislamiento; inspección del alta en navegador: Propia sin selector, Externa con proveedor requerido. |
| #16 Compras y margen | Ledger por línea externa con solicitud/confirmación/rechazo/cancelación, costo/moneda/referencia, actor/fecha y alcance. Venta, costo externo y comisión separados; margen desconocido con datos incompletos o moneda incompatible. | Compra USD no se suma a venta PEN; confirmación sin costo rechazada; costos aceptados calculan margen; orden mixta cancelada conserva compromisos y abonos. |
| #18 Materiales | Recepción pendiente; asociación multílínea; revisiones técnica y contenido explícitas, actor/fecha, rechazo con motivo. Reemplazo conserva versión vieja y vuelve a pendiente. Técnica compara medidas/duración declaradas. | Pruebas de especificaciones incompatibles, aprobación y reemplazo. Accesos antiguos ya no autoaprueban. Seller no aprueba contenido; admin sí, con sesiones reales. |
| #19 Entrega | Evidencia por línea/periodo/tipo/fecha; no cobertura futura; foto puntual, reporte manual y registro separados. Confirmación manual completa/parcial/incidencia o resolución explícita. Alcance aceptado conservado. | Una evidencia no certifica diez líneas. Evidencia sola no certifica; modificación invalida entrega previa; resolución conserva historial y permite cierre operativo. |
| #21 Documentos/versiones | OM, OC o contrato según política; mismo requisito en lecturas/etapas/pendientes. Snapshot inicial y modificaciones inmutables con motivo; documentos por revisión. | Contrato autoriza sin OM ficticia; cambio a OC deja autorización pendiente; versiones anteriores idénticas y UPDATE/DELETE rechazados. PDF conserva condiciones aceptadas nuevas. |
| #22 Pendientes | Cola actual derivada para reserva, autorización, proveedor/material, cumplimiento, cobro y resolución externa tras cancelar. Contexto, responsable/ausencia, vencimiento, atraso y enlace exacto. | Resolución retira causa; claves únicas; cobro parcial conserva saldo vencido; Inbox real mostró cuatro pendientes correctos sin falta de OM falsa. |
| #23 Captura y ficha | Cotización mínima; administrativos opcionales hasta confirmar. Requisitos específicos antes de transición. Ficha `/orders/[id]` con líneas, costos, materiales, evidencia, documentos/versiones, pendientes y acceso directo a cobranza. | Formulario/ficha revisados en navegador autenticado; server exige datos y autorización aunque el borrador sea flexible. |
| #24 Tracking | Matriz integral, decisiones y limitaciones documentadas; entrega para revisar en cada issue y seguimiento agregado. | Este informe, ADR 0010, pruebas y reporte de preservación. No equivale a validación comercial con clientes ni despliegue. |

## Migración y datos

`0011_hybrid_workflow.surql` aplicada a la BD local configurada. Es aditiva y no contiene borrado masivo ni REMOVE. Los campos nuevos obligatorios declaran inicialización de filas existentes mediante `MIGRATE EXISTING ROWS`, sin fallback de conversión. Se verificaron IDs, cantidades y valores anteriores de órdenes, líneas, documentos, materiales, fotos, facturas, pagos, pantallas, ubicaciones, empresas y contactos: sin diferencias salvo timestamps de actualización. Resultado estructurado en `2026-11-14-hybrid-migration.json`.

Una segunda ejecución de `npm run db:migrate` devolvió “Sin migraciones pendientes”: checksums válidos. Una base efímera adicional con datos anteriores (incluidos material aprobado, foto y snapshot) verificó la actualización sin asignar ni aprobar automáticamente nuevas coberturas.

## Validación

Desde `web/`:

```sh
./node_modules/.bin/tsx --env-file=.env.local --test --test-force-exit --test-concurrency=1 'tests/*.test.ts'
./node_modules/.bin/tsc --noEmit
npm run build
npm run lint
npm run db:migrate
```

La suite se ejecuta secuencialmente por archivo para evitar saturar los builds de índices de SurrealDB; las pruebas de concurrencia dentro de cada suite siguen siendo concurrentes. El migrador reintenta solo conflictos transaccionales identificados por el SDK, con límite; errores de datos/esquema siguen lanzando.

Las pruebas de dominio escriben únicamente en bases efímeras. Las acciones con sesiones reales cubren viewer, seller y admin; aislamiento también en permisos nativos y referencias same-store. Las comprobaciones del navegador sobre datos de negocio fueron de lectura/formularios sin guardar cambios.

Resultado final y comentarios de handoff: ver sección de cierre al pie (se completa tras las comprobaciones finales).

## Límites explícitos

- Implementado en checkout local; publicación e integración pendientes por instrucción de no hacer commits/pushes.
- Modificaciones aceptadas conservan las líneas existentes; cambiar pantallas/partes se hace mediante nueva contratación.
- No se inventa autorización ni certificación para materiales/fotos antiguos sin línea o revisión explícita. Los datos desconocidos históricos se muestran pendientes/sin asignar.
- Margen comercial excluye costos operativos propios, impuestos y conversión monetaria. No es contabilidad ni rentabilidad neta.
- Evidencia y revisiones son declaraciones manuales trazables, sin análisis automático de archivos ni integración con player/CMS.
- Lint global mantiene ocho errores y quince warnings previos a esta implementación, en efectos/refs y utilidades existentes. Los cambios nuevos no añaden errores de lint. No se corrigieron componentes ajenos para ampliar el alcance.
- Los casos de aceptación fueron validados técnicamente; siguen pendientes revisión humana, integración y prueba piloto con el negocio.

## Cierre y verificación independiente (14/11/2026)

Revisado contra el checkout, sin confiar en lo declarado arriba:

- `tsc --noEmit`: sin errores. `npm run build`: correcto. `npm run db:migrate`: "Sin migraciones pendientes" (0001–0011).
- `npm test`: **465 de 465** correctos (incluye `hybrid-workflow`, `hybrid-migration`, `surreal-timezone`).
- `npm run lint`: 8 errores y 15 warnings, los mismos que antes de esta implementación (react-hooks en archivos ajenos).
- Consistencia con la zona horaria por tenant (0009/0010): el flujo híbrido usa `dayStart/dayOf/displayEndOf` con la zona del tenant y entradas `datetime-local` convertidas con ella. Dashboard, lista de órdenes, ficha y agente calculan autorización, materiales y entrega con las mismas funciones.
- Navegador (datos de dev): `/orders/[id]` y `/inbox` cargan; los cuatro pendientes coinciden entre ambos. Corregido al verificar: la ficha mostraba fechas en ISO crudo; ahora usan el formato único `dd/mm/yyyy`.
- Sigue pendiente, fuera del alcance técnico: aceptación humana, commit/integración a `main` y prueba piloto. Los issues permanecen abiertos.
