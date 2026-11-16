-- Responsable por defecto = creador. Aditiva: solo rellena órdenes SIN responsable cuyo creador
-- sigue siendo miembro de la tienda (la asignación exige pertenecer al equipo). No borra nada.
UPDATE io_order SET responsible_email = string::lowercase(created_by)
  WHERE responsible_email = NONE AND created_by != NONE
    AND array::len(SELECT id FROM member_of WHERE out = $parent.store AND in.email = string::lowercase($parent.created_by)) > 0;
