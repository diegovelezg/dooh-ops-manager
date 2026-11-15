# ADR 0009 — Capacidad vendible DOOH (#13)

Fecha original: 2026-11-13. Actualización: 2026-11-14, flujo híbrido en SurrealDB.

## Unidad y exclusividad

- Un slot representa un espacio fijo por loop y día en una pantalla. La línea contrata pantalla, periodo, slots diarios (1–100) e importe total.
- Capacidad: `inv_slot` activos; sin slots explícitos, `sys_store.default_slots_per_screen` (default 10). Con slots explícitos todos inactivos, capacidad 0.
- Pedir tantos slots como capacidad ocupa toda la pantalla. No hay otro campo de exclusividad.
- Cambiar posteriormente el cupo no cambia la cantidad contratada: una antigua compra de N slots conserva N slots, aunque deje de representar toda la capacidad nueva.

## Cuándo se ocupa inventario

- Cotización nueva (`draft` sin reserva vigente): no consume capacidad.
- Reserva explícita: consume hasta `reservation_expires_at`; el formulario propone 24 horas, editables. Conserva actor, fecha y vencimiento.
- Confirmada (`signed`): consume su cantidad contratada. Cancelada: libera inventario, conserva obligaciones y datos.
- Los borradores anteriores a `0011` conservan únicamente el vencimiento histórico `created_at + 7d`, identificado como `legacy`. No se renueva ni confirma nada.
- Una reserva local no implica aceptación del proveedor externo.

## Autoridad transaccional

`fn::assert_capacity` barre los extremos de intervalos solicitados, órdenes que consumen y bookings no cancelados. En cada intervalo exige `usado + pedido <= cupo`. Respeta los instantes UTC y los días en la zona IANA del tenant, incluido DST.

Cada transacción escribe `inv_screen.occupancy_rev`: dos reservas/confirmaciones concurrentes sobre la misma pantalla entran en conflicto OCC. El SDK reintenta conflictos del servidor y comprueba de nuevo los datos. Pantallas distintas tienen registros independientes.

`fn::reserve_order`, `fn::confirm_order` y modificaciones aceptadas comprueban cupo en su propia transacción. Excluyen las líneas de la misma orden para no contar dos veces la reserva al confirmar. Un evento vuelve a comprobar cualquier transición a `signed`.

La cotización se crea en una transacción (correlativo, orden y líneas), sin compensaciones. Solo se comprueba cupo al reservar, confirmar o cambiar un compromiso vigente. La UI conserva las advertencias al cotizar sin impedir guardar la propuesta.

## Acuerdo e históricos

El snapshot v2 conserva pantalla, fechas, días, slots e importe. El PDF muestra slots y usa el snapshot aceptado. El parser conserva soporte de v1, sin inventar líneas ausentes de un snapshot histórico.

Las cantidades legacy permanecen en 1 slot cuando ese era el dato guardado. No se convierten silenciosamente en exclusivas ni se reescriben snapshots firmados. La migración `0011` archiva los snapshots existentes como versión 0.

La implementación anterior de Postgres y sus advisory locks queda en el historial Git; ya no es el mecanismo vigente.

## Evidencia

`tests/surreal-orders.test.ts`, `tests/surreal-timezone.test.ts`, `tests/hybrid-workflow.test.ts`, `tests/hybrid-migration.test.ts` y `tests/order-snapshot.test.ts`: compartir cupo, exceso, exclusividad por cantidad, concurrencia, cotización libre, expiración, confirmación sin doble conteo, zonas horarias y conservación de históricos.
