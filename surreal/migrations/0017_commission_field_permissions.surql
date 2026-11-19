-- Comisión de agencia: solo owner/admin de la tienda (paridad con
-- FEATURE_MIN_ROLE['agency.commission.view'] = 'admin' en web/lib/roles.ts).
-- Hasta ahora el rol solo se aplicaba en la capa app: cualquier cliente con token de
-- usuario (agente MCP, consola, /sql) leía estos campos siendo viewer/seller.
-- Con PERMISSIONS de campo, un rol sin acceso recibe el campo en NONE.
-- No afecta a la web: las lecturas de datos usan `app_server` (EDITOR, salta permisos de campo).
-- Sin REMOVE ni pérdida de datos: solo ALTER FIELD.
-- Cubre también las fotos JSON del acuerdo (snapshot_json / snapshot), que embeben
-- commission_pct: protegerlas por completo es conservador, no se filtra por subclave.
ALTER FIELD agency_commission_pct ON crm_company
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of[WHERE role IN ['admin', 'owner']]<-user;

ALTER FIELD commission_pct ON io_order
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of[WHERE role IN ['admin', 'owner']]<-user;

ALTER FIELD snapshot_json ON io_order
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of[WHERE role IN ['admin', 'owner']]<-user;

ALTER FIELD snapshot ON io_order_version
  PERMISSIONS FOR select WHERE $auth.id IN store<-member_of[WHERE role IN ['admin', 'owner']]<-user;
