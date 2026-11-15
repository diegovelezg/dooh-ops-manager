-- MVP híbrido (#14, #16, #18, #19, #21). Aditiva: conserva datos e históricos.
-- Cotizaciones nuevas NO retienen. Los borradores previos mantienen su hold original
-- identificado como legacy hasta created_at+7d; no se prolonga ni se confirma nada.
DEFINE FIELD workflow_rev ON io_order TYPE int DEFAULT 0 MIGRATE EXISTING ROWS AS workflow_rev_init USING 0;
DEFINE FIELD agreement_revision ON io_order TYPE int DEFAULT 0 MIGRATE EXISTING ROWS AS agreement_rev_init USING 0;
DEFINE FIELD reservation_expires_at ON io_order TYPE option<datetime>;
DEFINE FIELD reserved_at ON io_order TYPE option<datetime>;
DEFINE FIELD reserved_by ON io_order TYPE option<string>;
DEFINE FIELD reservation_origin ON io_order TYPE option<'explicit' | 'legacy'>;
DEFINE FIELD responsible_email ON io_order TYPE option<string>;
DEFINE FIELD authorization_kind ON io_order TYPE option<'OM' | 'OC' | 'CONTRACT'>;
UPDATE io_order SET reservation_expires_at = created_at + 7d, reserved_at = created_at,
  reserved_by = created_by, reservation_origin = 'legacy' WHERE status = 'draft';
DEFINE FIELD OVERWRITE kind ON io_agency_order TYPE 'OM' | 'OC' | 'CONTRACT';
DEFINE FIELD agreement_revision ON io_agency_order TYPE int DEFAULT 0 MIGRATE EXISTING ROWS AS document_rev_init USING 0;
UPDATE io_order SET authorization_kind = IF doc_contrato { 'CONTRACT' } ELSE IF doc_orden_compra { 'OC' } ELSE IF doc_orden_medios { 'OM' } ELSE { NONE };
DEFINE FIELD lines ON io_creative TYPE array<record<io_line>> DEFAULT [] ASSERT array::len($value.filter(|$l| $l.store = $this.store AND $l.order = $this.order)) = array::len($value) MIGRATE EXISTING ROWS AS material_lines_init USING [];
DEFINE FIELD OVERWRITE lines.* ON io_creative TYPE record<io_line> ASSERT $value.store = $this.store AND $value.order = $this.order;
DEFINE FIELD superseded_at ON io_creative TYPE option<datetime>;
DEFINE FIELD supersedes ON io_creative TYPE option<record<io_creative>> ASSERT $value = NONE OR ($value.store = $this.store AND $value.order = $this.order);
DEFINE FIELD qc_reviewed_by ON io_creative TYPE option<string>;
DEFINE FIELD qc_reviewed_at ON io_creative TYPE option<datetime>;
DEFINE FIELD legal_reviewed_by ON io_creative TYPE option<string>;
DEFINE FIELD legal_reviewed_at ON io_creative TYPE option<datetime>;
DEFINE FIELD line ON io_photo_check TYPE option<record<io_line>> REFERENCE ON DELETE REJECT
  ASSERT $value = NONE OR ($value.store = $this.store AND $value.order = $this.order);
DEFINE FIELD coverage_from ON io_photo_check TYPE option<datetime>;
DEFINE FIELD coverage_to ON io_photo_check TYPE option<datetime> ASSERT $value = NONE OR $value > $this.coverage_from;
DEFINE FIELD evidence_kind ON io_photo_check TYPE 'photo' | 'supplier_report' | 'play_log' DEFAULT 'photo' MIGRATE EXISTING ROWS AS evidence_kind_init USING 'photo';

DEFINE TABLE io_order_event SCHEMAFULL PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON io_order_event TYPE record<sys_store> READONLY;
DEFINE FIELD order ON io_order_event TYPE record<io_order> REFERENCE ON DELETE REJECT ASSERT $value.store = $this.store;
DEFINE FIELD kind ON io_order_event TYPE string;
DEFINE FIELD payload ON io_order_event TYPE object FLEXIBLE;
DEFINE FIELD created_by ON io_order_event TYPE option<string>;
DEFINE FIELD created_at ON io_order_event TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX io_order_event_order ON io_order_event FIELDS order;
DEFINE EVENT io_order_event_immutable ON io_order_event WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'io_order_event: historial inmutable' };

DEFINE TABLE io_order_version SCHEMAFULL PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON io_order_version TYPE record<sys_store> READONLY;
DEFINE FIELD order ON io_order_version TYPE record<io_order> REFERENCE ON DELETE REJECT ASSERT $value.store = $this.store;
DEFINE FIELD revision ON io_order_version TYPE int;
DEFINE FIELD snapshot ON io_order_version TYPE object FLEXIBLE;
DEFINE FIELD reason ON io_order_version TYPE string;
DEFINE FIELD created_by ON io_order_version TYPE option<string>;
DEFINE FIELD created_at ON io_order_version TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX io_order_version_order ON io_order_version FIELDS order;
DEFINE EVENT io_order_version_immutable ON io_order_version WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'io_order_version: historial inmutable' };
DEFINE INDEX io_order_version_unique ON io_order_version FIELDS order, revision UNIQUE;

DEFINE TABLE io_purchase SCHEMAFULL PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON io_purchase TYPE record<sys_store> READONLY;
DEFINE FIELD order ON io_purchase TYPE record<io_order> REFERENCE ON DELETE REJECT ASSERT $value.store = $this.store;
DEFINE FIELD line ON io_purchase TYPE record<io_line> REFERENCE ON DELETE REJECT ASSERT $value.order = $this.order AND $value.store = $this.store;
DEFINE FIELD supplier ON io_purchase TYPE record<crm_company> ASSERT $value.store = $this.store;
DEFINE FIELD status ON io_purchase TYPE 'requested' | 'confirmed' | 'rejected' | 'cancelled';
DEFINE FIELD cost_minor ON io_purchase TYPE option<int> ASSERT $value = NONE OR $value >= 0;
DEFINE FIELD currency ON io_purchase TYPE option<string> ASSERT $value = NONE OR string::matches($value, '^[A-Z]{3}$');
DEFINE FIELD reference ON io_purchase TYPE string;
DEFINE FIELD reason ON io_purchase TYPE option<string>;
DEFINE FIELD terms ON io_purchase TYPE object FLEXIBLE;
DEFINE FIELD sequence ON io_purchase TYPE int;
DEFINE FIELD created_by ON io_purchase TYPE option<string>;
DEFINE FIELD created_at ON io_purchase TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX io_purchase_order ON io_purchase FIELDS order;
DEFINE EVENT io_purchase_immutable ON io_purchase WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'io_purchase: historial inmutable' };

DEFINE TABLE io_delivery SCHEMAFULL PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON io_delivery TYPE record<sys_store> READONLY;
DEFINE FIELD order ON io_delivery TYPE record<io_order> REFERENCE ON DELETE REJECT ASSERT $value.store = $this.store;
DEFINE FIELD line ON io_delivery TYPE record<io_line> REFERENCE ON DELETE REJECT ASSERT $value.order = $this.order AND $value.store = $this.store;
DEFINE FIELD evidence ON io_delivery TYPE option<record<io_photo_check>> ASSERT $value = NONE OR ($value.store = $this.store AND $value.order = $this.order AND $value.line = $this.line);
DEFINE FIELD status ON io_delivery TYPE 'fulfilled' | 'partial' | 'incident' | 'resolved';
DEFINE FIELD delivered_slots_days ON io_delivery TYPE int ASSERT $value >= 0;
DEFINE FIELD resolution ON io_delivery TYPE option<string>;
DEFINE FIELD terms ON io_delivery TYPE object FLEXIBLE;
DEFINE FIELD sequence ON io_delivery TYPE int;
DEFINE FIELD created_by ON io_delivery TYPE option<string>;
DEFINE FIELD created_at ON io_delivery TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX io_delivery_order ON io_delivery FIELDS order;
DEFINE EVENT io_delivery_immutable ON io_delivery WHEN $event IN ['UPDATE', 'DELETE'] THEN { THROW 'io_delivery: historial inmutable' };

-- Archivo del snapshot firmado existente sin modificarlo ni inventar una nueva aceptación.
FOR $o IN (SELECT * FROM io_order WHERE status = 'signed' AND snapshot_json != NONE) {
  CREATE io_order_version SET store = $o.store, order = $o.id, revision = 0,
    snapshot = $o.snapshot_json, reason = 'Snapshot firmado anterior al flujo de versiones', created_by = $o.created_by;
};
DEFINE FUNCTION fn::order_consumes($o: record<io_order>) -> bool {
  RETURN $o.status = 'signed' OR ($o.status = 'draft' AND $o.reservation_expires_at > time::now());
};
-- Barrido de intervalos: mismo cupo para UI, reserva y confirmación; incluye DST y límites no diarios.
DEFINE FUNCTION OVERWRITE fn::assert_capacity($store: record<sys_store>, $exclude: option<record<io_order>>, $lines: array<object>) {
  LET $screens = array::distinct($lines.map(|$l| type::record('inv_screen', $l.screen_id)));
  UPDATE $screens SET occupancy_rev = (occupancy_rev ?? 0) + 1;
  FOR $scr IN $screens {
    IF !record::exists($scr) OR $scr.store != $store { THROW 'Pantalla fuera del inventario' };
    LET $cap = fn::screen_capacity($scr);
    LET $mine = $lines.filter(|$l| type::record('inv_screen', $l.screen_id) = $scr).map(|$l| {
      starts_at: <datetime> array::first($l.days).from, ends_at: <datetime> array::last($l.days).to, qty: <int> $l.slots
    });
    FOR $l IN $mine { IF $l.ends_at <= $l.starts_at OR $l.qty < 1 OR $l.qty > 100 { THROW 'Línea inválida' }; };
    LET $others = SELECT starts_at, ends_at, cant_slots AS qty FROM io_line
      WHERE screen = $scr AND ($exclude = NONE OR order != $exclude) AND fn::order_consumes(order);
    LET $books = SELECT starts_at, ends_at, 1 AS qty FROM inv_booking
      WHERE store = $store AND status != 'cancelled' AND slot IN (SELECT VALUE id FROM inv_slot WHERE screen = $scr);
    LET $all = array::concat($mine, $others, $books);
    LET $points = array::distinct(array::flatten($all.map(|$l| [$l.starts_at, $l.ends_at])));
    FOR $at IN $points {
      LET $asked = math::sum($mine.filter(|$l| $l.starts_at <= $at AND $l.ends_at > $at).map(|$l| $l.qty));
      LET $used = math::sum($others.filter(|$l| $l.starts_at <= $at AND $l.ends_at > $at).map(|$l| $l.qty));
      LET $booked = math::sum($books.filter(|$l| $l.starts_at <= $at AND $l.ends_at > $at).map(|$l| $l.qty));
      IF $asked > 0 AND $used + $booked + $asked > $cap { THROW string::concat('sin slots en ', record::id($scr), ': cupo excedido') };
    };
  };
};

/** Reemplaza TODAS las líneas de un borrador (valida capacidad en la misma transacción).
 *  `$lines`: [{ screen_id, slots, total, notes?, days: [{ d, from, to }] }]; `total` en unidades mayores. */
DEFINE FUNCTION OVERWRITE fn::replace_lines($order: record<io_order>, $lines: array<object>, $actor: option<string>) {
  LET $o = (SELECT * FROM ONLY $order);
  IF !$o { THROW "orden no encontrada" };
  IF $o.status != 'draft' { THROW string::concat('solo borradores (estado ', $o.status, ')') };
  IF array::len($lines) = 0 { THROW "sin líneas" };
  IF fn::order_consumes($order) { fn::assert_capacity($o.store, $order, $lines) };
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
  UPDATE $order SET starts_at = array::first(array::sort($starts)), ends_at = array::last(array::sort($ends)), updated_by = $actor ?? NONE, workflow_rev = workflow_rev + 1;
  RETURN NONE;
};


-- Estado de reserva e historial en UNA transacción del caller. $expected evita aceptar una lectura vieja.
DEFINE FUNCTION fn::reserve_order($order: record<io_order>, $expected: int, $until: datetime, $lines: array<object>, $actor: string) {
  LET $o = (SELECT * FROM ONLY $order);
  IF !$o OR $o.status != 'draft' { THROW 'Solo se reservan cotizaciones' };
  IF $o.workflow_rev != $expected { THROW 'La orden cambió; recarga antes de reservar' };
  IF $until <= time::now() OR array::len($lines) = 0 { THROW 'Reserva sin líneas o vencimiento futuro' };
  fn::assert_capacity($o.store, $order, $lines);
  UPDATE $order SET reservation_expires_at = $until, reserved_at = time::now(), reserved_by = $actor,
    reservation_origin = 'explicit', workflow_rev += 1, updated_by = $actor;
  CREATE io_order_event SET store = $o.store, order = $order, kind = 'reserved', payload = { expires_at: <string> $until }, created_by = $actor;
};
DEFINE FUNCTION fn::release_order($order: record<io_order>, $actor: string) {
  IF $order.status != 'draft' { THROW 'Solo se libera una reserva de cotización' };
  CREATE io_order_event SET store = $order.store, order = $order, kind = 'reservation_released', payload = { previous_expiry: <string> $order.reservation_expires_at }, created_by = $actor;
  UPDATE $order SET reservation_expires_at = NONE, workflow_rev += 1, updated_by = $actor;
};
DEFINE FUNCTION fn::confirm_order($order: record<io_order>, $expected: int, $snapshot: object, $lines: array<object>, $actor: string) {
  LET $o = (SELECT * FROM ONLY $order);
  IF !$o OR $o.status != 'draft' { THROW 'Solo se confirma una cotización' };
  IF $o.workflow_rev != $expected { THROW 'La orden cambió; recarga antes de confirmar' };
  IF $o.billing = NONE OR $o.billing_contact = NONE OR $o.signer_contact = NONE OR $o.payment_terms_days = NONE
    OR $o.authorization_kind = NONE OR array::len($lines) = 0 { THROW 'Completa contratante, contactos, pago y documento antes de confirmar' };
  fn::assert_capacity($o.store, $order, $lines);
  IF $o.billing_contact.deleted_at != NONE OR $o.signer_contact.deleted_at != NONE OR $o.billing_contact.company != $o.billing OR $o.signer_contact.company != $o.billing { THROW 'Contactos activos del contratante requeridos' };
  IF $o.agency != NONE AND $o.commission_pct = NONE { THROW 'Comisión explícita requerida' };
  LET $v = $o.agreement_revision + 1;
  CREATE io_order_version SET store = $o.store, order = $order, revision = $v, snapshot = $snapshot, reason = 'Aceptación inicial', created_by = $actor;
  UPDATE $order SET status = 'signed', signed_at = time::now(), snapshot_json = $snapshot,
    agreement_revision = $v, workflow_rev += 1, reservation_expires_at = NONE, updated_by = $actor;
  CREATE io_order_event SET store = $o.store, order = $order, kind = 'confirmed', payload = { revision: $v }, created_by = $actor;
};
-- Cualquier transición a signed, incluso fuera de la función, vuelve a comprobar capacidad.
DEFINE EVENT io_order_confirm_capacity ON io_order WHEN $event = 'UPDATE' AND $before.status != 'signed' AND $after.status = 'signed' THEN {
  LET $lines = (SELECT record::id(screen) AS screen_id, cant_slots AS slots,
    [{ d: <string> starts_at, from: <string> starts_at, to: <string> ends_at }] AS days FROM io_line WHERE order = $after.id);
  fn::assert_capacity($after.store, $after.id, $lines);
};

DEFINE EVENT io_creative_same_lines ON io_creative WHEN $event IN ['CREATE', 'UPDATE'] THEN {
  FOR $line IN $after.lines {
    IF !record::exists($line) OR $line.order != $after.order OR $line.store != $after.store { THROW 'Material: línea fuera de la orden' };
  };
};
