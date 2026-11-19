-- Las claves de agente no caducan: duran hasta que el usuario las revoca (decisión de producto).
-- NONE = sin vencimiento. Se hace en una migración nueva porque la 0018 ya está aplicada.
-- Sin pérdida de datos: solo se relaja el tipo del campo y la condición del SIGNIN.
DEFINE FIELD OVERWRITE expires_at ON agent_token TYPE option<datetime> READONLY;

DEFINE ACCESS OVERWRITE agent ON DATABASE TYPE RECORD
  SIGNIN (
    SELECT VALUE user FROM agent_token
    WHERE key_hash = crypto::sha256($key) AND revoked_at = NONE AND (expires_at = NONE OR expires_at > time::now())
  )
  DURATION FOR TOKEN 10m, FOR SESSION 1h;
