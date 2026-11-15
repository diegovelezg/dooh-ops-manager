-- Zona horaria por tenant. La BD guarda INSTANTES en UTC; el "día" de negocio existe solo en la
-- zona IANA del tenant (`sys_store.timezone`) y SurrealDB no resuelve zonas IANA ni DST, así que
-- toda conversión día↔instante la hace la app y llega a la BD ya resuelta:
--   · las líneas llegan con sus días como ventanas UTC `[from, to)` (un día puede durar 23/25 h);
--   · el año del correlativo y el "hoy" de un cobro llegan calculados en la zona del tenant.
-- `io_order.starts_at/ends_at` pasan de string (día) a datetime (UTC): inicio de la 1ª línea y fin
-- EXCLUSIVO de la última. La app los traduce a días con la zona del tenant al leerlos.

-- ── sys_store.timezone ────────────────────────────────────────────────────
-- Default solo para tiendas nuevas; el valor es siempre explícito y editable en Ajustes.
DEFINE FIELD timezone ON sys_store TYPE option<string> DEFAULT 'America/Lima'
  ASSERT $value = NONE OR (string::len($value) >= 3 AND string::len($value) <= 64);
UPDATE sys_store SET timezone = 'America/Lima' WHERE timezone = NONE;

-- Cambiar de zona con reservas/órdenes existentes corrompería sus ventanas (inicio de día en UTC).
DEFINE EVENT sys_store_timezone_locked ON sys_store WHEN $event = 'UPDATE' AND $before.timezone != $after.timezone THEN {
  IF array::len(SELECT VALUE id FROM io_order WHERE store = $after.id LIMIT 1) > 0
     OR array::len(SELECT VALUE id FROM inv_booking WHERE store = $after.id LIMIT 1) > 0 {
    THROW "La zona horaria no se puede cambiar: la tienda ya tiene órdenes o reservas";
  };
};

-- ── io_order: periodo como instantes UTC ──────────────────────────────────
-- El índice lee `starts_at`: SurrealDB exige quitarlo, migrar el campo y volver a definirlo.
REMOVE INDEX io_order_store ON io_order;
-- Los días string no son convertibles sin zona: las filas existentes se descartan (FALLBACK NONE) y se
-- recalculan abajo desde las líneas, que ya son instantes UTC (fuente de verdad).
DEFINE FIELD OVERWRITE starts_at ON io_order TYPE option<datetime> MIGRATE EXISTING ROWS AS order_starts_utc USING <datetime> ($value + 'T00:00:00Z') FALLBACK NONE;
DEFINE FIELD OVERWRITE ends_at ON io_order TYPE option<datetime> ASSERT $value = NONE OR $this.starts_at = NONE OR $value > $this.starts_at
  MIGRATE EXISTING ROWS AS order_ends_utc USING <datetime> ($value + 'T00:00:00Z') FALLBACK NONE;
-- (El recálculo desde las líneas y la reconstrucción del índice van en 0010: SurrealDB construye los
-- índices con las filas ya confirmadas, no dentro de la transacción que migra el campo.)

-- ── Funciones sin zona: reciben instantes/ventanas ya resueltos ───────────
REMOVE FUNCTION fn::lima_day_start;
REMOVE FUNCTION fn::days;

/** Capacidad por pantalla y día. `$lines`: [{ screen_id, slots, days: [{ d, from, to }] }] con cada día
 *  como ventana UTC `[from, to)` en la zona del tenant (la resuelve la app). */
DEFINE FUNCTION OVERWRITE fn::assert_capacity($store: record<sys_store>, $exclude: option<record<io_order>>, $lines: array<object>) {
  IF array::len($lines) = 0 { RETURN NONE };
  FOR $l IN $lines {
    IF !$l.screen_id OR array::len($l.days ?? []) = 0 { THROW "línea inválida" };
    LET $n = <int> ($l.slots ?? 1);
    IF $n < 1 OR $n > 100 { THROW "slots inválidos en línea (1–100)" };
  };
  LET $screens = array::distinct(array::map($lines, |$l| type::record('inv_screen', $l.screen_id)));
  -- Registro compartido: dos transacciones sobre la misma pantalla no pueden commitear a la vez.
  UPDATE $screens SET occupancy_rev = (occupancy_rev ?? 0) + 1;
  FOR $scr IN $screens {
    LET $mine = array::filter($lines, |$l| type::record('inv_screen', $l.screen_id) = $scr);
    LET $cap = fn::screen_capacity($scr);
    LET $days = array::distinct(array::flatten(array::map($mine, |$l| $l.days)));
    FOR $d IN $days {
      LET $from = <datetime> $d.from;
      LET $to = <datetime> $d.to;
      LET $lines_reserved = (SELECT VALUE math::sum(cant_slots) FROM io_line
        WHERE screen = $scr AND starts_at < $to AND ends_at > $from
          AND ($exclude = NONE OR order != $exclude)
          AND order.status != 'cancelled'
          AND (order.status != 'draft' OR order.created_at + 7d > time::now())
        GROUP ALL)[0] ?? 0;
      LET $booked = (SELECT VALUE count() FROM inv_booking
        WHERE store = $store AND status != 'cancelled' AND starts_at < $to AND ends_at > $from
          AND slot IN (SELECT VALUE id FROM inv_slot WHERE screen = $scr)
        GROUP ALL)[0] ?? 0;
      LET $asked = math::sum(array::map(array::filter($mine, |$l| $d IN $l.days), |$l| <int> ($l.slots ?? 1)));
      IF $lines_reserved + $booked + $asked > $cap {
        THROW string::concat('sin slots en ', record::id($scr), ' el ', $d.d, ': cupo/día excedido');
      };
    };
  };
  RETURN NONE;
};

/** Reemplaza TODAS las líneas de un borrador (valida capacidad en la misma transacción).
 *  `$lines`: [{ screen_id, slots, total, notes?, days: [{ d, from, to }] }]; `total` en unidades mayores. */
DEFINE FUNCTION OVERWRITE fn::replace_lines($order: record<io_order>, $lines: array<object>, $actor: option<string>) {
  LET $o = (SELECT * FROM ONLY $order);
  IF !$o { THROW "orden no encontrada" };
  IF $o.status != 'draft' { THROW string::concat('solo borradores (estado ', $o.status, ')') };
  IF array::len($lines) = 0 { THROW "sin líneas" };
  fn::assert_capacity($o.store, $order, $lines);
  DELETE io_line WHERE order = $order;
  FOR $l IN $lines {
    IF !type::is_number($l.total) OR $l.total <= 0 { THROW "total inválido en línea" };
    LET $scr = type::record('inv_screen', $l.screen_id);
    IF !record::exists($scr) OR (SELECT VALUE store FROM ONLY $scr) != $o.store { THROW "pantalla fuera del inventario" };
    LET $from = <datetime> array::first($l.days).from;
    LET $to = <datetime> array::last($l.days).to;
    IF $to <= $from { THROW "fin anterior al inicio en línea" };
    CREATE io_line SET
      store = $o.store, order = $order, screen = $scr,
      starts_at = $from, ends_at = $to,
      rate_minor = <int> math::round($l.total * 100),
      cant_dias = array::len($l.days),
      cant_slots = <int> ($l.slots ?? 1),
      notes = IF $l.notes AND string::len(string::trim($l.notes)) > 0 { string::trim($l.notes) } ELSE { NONE };
  };
  LET $starts = array::map($lines, |$l| <datetime> array::first($l.days).from);
  LET $ends = array::map($lines, |$l| <datetime> array::last($l.days).to);
  UPDATE $order SET starts_at = array::first(array::sort($starts)), ends_at = array::last(array::sort($ends)), updated_by = $actor ?? NONE;
  RETURN NONE;
};

/** Siguiente número de IO: `PREFIJO-AÑO-0001` (el año es el del tenant, lo resuelve la app). */
DEFINE FUNCTION OVERWRITE fn::mint_io_number($store: record<sys_store>, $year: int) -> string {
  LET $c = UPSERT type::record('io_counter', [$store, $year]) SET store = $store, year = $year, last_n = (last_n ?? 0) + 1 RETURN AFTER;
  LET $n = $c[0].last_n;
  RETURN string::concat($store.io_prefix ?? 'OI', '-', <string> $year, '-', IF $n < 10000 { string::slice(string::concat('0000', <string> $n), -4) } ELSE { <string> $n });
};

/** Cobro de factura. `$today` es "hoy" en la zona del tenant (resuelto por la app): no se cobra a futuro. */
DEFINE FUNCTION OVERWRITE fn::invoice_record_payment($invoice: record<io_invoice>, $payment_id: string, $amount: int, $paid_on: string, $reference: string, $today: string, $actor: option<string>) {
  LET $inv = (SELECT * FROM ONLY $invoice);
  IF !$inv { THROW "Factura no encontrada" };
  LET $existing = (SELECT * FROM ONLY type::record('io_invoice_payment', $payment_id));
  IF $existing {
    IF $existing.invoice = $invoice AND $existing.amount_minor = $amount AND $existing.paid_on = $paid_on
       AND $existing.reference = string::trim($reference) AND $existing.source = 'payment' { RETURN NONE };
    THROW "La solicitud de cobro ya existe con otros datos";
  };
  IF $inv.status NOT IN ['issued', 'overdue'] { THROW "La factura no admite nuevos cobros" };
  IF !$payment_id OR $amount <= 0 OR !fn::is_date($paid_on) OR !fn::is_date($today)
     OR $paid_on > $today
     OR string::len(string::trim($reference)) < 1 OR string::len(string::trim($reference)) > 200 {
    THROW "Monto, fecha o referencia de cobro inválidos";
  };
  LET $paid = math::sum(SELECT VALUE amount_minor FROM io_invoice_payment WHERE invoice = $invoice AND voided_at = NONE);
  IF $paid + $amount > $inv.amount_minor { THROW "El monto supera el saldo de la factura" };
  CREATE type::record('io_invoice_payment', $payment_id) SET
    store = $inv.store, invoice = $invoice, amount_minor = $amount, source = 'payment',
    paid_on = $paid_on, reference = string::trim($reference), created_by = $actor ?? NONE;
  UPDATE $invoice SET status = IF $paid + $amount = $inv.amount_minor { 'paid' } ELSE { 'issued' };
  IF $inv.order { UPDATE $inv.order SET updated_by = $actor ?? NONE };
  RETURN NONE;
};
