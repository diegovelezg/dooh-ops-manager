-- Índices de lectura por tienda para las tablas hijas que el tablero (Hoy / Inbox) recorre completas.
-- Sin un índice que empiece por `store`, `WHERE store = $s` hace TableScan de TODOS los tenants
-- (EXPLAIN FULL: `order IN (...)` e `IN $ids` tampoco usan `*_order`). Con el índice el scan se limita
-- a las filas de la tienda. Solo agrega índices (no destruye nada); CONCURRENTLY no bloquea escrituras.
DEFINE INDEX io_line_store ON io_line FIELDS store CONCURRENTLY;
DEFINE INDEX io_creative_store ON io_creative FIELDS store CONCURRENTLY;
DEFINE INDEX io_photo_check_store ON io_photo_check FIELDS store CONCURRENTLY;
DEFINE INDEX io_purchase_store ON io_purchase FIELDS store CONCURRENTLY;
DEFINE INDEX io_delivery_store ON io_delivery FIELDS store CONCURRENTLY;
DEFINE INDEX io_invoice_payment_store ON io_invoice_payment FIELDS store CONCURRENTLY;
