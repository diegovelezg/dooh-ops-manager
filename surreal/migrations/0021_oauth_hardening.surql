-- Endurecimiento del OAuth de agentes (revisión de código):
--  · agent_lock: un registro por usuario que TODA emisión de token escribe. Convierte el write-skew bajo OCC
--    (límite de 10 tokens, reemplazo por cliente) en un conflicto reintentable, como en 0002/0006.
--  · oauth_code.token: qué token emitió cada código; reutilizar un código revoca SOLO ese token.
--  · oauth_code.resource: audiencia concedida (la URL canónica de /mcp); el endpoint de token la contrasta (RFC 8707).
-- Sin REMOVE ni pérdida de datos: solo tablas y campos nuevos.
DEFINE TABLE agent_lock SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD n ON agent_lock TYPE int DEFAULT 0;

DEFINE FIELD token ON oauth_code TYPE option<record<agent_token>> REFERENCE ON DELETE UNSET;
DEFINE FIELD resource ON oauth_code TYPE option<string> READONLY;
