# ADR 0009 — Capacidad vendible DOOH (issue #13)

Fecha: 2026-11-13. Alcance: cerrar el issue #13 sin reescribir históricos.

## Modalidad única inicial

- **1 slot = 1 espacio fijo por loop y día en la misma pantalla.** Es la
  unidad vendible (ref. sector: espacios fijos por loop, Broadsign Direct).
  No hay optimizador, ni todos los tipos de compra, ni programática
  (fuera de alcance del issue).
- **Capacidad** slots/día por pantalla: `inv_slots` activos; sin slots
  explícitos, `sys_stores.default_slots_per_screen` (default 10).
  Pantalla con filas de slots todas inactivas => capacidad 0 (pausada).
- **Línea** = pantalla + periodo inclusivo + slots (1–100) + flag
  `is_exclusive` + total. La exclusiva se contrata como **1 slot exclusivo**.
- **Exclusividad explícita**: una línea exclusiva ocupa toda la pantalla
  ese periodo. Regla:
  - día con exclusiva vigente => bloqueado para todo lo demás;
  - exclusiva pedida => requiere día vacío (reservados = 0);
  - exclusiva pedida con slots ≠ 1 => inválida (contradicción).

## Regla única de capacidad (selección, guardado, ocupación)

- El día-pantalla bloquea si `reservados + pedidos > capacidad`,
  o si hay exclusiva vigente, o si la pedida es exclusiva y el día no
  está vacío. Función pura: `dayBlocked` en `web/lib/availability.ts`.
- Fuentes vigentes: líneas de órdenes no canceladas + bookings no
  cancelados (1 slot c/u). Borrador aparta solo si fresco
  (`created_at + 7 días > ahora`, `HOLD_DAYS`).
- La **autoridad** ante concurrentes es la BD:
  `io_assert_capacity` + `io_replace_lines` con
  `pg_advisory_xact_lock('io-cap:' || store)` (migración
  `20270103000000`). El pre-check de la app (`findLineConflicts`)
  es solo UX; el RPC falla cerrado con `sin slots...`.
- Creación: post-inserción se invoca `io_assert_capacity` con el
  `io_id` nuevo como excluido; ante conflicto se compensa (borra la
  orden) y se responde reintentable. Degradación elegante si la
  migración aún no está aplicada (el pre-check ya validó).

## Órdenes y documento comercial

- La orden y su drawer muestran **unidad y cantidad**: Slots por línea
  (`orden-drawer.tsx`, `OrderScreensTable`) y foto inmutable al firmar:
  `OrderSnapshot v2` incluye `lines[]` (pantalla, periodo, días, slots,
  exclusiva, total). `parseOrderSnapshot` acepta v1 (legacy, sin líneas)
  y v2.

## Históricos (sin cambio silencioso)

- Migraciones aditivas: `cant_slots` default 1, `is_exclusive` default
  false, `default_slots_per_screen` default 10. **No se reescriben filas.**
- Interpretación documentada: las órdenes legacy (creadas cuando
  cualquier solape bloqueaba) se leen hoy como **1 slot no exclusivo**
  sobre capacidad 10. Pueden compartir pantalla con ventas nuevas; eso
  es lectura futura, no alteración de su compromiso firmado (el snapshot
  v1 sigue válido y el PDF prefiere snapshot).
- Verificación: `npm test` (pure: `dayBlocked`, `normalizeLineExclusive`,
  snapshot v2, validación exclusiva) + funcional manual por criterio:
  1. dos anunciantes comparten sin conflicto artificial;
  2. exceso rechazado incl. concurrentes (RPC);
  3. exclusiva bloquea incompatibles;
  4. orden/doc muestran unidad y cantidad.
