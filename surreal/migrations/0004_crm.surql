-- 0004 · CRM: empresas, contactos y vínculos comerciales.
--
-- · Aislamiento: cada registro lleva `store` (READONLY) y toda relación valida que
--   el destino sea de la MISMA tienda (reemplaza las FK compuestas (store_id, id)).
-- · Borrado lógico (`deleted_at`): las listas muestran activos; el historial de
--   órdenes conserva el vínculo.
-- · Unicidad parcial = índice UNIQUE sobre campos opcionales (NONE no colisiona).
-- · Los vínculos agencia→anunciante y contacto→cuenta son ARISTAS de grafo.

DEFINE FUNCTION fn::iso($d: option<datetime>) -> option<string> {
  RETURN IF $d { <string> $d } ELSE { NONE };
};

-- ── crm_company ───────────────────────────────────────────────────────────
DEFINE TABLE crm_company SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user
              FOR create, update, delete NONE;
DEFINE FIELD store ON crm_company TYPE record<sys_store> READONLY;
DEFINE FIELD name ON crm_company TYPE string ASSERT string::len(string::trim($value)) > 0;
DEFINE FIELD legal_name ON crm_company TYPE option<string>;
-- NONE = la casa (red propia): nunca se lista como contraparte.
DEFINE FIELD kind ON crm_company TYPE option<'agencia' | 'anunciante' | 'proveedor'>;
DEFINE FIELD tax_id ON crm_company TYPE option<string>;
DEFINE FIELD domain ON crm_company TYPE option<string>;
DEFINE FIELD email ON crm_company TYPE option<string>;
DEFINE FIELD phone ON crm_company TYPE option<string>;
DEFINE FIELD address ON crm_company TYPE option<string>;
DEFINE FIELD city ON crm_company TYPE option<string>;
DEFINE FIELD country ON crm_company TYPE option<string>;
DEFINE FIELD notes ON crm_company TYPE option<string>;
DEFINE FIELD external_ref ON crm_company TYPE option<string>;
DEFINE FIELD agency_commission_pct ON crm_company TYPE option<int> ASSERT $value = NONE OR ($value >= 0 AND $value <= 100);
-- Vertical IAB 2.0 (IAB1–IAB24).
DEFINE FIELD category_iab ON crm_company TYPE option<
  'IAB1' | 'IAB2' | 'IAB3' | 'IAB4' | 'IAB5' | 'IAB6' | 'IAB7' | 'IAB8' | 'IAB9' | 'IAB10' | 'IAB11' | 'IAB12'
  | 'IAB13' | 'IAB14' | 'IAB15' | 'IAB16' | 'IAB17' | 'IAB18' | 'IAB19' | 'IAB20' | 'IAB21' | 'IAB22' | 'IAB23' | 'IAB24'>;
-- Subtipo: solo proveedores.
DEFINE FIELD provider_type ON crm_company
  TYPE option<'media_owner' | 'print_production' | 'installation' | 'maintenance' | 'other'>
  ASSERT $value = NONE OR $this.kind = 'proveedor';
DEFINE FIELD created_by ON crm_company TYPE option<string>;
DEFINE FIELD updated_by ON crm_company TYPE option<string>;
DEFINE FIELD deleted_at ON crm_company TYPE option<datetime>;
DEFINE FIELD created_at ON crm_company TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON crm_company TYPE datetime VALUE time::now();
DEFINE FIELD search ON crm_company COMPUTED
  fn::norm(string::concat(name, ' ', legal_name ?? '', ' ', tax_id ?? '', ' ', domain ?? '', ' ', email ?? ''));
DEFINE INDEX crm_company_store ON crm_company FIELDS store, deleted_at;
DEFINE INDEX crm_company_tax ON crm_company FIELDS store, tax_id UNIQUE;
DEFINE INDEX crm_company_domain ON crm_company FIELDS store, domain UNIQUE;
DEFINE INDEX crm_company_ref ON crm_company FIELDS store, external_ref UNIQUE;

-- ── crm_contact ───────────────────────────────────────────────────────────
DEFINE TABLE crm_contact SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user
              FOR create, update, delete NONE;
DEFINE FIELD store ON crm_contact TYPE record<sys_store> READONLY;
DEFINE FIELD company ON crm_contact TYPE option<record<crm_company>> REFERENCE ON DELETE UNSET
  ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD first_name ON crm_contact TYPE option<string>;
DEFINE FIELD last_name ON crm_contact TYPE option<string>;
DEFINE FIELD email ON crm_contact TYPE option<string>;
DEFINE FIELD phone ON crm_contact TYPE option<string>;
DEFINE FIELD job_title ON crm_contact TYPE option<string>;
DEFINE FIELD is_primary ON crm_contact TYPE bool DEFAULT false;
DEFINE FIELD notes ON crm_contact TYPE option<string>;
DEFINE FIELD created_by ON crm_contact TYPE option<string>;
DEFINE FIELD updated_by ON crm_contact TYPE option<string>;
DEFINE FIELD deleted_at ON crm_contact TYPE option<datetime>;
DEFINE FIELD created_at ON crm_contact TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON crm_contact TYPE datetime VALUE time::now();
-- Claves derivadas de unicidad (se mantienen solas; no las escribe la app):
--   · email único (sin importar mayúsculas) por empresa, o por tienda si no tiene empresa
--   · un teléfono por empresa
--   · un solo contacto principal por empresa
DEFINE FIELD email_scope ON crm_contact TYPE option<string>
  VALUE IF email { string::concat(<string> (company ?? store), '|', string::lowercase(email)) };
DEFINE FIELD phone_scope ON crm_contact TYPE option<string>
  VALUE IF company AND phone { string::concat(<string> company, '|', phone) };
DEFINE FIELD primary_of ON crm_contact TYPE option<record<crm_company>>
  VALUE IF is_primary AND company { company };
DEFINE FIELD search ON crm_contact COMPUTED
  fn::norm(string::concat(first_name ?? '', ' ', last_name ?? '', ' ', email ?? '', ' ', job_title ?? '', ' ', company.name ?? ''));
-- Al menos un canal de contacto (un ASSERT de campo no se evalúa sobre NONE → evento).
DEFINE EVENT crm_contact_has_channel ON crm_contact WHEN $event IN ['CREATE', 'UPDATE'] AND $after.email = NONE AND $after.phone = NONE
  THEN { THROW "crm_contact: requiere email o teléfono" };
DEFINE INDEX crm_contact_store ON crm_contact FIELDS store, company, deleted_at;
DEFINE INDEX crm_contact_email ON crm_contact FIELDS email_scope UNIQUE;
DEFINE INDEX crm_contact_phone ON crm_contact FIELDS phone_scope UNIQUE;
DEFINE INDEX crm_contact_primary ON crm_contact FIELDS primary_of UNIQUE;

-- ── crm_company_link: agencia -[crm_company_link]-> anunciante ────────────
DEFINE TABLE crm_company_link TYPE RELATION IN crm_company OUT crm_company ENFORCED SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user
              FOR create, update, delete NONE;
DEFINE FIELD store ON crm_company_link TYPE record<sys_store> READONLY;
DEFINE FIELD OVERWRITE in ON crm_company_link TYPE record<crm_company> ASSERT $value.store = $this.store;
DEFINE FIELD OVERWRITE out ON crm_company_link TYPE record<crm_company> ASSERT $value != $this.in AND $value.store = $this.store;
DEFINE FIELD origin ON crm_company_link TYPE 'manual' | 'oi' DEFAULT 'manual';
DEFINE FIELD created_by ON crm_company_link TYPE option<string>;
DEFINE FIELD updated_by ON crm_company_link TYPE option<string>;
DEFINE FIELD created_at ON crm_company_link TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON crm_company_link TYPE datetime VALUE time::now();
DEFINE INDEX crm_company_link_pair ON crm_company_link FIELDS in, out UNIQUE;

-- ── crm_contact_account: contacto -[crm_contact_account]-> anunciante que atiende ──
-- La agencia es la empresa del contacto (`in.company`): no se duplica.
DEFINE TABLE crm_contact_account TYPE RELATION IN crm_contact OUT crm_company ENFORCED SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user
              FOR create, update, delete NONE;
DEFINE FIELD store ON crm_contact_account TYPE record<sys_store> READONLY;
DEFINE FIELD OVERWRITE in ON crm_contact_account TYPE record<crm_contact>
  ASSERT $value.store = $this.store AND $value.company != NONE;
DEFINE FIELD OVERWRITE out ON crm_contact_account TYPE record<crm_company>
  ASSERT $value.store = $this.store AND $value != $this.in.company;
DEFINE FIELD created_by ON crm_contact_account TYPE option<string>;
DEFINE FIELD updated_by ON crm_contact_account TYPE option<string>;
DEFINE FIELD created_at ON crm_contact_account TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON crm_contact_account TYPE datetime VALUE time::now();
DEFINE INDEX crm_contact_account_pair ON crm_contact_account FIELDS in, out UNIQUE;
