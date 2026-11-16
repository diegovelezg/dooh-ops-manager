-- `inv_booking` no tenía índice que empiece por `store`: la disponibilidad (`store = $s AND starts_at < … AND
-- ends_at > …`) escaneaba los bookings de TODOS los tenants. Solo agrega un índice; CONCURRENTLY no bloquea escrituras.
DEFINE INDEX inv_booking_store ON inv_booking FIELDS store, starts_at CONCURRENTLY;
