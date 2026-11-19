-- OAuth 2.1 para el MCP de agentes (ChatGPT, Claude, Antigravity…): registro dinámico de clientes
-- (DCR, RFC 7591), códigos de autorización de un solo uso con PKCE y vínculo token ↔ cliente.
-- Las tablas son internas (PERMISSIONS NONE): solo las toca `app_server` desde /oauth/*.
-- El token de acceso OAuth es un `agent_token` (migraciones 0018/0019): no caduca y se revoca en Ajustes.
DEFINE TABLE oauth_client SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD name ON oauth_client TYPE string ASSERT string::len(string::trim($value)) >= 1 AND string::len($value) <= 100;
DEFINE FIELD redirect_uris ON oauth_client TYPE array<string> ASSERT array::len($value) >= 1 AND array::len($value) <= 5;
DEFINE FIELD created_at ON oauth_client TYPE datetime DEFAULT time::now() READONLY;

DEFINE TABLE oauth_code SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD code_hash ON oauth_code TYPE string READONLY;
DEFINE FIELD client ON oauth_code TYPE record<oauth_client> READONLY REFERENCE ON DELETE CASCADE;
DEFINE FIELD user ON oauth_code TYPE record<user> READONLY REFERENCE ON DELETE CASCADE;
DEFINE FIELD redirect_uri ON oauth_code TYPE string READONLY;
DEFINE FIELD code_challenge ON oauth_code TYPE string READONLY;
DEFINE FIELD expires_at ON oauth_code TYPE datetime READONLY;
DEFINE FIELD used_at ON oauth_code TYPE option<datetime>;
DEFINE FIELD created_at ON oauth_code TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX oauth_code_hash ON oauth_code FIELDS code_hash UNIQUE;

-- Token emitido por un cliente OAuth (NONE = clave creada a mano, ya retirada de la UI).
DEFINE FIELD client ON agent_token TYPE option<record<oauth_client>> READONLY REFERENCE ON DELETE CASCADE;
DEFINE INDEX agent_token_client ON agent_token FIELDS user, client;
