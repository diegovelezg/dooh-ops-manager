-- Periodo de la orden (instantes UTC) = [inicio de la 1ª línea, fin exclusivo de la última].
-- Las líneas son la fuente de verdad (ya eran instantes); el periodo antiguo en días no se podía
-- convertir sin zona y 0009 lo descartó.
UPDATE io_order SET
  starts_at = (SELECT VALUE starts_at FROM io_line WHERE order = $parent.id ORDER BY starts_at ASC LIMIT 1)[0],
  ends_at = (SELECT VALUE ends_at FROM io_line WHERE order = $parent.id ORDER BY ends_at DESC LIMIT 1)[0];

DEFINE INDEX io_order_store ON io_order FIELDS store, status, starts_at CONCURRENTLY;
