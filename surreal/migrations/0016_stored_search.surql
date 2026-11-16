-- `search` pasa de COMPUTED (se evaluaba en CADA lectura, por fila: `fn::norm` + joins a empresa/venue/proveedor)
-- a campo GUARDADO (`VALUE`, se evalúa al escribir). Medido con 8 250 contactos / 1 624 pantallas: el listado
-- con texto tardaba ~430 ms / ~230 ms, de los que ~130 / ~110 ms eran solo evaluar `search`.
-- Los textos de OTRAS tablas que `search` incorpora se mantienen con eventos de cascada:
--   · crm_company.name  → search de sus contactos (company.name) y de sus pantallas (supplier.name)
--   · inv_venue.name/district/city → search de sus pantallas (venue.*)
-- `inv_venue.search` queda COMPUTED (ninguna lectura lo usa).
-- Tipo `option<string>`: con nivel de compatibilidad 4, un `string` sobre una tabla con filas exige MIGRATE
-- EXISTING ROWS; el `VALUE` lo llena siempre (el relleno de abajo cubre las filas existentes).

-- Índice para el evento de cascada por proveedor (contactos ya tiene `crm_contact_store (store, company, …)`
-- y pantallas por venue `inv_screen_venue (store, venue)`).
DEFINE INDEX inv_screen_supplier ON inv_screen FIELDS store, supplier CONCURRENTLY;

DEFINE FIELD OVERWRITE search ON crm_company TYPE option<string>
  VALUE fn::norm(string::concat(name, ' ', legal_name ?? '', ' ', tax_id ?? '', ' ', domain ?? '', ' ', email ?? ''));
DEFINE FIELD OVERWRITE search ON crm_contact TYPE option<string>
  VALUE fn::norm(string::concat(first_name ?? '', ' ', last_name ?? '', ' ', email ?? '', ' ', job_title ?? '', ' ', company.name ?? ''));
DEFINE FIELD OVERWRITE search ON inv_screen TYPE option<string>
  VALUE fn::norm(string::concat(name, ' ', external_ref ?? '', ' ', venue.name ?? '', ' ', venue.district ?? '', ' ', venue.city ?? '', ' ', supplier.name ?? ''));

-- Reescribir un registro sin SET re-evalúa sus `VALUE` (recalcula `search`).
DEFINE EVENT crm_company_search_cascade ON crm_company WHEN $event = 'UPDATE' AND $before.name != $after.name THEN {
  UPDATE crm_contact WHERE store = $after.store AND company = $after.id;
  UPDATE inv_screen WHERE store = $after.store AND supplier = $after.id;
};
DEFINE EVENT inv_venue_search_cascade ON inv_venue
  WHEN $event = 'UPDATE' AND ($before.name != $after.name OR $before.district != $after.district OR $before.city != $after.city) THEN {
  UPDATE inv_screen WHERE store = $after.store AND venue = $after.id;
};

-- Relleno de las filas existentes. IRREVERSIBLE (derivado, se puede recalcular): solo escribe `search`.
-- `updated_at` es `VALUE time::now()` y marcaría TODAS las filas como editadas ahora; se conserva el valor
-- previo mientras dura el relleno y se restaura la definición original justo después.
DEFINE FIELD OVERWRITE updated_at ON crm_company TYPE datetime VALUE $value ?? time::now();
DEFINE FIELD OVERWRITE updated_at ON crm_contact TYPE datetime VALUE $value ?? time::now();
DEFINE FIELD OVERWRITE updated_at ON inv_screen TYPE datetime VALUE $value ?? time::now();
UPDATE crm_company;
UPDATE crm_contact;
UPDATE inv_screen;
DEFINE FIELD OVERWRITE updated_at ON crm_company TYPE datetime VALUE time::now();
DEFINE FIELD OVERWRITE updated_at ON crm_contact TYPE datetime VALUE time::now();
DEFINE FIELD OVERWRITE updated_at ON inv_screen TYPE datetime VALUE time::now();
