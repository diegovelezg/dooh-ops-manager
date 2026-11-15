-- 0001 · Identidad y tenencia: usuarios, tiendas, membresías, sesión.
--
-- Modelo: `user` -[member_of {role}]-> `sys_store`. La membresía es una arista
-- de grafo (no una tabla puente): el aislamiento por tienda se expresa con
-- PERMISSIONS sobre `$auth->member_of->sys_store`, sin función auxiliar.
-- Las claves de registro son los UUID históricos (`sys_store:⟨uuid⟩`); en la
-- app los ids viajan como string plano (`record::id(id)`).

-- ── user ──────────────────────────────────────────────────────────────────
DEFINE TABLE user SCHEMAFULL
  PERMISSIONS
    FOR select WHERE id = $auth.id
    FOR create, update, delete NONE;
DEFINE FIELD email ON user TYPE string
  ASSERT string::is_email($value)
  VALUE string::lowercase($value);
-- Hash bcrypt (`crypto::bcrypt::generate`). Nunca legible por sesiones de usuario.
DEFINE FIELD password ON user TYPE string PERMISSIONS NONE;
DEFINE FIELD created_at ON user TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX user_email ON user FIELDS email UNIQUE;

-- ── sys_store (tenant) ────────────────────────────────────────────────────
DEFINE TABLE sys_store SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth.id IN <-member_of<-user
    FOR create, update, delete NONE;
DEFINE FIELD name ON sys_store TYPE option<string>;
-- ISO 4217 en mayúsculas; sin códigos no monetarios (paridad con lib/currency.ts).
DEFINE FIELD shop_currency ON sys_store TYPE string DEFAULT 'PEN'
  ASSERT string::matches($value, '^[A-Z]{3}$') AND $value NOT IN ['XXX','ZZZ','XTS','XAU','XAG','XDR'];
DEFINE FIELD shop_country ON sys_store TYPE option<string>;
-- Prefijo del número de IO (OI-0001). 2..4 letras mayúsculas.
DEFINE FIELD io_prefix ON sys_store TYPE string DEFAULT 'OI'
  ASSERT string::matches($value, '^[A-Z]{2,4}$');
-- Empresa propia de la tienda (fase CRM crea `crm_company`).
DEFINE FIELD home_company ON sys_store TYPE option<record<crm_company>>;
-- Espacios vendibles por pantalla y día cuando la pantalla no define slots.
DEFINE FIELD default_slots_per_screen ON sys_store TYPE int DEFAULT 10
  ASSERT $value >= 1 AND $value <= 100;
-- Serializa mutaciones de membresía por tienda (OCC: todas escriben este campo,
-- así dos cambios concurrentes no pueden dejar la tienda sin propietario).
DEFINE FIELD membership_version ON sys_store TYPE int DEFAULT 0 PERMISSIONS NONE;
DEFINE FIELD created_at ON sys_store TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX sys_store_created ON sys_store FIELDS created_at;

-- ── member_of (arista user → sys_store) ───────────────────────────────────
DEFINE TABLE member_of TYPE RELATION IN user OUT sys_store ENFORCED SCHEMAFULL
  PERMISSIONS
    FOR select WHERE in = $auth.id
    FOR create, update, delete NONE;
DEFINE FIELD role ON member_of TYPE 'owner' | 'admin' | 'seller' | 'viewer' DEFAULT 'seller';
DEFINE FIELD created_at ON member_of TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX member_of_unique ON member_of FIELDS in, out UNIQUE;

-- ── sys_store_profile (1:1 con la tienda) ─────────────────────────────────
DEFINE TABLE sys_store_profile SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth.id IN store<-member_of<-user
    FOR create, update, delete NONE;
DEFINE FIELD store ON sys_store_profile TYPE record<sys_store> REFERENCE ON DELETE CASCADE READONLY;
DEFINE FIELD business_model ON sys_store_profile TYPE 'b2c' | 'b2b' | 'hybrid' DEFAULT 'b2b';
DEFINE FIELD industry ON sys_store_profile TYPE option<string>;
DEFINE FIELD catalog_type ON sys_store_profile
  TYPE option<'consumible' | 'perecedero' | 'moda_estacional' | 'durable' | 'servicio' | 'digital' | 'mixto'>;
DEFINE FIELD archetype ON sys_store_profile
  TYPE 'b2c_consumible' | 'b2c_moda' | 'b2c_durable' | 'b2b_recurrente' | 'b2b_proyecto' | 'hibrido'
  DEFAULT 'b2b_recurrente';
DEFINE FIELD company_required ON sys_store_profile TYPE bool DEFAULT true;
DEFINE FIELD description ON sys_store_profile TYPE option<string>;
DEFINE FIELD vertical_detected ON sys_store_profile TYPE option<string>;
DEFINE FIELD taxonomy_id ON sys_store_profile TYPE option<string>;
DEFINE FIELD buyer_type ON sys_store_profile TYPE option<string>;
DEFINE FIELD created_at ON sys_store_profile TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON sys_store_profile TYPE datetime VALUE time::now();
DEFINE INDEX sys_store_profile_store ON sys_store_profile FIELDS store UNIQUE;

-- ── Sesión: login email+password, JWT corto + refresh rotativo ────────────
-- Clave del JWT generada y custodiada por SurrealDB (no hay secreto en repo).
DEFINE ACCESS app ON DATABASE TYPE RECORD
  SIGNIN (
    SELECT * FROM user
    WHERE email = string::lowercase($email)
      AND crypto::bcrypt::compare(password, $password)
  )
  WITH REFRESH
  DURATION FOR TOKEN 15m, FOR SESSION 12h, FOR GRANT 30d;

-- ── Usuario de sistema de la app (equivalente al service_role) ────────────
-- Para jobs/scripts y lecturas de servidor sin sesión de usuario. Rol EDITOR:
-- no puede tocar usuarios de DB ni accesos (eso es del migrador root).
DEFINE USER app_server ON DATABASE PASSWORD {{APP_SERVER_PASSWORD}} ROLES EDITOR DURATION FOR TOKEN 1h, FOR SESSION 12h;
