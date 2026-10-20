-- Location of connected accounts (with consent), personal reminders, staff leave requests.
-- Run in Supabase SQL Editor AFTER 20261102_needs_reply.sql. Safe to rerun.

insert into public.role_permissions (role, feature, allowed) values
  ('supervisor', 'location.share', false), ('production', 'location.share', false), ('driver', 'location.share', true), ('customer', 'location.share', false),
  ('supervisor', 'location.view', false), ('production', 'location.view', false), ('driver', 'location.view', false), ('customer', 'location.view', false),
  ('supervisor', 'leave.request', true), ('production', 'leave.request', true), ('driver', 'leave.request', true), ('customer', 'leave.request', false),
  ('supervisor', 'leave.manage', false), ('production', 'leave.manage', false), ('driver', 'leave.manage', false), ('customer', 'leave.manage', false),
  ('supervisor', 'calendar.view', true), ('production', 'calendar.view', true), ('driver', 'calendar.view', true), ('customer', 'calendar.view', false)
on conflict (role, feature) do nothing;

insert into public.notification_settings (event, label, audience, push_enabled, email_enabled, sort_order) values
  ('leave.new', 'Demande de congé', 'Responsables', true, false, 14),
  ('leave.decision', 'Réponse à une demande de congé', 'Équipe', true, true, 15)
on conflict (event) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Location: shared only by accounts whose profile allows it AND who agreed
-- ---------------------------------------------------------------------------

alter table public.profiles add column if not exists location_consent boolean not null default false;

create table if not exists public.user_locations (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy double precision,
  updated_at timestamptz not null default now()
);
alter table public.user_locations enable row level security;
GRANT SELECT ON public.user_locations TO authenticated;
drop policy if exists "user_locations_read" on public.user_locations;
create policy "user_locations_read" on public.user_locations for select to authenticated
  using (user_id = (select auth.uid()) or (select public.has_feature('location.view')));

create or replace function public.set_location_consent(p_consent boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.active_uid() is null then
    raise exception using errcode = '28000', message = 'Compte actif requis.';
  end if;
  update public.profiles set location_consent = coalesce(p_consent, false) where id = auth.uid();
  -- Withdrawing consent erases the last known position.
  if not coalesce(p_consent, false) then
    delete from public.user_locations where user_id = auth.uid();
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.set_location_consent(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_location_consent(boolean) TO authenticated;

create or replace function public.update_my_location(p_latitude double precision, p_longitude double precision, p_accuracy double precision default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.active_uid() is null or not public.has_feature('location.share')
     or not exists (select 1 from public.profiles pr where pr.id = auth.uid() and pr.location_consent) then
    return false;
  end if;
  insert into public.user_locations (user_id, latitude, longitude, accuracy, updated_at)
  values (auth.uid(), p_latitude, p_longitude, p_accuracy, now())
  on conflict (user_id) do update set latitude = excluded.latitude, longitude = excluded.longitude, accuracy = excluded.accuracy, updated_at = now();
  return true;
end;
$$;
REVOKE ALL ON FUNCTION public.update_my_location(double precision, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_my_location(double precision, double precision, double precision) TO authenticated;

create or replace function public.team_locations()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_feature('location.view') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de voir les positions.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', pr.id, 'name', coalesce(nullif(btrim(pr.full_name), ''), u.email), 'role', pr.role,
      'consent', pr.location_consent, 'latitude', l.latitude, 'longitude', l.longitude, 'accuracy', l.accuracy,
      'updated_at', l.updated_at, 'last_sign_in_at', u.last_sign_in_at
    ) order by l.updated_at desc nulls last, pr.full_name)
    from public.profiles pr
    left join auth.users u on u.id = pr.id
    left join public.user_locations l on l.user_id = pr.id
    where pr.account_status = 'active' and pr.role <> 'customer'
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.team_locations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_locations() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Personal reminders (also shown in the calendar)
-- ---------------------------------------------------------------------------

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  note text,
  remind_at timestamptz not null,
  done boolean not null default false,
  order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists reminders_user_idx on public.reminders(user_id, remind_at);
alter table public.reminders enable row level security;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminders TO authenticated;
drop policy if exists "reminders_own" on public.reminders;
create policy "reminders_own" on public.reminders for all to authenticated
  using (user_id = (select public.active_uid())) with check (user_id = (select public.active_uid()));

-- ---------------------------------------------------------------------------
-- 3. Leave requests (validation optional, decided by the admin)
-- ---------------------------------------------------------------------------

alter table public.app_settings add column if not exists leave_approval_required boolean not null default true;
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('paid', 'sick', 'unpaid', 'training', 'other')),
  start_date date not null,
  end_date date not null,
  half_day boolean not null default false,
  note text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'refused', 'cancelled')),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists leave_requests_dates_idx on public.leave_requests(start_date, end_date);
alter table public.leave_requests enable row level security;
GRANT SELECT ON public.leave_requests TO authenticated;
drop policy if exists "leave_requests_read" on public.leave_requests;
-- Everyone in the team sees approved absences (planning); managers see all requests.
create policy "leave_requests_read" on public.leave_requests for select to authenticated using (
  user_id = (select auth.uid()) or (select public.has_feature('leave.manage'))
  or (status = 'approved' and (select public.is_staff()) or status = 'approved' and (select public.has_feature('calendar.view')))
);

create or replace function public.request_leave(p_kind text, p_start date, p_end date, p_half_day boolean default false, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auto boolean := not coalesce((select s.leave_approval_required from public.app_settings s where s.id = 1), true);
  v_id uuid;
  v_name text;
begin
  if public.active_uid() is null or not public.has_feature('leave.request') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de demander des congés.';
  end if;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception using errcode = '22023', message = 'Dates de congé invalides.';
  end if;
  if exists (select 1 from public.leave_requests l where l.user_id = auth.uid() and l.status in ('pending', 'approved')
             and daterange(l.start_date, l.end_date, '[]') && daterange(p_start, p_end, '[]')) then
    raise exception using errcode = '22023', message = 'Vous avez déjà une demande sur ces dates.';
  end if;
  insert into public.leave_requests (user_id, kind, start_date, end_date, half_day, note, status, decided_at)
  values (auth.uid(), p_kind, p_start, p_end, coalesce(p_half_day, false), nullif(btrim(coalesce(p_note, '')), ''),
          case when v_auto then 'approved' else 'pending' end, case when v_auto then now() end)
  returning id into v_id;
  if not v_auto then
    select coalesce(nullif(btrim(pr.full_name), ''), u.email) into v_name from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = auth.uid();
    perform public.notify(array(select public.team_with_feature('leave.manage')), 'leave.new',
      format('Demande de congé : %s', v_name), format('Du %s au %s.', to_char(p_start, 'DD/MM/YYYY'), to_char(p_end, 'DD/MM/YYYY')), null);
  end if;
  return jsonb_build_object('id', v_id, 'status', case when v_auto then 'approved' else 'pending' end);
end;
$$;
REVOKE ALL ON FUNCTION public.request_leave(text, date, date, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_leave(text, date, date, boolean, text) TO authenticated;

create or replace function public.decide_leave(p_id uuid, p_action text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_leave public.leave_requests%rowtype;
begin
  select l.* into v_leave from public.leave_requests l where l.id = p_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Demande introuvable.';
  end if;
  if p_action = 'cancel' then
    if v_leave.user_id <> auth.uid() and not public.has_feature('leave.manage') then
      raise exception using errcode = '42501', message = 'Vous ne pouvez annuler que vos demandes.';
    end if;
    update public.leave_requests set status = 'cancelled', decided_at = now() where id = p_id;
    return;
  end if;
  if not public.has_feature('leave.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de valider les congés.';
  end if;
  if v_leave.user_id = auth.uid() and not public.is_admin() then
    raise exception using errcode = '42501', message = 'Votre propre demande doit être validée par une autre personne.';
  end if;
  if v_leave.status <> 'pending' or p_action not in ('approve', 'refuse') then
    raise exception using errcode = '22023', message = 'Cette demande a déjà été traitée.';
  end if;
  update public.leave_requests
  set status = case when p_action = 'approve' then 'approved' else 'refused' end,
      decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_id;
  perform public.notify(array[v_leave.user_id], 'leave.decision',
    format('Congé du %s : %s', to_char(v_leave.start_date, 'DD/MM'), case when p_action = 'approve' then 'accepté' else 'refusé' end),
    coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Consultez vos demandes dans Plus → Congés.'), null);
end;
$$;
REVOKE ALL ON FUNCTION public.decide_leave(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_leave(uuid, text, text) TO authenticated;

create or replace function public.admin_set_leave_approval(p_required boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  update public.app_settings set leave_approval_required = coalesce(p_required, true), updated_at = now() where id = 1;
end;
$$;
REVOKE ALL ON FUNCTION public.admin_set_leave_approval(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_leave_approval(boolean) TO authenticated;

-- Names of colleagues for the absence planning (no other profile data).
create or replace function public.leave_list(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'user_id', l.user_id, 'name', coalesce(nullif(btrim(pr.full_name), ''), u.email), 'kind', l.kind,
    'start_date', l.start_date, 'end_date', l.end_date, 'half_day', l.half_day, 'note', l.note, 'status', l.status,
    'decision_note', l.decision_note, 'created_at', l.created_at, 'mine', l.user_id = auth.uid()
  ) order by l.start_date), '[]'::jsonb)
  from public.leave_requests l
  join public.profiles pr on pr.id = l.user_id
  left join auth.users u on u.id = pr.id
  where l.end_date >= p_from and l.start_date <= p_to
    and (l.user_id = auth.uid() or public.has_feature('leave.manage')
         or (l.status = 'approved' and (public.is_staff() or public.has_feature('calendar.view'))));
$$;
REVOKE ALL ON FUNCTION public.leave_list(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leave_list(date, date) TO authenticated;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY array['leave_requests'] LOOP
    EXECUTE format('drop trigger if exists audit_%1$s on public.%1$I', t);
    EXECUTE format('create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute function public.audit_row()', t);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Incidents reported by drivers (delivery or vehicle), statistics right
-- ---------------------------------------------------------------------------

insert into public.role_permissions (role, feature, allowed) values
  ('supervisor', 'incidents.report', true), ('production', 'incidents.report', false), ('driver', 'incidents.report', true), ('customer', 'incidents.report', false),
  ('supervisor', 'incidents.manage', true), ('production', 'incidents.manage', false), ('driver', 'incidents.manage', false), ('customer', 'incidents.manage', false),
  ('supervisor', 'stats.view', false), ('production', 'stats.view', false), ('driver', 'stats.view', false), ('customer', 'stats.view', false)
on conflict (role, feature) do nothing;

insert into public.notification_settings (event, label, audience, push_enabled, email_enabled, sort_order)
values ('incident.new', 'Incident signalé', 'Responsables', true, false, 16)
on conflict (event) do nothing;

create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('delivery', 'vehicle')),
  category text not null,
  description text not null check (char_length(btrim(description)) between 1 and 2000),
  order_id uuid references public.orders(id) on delete set null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  attachment jsonb,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolution text,
  reported_by uuid references public.profiles(id) on delete set null,
  resolved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
alter table public.incidents enable row level security;
GRANT SELECT ON public.incidents TO authenticated;
drop policy if exists "incidents_read" on public.incidents;
create policy "incidents_read" on public.incidents for select to authenticated
  using (reported_by = (select auth.uid()) or (select public.has_feature('incidents.manage')));

create or replace function public.report_incident(p_kind text, p_category text, p_description text, p_order_id uuid default null, p_vehicle_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_name text;
begin
  if public.active_uid() is null or not public.has_feature('incidents.report') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de signaler des incidents.';
  end if;
  if p_kind not in ('delivery', 'vehicle') or char_length(btrim(coalesce(p_description, ''))) = 0 then
    raise exception using errcode = '22023', message = 'Décrivez l’incident.';
  end if;
  insert into public.incidents (kind, category, description, order_id, vehicle_id, reported_by)
  values (p_kind, left(coalesce(nullif(btrim(p_category), ''), 'Autre'), 60), btrim(p_description), p_order_id, p_vehicle_id, auth.uid())
  returning id into v_id;
  select coalesce(nullif(btrim(pr.full_name), ''), u.email) into v_name from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = auth.uid();
  perform public.notify(array(select public.team_with_feature('incidents.manage')), 'incident.new',
    format('Incident %s : %s', case when p_kind = 'vehicle' then 'véhicule' else 'livraison' end, p_category),
    format('%s — %s', v_name, left(btrim(p_description), 120)), p_order_id);
  return v_id;
end;
$$;
REVOKE ALL ON FUNCTION public.report_incident(text, text, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_incident(text, text, text, uuid, uuid) TO authenticated;

create or replace function public.resolve_incident(p_id uuid, p_resolution text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_feature('incidents.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de traiter les incidents.';
  end if;
  update public.incidents set status = 'resolved', resolution = nullif(btrim(coalesce(p_resolution, '')), ''), resolved_by = auth.uid(), resolved_at = now()
  where id = p_id and status = 'open';
  if not found then
    raise exception using errcode = 'P0002', message = 'Incident introuvable ou déjà traité.';
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.resolve_incident(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_incident(uuid, text) TO authenticated;

DO $$
BEGIN
  EXECUTE 'drop trigger if exists audit_incidents on public.incidents';
  EXECUTE 'create trigger audit_incidents after insert or update or delete on public.incidents for each row execute function public.audit_row()';
END;
$$;
