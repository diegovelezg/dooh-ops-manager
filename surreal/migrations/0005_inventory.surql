-- 0005 · Inventario DOOH: venues (ubicaciones) y pantallas.
--
-- · `inv_venue.location` es un punto geoespacial nativo (lon, lat): las búsquedas
--   por cercanía usan `geo::distance` sin cálculo manual.
-- · El embedding semántico vive en la propia pantalla con índice HNSW (768 dim,
--   gemini-embedding-001): no hay tabla aparte que sincronizar.
-- · Un venue/pantalla "de proveedor" exige proveedor (evento: el ASSERT de campo no
--   se evalúa sobre NONE).

-- ── inv_venue ─────────────────────────────────────────────────────────────
DEFINE TABLE inv_venue SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user
              FOR create, update, delete NONE;
DEFINE FIELD store ON inv_venue TYPE record<sys_store> READONLY;
DEFINE FIELD company ON inv_venue TYPE option<record<crm_company>> REFERENCE ON DELETE UNSET
  ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD supplier ON inv_venue TYPE option<record<crm_company>> REFERENCE ON DELETE UNSET
  ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD ownership ON inv_venue TYPE 'own' | 'supplier' DEFAULT 'own';
DEFINE FIELD name ON inv_venue TYPE string ASSERT string::len(string::trim($value)) > 0;
DEFINE FIELD venue_type ON inv_venue TYPE option<string>;
DEFINE FIELD location ON inv_venue TYPE option<geometry<point>>;
DEFINE FIELD address ON inv_venue TYPE option<string>;
DEFINE FIELD full_address ON inv_venue TYPE option<string>;
DEFINE FIELD district ON inv_venue TYPE option<string>;
DEFINE FIELD city ON inv_venue TYPE option<string>;
DEFINE FIELD region ON inv_venue TYPE option<string>;
DEFINE FIELD postal_code ON inv_venue TYPE option<string>;
DEFINE FIELD country ON inv_venue TYPE option<string>;
DEFINE FIELD timezone ON inv_venue TYPE option<string>;
DEFINE FIELD source ON inv_venue TYPE 'sheet' | 'csv' | 'manual' | 'legacy' DEFAULT 'sheet';
DEFINE FIELD external_ref ON inv_venue TYPE option<string>;
DEFINE FIELD notes ON inv_venue TYPE option<string>;
DEFINE FIELD created_at ON inv_venue TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON inv_venue TYPE datetime VALUE time::now();
DEFINE FIELD search ON inv_venue COMPUTED fn::norm(string::concat(name, ' ', district ?? '', ' ', city ?? ''));
DEFINE EVENT inv_venue_supplier_required ON inv_venue WHEN $event IN ['CREATE', 'UPDATE'] AND $after.ownership = 'supplier' AND $after.supplier = NONE
  THEN { THROW "inv_venue: ownership 'supplier' requiere proveedor" };
DEFINE INDEX inv_venue_store ON inv_venue FIELDS store, city;
DEFINE INDEX inv_venue_ref ON inv_venue FIELDS store, external_ref UNIQUE;

-- ── inv_screen ────────────────────────────────────────────────────────────
DEFINE TABLE inv_screen SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user
              FOR create, update, delete NONE;
DEFINE FIELD store ON inv_screen TYPE record<sys_store> READONLY;
DEFINE FIELD venue ON inv_screen TYPE record<inv_venue> REFERENCE ON DELETE CASCADE
  ASSERT $value.store = $this.store;
DEFINE FIELD supplier ON inv_screen TYPE option<record<crm_company>> REFERENCE ON DELETE UNSET
  ASSERT $value = NONE OR $value.store = $this.store;
DEFINE FIELD name ON inv_screen TYPE string ASSERT string::len(string::trim($value)) > 0;
DEFINE FIELD ownership ON inv_screen TYPE 'own' | 'supplier' DEFAULT 'own';
DEFINE FIELD modality ON inv_screen TYPE 'digital' | 'static' DEFAULT 'digital';
DEFINE FIELD is_active ON inv_screen TYPE bool DEFAULT true;
DEFINE FIELD source ON inv_screen TYPE 'sheet' | 'csv' | 'manual' | 'legacy' DEFAULT 'sheet';
DEFINE FIELD external_ref ON inv_screen TYPE option<string>;
DEFINE FIELD enrichment_status ON inv_screen TYPE 'pending' | 'done' DEFAULT 'done';
-- Pantalla física
DEFINE FIELD width_px ON inv_screen TYPE option<int> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD height_px ON inv_screen TYPE option<int> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD dpi ON inv_screen TYPE option<int> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD width_m ON inv_screen TYPE option<number>;
DEFINE FIELD height_m ON inv_screen TYPE option<number>;
DEFINE FIELD orientation ON inv_screen TYPE option<'landscape' | 'portrait' | 'square'>;
DEFINE FIELD technology ON inv_screen TYPE option<string>;
DEFINE FIELD placement ON inv_screen TYPE option<'fixed' | 'moving'>;
DEFINE FIELD player_id ON inv_screen TYPE option<string>;
DEFINE FIELD url ON inv_screen TYPE option<string>;
DEFINE FIELD operating_hours ON inv_screen TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD media_images ON inv_screen TYPE array<string> DEFAULT [];
DEFINE FIELD source_attrs ON inv_screen TYPE object FLEXIBLE DEFAULT {};
-- Comercial
DEFINE FIELD price_pen ON inv_screen TYPE option<number>;
DEFINE FIELD impact_day ON inv_screen TYPE option<int>;
DEFINE FIELD impressions_day ON inv_screen TYPE option<int>;
DEFINE FIELD duration_sec ON inv_screen TYPE option<int>;
DEFINE FIELD views_per_spot ON inv_screen TYPE option<int>;
DEFINE FIELD effective_daily_views ON inv_screen TYPE option<int>;
DEFINE FIELD plays_per_day ON inv_screen TYPE option<int> ASSERT $value = NONE OR $value > 0;
DEFINE FIELD restrictions ON inv_screen TYPE option<string>;
DEFINE FIELD description ON inv_screen TYPE option<string>;
DEFINE FIELD sales_pitch ON inv_screen TYPE option<string>;
DEFINE FIELD audience_target ON inv_screen TYPE option<string>;
DEFINE FIELD tags ON inv_screen TYPE option<array<string>>;
-- Enriquecimiento geográfico / audiencia
DEFINE FIELD score ON inv_screen TYPE option<number>;
DEFINE FIELD traffic_mobility_score ON inv_screen TYPE option<int>;
DEFINE FIELD commercial_intensity_score ON inv_screen TYPE option<int>;
DEFINE FIELD vehicular_pct ON inv_screen TYPE option<int>;
DEFINE FIELD pedestrian_pct ON inv_screen TYPE option<int>;
DEFINE FIELD geo_daily_life ON inv_screen TYPE option<number>;
DEFINE FIELD geo_travel_transit ON inv_screen TYPE option<number>;
DEFINE FIELD geo_gen_z_lifestyle ON inv_screen TYPE option<number>;
DEFINE FIELD geo_health_wellness ON inv_screen TYPE option<number>;
DEFINE FIELD geo_high_end_luxury ON inv_screen TYPE option<number>;
DEFINE FIELD geo_business_executive ON inv_screen TYPE option<number>;
DEFINE FIELD suggested_local_businesses ON inv_screen TYPE option<string>;
DEFINE FIELD landuse_zones ON inv_screen TYPE option<string>;
DEFINE FIELD building_types ON inv_screen TYPE option<string>;
DEFINE FIELD pois_anchors ON inv_screen TYPE option<string>;
DEFINE FIELD pois_anchors_count ON inv_screen TYPE option<int>;
DEFINE FIELD pois_total_count ON inv_screen TYPE option<int>;
DEFINE FIELD pois_list_json ON inv_screen TYPE array<object> FLEXIBLE DEFAULT [];
DEFINE FIELD road_tier_label ON inv_screen TYPE option<string>;
DEFINE FIELD congestion_level ON inv_screen TYPE option<string>;
DEFINE FIELD average_speed_kmh ON inv_screen TYPE option<number>;
DEFINE FIELD is_major_corridor ON inv_screen TYPE option<bool>;
DEFINE FIELD primary_road_class ON inv_screen TYPE option<string>;
DEFINE FIELD road_classes_detected ON inv_screen TYPE option<string>;
-- Embedding semántico (gemini-embedding-001, 768 dim)
DEFINE FIELD embedding ON inv_screen TYPE option<array<float, 768>>;
DEFINE FIELD embedding_model ON inv_screen TYPE option<string>;
DEFINE FIELD created_at ON inv_screen TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON inv_screen TYPE datetime VALUE time::now();
DEFINE FIELD search ON inv_screen COMPUTED
  fn::norm(string::concat(name, ' ', external_ref ?? '', ' ', venue.name ?? '', ' ', venue.district ?? '', ' ', venue.city ?? '', ' ', supplier.name ?? ''));
DEFINE EVENT inv_screen_supplier_required ON inv_screen WHEN $event IN ['CREATE', 'UPDATE'] AND $after.ownership = 'supplier' AND $after.supplier = NONE
  THEN { THROW "inv_screen: ownership 'supplier' requiere proveedor" };
DEFINE INDEX inv_screen_store ON inv_screen FIELDS store, is_active;
DEFINE INDEX inv_screen_venue ON inv_screen FIELDS store, venue;
DEFINE INDEX inv_screen_ref ON inv_screen FIELDS store, external_ref UNIQUE;
DEFINE INDEX inv_screen_embedding ON inv_screen FIELDS embedding HNSW DIMENSION 768 DIST COSINE;
