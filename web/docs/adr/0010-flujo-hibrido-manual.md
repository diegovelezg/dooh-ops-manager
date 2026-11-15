# ADR 0010 — Flujo híbrido manual y trazable

Fecha: 2026-11-14. Issues #14, #15, #16, #18, #19, #21, #22 y #23; aceptación agrupada en #24.

## Decisiones confirmadas por Diego

- Reserva explícita con 24 horas predeterminadas y vencimiento editable; cotizar no retiene.
- Certificar exige evidencia de la línea/periodo y confirmación manual. Adjuntar una foto no certifica automáticamente.

## Contratación y versiones

La cotización requiere anunciante, marca, líneas, periodos, cantidades e importes. Antes de confirmar exige contratante y contactos activos, condición de pago, responsable del equipo, documento habilitante y comisión explícita cuando hay agencia. La reserva puede preceder a esos datos administrativos, con cupo comprobado.

El vendedor configura OM, OC o contrato/aceptación como política comercial; no se afirma una obligación legal universal. Solo el documento del tipo requerido y revisión vigente acredita autorización. Formulario, lectura, etapas y tareas comparten estas reglas.

Confirmar crea una versión inmutable con partes, contactos, líneas, cantidades, precios, moneda y condiciones. Cambios posteriores requieren motivo, control de revisión y otra versión; se conservan las anteriores. Se pueden modificar periodos, cantidades, importes, pago y notas de las líneas existentes. Una sustitución de pantallas/partes se gestiona mediante una nueva contratación, conservando la anterior.

Los acuerdos históricos se archivan como versión 0 exactamente como estaban; datos que el snapshot antiguo no contenía no se presentan como una nueva aceptación. Las fotos/materiales previos permanecen, pero no se inventan asignaciones por línea ni revisiones manuales. Los responsables históricos no conocidos se muestran sin asignar y pueden asignarse explícitamente.

## Inventario y compra externa

El alta distingue propio/proveedor y mantiene coherencia entre pantalla y su ubicación. Propio no lleva proveedor; externo exige proveedor activo del tenant. Cambiar modalidad limpia la selección incompatible.

Una orden mezcla inventario propio y externo. Cada compra externa guarda solicitud/confirmación/rechazo/cancelación, referencia, actor, fecha, costo y moneda, además del alcance aceptado. Es un historial de registros, sin sobrescribir el compromiso previo.

Margen comercial mostrado = venta menos costo externo aceptado menos comisión de agencia. Excluye costos operativos propios, impuestos y contabilidad. No calcula margen si faltan costos/comisión o si una compra usa otra moneda: no hay conversión implícita. Una modificación de fechas/cantidades vuelve a dejar pendiente una aceptación que ya no corresponde al alcance vigente.

## Materiales y evidencia

El material entra pendiente y se asigna a líneas. Técnica (seller+) y contenido (admin+) son revisiones manuales separadas, con actor/fecha y motivo al rechazar. Técnica compara duración/resolución declaradas con requisitos de las pantallas; no analiza el archivo automáticamente. Reemplazar crea una versión pendiente y conserva la anterior.

La evidencia guarda línea, tipo, cobertura y fecha real. Se distinguen foto puntual, reporte manual y registro de emisión. No se acepta cobertura futura. La foto tiene cobertura acotada y no afirma frecuencia. El cumplimiento completo exige evidencia que cubra el periodo finalizado, cantidad contratada y confirmación manual. Parcial/incidencia conservan cantidad y motivo; resolución administrativa (admin+) permite una excepción explícita con motivo y trazabilidad. Tras modificar el alcance, una entrega anterior no certifica las nuevas cantidades/fechas.

La orden terminada cierra operativamente al cumplirse o resolverse todas las líneas; cobranza y compromisos externos pendientes siguen por separado. Cancelar no borra compras, versiones, evidencia ni saldos legítimos. No se reactiva un acuerdo aceptado como cotización editable.

## Cola de trabajo y permisos

Hoy e Inbox derivan pendientes actuales de reserva, autorización, proveedor, material, entrega y cobro. Cada uno tiene contexto, responsable o falta de asignación, vencimiento conocido y acción. La causa resuelta desaparece sin mantener copias persistentes. Los avisos narrativos antiguos de esas mismas causas no duplican la cola vigente.

La ficha `/orders/[id]` conserva contexto y enlaces a líneas; los drawers siguen sirviendo para consulta y cobranza. Las mutaciones resuelven tenant/rol desde sesión, comprueban propiedad y revisión en servidor. Los cambios de comisión requieren admin/owner, igual que en el editor existente.

## Migración

`0011_hybrid_workflow.surql` es aditiva, sin REMOVE/DELETE masivos. Inicializa campos obligatorios mediante `MIGRATE EXISTING ROWS` con constantes explícitas, sin fallback de conversión. Referencias y tablas mantienen aislamiento por tienda e historial protegido contra UPDATE/DELETE.

Referencia técnica: [DEFINE FIELD, migración de registros existentes](https://surrealdb.com/docs/reference/query-language/statements/define/field). La política de negocio está definida arriba; esa referencia solo explica la sintaxis del motor.
