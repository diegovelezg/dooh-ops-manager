-- Issue #13: capacidad vendible DOOH sin bloquear pantalla completa.
-- Modalidad única: 1 slot = 1 espacio fijo por loop y día en la misma pantalla.
-- Exclusividad explícita: línea exclusiva ocupa toda la pantalla (bloquea
-- cualquier otra) y solo cabe si el día está vacío. Sin DROP: solo ADD COLUMN
-- (default cubre filas legacy: no exclusivas, 1 slot) + funciones de guarda.
-- IRREVERSIBLE: no hay reescritura de históricos; las órdenes legacy se
-- interpretan como 1 slot no exclusivo sobre capacidad default 10 (ver ADR
-- 0009). No se cambia silenciosamente su compromiso: solo cambia la lectura
-- de disponibilidad futura.
alter table public.io_lines
  add column if not exists is_exclusive boolean not null default false;

-- Guardia de capacidad + exclusividad, serializada por tienda.
-- p_lines: [{screen_id, starts (yyyy-mm-dd), ends (yyyy-mm-dd), slots, exclusive}]
-- Lanza EXCEPTION 'sin slots...' si algún día-pantalla no tiene cupo o choca
-- con exclusividad. Excluye la propia orden (p_exclude_io) y órdenes
-- canceladas; borradores solo apartan si frescos (7 días, HOLD_DAYS).
create or replace function public.io_assert_capacity(
  p_store uuid,
  p_exclude_io uuid,
  p_lines jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $func$
declare
  l jsonb;
  v_screen uuid;
  v_start date;
  v_end date;
  v_slots int;
  v_excl boolean;
  v_day date;
  v_cap int;
  v_reserved int;
  v_has_excl boolean;
  v_new_slots int;
  v_new_excl boolean;
begin
  -- Serializa check+write entre vendedores concurrentes (se libera al commit).
  perform pg_advisory_xact_lock(hashtext('io-cap:' || p_store::text));

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return;
  end if;

  for l in select * from jsonb_array_elements(p_lines) loop
    begin
      v_screen := (l ->> 'screen_id')::uuid;
      v_start := (l ->> 'starts')::date;
      v_end := (l ->> 'ends')::date;
      v_slots := coalesce(nullif(btrim(l ->> 'slots'), ''), '1')::int;
      v_excl := coalesce((l ->> 'exclusive')::boolean, false);
    exception when others then
      raise exception 'línea inválida';
    end;
    if v_end < v_start then
      raise exception 'fin anterior al inicio en línea';
    end if;
    if v_slots is null or v_slots < 1 or v_slots > 100 then
      raise exception 'slots inválidos en línea (1–100)';
    end if;
    if v_excl and v_slots <> 1 then
      raise exception 'la exclusiva usa 1 slot (ocupa toda la pantalla)';
    end if;

    -- Capacidad: slots propios activos o default del tenant.
    select count(*)::int into v_cap
    from inv_slots where store_id = p_store and screen_id = v_screen and is_active is distinct from false;
    if v_cap = 0 then
      -- Sin slots explícitos: default del tenant (o 10 del código).
      select coalesce(default_slots_per_screen, 10)::int into v_cap
      from sys_stores where id = p_store;
      if v_cap is null or v_cap < 1 then v_cap := 10; end if;
      if exists (select 1 from inv_slots where store_id = p_store and screen_id = v_screen) then
        -- Tiene filas pero todas inactivas => capacidad 0 (pantalla pausada).
        v_cap := 0;
      end if;
    end if;

    for v_day in select generate_series(v_start, v_end, '1 day'::interval)::date loop
      -- Reservado existente ese día (excluye propia orden).
      select coalesce(sum(ol.cant_slots), 0)::int,
             bool_or(ol.is_exclusive)
        into v_reserved, v_has_excl
      from io_lines ol
      join io_orders o on o.id = ol.io_id and o.store_id = p_store
      where ol.store_id = p_store
        and ol.screen_id = v_screen
        and ol.starts_at < (v_day + 1)::timestamp at time zone 'America/Lima'
        and ol.ends_at > v_day::timestamp at time zone 'America/Lima'
        and (p_exclude_io is null or ol.io_id <> p_exclude_io)
        and o.status <> 'cancelled'
        and (o.status <> 'draft' or o.created_at + interval '7 days' > now());
      v_reserved := coalesce(v_reserved, 0);
      v_has_excl := coalesce(v_has_excl, false);

      -- Bookings vigentes cuentan 1 slot (sin exclusividad propia).
      select count(*)::int into v_new_slots from inv_bookings b
      where b.store_id = p_store
        and b.status <> 'cancelled'
        and b.starts_at < ((v_day + 1)::timestamp at time zone 'America/Lima')
        and b.ends_at > (v_day::timestamp at time zone 'America/Lima')
        and b.slot_id in (select id from inv_slots where store_id = p_store and screen_id = v_screen);
      v_reserved := v_reserved + coalesce(v_new_slots, 0);

      -- Suma de las propias líneas nuevas ese día (misma pantalla).
      select coalesce(sum(coalesce(nullif(btrim(x ->> 'slots'), ''), '1')::int), 0)::int,
             bool_or(coalesce((x ->> 'exclusive')::boolean, false))
        into v_new_slots, v_new_excl
      from jsonb_array_elements(p_lines) x
      where (x ->> 'screen_id')::uuid = v_screen
        and (x ->> 'starts')::date <= v_day
        and (x ->> 'ends')::date >= v_day;
      v_new_slots := coalesce(v_new_slots, 0);
      v_new_excl := coalesce(v_new_excl, false);

      if v_has_excl then
        raise exception 'sin slots en % el %: pantalla con venta exclusiva', v_screen, v_day;
      end if;
      if v_new_excl then
        -- Exclusiva nueva: día debe estar vacío y sin otra nueva compartida.
        -- (La exclusiva siempre se pide con 1 slot: ocupa toda la pantalla.)
        if v_reserved > 0 then
          raise exception 'sin slots en % el %: venta exclusiva requiere día vacío', v_screen, v_day;
        end if;
        if v_new_slots > v_slots then
          -- Más de una línea nueva el mismo día (o slots>cap): choca consigo.
          raise exception 'sin slots en % el %: exclusiva incompatible con otra línea', v_screen, v_day;
        end if;
      else
        if v_reserved + v_new_slots > v_cap then
          raise exception 'sin slots en % el %: cupo/día excedido', v_screen, v_day;
        end if;
      end if;
    end loop;
  end loop;
end;
$func$;

revoke all on function public.io_assert_capacity(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.io_assert_capacity(uuid, uuid, jsonb)
  to service_role;

-- Reemplazo atómico endurecido (issue #13): acepta `exclusive` por línea,
-- verifica cupo+exclusividad con lock ANTES de borrar/insertar (autoridad en
-- BD; el pre-check de la app queda solo para mensaje UX). Falla cerrado.
create or replace function public.io_replace_lines(
  p_store uuid,
  p_io uuid,
  p_lines jsonb,
  p_actor text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_status text;
  v_starts date;
  v_ends date;
  l jsonb;
  v_screen uuid;
  v_start date;
  v_end date;
  v_total numeric;
  v_notes text;
  v_slots int;
  v_excl boolean;
begin
  perform pg_advisory_xact_lock(hashtext('io-cap:' || p_store::text));

  select status into v_status from io_orders where store_id = p_store and id = p_io;
  if not found then
    raise exception 'orden no encontrada';
  end if;
  if v_status <> 'draft' then
    raise exception 'solo borradores (estado %)', v_status;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'sin líneas';
  end if;

  -- Autoridad anti-sobreventa (incluye concurrentes serializados por el lock).
  perform public.io_assert_capacity(p_store, p_io, p_lines);

  delete from io_lines where store_id = p_store and io_id = p_io;

  v_starts := null;
  v_ends := null;
  for l in select * from jsonb_array_elements(p_lines) loop
    begin
      v_screen := (l ->> 'screen_id')::uuid;
      v_start := (l ->> 'starts')::date;
      v_end := (l ->> 'ends')::date;
      v_total := (l ->> 'total')::numeric;
      v_slots := coalesce(nullif(btrim(l ->> 'slots'), ''), '1')::int;
      v_excl := coalesce((l ->> 'exclusive')::boolean, false);
    exception when others then
      raise exception 'línea inválida';
    end;
    if v_end < v_start then
      raise exception 'fin anterior al inicio en línea';
    end if;
    if v_total is null or v_total <= 0 then
      raise exception 'total inválido en línea';
    end if;
    if v_slots is null or v_slots < 1 or v_slots > 100 then
      raise exception 'slots inválidos en línea (1–100)';
    end if;
    if v_excl and v_slots <> 1 then
      raise exception 'la exclusiva usa 1 slot (ocupa toda la pantalla)';
    end if;
    if not exists (select 1 from inv_screens where store_id = p_store and id = v_screen) then
      raise exception 'pantalla fuera del inventario';
    end if;
    v_notes := nullif(btrim(l ->> 'notes'), '');
    insert into io_lines (
      store_id, io_id, screen_id, slot_id, starts_at, ends_at,
      rate_minor, tarifa_regular_minor, cant_meses, cant_dias, cant_slots, is_exclusive, notes
    ) values (
      p_store, p_io, v_screen, null,
      (v_start::timestamp at time zone 'America/Lima'),
      ((v_end + 1)::timestamp at time zone 'America/Lima'),
      round(v_total * 100)::int,
      null, null,
      (v_end - v_start + 1),
      v_slots,
      coalesce(v_excl, false),
      v_notes
    );
    if v_starts is null or v_start < v_starts then v_starts := v_start; end if;
    if v_ends is null or v_end > v_ends then v_ends := v_end; end if;
  end loop;

  update io_orders
  set starts_at = v_starts,
      ends_at = v_ends,
      updated_at = now(),
      updated_by = p_actor
  where store_id = p_store and id = p_io;
end;
$func$;

revoke all on function public.io_replace_lines(uuid, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.io_replace_lines(uuid, uuid, jsonb, text)
  to service_role;
