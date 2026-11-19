-- Acceso de agentes de IA (Claude, ChatGPT, Cursor…): clave personal por usuario, generada
-- desde Ajustes y revocable. La clave se guarda solo como hash SHA-256. El proxy `/mcp` la
-- canjea por un JWT de 10 min del PROPIO usuario (`signin` del acceso `agent`): el agente ve
-- lo mismo que él en la web (PERMISSIONS por tienda y por campo) y nunca usa `app_server`.
-- Tabla + acceso RECORD en vez de grants BEARER nativos: crear/revocar grants exige OWNER y
-- `app_server` (EDITOR) no debe tocar accesos (ver surreal/README.md).
DEFINE TABLE agent_token SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD user ON agent_token TYPE record<user> READONLY REFERENCE ON DELETE CASCADE;
DEFINE FIELD label ON agent_token TYPE string ASSERT string::len(string::trim($value)) >= 1 AND string::len($value) <= 60;
DEFINE FIELD key_hash ON agent_token TYPE string READONLY;
-- Últimos caracteres de la clave: para reconocerla en la lista (la clave completa no se puede recuperar).
DEFINE FIELD hint ON agent_token TYPE string READONLY;
DEFINE FIELD expires_at ON agent_token TYPE datetime READONLY;
DEFINE FIELD revoked_at ON agent_token TYPE option<datetime>;
DEFINE FIELD last_used_at ON agent_token TYPE option<datetime>;
DEFINE FIELD created_at ON agent_token TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX agent_token_hash ON agent_token FIELDS key_hash UNIQUE;
DEFINE INDEX agent_token_user ON agent_token FIELDS user;

DEFINE ACCESS agent ON DATABASE TYPE RECORD
  SIGNIN (
    SELECT VALUE user FROM agent_token
    WHERE key_hash = crypto::sha256($key) AND revoked_at = NONE AND expires_at > time::now()
  )
  DURATION FOR TOKEN 10m, FOR SESSION 1h;
