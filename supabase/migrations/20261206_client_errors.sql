-- Errors of the application itself (a screen that crashes, an unexpected failure): recorded automatically with the
-- screen, the account, the device and the technical message, and listed for Appro+ (Paramétrage → Erreurs de
-- l'application) instead of a white screen nobody hears about. Run AFTER 20261205_home_counts.sql. Safe to rerun.

create table if not exists public.client_errors (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references public.profiles(id) on delete set null,
  org_id uuid references public.organizations(id) on delete set null,
  screen text,
  kind text not null default 'render',
  message text not null,
  stack text,
  component_stack text,
  platform text,
  app_version text,
  url text,
  occurrences int not null default 1,
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists client_errors_recent on public.client_errors (last_seen_at desc);
alter table public.client_errors enable row level security;
-- No direct access: written by log_client_error, read by platform_client_errors.
drop policy if exists "client_errors_none" on public.client_errors;

-- Called by the application; never fails (an error while reporting an error must not break anything).
-- The same error of the same person on the same screen within a day is counted, not stored again.
create or replace function public.log_client_error(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_message text := left(coalesce(nullif(btrim(p ->> 'message'), ''), 'Erreur inconnue'), 2000);
  v_screen text := left(p ->> 'screen', 120);
  v_id uuid;
begin
  if jsonb_typeof(p) is distinct from 'object' then return; end if;
  -- At most 100 new errors per person per hour.
  if (select count(*) from public.client_errors e where e.user_id is not distinct from v_uid and e.created_at > now() - interval '1 hour') >= 100 then
    return;
  end if;
  select e.id into v_id from public.client_errors e
  where e.user_id is not distinct from v_uid and e.message = v_message and e.screen is not distinct from v_screen
    and e.last_seen_at > now() - interval '1 day' and e.resolved_at is null
  order by e.last_seen_at desc limit 1;
  if v_id is not null then
    update public.client_errors set occurrences = occurrences + 1, last_seen_at = now() where id = v_id;
    return;
  end if;
  insert into public.client_errors (user_id, org_id, screen, kind, message, stack, component_stack, platform, app_version, url)
  values (v_uid, (select pr.org_id from public.profiles pr where pr.id = v_uid), v_screen,
    left(coalesce(p ->> 'kind', 'render'), 30), v_message, left(p ->> 'stack', 8000), left(p ->> 'component_stack', 8000),
    left(p ->> 'platform', 40), left(p ->> 'app_version', 40), left(p ->> 'url', 500));
exception when others then
  return;
end;
$$;
REVOKE ALL ON FUNCTION public.log_client_error(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_client_error(jsonb) TO authenticated, anon;

create or replace function public.platform_client_errors(p_include_resolved boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.platform_can('platform.pros.view') then
    raise exception using errcode = '42501', message = 'Réservé à l’équipe Appro+.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', e.id, 'created_at', e.created_at, 'last_seen_at', e.last_seen_at, 'occurrences', e.occurrences,
      'screen', e.screen, 'kind', e.kind, 'message', e.message, 'stack', e.stack, 'component_stack', e.component_stack,
      'platform', e.platform, 'app_version', e.app_version, 'url', e.url, 'resolved_at', e.resolved_at,
      'user', coalesce(nullif(btrim(pr.full_name), ''), u.email), 'org_name', o.name) order by e.last_seen_at desc)
    from (select * from public.client_errors x where p_include_resolved or x.resolved_at is null order by x.last_seen_at desc limit 300) e
    left join public.profiles pr on pr.id = e.user_id
    left join auth.users u on u.id = e.user_id
    left join public.organizations o on o.id = e.org_id), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.platform_client_errors(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_client_errors(boolean) TO authenticated;

-- p_id null: every open error at once.
create or replace function public.platform_resolve_client_error(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Réservé à l’équipe Appro+.';
  end if;
  update public.client_errors set resolved_at = now() where (p_id is null or id = p_id) and resolved_at is null;
end;
$$;
REVOKE ALL ON FUNCTION public.platform_resolve_client_error(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_resolve_client_error(uuid) TO authenticated;

notify pgrst, 'reload schema';
