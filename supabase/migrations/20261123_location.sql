-- Location of a colleague, with consent:
--   * a colleague allowed to ("Voir la position des comptes") asks; the person is told at once and accepts
--     (her current position is sent) or refuses;
--   * no answer within a minute: the position is shown only if the person's tracking is allowed by the
--     administrator ("Repérage autorisé" on her account), or if the one asking is the Pro's administrator;
--     the person then receives a message saying who looked and when;
--   * positions are no longer read directly: every look is a request, kept as a trace.
-- Run in Supabase SQL Editor AFTER 20261122_cleanup.sql. Safe to rerun.

alter table public.profiles add column if not exists location_tracking boolean not null default false;

-- Only one's own position is readable as such; the others go through a request.
drop policy if exists "user_locations_read" on public.user_locations;
create policy "user_locations_read" on public.user_locations for select to authenticated using (user_id = (select auth.uid()));

create table if not exists public.location_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  target_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'refused', 'automatic', 'expired')),
  latitude double precision,
  longitude double precision,
  accuracy double precision,
  located_at timestamptz,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create index if not exists location_requests_target_idx on public.location_requests(target_id, status);
alter table public.location_requests enable row level security;

create or replace function public.location_name(p_user uuid)
returns text language sql stable security definer set search_path = ''
as $$ select coalesce(nullif(btrim(pr.full_name), ''), u.email, 'Un collègue') from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = p_user; $$;
REVOKE ALL ON FUNCTION public.location_name(uuid) FROM PUBLIC, anon, authenticated;

-- The accounts of my Pro, without their position (it is asked for, see request_location).
create or replace function public.team_locations()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not public.has_feature('location.view') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de voir les positions.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', pr.id, 'name', coalesce(nullif(btrim(pr.full_name), ''), u.email), 'role', pr.role,
      'consent', pr.location_consent, 'tracking', pr.location_tracking,
      'latitude', null, 'longitude', null, 'accuracy', null,
      'updated_at', l.updated_at, 'last_sign_in_at', u.last_sign_in_at
    ) order by pr.full_name)
    from public.profiles pr
    left join auth.users u on u.id = pr.id
    left join public.user_locations l on l.user_id = pr.id
    where pr.org_id = v_org and pr.account_status = 'active' and pr.role <> 'customer' and pr.id <> auth.uid()
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.team_locations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_locations() TO authenticated;

-- The administrator allows (or not) tracking without answer for an account of the Pro.
create or replace function public.set_location_tracking(p_user_id uuid, p_allowed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not (public.is_admin() or public.is_org_owner(v_org)) then
    raise exception using errcode = '42501', message = 'Seul l’administrateur règle le repérage.';
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set location_tracking = coalesce(p_allowed, false) where id = p_user_id and org_id = v_org;
  perform set_config('appro.link_write', 'off', true);
  if not found then
    raise exception using errcode = 'P0002', message = 'Compte introuvable.';
  end if;
  perform public.notify(array[p_user_id], 'location.tracking', case when p_allowed then 'Repérage autorisé' else 'Repérage retiré' end,
    case when p_allowed then 'Votre administrateur peut voir votre dernière position si vous ne répondez pas à une demande dans la minute. Vous êtes prévenu à chaque consultation.'
         else 'Votre position ne sera plus montrée sans votre accord.' end);
end;
$$;
REVOKE ALL ON FUNCTION public.set_location_tracking(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_location_tracking(uuid, boolean) TO authenticated;

create or replace function public.request_location(p_target_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
  v_id uuid;
begin
  if v_org is null or not public.has_feature('location.view') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de voir les positions.';
  end if;
  if p_target_id = auth.uid() or not exists (select 1 from public.profiles pr where pr.id = p_target_id and pr.org_id = v_org and pr.account_status = 'active') then
    raise exception using errcode = 'P0002', message = 'Compte introuvable dans votre équipe.';
  end if;
  insert into public.location_requests (org_id, requester_id, target_id) values (v_org, auth.uid(), p_target_id) returning id into v_id;
  perform public.notify(array[p_target_id], 'location.request', 'Demande de position',
    format('%s demande à voir votre position : ouvrez l’application pour accepter ou refuser.', public.location_name(auth.uid())));
  return v_id;
end;
$$;
REVOKE ALL ON FUNCTION public.request_location(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_location(uuid) TO authenticated;

-- The requests waiting for my answer (shown by the app as soon as it is open).
create or replace function public.my_location_requests()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'requester', public.location_name(r.requester_id), 'created_at', r.created_at,
      'tracking', (select pr.location_tracking from public.profiles pr where pr.id = r.target_id)) order by r.created_at), '[]'::jsonb)
  from public.location_requests r
  where r.target_id = (select auth.uid()) and r.status = 'pending' and r.created_at > now() - interval '10 minutes';
$$;
REVOKE ALL ON FUNCTION public.my_location_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_location_requests() TO authenticated;

create or replace function public.answer_location_request(p_request_id uuid, p_accept boolean,
  p_latitude double precision default null, p_longitude double precision default null, p_accuracy double precision default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.location_requests%rowtype;
begin
  select * into v_request from public.location_requests where id = p_request_id for update;
  if v_request.id is null or v_request.target_id is distinct from auth.uid() then
    raise exception using errcode = 'P0002', message = 'Demande introuvable.';
  end if;
  if p_accept and (p_latitude is null or p_longitude is null) then
    raise exception using errcode = '22023', message = 'Position indisponible : autorisez la localisation sur ce téléphone.';
  end if;
  update public.location_requests set
    status = case when p_accept then 'accepted' else 'refused' end, answered_at = now(),
    latitude = case when p_accept then p_latitude end, longitude = case when p_accept then p_longitude end,
    accuracy = case when p_accept then p_accuracy end, located_at = case when p_accept then now() end
  where id = p_request_id;
  if p_accept then
    insert into public.user_locations (user_id, latitude, longitude, accuracy, updated_at)
    values (auth.uid(), p_latitude, p_longitude, p_accuracy, now())
    on conflict (user_id) do update set latitude = excluded.latitude, longitude = excluded.longitude, accuracy = excluded.accuracy, updated_at = now();
  end if;
  perform public.notify(array[v_request.requester_id], 'location.answer',
    case when p_accept then 'Position partagée' else 'Position refusée' end,
    format('%s %s votre demande.', public.location_name(auth.uid()), case when p_accept then 'a accepté' else 'a refusé' end));
end;
$$;
REVOKE ALL ON FUNCTION public.answer_location_request(uuid, boolean, double precision, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.answer_location_request(uuid, boolean, double precision, double precision, double precision) TO authenticated;

-- Polled by the one who asked. After a minute without answer: the last known position when tracking is allowed
-- or when the one asking is the Pro's administrator (the person is told), otherwise "expired".
create or replace function public.location_request_status(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.location_requests%rowtype;
  v_target public.profiles%rowtype;
  v_last public.user_locations%rowtype;
begin
  select * into v_request from public.location_requests where id = p_request_id for update;
  if v_request.id is null or v_request.requester_id is distinct from auth.uid() then
    raise exception using errcode = 'P0002', message = 'Demande introuvable.';
  end if;
  if v_request.status = 'pending' and v_request.created_at < now() - interval '1 minute' then
    select * into v_target from public.profiles where id = v_request.target_id;
    select * into v_last from public.user_locations where user_id = v_request.target_id;
    if v_target.location_tracking or public.is_admin() or public.is_org_owner(v_request.org_id) then
      update public.location_requests set status = 'automatic', answered_at = now(),
        latitude = v_last.latitude, longitude = v_last.longitude, accuracy = v_last.accuracy, located_at = v_last.updated_at
      where id = p_request_id
      returning * into v_request;
      perform public.notify(array[v_request.target_id], 'location.viewed', 'Votre position a été consultée',
        format('%s a vu votre dernière position connue, sans réponse de votre part dans la minute%s.', public.location_name(auth.uid()),
          case when v_target.location_tracking then ' (repérage autorisé par votre administrateur)' else ' (administrateur de votre Pro)' end));
    else
      update public.location_requests set status = 'expired', answered_at = now() where id = p_request_id returning * into v_request;
    end if;
  end if;
  return jsonb_build_object('id', v_request.id, 'status', v_request.status, 'latitude', v_request.latitude, 'longitude', v_request.longitude,
    'accuracy', v_request.accuracy, 'located_at', v_request.located_at, 'target', public.location_name(v_request.target_id),
    'seconds_left', greatest(0, 60 - extract(epoch from now() - v_request.created_at)::int));
end;
$$;
REVOKE ALL ON FUNCTION public.location_request_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.location_request_status(uuid) TO authenticated;

-- Who looked at my position (trace kept for the person).
create or replace function public.my_location_views()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('requester', public.location_name(r.requester_id), 'status', r.status, 'created_at', r.created_at)
    order by r.created_at desc), '[]'::jsonb)
  from (select * from public.location_requests x where x.target_id = (select auth.uid()) order by x.created_at desc limit 50) r;
$$;
REVOKE ALL ON FUNCTION public.my_location_views() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_location_views() TO authenticated;

notify pgrst, 'reload schema';
