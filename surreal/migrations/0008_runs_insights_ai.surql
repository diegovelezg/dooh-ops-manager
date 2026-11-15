-- 0008 · Corridas en segundo plano, muro de avisos (insights) y registros de IA.

-- ── sys_run: corridas de larga duración (cinta de progreso) ───────────────
-- `updated_at` es el heartbeat: se sella solo en cada escritura (advanceRun, total…).
DEFINE FIELD run_rev ON sys_store TYPE option<int> PERMISSIONS NONE;
DEFINE TABLE sys_run SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON sys_run TYPE record<sys_store> READONLY;
DEFINE FIELD kind ON sys_run TYPE string;
DEFINE FIELD label ON sys_run TYPE string;
DEFINE FIELD status ON sys_run TYPE 'running' | 'done' | 'error' DEFAULT 'running';
DEFINE FIELD total ON sys_run TYPE int DEFAULT 0;
DEFINE FIELD processed ON sys_run TYPE int DEFAULT 0;
DEFINE FIELD failed ON sys_run TYPE int DEFAULT 0;
DEFINE FIELD current ON sys_run TYPE option<string>;
DEFINE FIELD summary ON sys_run TYPE option<string>;
DEFINE FIELD error ON sys_run TYPE option<string>;
DEFINE FIELD error_code ON sys_run TYPE option<'judge_veto' | 'busy' | 'llm_fail' | 'stale' | 'conflict'>;
DEFINE FIELD pulse_state ON sys_run TYPE option<'needs' | 'active' | 'paused'>;
DEFINE FIELD scope_kind ON sys_run TYPE 'global' | 'signal' | 'customer' | 'domain' DEFAULT 'global';
DEFINE FIELD scope_id ON sys_run TYPE option<string>;
DEFINE FIELD started_at ON sys_run TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD finished_at ON sys_run TYPE option<datetime>;
DEFINE FIELD updated_at ON sys_run TYPE datetime VALUE time::now();
DEFINE INDEX sys_run_store ON sys_run FIELDS store, status, started_at;

/** Slot atómico de corrida: una sola corrida en curso por tienda y compatibilidad
 *  (`sync` choca con todo; el mismo kind choca consigo). Devuelve la clave de la corrida o NONE si
 *  hay ocupación. Reescribe la tienda (registro compartido): dos arranques simultáneos se
 *  serializan y el segundo ve al primero. */
DEFINE FUNCTION fn::run_start($store: record<sys_store>, $kind: string, $label: string, $total: int) {
  UPDATE $store SET run_rev = (run_rev ?? 0) + 1;
  LET $busy = array::len(SELECT VALUE id FROM sys_run
    WHERE store = $store AND status = 'running' AND ($kind = 'sync' OR kind = 'sync' OR kind = $kind) LIMIT 1);
  IF $busy > 0 { RETURN NONE };
  LET $r = CREATE sys_run SET store = $store, kind = $kind, label = $label, total = $total;
  RETURN record::id($r[0].id);
};

-- ── sys_insight: muro de avisos; `insight_read` = descartado por usuario ──
DEFINE TABLE sys_insight SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON sys_insight TYPE record<sys_store> READONLY;
DEFINE FIELD kind ON sys_insight TYPE string;
DEFINE FIELD title ON sys_insight TYPE string;
DEFINE FIELD body ON sys_insight TYPE string;
DEFINE FIELD links ON sys_insight TYPE array<string> DEFAULT [];
DEFINE FIELD audience ON sys_insight TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD severity ON sys_insight TYPE string DEFAULT 'info';
DEFINE FIELD scope_kind ON sys_insight TYPE option<string>;
DEFINE FIELD scope_id ON sys_insight TYPE option<string>;
DEFINE FIELD context ON sys_insight TYPE option<object> FLEXIBLE;
DEFINE FIELD created_at ON sys_insight TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX sys_insight_store ON sys_insight FIELDS store, created_at;

DEFINE TABLE insight_read TYPE RELATION IN user OUT sys_insight ENFORCED SCHEMAFULL
  PERMISSIONS FOR select WHERE in = $auth.id FOR create, update, delete NONE;
DEFINE FIELD read_at ON insight_read TYPE datetime DEFAULT time::now();
DEFINE INDEX insight_read_pair ON insight_read FIELDS in, out UNIQUE;

-- ── Registros de IA ───────────────────────────────────────────────────────
DEFINE TABLE ai_llm_usage SCHEMAFULL
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user FOR create, update, delete NONE;
DEFINE FIELD store ON ai_llm_usage TYPE record<sys_store> READONLY;
DEFINE FIELD process ON ai_llm_usage TYPE string;
DEFINE FIELD provider ON ai_llm_usage TYPE string;
DEFINE FIELD model ON ai_llm_usage TYPE string;
DEFINE FIELD prompt_tokens ON ai_llm_usage TYPE int DEFAULT 0;
DEFINE FIELD completion_tokens ON ai_llm_usage TYPE int DEFAULT 0;
DEFINE FIELD total_tokens ON ai_llm_usage TYPE int DEFAULT 0;
DEFINE FIELD reasoning_tokens ON ai_llm_usage TYPE option<int>;
DEFINE FIELD latency_ms ON ai_llm_usage TYPE option<int>;
DEFINE FIELD used_fallback ON ai_llm_usage TYPE bool DEFAULT false;
DEFINE FIELD success ON ai_llm_usage TYPE bool DEFAULT true;
DEFINE FIELD created_at ON ai_llm_usage TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX ai_llm_usage_store ON ai_llm_usage FIELDS store, created_at;

-- Brief de vertical (cache global): la clave del registro es el taxonomy_id, o la vertical
-- normalizada si no hay mapeo (sin trucos de unique con NULL).
DEFINE TABLE ai_vertical_profile SCHEMAFULL PERMISSIONS FOR select WHERE $auth != NONE FOR create, update, delete NONE;
DEFINE FIELD taxonomy_id ON ai_vertical_profile TYPE option<string>;
DEFINE FIELD vertical_detected ON ai_vertical_profile TYPE string;
DEFINE FIELD brief ON ai_vertical_profile TYPE object FLEXIBLE;
DEFINE FIELD sources ON ai_vertical_profile TYPE array<object> FLEXIBLE DEFAULT [];
DEFINE FIELD confidence ON ai_vertical_profile TYPE option<string>;
DEFINE FIELD researched_at ON ai_vertical_profile TYPE datetime DEFAULT time::now();
DEFINE FIELD created_at ON ai_vertical_profile TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON ai_vertical_profile TYPE datetime VALUE time::now();

-- Firmographics públicos por dominio (cache global; nunca PII del tenant). Clave = dominio.
DEFINE TABLE ai_domain_cache SCHEMAFULL PERMISSIONS FOR select WHERE $auth != NONE FOR create, update, delete NONE;
DEFINE FIELD domain_type ON ai_domain_cache TYPE 'business' | 'institutional' DEFAULT 'business';
DEFINE FIELD company_name ON ai_domain_cache TYPE option<string>;
DEFINE FIELD industry ON ai_domain_cache TYPE option<string>;
DEFINE FIELD description ON ai_domain_cache TYPE option<string>;
DEFINE FIELD size ON ai_domain_cache TYPE option<string>;
DEFINE FIELD location ON ai_domain_cache TYPE option<string>;
DEFINE FIELD logo_url ON ai_domain_cache TYPE option<string>;
DEFINE FIELD source_url ON ai_domain_cache TYPE option<string>;
DEFINE FIELD model ON ai_domain_cache TYPE option<string>;
DEFINE FIELD confidence ON ai_domain_cache TYPE option<number>;
DEFINE FIELD enriched_at ON ai_domain_cache TYPE datetime DEFAULT time::now();
DEFINE FIELD created_at ON ai_domain_cache TYPE datetime DEFAULT time::now() READONLY;
