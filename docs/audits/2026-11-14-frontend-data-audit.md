# Auditoría del consumo de datos en el frontend tras migrar a SurrealDB

Fecha: 2026-11-14T18:15:08.419690-05:00 (America/Lima). Entorno local: Next.js `localhost:3000`; SurrealDB namespace `dooh`, base `ops`.

## Resultado

Se localizaron y corrigieron inconsistencias en el recorrido BD → repositorios → API/server actions → interfaz. La revisión final de datos y los recorridos visuales autenticados descritos abajo no presentaron nuevos fallos de ejecución. **No se emite una certificación de “cero errores” para todo el proyecto:** ESLint sigue reportando 8 errores ya presentes al inicio.

La revisión incluyó IDs y relaciones, fechas UTC y días del tenant, campos opcionales, importes en unidades menores, conteos, filtros, disponibilidad, manejo de errores y acceso por membresía. Se usó el servidor existente del mismo proyecto en el puerto 3000.

## Problemas confirmados y corregidos

| Prioridad | Problema reproducido | Corrección |
|---|---|---|
| P1 | Finanzas recibía una fila por línea y contaba cada una como una orden. Los datos reales daban 2 órdenes y ticket de 224 991 unidades menores, aunque existe 1 orden con 2 líneas. | `FinanceOrder` exige `order_id`; el conteo mensual y del tramo usa órdenes distintas. Se siguen sumando todos los importes de líneas. Se actualizan la página y la herramienta del agente para compartir la misma regla. Resultado: 1 orden, contratado y ticket de **449 982 unidades menores = S/ 4 499,82**. La tabla mensual se etiqueta “Órdenes”. |
| P1 | Nueva orden y edición solo recibían las primeras 200 de las **203 pantallas activas**. Las acciones de disponibilidad también recortaban silenciosamente IDs a 200. | Se elimina el recorte en los dos consumidores y en ambas acciones. El selector visual muestra **203 de 203**; las pruebas verifican disponibilidad y ocupación de las 203. |
| P1 | `listMyStores` convertía cualquier error de sesión/membresía en `null`, valor reservado al modo anónimo. Con un token inválido reproducido en un proceso de prueba, devolvía la lista sin filtro de membresía. | Se propaga el error en lugar de convertirlo en acceso anónimo. Regresión con token inválido, ausencia de sesión y usuario de una sola tienda frente a otra tienda. |
| P2 | `countOrders(endedBefore)` interpretaba el día en UTC, mientras `selectOrders` lo convertía a la zona del tenant. Para `2026-12-01`, los datos reales daban listado=1, conteo=0. | Ambos usan el inicio del día en la zona del tenant. Resultado listado=1, conteo=1. Pruebas independientes para Lima y Tokio. |
| P1 | La API de ocupación capturaba un error de disponibilidad y respondía capacidad por defecto, cero conflictos y calendario libre. Además, parámetros ausentes se convertían a cero mediante `Number(null)`. | Un fallo de consulta produce HTTP 500. Los parámetros ausentes aplican las ventanas documentadas de 90 días pasados y 120 futuros. Regresión con fallo parcial de capacidad inyectado, sin tocar datos reales. |
| P2 | El indicador de consumo de IA podía mostrar cero o cifras de la tienda anterior si fallaba la API o cambiaba la tienda. También llamaba `useTz` sin tienda activa. | La API fallida se distingue como “Uso no disponible”; se reinicia el estado por tienda, se incluye la zona en las dependencias y no se monta el consumidor de zona sin tienda. Se verificó el indicador visible en escritorio con el consumo real. |
| P2 | Una respuesta antigua de disponibilidad podía sobrescribir la consulta nueva; un error de ocupación se ignoraba; el cálculo de “hasta” comparaba objetos en vez de sus fechas. Faltaba la zona en dependencias del hook y de la interpretación inicial de líneas. | Se ignoran las respuestas de efectos ya invalidados, se muestra el error de ocupación, se compara `ends` y se incluyen las dependencias de zona. |

Archivos principales: `web/lib/finance.ts`, `web/lib/tenant.ts`, `web/lib/orders-store.ts`, `web/lib/order-actions.ts`, `web/app/api/screens/route.ts`, `web/app/api/screens/[id]/occupancy/route.ts`, `web/components/usage-pill.tsx` y consumidores de órdenes/finanzas.

## Verificación con los datos reales

Se ejecutaron **269 comprobaciones de lectura** a través de los repositorios que consume la aplicación, sin modificar datos de negocio. Incluyen las **203 fichas de pantalla**, opciones y órdenes de listado, fichas de empresas, contactos activos/archivados, órdenes y sus líneas, marcas, disponibilidad y snapshot de Hoy. Resultado final: **269 correctas, cero excepciones**.

La comprobación inicial usó por error `kind` como clave de ordenación de empresas en el script de auditoría; se corrigió a la clave pública `type`. Esa excepción era del script de comprobación, no de la aplicación, y no se reporta como defecto del producto.

Después de corregir el desfase temporal, se repitió también la comparación de conteo/listado sobre la orden real:

| Corte de fin | Listado | Conteo |
|---|---:|---:|
| `2026-11-30` | 0 | 0 |
| `2026-12-01` | 1 | 1 |

## Revisión visual con sesión real

Se inspeccionaron **11 páginas**: Hoy, Finanzas, Inventario, Órdenes, Nueva orden, Ocupación, Empresas, Contactos, Marcas, Inbox y Ajustes. También la ficha de pantalla, su calendario y el detalle de la orden. Se probaron la búsqueda “Bonilla” y el selector de pantallas.

Resultados observados:

- Inventario: **203 ubicaciones y 203 pantallas**. Búsqueda “Bonilla”: 2 resultados; ficha y coordenadas coherentes con la BD.
- Selector de nueva orden: **203 de 203**. No se creó ni envió una orden real.
- Orden `SM-2026-0001`: 2 pantallas, 27 días, 1 slot por línea, periodo **04/11/2026–30/11/2026**. Firma y fechas de auditoría visibles en hora del tenant.
- Finanzas: **1 orden** y ticket igual al bruto de esa orden. El componente monetario compacta el importe visible a `PEN 4.500`; los cálculos conservan los **449 982 céntimos** originales.
- Ocupación de Bonilla hacia Miraflores: **1/10 slots reservado, 9 libres**; calendario y matriz coinciden. “Libre” indica que todavía admite otro slot, no que carezca de pauta.
- Hoy, Órdenes e Inbox coinciden en que falta material registrado y la salida está atrasada; no se confunde la autorización con material disponible.
- Empresas: 4 resultados con el filtro predeterminado Agencia/Anunciante. Contactos: 11. Marcas: 1 con 2 pantallas. Ajustes: 5 miembros y zona del tenant. Son conteos filtrados del frontend, no pérdida de empresas proveedoras o del usuario sin membresía.
- Se comprobó el indicador de IA en escritorio y el resto de páginas en la vista estrecha existente. El tamaño temporal de escritorio se restauró al terminar.

### Incidencia del servidor de desarrollo

La prueba visual de ocupación detectó un bundle antiguo que aún referenciaba `limaDayStart`, aunque ese nombre ya no existía en el código fuente vigente. Se verificó la ausencia de referencias en `web/lib` y `web/app`, se compiló producción y se reinició **el mismo servidor en el puerto 3000**. Después, la ocupación respondió correctamente y las comprobaciones finales del navegador no reportaron errores de consola. No se añadió un alias ni un fallback para ocultar la incompatibilidad.

## Pruebas y compilación

Ejecutadas desde `web/`:

```bash
npm test
npx tsc --noEmit
npm run build
npm run lint
```

| Comprobación | Resultado |
|---|---|
| Tests | **452/452**, cero fallidos y cero omitidos |
| TypeScript | Correcto |
| Build de producción | Correcto |
| Lecturas de datos reales | **269/269** |
| `git diff --check` | Correcto |
| ESLint | **8 errores y 15 avisos**; al inicio eran 8 errores y 17 avisos |

Las nuevas regresiones viven en `web/tests/finance.test.ts`, `web/tests/surreal-timezone.test.ts` y `web/tests/tenant-reads.test.ts`. Las pruebas de integración crean y eliminan bases efímeras en `dooh_test`. Las cookies y la navegación de Next se controlan en el proceso hijo de prueba; se usan consultas SurrealDB reales. Para probar el calendario fallido se inyecta únicamente un error de lectura en ese proceso, sin alterar el servidor ni las tablas de negocio.

## Pendiente: errores de lint preexistentes

Estos errores ya se observaron en la ejecución inicial. Siguen impidiendo declarar que todos los checks del repositorio pasan; no se eliminaron mediante desactivaciones de reglas.

| Archivo | Línea | Regla |
|---|---:|---|
| `web/app/(dashboard)/companies/vinculo-form.tsx` | 63 | `react-hooks/set-state-in-effect` |
| `web/app/(dashboard)/finance/page.tsx` | 169 | `react-hooks/purity` |
| `web/app/(dashboard)/orders/new/nueva-form.tsx` | 134 | `react-hooks/set-state-in-effect` |
| `web/app/(dashboard)/orders/new/nueva-form.tsx` | 218 | `react-hooks/set-state-in-effect` |
| `web/app/(dashboard)/orders/order-lines-form.tsx` | 157 | `react-hooks/set-state-in-effect` |
| `web/app/(dashboard)/screens/venue-map-picker.tsx` | 36 | `react-hooks/refs` |
| `web/components/entity-list.tsx` | 41 | `react-hooks/set-state-in-effect` |
| `web/hooks/use-mobile.ts` | 14 | `react-hooks/set-state-in-effect` |

Se concentran en sincronización de estado dentro de efectos, escritura de refs durante render y el uso de tiempo actual en el render servidor de Finanzas. No provocaron un fallo en los recorridos ejecutados, pero quedan como hallazgos de calidad pendientes.

## Evidencia y límites

El archivo [2026-11-14-frontend-data-audit.json](2026-11-14-frontend-data-audit.json) registra las 269 comprobaciones, resultados de validación y errores de lint pendientes. Los logs y scripts de comprobación adicionales están en `/tmp/dooh-fe-*`; son temporales.

Capturas guardadas:

- `/home/diegovelezg/.codex/visualizations/2026/11/14/01a1dc41-f295-7613-b5ef-47bf36e6fccf/fe-audit-finance.jpg`
- `/home/diegovelezg/.codex/visualizations/2026/11/14/01a1dc41-f295-7613-b5ef-47bf36e6fccf/fe-audit-finance-desktop.jpg`

La sesión visual fue la del propietario del tenant local; la separación entre tenants se verificó además en bases efímeras. No se enviaron formularios que alteraran datos reales, no se ejecutaron llamadas al LLM ni se validó una base remota de producción. Las entidades sin registros reales (por ejemplo, facturas y pagos) están cubiertas por pruebas de integración, no por comprobación visual de transacciones reales. No se hicieron commits ni pushes.
