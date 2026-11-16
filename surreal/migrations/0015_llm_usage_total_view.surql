-- Consumo LLM acumulado por tienda como vista de tabla: SurrealDB la mantiene de forma incremental en cada
-- `CREATE ai_llm_usage` (el relleno inicial recorre las filas existentes UNA vez). El pill del header pedía
-- el histórico cada 30 s por pestaña con `SELECT math::sum(...) FROM ai_llm_usage ... GROUP ALL`, que recorre
-- TODA la historia de la tienda en cada llamada; ahora es leer una fila por tienda.
-- `ai_llm_usage` es solo-inserción (create/update/delete NONE para usuarios), así que la vista no diverge.
DEFINE TABLE ai_llm_usage_total TYPE NORMAL SCHEMALESS AS
  SELECT store, math::sum(total_tokens) AS total_tokens, count() AS calls
  FROM ai_llm_usage GROUP BY store
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of<-user;
