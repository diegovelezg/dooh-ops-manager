-- 0006 · Órdenes de inserción (IO), líneas, capacidad, facturas y cobros.
--
-- CONCURRENCIA (SurrealDB usa OCC: sin FOR UPDATE ni advisory locks). La regla es:
-- toda transacción que dependa de lo que OTRA pueda cambiar escribe un registro
-- compartido; así dos concurrentes chocan en el commit y el SDK reintenta con datos
-- frescos (en `collect()`):
--   · capacidad  → `inv_screen.occupancy_rev` (una pantalla = una "cerradura"; PG usaba
--                  un lock por TIENDA, esto serializa solo lo que se pisa)
--   · cobros     → la propia factura (`io_invoice`, cada función la reescribe)
--   · numeración → `io_counter:[tienda, año]`
--   · reservas   → `inv_slot.booking_rev`
-- Sin ese registro compartido dos lecturas disjuntas pasarían ambas (write skew).
--
-- Fechas de negocio (inicio/fin, emisión…) son strings ISO `yyyy-mm-dd`: son días, no
-- instantes. Los instantes (líneas, firma, creación) son `datetime`. Lima no tiene DST
-- (UTC-5 fijo): el día-Lima [d, d+1) es [d 05:00Z, d+1 05:00Z).

DEFINE FUNCTION fn::is_date($v: any) -> bool {
  RETURN type::is_string($v) AND string::matches($v, '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
};
/** Clave (id sin tabla) de un enlace opcional; NONE si no hay. Para armar DTOs de la app. */
DEFINE FUNCTION fn::key($r: option<record>) -> option<string> { RETURN IF $r { record::id($r) } ELSE { NONE }; };
/** Inicio del día Lima (instante UTC). */
DEFINE FUNCTION fn::lima_day_start($d: string) -> datetime { RETURN <datetime> string::concat($d, 'T05:00:00Z'); };
/** Días ISO [a, b] inclusivos. */
DEFINE FUNCTION fn::days($a: string, $b: string) -> array<string> {
  RETURN array::map(
    array::range(0, duration::days(<datetime> string::concat($b, 'T00:00:00Z') - <datetime> string::concat($a, 'T00:00:00Z')) + 1),
    |$i| time::format(<datetime> string::concat($a, 'T00:00:00Z') + duration::from_days($i), '%Y-%m-%d')
  );
};

-- Registro compartido de concurrencia en tablas ya creadas.
DEFINE FIELD occupancy_rev ON inv_screen TYPE option<int> PERMISSIONS NONE;

-- ── inv_slot: espacio vendible fijo de una pantalla ───────────────────────
DEFINE TABLE inv_slot SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON inv_slot TYPE record<sys_store> READONLY;
DEFINE FIELD screen ON inv_slot TYPE record<inv_screen> REFERENCE ON DELETE CASCADE ASSERT $value.store = $this.store;
DEFINE FIELD slot_index ON inv_slot TYPE int ASSERT $value >= 1;
DEFINE FIELD is_programmatic_allowed ON inv_slot TYPE bool DEFAULT false;
DEFINE FIELD share_of_voice_target ON inv_slot TYPE option<number>;
DEFINE FIELD is_active ON inv_slot TYPE bool DEFAULT true;
DEFINE FIELD external_ref ON inv_slot TYPE option<string>;
DEFINE FIELD booking_rev ON inv_slot TYPE int DEFAULT 0 PERMISSIONS NONE;
DEFINE FIELD created_at ON inv_slot TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX inv_slot_screen ON inv_slot FIELDS screen, slot_index UNIQUE;
DEFINE INDEX inv_slot_ref ON inv_slot FIELDS store, external_ref UNIQUE;

-- ── io_order ──────────────────────────────────────────────────────────────
DEFINE TABLE io_order SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON io_order TYPE record<sys_store> READONLY;
DEFINE FIELD number ON io_order TYPE string ASSERT string::len(string::trim($value)) > 0;
DEFINE FIELD status ON io_order TYPE 'draft' | 'signed' | 'cancelled' DEFAULT 'draft';
DEFINE FIELD brand ON io_order TYPE option<string> ASSERT $value = NONE OR string::len(string::trim($value)) > 0;
DEFINE FIELD currency ON io_order TYPE string DEFAULT 'PEN' ASSERT string::matches($value, '^[A-Z]{3}$');
DEFINE FIELD advertiser ON io_order TYPE option<record<crm_company>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD billing ON io_order TYPE option<record<crm_company>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD agency ON io_order TYPE option<record<crm_company>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD billing_contact ON io_order TYPE option<record<crm_contact>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD signer_contact ON io_order TYPE option<record<crm_contact>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD payment_contact ON io_order TYPE option<record<crm_contact>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD manager_contact ON io_order TYPE option<record<crm_contact>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD starts_at ON io_order TYPE option<string> ASSERT $value = NONE OR fn::is_date($value);
DEFINE FIELD ends_at ON io_order TYPE option<string> ASSERT $value = NONE OR (fn::is_date($value) AND ($this.starts_at = NONE OR $value >= $this.starts_at));
DEFINE FIELD payment_terms ON io_order TYPE option<string>;
DEFINE FIELD payment_terms_days ON io_order TYPE option<int> ASSERT $value = NONE OR $value >= 0;
DEFINE FIELD commission_pct ON io_order TYPE option<number> ASSERT $value = NONE OR ($value >= 0 AND $value <= 100);
DEFINE FIELD service_clauses ON io_order TYPE option<string>;
DEFINE FIELD signed_by_agency ON io_order TYPE option<string>;
DEFINE FIELD signed_by_company ON io_order TYPE option<string>;
DEFINE FIELD signed_at ON io_order TYPE option<datetime>;
DEFINE FIELD notes ON io_order TYPE option<string>;
DEFINE FIELD doc_orden_medios ON io_order TYPE bool DEFAULT false;
DEFINE FIELD doc_orden_compra ON io_order TYPE bool DEFAULT false;
DEFINE FIELD doc_contrato ON io_order TYPE bool DEFAULT false;
DEFINE FIELD billing_portal_email ON io_order TYPE option<string>;
DEFINE FIELD billing_detail ON io_order TYPE option<string>;
DEFINE FIELD invoice_registration ON io_order TYPE option<string>;
-- Foto inmutable al firmar (OrderSnapshot v1/v2).
DEFINE FIELD snapshot_json ON io_order TYPE option<object> FLEXIBLE;
DEFINE FIELD created_by ON io_order TYPE option<string>;
DEFINE FIELD updated_by ON io_order TYPE option<string>;
DEFINE FIELD created_at ON io_order TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON io_order TYPE datetime VALUE time::now();
DEFINE EVENT io_order_signed_has_date ON io_order WHEN $event IN ['CREATE', 'UPDATE'] AND $after.status = 'signed' AND $after.signed_at = NONE
  THEN { THROW "io_order: una orden firmada requiere signed_at" };
DEFINE INDEX io_order_number ON io_order FIELDS store, number UNIQUE;
DEFINE INDEX io_order_store ON io_order FIELDS store, status, starts_at;

-- ── io_line: pantalla + periodo + slots ───────────────────────────────────
DEFINE TABLE io_line SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON io_line TYPE record<sys_store> READONLY;
DEFINE FIELD order ON io_line TYPE record<io_order> REFERENCE ON DELETE CASCADE ASSERT $value.store = $this.store;
-- REJECT: una pantalla con historia comercial no se elimina.
DEFINE FIELD screen ON io_line TYPE record<inv_screen> REFERENCE ON DELETE REJECT ASSERT $value.store = $this.store;
DEFINE FIELD slot ON io_line TYPE option<record<inv_slot>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
-- Periodo [starts_at, ends_at): el fin es el inicio del día siguiente (Lima).
DEFINE FIELD starts_at ON io_line TYPE datetime;
DEFINE FIELD ends_at ON io_line TYPE datetime ASSERT $value > $this.starts_at;
DEFINE FIELD rate_minor ON io_line TYPE option<int> ASSERT $value = NONE OR $value >= 0;
DEFINE FIELD tarifa_regular_minor ON io_line TYPE option<int> ASSERT $value = NONE OR $value >= 0;
DEFINE FIELD cant_meses ON io_line TYPE option<number> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD cant_dias ON io_line TYPE option<number> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD cant_slots ON io_line TYPE int DEFAULT 1 ASSERT $value >= 1 AND $value <= 100;
DEFINE FIELD notes ON io_line TYPE option<string>;
DEFINE FIELD created_at ON io_line TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX io_line_order ON io_line FIELDS order;
DEFINE INDEX io_line_screen ON io_line FIELDS screen, starts_at;

-- ── io_campaign / inv_booking ─────────────────────────────────────────────
DEFINE TABLE io_campaign SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON io_campaign TYPE record<sys_store> READONLY;
DEFINE FIELD advertiser ON io_campaign TYPE option<record<crm_company>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD order ON io_campaign TYPE option<record<io_order>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD primary_contact ON io_campaign TYPE option<record<crm_contact>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD name ON io_campaign TYPE string ASSERT string::len(string::trim($value)) > 0;
DEFINE FIELD status ON io_campaign TYPE 'draft' | 'reserved' | 'active' | 'completed' | 'cancelled' DEFAULT 'draft';
DEFINE FIELD starts_at ON io_campaign TYPE option<string> ASSERT $value = NONE OR fn::is_date($value);
DEFINE FIELD ends_at ON io_campaign TYPE option<string> ASSERT $value = NONE OR fn::is_date($value);
DEFINE FIELD budget_minor ON io_campaign TYPE option<int>;
DEFINE FIELD notes ON io_campaign TYPE option<string>;
DEFINE FIELD created_at ON io_campaign TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON io_campaign TYPE datetime VALUE time::now();
DEFINE INDEX io_campaign_order ON io_campaign FIELDS order UNIQUE;

DEFINE TABLE inv_booking SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON inv_booking TYPE record<sys_store> READONLY;
DEFINE FIELD slot ON inv_booking TYPE record<inv_slot> REFERENCE ON DELETE CASCADE ASSERT $value.store = $this.store;
DEFINE FIELD campaign ON inv_booking TYPE option<record<io_campaign>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD order ON inv_booking TYPE option<record<io_order>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD starts_at ON inv_booking TYPE datetime;
DEFINE FIELD ends_at ON inv_booking TYPE datetime ASSERT $value > $this.starts_at;
DEFINE FIELD status ON inv_booking TYPE 'hold' | 'confirmed' | 'active' | 'completed' | 'cancelled' DEFAULT 'hold';
DEFINE FIELD created_at ON inv_booking TYPE datetime DEFAULT time::now() READONLY;
-- Hard hold: un slot no se confirma dos veces en el mismo periodo. El evento escribe el slot
-- (registro compartido) para que dos confirmaciones concurrentes choquen y se reintenten.
DEFINE EVENT inv_booking_hard_hold ON inv_booking WHEN $event IN ['CREATE', 'UPDATE'] AND $after.status IN ['confirmed', 'active'] THEN {
  UPDATE $after.slot SET booking_rev = (booking_rev ?? 0) + 1;
  IF array::len(SELECT id FROM inv_booking
      WHERE slot = $after.slot AND id != $after.id AND status IN ['confirmed', 'active']
        AND starts_at < $after.ends_at AND ends_at > $after.starts_at) > 0 {
    THROW "inv_booking: hard hold solapado en el slot";
  };
};
DEFINE INDEX inv_booking_slot ON inv_booking FIELDS slot, starts_at;
DEFINE INDEX inv_booking_order ON inv_booking FIELDS order;

-- ── Documentos y control de la orden ──────────────────────────────────────
DEFINE TABLE io_agency_order SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON io_agency_order TYPE record<sys_store> READONLY;
DEFINE FIELD order ON io_agency_order TYPE record<io_order> REFERENCE ON DELETE CASCADE ASSERT $value.store = $this.store;
DEFINE FIELD kind ON io_agency_order TYPE 'OM' | 'OC';
DEFINE FIELD code ON io_agency_order TYPE string ASSERT string::len(string::trim($value)) > 0;
DEFINE FIELD portal ON io_agency_order TYPE option<string>;
DEFINE FIELD issued_at ON io_agency_order TYPE option<string> ASSERT $value = NONE OR fn::is_date($value);
DEFINE FIELD document_url ON io_agency_order TYPE option<string>;
DEFINE FIELD notes ON io_agency_order TYPE option<string>;
DEFINE FIELD created_by ON io_agency_order TYPE option<string>;
DEFINE FIELD created_at ON io_agency_order TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON io_agency_order TYPE datetime VALUE time::now();
DEFINE INDEX io_agency_order_code ON io_agency_order FIELDS store, kind, code UNIQUE;

DEFINE TABLE io_creative SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON io_creative TYPE record<sys_store> READONLY;
DEFINE FIELD order ON io_creative TYPE record<io_order> REFERENCE ON DELETE CASCADE ASSERT $value.store = $this.store;
DEFINE FIELD name ON io_creative TYPE string ASSERT string::len(string::trim($value)) > 0;
DEFINE FIELD file_url ON io_creative TYPE option<string>;
DEFINE FIELD width_px ON io_creative TYPE option<int> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD height_px ON io_creative TYPE option<int> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD aspect ON io_creative TYPE option<string>;
DEFINE FIELD container ON io_creative TYPE option<string>;
DEFINE FIELD codec ON io_creative TYPE option<string>;
DEFINE FIELD fps ON io_creative TYPE option<number> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD bitrate_kbps ON io_creative TYPE option<int> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD duration_s ON io_creative TYPE option<number> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD material_deadline ON io_creative TYPE option<string> ASSERT $value = NONE OR fn::is_date($value);
DEFINE FIELD qc_status ON io_creative TYPE 'pending' | 'approved' | 'rejected' DEFAULT 'pending';
DEFINE FIELD qc_notes ON io_creative TYPE option<string>;
DEFINE FIELD legal_status ON io_creative TYPE 'pending' | 'approved' | 'rejected' DEFAULT 'pending';
DEFINE FIELD legal_notes ON io_creative TYPE option<string>;
DEFINE FIELD created_by ON io_creative TYPE option<string>;
DEFINE FIELD created_at ON io_creative TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON io_creative TYPE datetime VALUE time::now();

DEFINE TABLE io_photo_check SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON io_photo_check TYPE record<sys_store> READONLY;
DEFINE FIELD order ON io_photo_check TYPE record<io_order> REFERENCE ON DELETE CASCADE ASSERT $value.store = $this.store;
DEFINE FIELD screen ON io_photo_check TYPE option<record<inv_screen>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD taken_at ON io_photo_check TYPE datetime DEFAULT time::now();
DEFINE FIELD photo_url ON io_photo_check TYPE option<string>;
DEFINE FIELD video_url ON io_photo_check TYPE option<string>;
DEFINE FIELD notes ON io_photo_check TYPE option<string>;
DEFINE FIELD created_by ON io_photo_check TYPE option<string>;
DEFINE FIELD created_at ON io_photo_check TYPE datetime DEFAULT time::now() READONLY;
DEFINE EVENT io_photo_check_has_media ON io_photo_check WHEN $event IN ['CREATE', 'UPDATE'] AND $after.photo_url = NONE AND $after.video_url = NONE
  THEN { THROW "io_photo_check: requiere foto o video" };

DEFINE TABLE io_play_log SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON io_play_log TYPE record<sys_store> READONLY;
DEFINE FIELD order ON io_play_log TYPE option<record<io_order>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD screen ON io_play_log TYPE option<record<inv_screen>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD slot ON io_play_log TYPE option<record<inv_slot>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD played_at ON io_play_log TYPE datetime;
DEFINE FIELD duration_s ON io_play_log TYPE option<number> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD error_code ON io_play_log TYPE option<string>;
DEFINE FIELD source ON io_play_log TYPE option<string>;
DEFINE FIELD raw_json ON io_play_log TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD created_at ON io_play_log TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX io_play_log_order ON io_play_log FIELDS order, played_at;

-- ── io_invoice / io_invoice_payment ───────────────────────────────────────
DEFINE TABLE io_invoice SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON io_invoice TYPE record<sys_store> READONLY;
DEFINE FIELD order ON io_invoice TYPE option<record<io_order>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD number ON io_invoice TYPE string ASSERT string::len(string::trim($value)) > 0;
DEFINE FIELD amount_minor ON io_invoice TYPE int ASSERT $value >= 0;
-- Paridad de moneda con la orden (nunca se mezclan monedas).
DEFINE FIELD currency ON io_invoice TYPE string DEFAULT 'PEN'
  ASSERT string::matches($value, '^[A-Z]{3}$') AND ($this.order = NONE OR $value = $this.order.currency);
DEFINE FIELD issue_date ON io_invoice TYPE option<string> ASSERT $value = NONE OR fn::is_date($value);
DEFINE FIELD due_date ON io_invoice TYPE option<string>
  ASSERT $value = NONE OR (fn::is_date($value) AND ($this.issue_date = NONE OR $value >= $this.issue_date));
DEFINE FIELD status ON io_invoice TYPE 'draft' | 'issued' | 'paid' | 'overdue' | 'cancelled' DEFAULT 'draft';
DEFINE FIELD om_ref ON io_invoice TYPE option<string>;
DEFINE FIELD pop_report_url ON io_invoice TYPE option<string>;
DEFINE FIELD notes ON io_invoice TYPE option<string>;
DEFINE FIELD created_at ON io_invoice TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON io_invoice TYPE datetime VALUE time::now();
-- Cobrado = suma de cobros vigentes (no revertidos): siempre al día, sin columna que sincronizar.
DEFINE FIELD paid_minor ON io_invoice COMPUTED
  math::sum((SELECT VALUE amount_minor FROM io_invoice_payment WHERE invoice = $parent.id AND voided_at = NONE));
DEFINE INDEX io_invoice_number ON io_invoice FIELDS store, number UNIQUE;
DEFINE INDEX io_invoice_order ON io_invoice FIELDS order;

DEFINE TABLE io_invoice_payment SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON io_invoice_payment TYPE record<sys_store> READONLY;
DEFINE FIELD invoice ON io_invoice_payment TYPE record<io_invoice> REFERENCE ON DELETE CASCADE ASSERT $value.store = $this.store;
DEFINE FIELD amount_minor ON io_invoice_payment TYPE int ASSERT $value > 0;
DEFINE FIELD source ON io_invoice_payment TYPE 'payment' | 'legacy_balance' DEFAULT 'payment';
DEFINE FIELD paid_on ON io_invoice_payment TYPE option<string> ASSERT $value = NONE OR fn::is_date($value);
DEFINE FIELD reference ON io_invoice_payment TYPE option<string>;
DEFINE FIELD created_by ON io_invoice_payment TYPE option<string>;
DEFINE FIELD voided_at ON io_invoice_payment TYPE option<datetime>;
DEFINE FIELD voided_by ON io_invoice_payment TYPE option<string>;
DEFINE FIELD void_reason ON io_invoice_payment TYPE option<string>;
DEFINE FIELD created_at ON io_invoice_payment TYPE datetime DEFAULT time::now() READONLY;
-- Un solo saldo heredado por factura.
DEFINE FIELD legacy_of ON io_invoice_payment TYPE option<record<io_invoice>> VALUE IF source = 'legacy_balance' { invoice };
DEFINE INDEX io_invoice_payment_legacy ON io_invoice_payment FIELDS legacy_of UNIQUE;
DEFINE INDEX io_invoice_payment_invoice ON io_invoice_payment FIELDS invoice;
DEFINE EVENT io_invoice_payment_shape ON io_invoice_payment WHEN $event IN ['CREATE', 'UPDATE'] THEN {
  IF $after.source = 'payment' AND ($after.paid_on = NONE OR $after.reference = NONE OR string::len(string::trim($after.reference)) = 0) {
    THROW "io_invoice_payment: un cobro requiere fecha y referencia";
  };
  IF $after.source = 'legacy_balance' AND $after.paid_on != NONE { THROW "io_invoice_payment: el saldo heredado no lleva fecha"; };
  IF ($after.voided_at = NONE) != ($after.void_reason = NONE) OR ($after.voided_at = NONE AND $after.voided_by != NONE) {
    THROW "io_invoice_payment: la reversión requiere fecha y motivo";
  };
};

-- ── Numeración correlativa por tienda y año (hora Lima) ───────────────────
DEFINE TABLE io_counter SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD store ON io_counter TYPE record<sys_store>;
DEFINE FIELD year ON io_counter TYPE int ASSERT $value >= 2000 AND $value <= 2100;
DEFINE FIELD last_n ON io_counter TYPE int DEFAULT 0 ASSERT $value >= 0;

/** Siguiente número de IO: `PREFIJO-AÑO-0001`. Dos creaciones concurrentes escriben el mismo
 *  contador → una reintenta y obtiene el siguiente (nunca se repite ni se salta en silencio). */
DEFINE FUNCTION fn::mint_io_number($store: record<sys_store>) -> string {
  LET $y = time::year(time::now() - 5h);
  LET $c = UPSERT type::record('io_counter', [$store, $y]) SET store = $store, year = $y, last_n = (last_n ?? 0) + 1 RETURN AFTER;
  LET $n = $c[0].last_n;
  RETURN string::concat($store.io_prefix ?? 'OI', '-', <string> $y, '-', IF $n < 10000 { string::slice(string::concat('0000', <string> $n), -4) } ELSE { <string> $n });
};
