-- 0002 · Invariante de membresía: toda tienda conserva al menos un propietario.
--
-- Vive en la DB (no en la app) para valer en cualquier ruta de escritura. Bajo
-- OCC, dos transacciones que degradan a propietarios DISTINTOS no chocan por sí
-- solas (cada una lee al otro como owner → write skew). Por eso el evento escribe
-- `sys_store.membership_version`: es el registro compartido que convierte esa
-- carrera en un conflicto de escritura reintentable.
DEFINE EVENT member_of_keep_owner ON member_of
  WHEN $event IN ['UPDATE', 'DELETE']
   AND $before.role = 'owner'
   AND ($event = 'DELETE' OR $after.role != 'owner')
THEN {
  UPDATE $before.out SET membership_version += 1;
  IF record::exists($before.out)
     AND array::len(SELECT VALUE id FROM member_of WHERE out = $before.out AND role = 'owner') = 0 {
    THROW "member_of: la tienda no puede quedarse sin propietario";
  };
};
