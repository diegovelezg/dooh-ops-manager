# Revisión de issues abiertos — 14/11/2026

Repositorio: https://github.com/diegovelezg/dooh-ops-manager

## Dictamen

Se revisaron los **10 issues abiertos**, sus descripciones y comentarios (sin comentarios en los diez), contrastándolos con el checkout actual de la rama `surrealdb` y con archivos de la rama `main` consultados directamente en GitHub.

- **Cierre inmediato por obsolescencia de Supabase: ninguno.** Los abiertos son principalmente requisitos funcionales del MVP híbrido, independientes del motor de datos.
- **Candidato a cierre al integrar/publicar: #13.** La implementación local y sus pruebas cubren capacidad por slots; falta confirmar que la solución completa llegue a la rama pública de referencia antes de declararlo terminado en GitHub.
- **Mantener abiertos: los otros 9**, incluyendo el tracking #24. #22 está parcialmente implementado y conviene acotar su descripción al trabajo restante.
- Los issues **#1–#12, #17 y #20 ya están cerrados**. No requieren una segunda limpieza. #24 ya refleja #17 y #20 como completados.

No se modificaron issues, comentarios ni etiquetas en GitHub. No se hicieron commits ni pushes. La petición se atendió como revisión y clasificación; no se cerraron pendientes funcionales bajo el supuesto de que la migración los resolvía.

## Clasificación completa

| Issue | Decisión propuesta | Evidencia actual / trabajo pendiente |
|---|---|---|
| [#13 — Capacidad vendible](https://github.com/diegovelezg/dooh-ops-manager/issues/13) | Candidato a cerrar tras integración y verificación en `main` | La BD aplica cupo por pantalla/día; dos órdenes comparten 6+4 slots; rechaza exceso, exclusiva por cantidad y carreras concurrentes. El snapshot v2 y el PDF incluyen slots. ADR 0009 documenta históricos y límites de exclusividad. Implementación local en `e0015cd`, `17c4b3c` y adaptación SurrealDB todavía sin commit. |
| [#14 — Cotización / reserva / confirmación](https://github.com/diegovelezg/dooh-ops-manager/issues/14) | Mantener | `HOLD_DAYS = 7`; crear un borrador continúa reteniendo capacidad por su edad. No hay transición explícita de cotización a reserva con actor y vencimiento comercial visible. |
| [#15 — Pantallas propias sin proveedor](https://github.com/diegovelezg/dooh-ops-manager/issues/15) | Mantener; corrección acotada prioritaria | `canSubmit` todavía exige `supplierId !== "__none"`. El backend y la BD admiten inventario propio sin proveedor, pero el alta de la interfaz sigue bloqueándolo. No confundir soporte del esquema con flujo completo de usuario. |
| [#16 — Confirmación / costo / margen de terceros](https://github.com/diegovelezg/dooh-ops-manager/issues/16) | Mantener | La línea de orden contiene tarifa de venta y cantidad. No se encontró un flujo ni campos para confirmación externa, costo aceptado y evidencia/moneda de compra. La comisión de agencia no resuelve ese requisito. |
| [#18 — Recepción y aprobación de materiales](https://github.com/diegovelezg/dooh-ops-manager/issues/18) | Mantener | `attachCreativeAction` sigue insertando `qc_status: "approved"` y `legal_status: "approved"` al adjuntar una URL. No existe asociación del archivo a cada línea con revisión/versionado explícitos. |
| [#19 — Certificación por línea / entregas parciales](https://github.com/diegovelezg/dooh-ops-manager/issues/19) | Mantener | `attachPhotoAction` recibe solo orden+URL. El estado usa existencia de foto a nivel de orden (`photoBy.has(id)` / `photos_count > 0`); una evidencia no demuestra cobertura de cada pantalla y periodo. Faltan resolución e historial de entregas parciales. |
| [#21 — Documentos y versiones del acuerdo](https://github.com/diegovelezg/dooh-ops-manager/issues/21) | Mantener | `orderStage` aún exige `hasOm` universalmente. Elegir contrato u OC en el formulario no cambia esa regla. El snapshot congela datos al firmar, pero no constituye un historial de modificaciones posteriores del acuerdo. |
| [#22 — Pendientes accionables en Hoy/Inbox](https://github.com/diegovelezg/dooh-ops-manager/issues/22) | Mantener y acotar | Ya existen contexto de la orden, menciones, enlaces a acción y deduplicación. `WallInsight` no define responsable operativo y vencimiento de tarea; tampoco cubre compromisos externos ni garantiza retirar/actualizar automáticamente todo pendiente resuelto. Depende de reglas de documentos #21 y de los demás flujos. |
| [#23 — Cotización mínima / vista completa de orden](https://github.com/diegovelezg/dooh-ops-manager/issues/23) | Mantener | La creación todavía exige condición de pago, documento para facturación y contactos contratante/firmante. La gestión de la orden sigue en drawer; la ruta `/orders/[id]/print` sirve al documento, no a un espacio completo de trabajo. |
| [#24 — Tracking MVP híbrido](https://github.com/diegovelezg/dooh-ops-manager/issues/24) | Mantener | Es el seguimiento de aceptación integral de los anteriores; no es un duplicado accidental. #17 y #20 ya figuran completados. Actualizar #13 cuando corresponda, conservando los demás pendientes. |

## Evidencia específica del candidato #13

Código actual:

- `web/lib/availability.ts`: `dayBlocked`, `getScreenCapacities`, `getPeriodAvailability` y grilla por slots.
- `surreal/migrations/0007_order_functions.surql` y `0009_tenant_timezone.surql`: autoridad transaccional de capacidad y reemplazo de líneas, con conflicto OCC sobre la pantalla.
- `web/tests/surreal-orders.test.ts`: 6+4 sobre cupo 10; rechazo de exceso; slots==capacidad; reservas de órdenes vencidas/canceladas; slots propios/pausa; **12 solicitudes concurrentes de 4 slots, exactamente 2 aceptadas**.
- `web/lib/order-snapshot.ts` y `web/tests/order-snapshot.test.ts`: snapshot v2 con cantidades, compatibilidad v1.
- `web/app/orders/[id]/print/page.tsx`: documento con columna Slots.
- `web/docs/adr/0009-capacidad-vendible-dooh.md`: unidad, exclusividad por cantidad, interpretación histórica y adaptación SurrealDB.

Validación ejecutada desde `web/`:

```bash
./node_modules/.bin/tsx --env-file=.env.local --test tests/surreal-orders.test.ts tests/order-snapshot.test.ts tests/availability.test.ts
```

Resultado: **39 tests correctos; cero fallidos y cero omitidos**. Las pruebas de BD usaron una base efímera, sin alterar datos de negocio.

### Por qué no cerrar #13 todavía

`main` es la rama predeterminada en GitHub. La lectura remota actual de `web/lib/availability.ts` todavía usa Supabase, aunque ya tiene parte del cálculo por slots. El ADR 0009 local no se encontró en `main`, y GitHub no pudo comparar el commit local `17c4b3cd8f99d51b79e10e894f11c5e71bb48075` con `main` (404). Por tanto, no está verificada la publicación de la solución completa. No basta con que el checkout local funcione para afirmar que el issue está resuelto en la versión pública de referencia.

Además, el ADR declara un límite comercial que debe mantenerse visible: si posteriormente aumenta la capacidad, una cantidad histórica que antes ocupaba toda la pantalla no se convierte automáticamente en exclusividad perpetua. No se cambió esta decisión ni se reescribieron compromisos históricos durante la revisión.

## Limpieza recomendada

1. Integrar/publicar por el flujo habitual la solución de #13 y su adaptación SurrealDB; verificar allí los criterios, cerrar #13 como completado y actualizar su casilla en #24. Esta revisión no autoriza ni ejecuta commits/pushes.
2. Atender #15 como corrección pequeña y vigente: liberar alta propia, hacer explícita propiedad y mantener validación de proveedor para terceros.
3. Conservar #14, #16, #18, #19 y #21 como trabajo central del MVP. La migración cambia su implementación técnica, no su necesidad funcional.
4. Acotar #22 a responsable operativo, vencimiento, ciclo de resolución y pendientes aún no cubiertos; evitar volver a construir el feed/menciones/enlaces ya disponibles.
5. Mantener #23 para simplificación de captura y vista completa, y #24 como aceptación integral. No cerrar un tracking porque parte de sus subtareas ya esté resuelta.

## Referencias consultadas

- Lista de abiertos: https://github.com/diegovelezg/dooh-ops-manager/issues?q=is%3Aissue%20is%3Aopen
- Lista de cerrados: https://github.com/diegovelezg/dooh-ops-manager/issues?q=is%3Aissue%20is%3Aclosed
- Código remoto comparado: https://github.com/diegovelezg/dooh-ops-manager/blob/main/web/lib/availability.ts y https://github.com/diegovelezg/dooh-ops-manager/blob/main/web/lib/order-actions.ts

No se consultaron las referencias comerciales externas enlazadas dentro de los issues: esta revisión contrasta sus criterios con la implementación, sin proponer nuevas políticas comerciales ni validar requisitos legales del sector.
