-- 0007 · Reglas transaccionales de órdenes: capacidad por día-pantalla, reemplazo de líneas
-- y cobros de facturas. Cada función se ejecuta dentro de UNA transacción del caller y
-- escribe un registro compartido (ver 0006) para que las carreras se conviertan en
-- conflictos reintentables en vez de sobreventa o doble cobro.

/** Capacidad slots/día de una pantalla (SSOT): slots activos propios; sin slots definidos, el
 *  default de la tienda (10); si todos están inactivos, 0 (pantalla pausada). */
DEFINE FUNCTION fn::screen_capacity($screen: record<inv_screen>) -> int {
  LET $active = (SELECT VALUE count() FROM inv_slot WHERE screen = $screen AND is_active != false GROUP ALL)[0] ?? 0;
  IF $active > 0 { RETURN $active };
  IF array::len(SELECT VALUE id FROM inv_slot WHERE screen = $screen LIMIT 1) > 0 { RETURN 0 };
  RETURN (SELECT VALUE store.default_slots_per_screen FROM ONLY $screen) ?? 10;
};

/** Capacidad por día-pantalla (regla única del ADR 0009): reservado + pedido ≤ capacidad.
 *  `$lines`: [{ screen_id, starts, ends, slots }] con fechas ISO inclusivas.
 *  Reservado = líneas de órdenes no canceladas (borrador solo si fresco, 7 días) + bookings
 *  no cancelados; `$exclude` = orden que se está reemplazando. Capacidad = slots activos de la
 *  pantalla; sin slots definidos, el default de la tienda; todos inactivos = pausada (0). */
DEFINE FUNCTION fn::assert_capacity($store: record<sys_store>, $exclude: option<record<io_order>>, $lines: array<object>) {
  IF array::len($lines) = 0 { RETURN NONE };
  FOR $l IN $lines {
    IF !$l.screen_id OR !fn::is_date($l.starts) OR !fn::is_date($l.ends) { THROW "línea inválida" };
    IF $l.ends < $l.starts { THROW "fin anterior al inicio en línea" };
    LET $n = <int> ($l.slots ?? 1);
    IF $n < 1 OR $n > 100 { THROW "slots inválidos en línea (1–100)" };
  };
  LET $screens = array::distinct(array::map($lines, |$l| type::record('inv_screen', $l.screen_id)));
  -- Registro compartido: dos transacciones sobre la misma pantalla no pueden commitear a la vez.
  UPDATE $screens SET occupancy_rev = (occupancy_rev ?? 0) + 1;
  FOR $scr IN $screens {
    LET $mine = array::filter($lines, |$l| type::record('inv_screen', $l.screen_id) = $scr);
    LET $cap = fn::screen_capacity($scr);
    LET $days = array::distinct(array::flatten(array::map($mine, |$l| fn::days($l.starts, $l.ends))));
    FOR $d IN $days {
      LET $from = fn::lima_day_start($d);
      LET $to = $from + 1d;
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
      LET $asked = math::sum(array::map(array::filter($mine, |$l| $l.starts <= $d AND $l.ends >= $d), |$l| <int> ($l.slots ?? 1)));
      IF $lines_reserved + $booked + $asked > $cap {
        THROW string::concat('sin slots en ', record::id($scr), ' el ', $d, ': cupo/día excedido');
      };
    };
  };
  RETURN NONE;
};

/** Reemplaza TODAS las líneas de un borrador (valida capacidad en la misma transacción).
 *  `$lines`: [{ screen_id, starts, ends, total, slots, notes? }]; `total` en unidades mayores. */
DEFINE FUNCTION fn::replace_lines($order: record<io_order>, $lines: array<object>, $actor: option<string>) {
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
    CREATE io_line SET
      store = $o.store, order = $order, screen = $scr,
      starts_at = fn::lima_day_start($l.starts),
      ends_at = fn::lima_day_start($l.ends) + 1d,
      rate_minor = <int> math::round($l.total * 100),
      cant_dias = array::len(fn::days($l.starts, $l.ends)),
      cant_slots = <int> ($l.slots ?? 1),
      notes = IF $l.notes AND string::len(string::trim($l.notes)) > 0 { string::trim($l.notes) } ELSE { NONE };
  };
  LET $starts = array::sort(array::map($lines, |$l| $l.starts));
  LET $ends = array::sort(array::map($lines, |$l| $l.ends));
  UPDATE $order SET starts_at = $starts[0], ends_at = array::last($ends), updated_by = $actor ?? NONE;
  RETURN NONE;
};

/** Cobro de factura: idempotente por id; nunca supera el saldo. Reescribe la factura (registro
 *  compartido) → dos cobros simultáneos se serializan y el segundo ve el saldo real. */
DEFINE FUNCTION fn::invoice_record_payment($invoice: record<io_invoice>, $payment_id: string, $amount: int, $paid_on: string, $reference: string, $actor: option<string>) {
  LET $inv = (SELECT * FROM ONLY $invoice);
  IF !$inv { THROW "Factura no encontrada" };
  LET $existing = (SELECT * FROM ONLY type::record('io_invoice_payment', $payment_id));
  IF $existing {
    IF $existing.invoice = $invoice AND $existing.amount_minor = $amount AND $existing.paid_on = $paid_on
       AND $existing.reference = string::trim($reference) AND $existing.source = 'payment' { RETURN NONE };
    THROW "La solicitud de cobro ya existe con otros datos";
  };
  IF $inv.status NOT IN ['issued', 'overdue'] { THROW "La factura no admite nuevos cobros" };
  IF !$payment_id OR $amount <= 0 OR !fn::is_date($paid_on)
     OR $paid_on > time::format(time::now() - 5h, '%Y-%m-%d')
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

/** Reversión de un cobro (no se borra: queda auditado con motivo). Recalcula el estado. */
DEFINE FUNCTION fn::invoice_void_payment($invoice: record<io_invoice>, $payment_id: string, $reason: string, $actor: option<string>) {
  LET $inv = (SELECT * FROM ONLY $invoice);
  IF !$inv { THROW "Factura no encontrada" };
  IF $inv.status NOT IN ['issued', 'paid', 'overdue'] { THROW "La factura no admite correcciones de cobro" };
  IF string::len(string::trim($reason)) < 1 OR string::len(string::trim($reason)) > 500 { THROW "Indica el motivo de la reversión (máx 500)" };
  LET $pay = (SELECT * FROM ONLY type::record('io_invoice_payment', $payment_id));
  IF !$pay OR $pay.invoice != $invoice { THROW "Cobro no encontrado" };
  UPDATE type::record('io_invoice_payment', $payment_id) SET voided_at = time::now(), voided_by = $actor ?? NONE, void_reason = string::trim($reason)
    WHERE voided_at = NONE;
  LET $paid = math::sum(SELECT VALUE amount_minor FROM io_invoice_payment WHERE invoice = $invoice AND voided_at = NONE);
  UPDATE $invoice SET status = IF $paid >= $inv.amount_minor AND $inv.amount_minor > 0 { 'paid' } ELSE { 'issued' };
  IF $inv.order { UPDATE $inv.order SET updated_by = $actor ?? NONE };
  RETURN NONE;
};

/** Anula una factura emitida sin cobros vigentes. */
DEFINE FUNCTION fn::invoice_cancel($invoice: record<io_invoice>, $actor: option<string>) {
  LET $inv = (SELECT * FROM ONLY $invoice);
  IF !$inv { THROW "Factura no encontrada" };
  IF $inv.status NOT IN ['issued', 'overdue'] { THROW "Solo se puede anular una factura emitida sin cobros" };
  IF array::len(SELECT VALUE id FROM io_invoice_payment WHERE invoice = $invoice AND voided_at = NONE) > 0 {
    THROW "La factura tiene cobros: revisa y revierte los registros erróneos antes de anular";
  };
  UPDATE $invoice SET status = 'cancelled';
  IF $inv.order { UPDATE $inv.order SET updated_by = $actor ?? NONE };
  RETURN NONE;
};

-- Red de seguridad para cualquier ruta de escritura: un cobro nunca excede la factura.
DEFINE EVENT io_invoice_payment_cap ON io_invoice_payment WHEN $event = 'CREATE' THEN {
  UPDATE $after.invoice SET payment_rev = (payment_rev ?? 0) + 1;
  IF math::sum(SELECT VALUE amount_minor FROM io_invoice_payment WHERE invoice = $after.invoice AND voided_at = NONE)
     > (SELECT VALUE amount_minor FROM ONLY $after.invoice) {
    THROW "io_invoice_payment: el cobro excede el monto de la factura";
  };
};
DEFINE FIELD payment_rev ON io_invoice TYPE int DEFAULT 0 PERMISSIONS NONE;
