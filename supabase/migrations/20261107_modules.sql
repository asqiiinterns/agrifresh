-- Modules: each function of the app can be switched off for everyone (Paramétrage → Modules).
-- A module that is off disappears: its rights answer "no" for every account (admins included),
-- and the client options it carries count as off in every server function.
-- Every module is ON unless switched off, so installing this changes nothing by itself.
-- Run in Supabase SQL Editor AFTER 20261106_appro_plus.sql. Safe to rerun.
--
-- Note for later migrations: a migration that recreates has_feature() or a function reading
-- client options must end with `select public.apply_module_guards();`.

create table if not exists public.app_modules (
  key text primary key,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
alter table public.app_modules enable row level security;
GRANT SELECT ON public.app_modules TO authenticated;
drop policy if exists "app_modules_read" on public.app_modules;
create policy "app_modules_read" on public.app_modules for select to authenticated using (true);

-- The catalogue (same keys as src/data/modules.ts).
create or replace function public.module_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['decide', 'production', 'planning', 'delivery', 'delivery_qr', 'signature', 'fleet', 'invoicing', 'reminders',
    'exports', 'returns', 'claims', 'client_messages', 'team_messages', 'attachments', 'needs_reply', 'staff_orders',
    'recurring', 'order_tags', 'stock', 'origin', 'reconfirm', 'calendar', 'leaves', 'incidents', 'location', 'stats',
    'audit', 'languages', 'home_custom'];
$$;

create or replace function public.module_enabled(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select m.enabled from public.app_modules m where m.key = p_key), true);
$$;
REVOKE ALL ON FUNCTION public.module_enabled(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.module_enabled(text) TO authenticated;

-- Which module a right belongs to (null = always available: home, alerts, orders, clients, catalogue).
create or replace function public.feature_module(p_feature text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_feature
    when 'production.view' then 'production' when 'production.update' then 'production'
    when 'orders.plan' then 'planning'
    when 'deliveries' then 'delivery' when 'orders.ship' then 'delivery'
    when 'fleet.manage' then 'fleet'
    when 'invoices.manage' then 'invoicing' when 'client.invoices' then 'invoicing'
    when 'returns.manage' then 'returns' when 'client.returns' then 'returns'
    when 'claims.manage' then 'claims' when 'client.claims' then 'claims'
    when 'messages.manage' then 'client_messages' when 'client.messages' then 'client_messages'
    when 'team.messages' then 'team_messages'
    when 'orders.create' then 'staff_orders'
    when 'client.recurring' then 'recurring'
    when 'calendar.view' then 'calendar'
    when 'leave.request' then 'leaves' when 'leave.manage' then 'leaves'
    when 'incidents.report' then 'incidents' when 'incidents.manage' then 'incidents'
    when 'location.share' then 'location' when 'location.view' then 'location'
    when 'stats.view' then 'stats'
    when 'audit.view' then 'audit'
  end;
$$;

-- Rewrites in place what must obey the modules: has_feature() (its previous body becomes
-- has_feature_base) and every function reading a client option of a module.
create or replace function public.apply_module_guards()
returns int
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_def text;
  v_new text;
  v_count int := 0;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'has_feature' and p.prosrc like '%has_feature_base%') then
    v_def := pg_get_functiondef('public.has_feature(text)'::regprocedure);
    execute replace(v_def, 'FUNCTION public.has_feature(', 'FUNCTION public.has_feature_base(');
    execute 'REVOKE ALL ON FUNCTION public.has_feature_base(text) FROM PUBLIC, anon, authenticated';
    execute $f$
      create or replace function public.has_feature(p_feature text)
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $body$
        select (public.feature_module(p_feature) is null or public.module_enabled(public.feature_module(p_feature)))
          and public.has_feature_base(p_feature);
      $body$
    $f$;
    v_count := v_count + 1;
  end if;

  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname not in ('apply_module_guards', 'has_feature', 'has_feature_base', 'module_enabled')
      and p.prosrc ~ '\m(c|v_client)\.(delivery_signature|payment_reminders|scan_delivery_note|scan_client_qr|reception_qr|show_origin|show_stock|stock_managed|reconfirm_declined)\M'
      and p.prosrc not like '%public.module_enabled(''%'
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := v_def;
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(delivery_signature)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''signature''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(payment_reminders)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''reminders''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(scan_delivery_note|scan_client_qr|reception_qr)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''delivery_qr''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(show_origin)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''origin''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(show_stock|stock_managed)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''stock''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(reconfirm_declined)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''reconfirm''))', 'g');
    if v_new <> v_def then
      execute v_new;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;
REVOKE ALL ON FUNCTION public.apply_module_guards() FROM PUBLIC, anon, authenticated;

select public.apply_module_guards();

-- State of every module, for the app (all signed-in users).
create or replace function public.app_modules_state()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_object_agg(k, public.module_enabled(k)) from unnest(public.module_keys()) as k;
$$;
REVOKE ALL ON FUNCTION public.app_modules_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_modules_state() TO authenticated;

create or replace function public.admin_set_module(p_key text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Seul un administrateur peut activer ou désactiver un module.';
  end if;
  if not (p_key = any(public.module_keys())) then
    raise exception using errcode = '22023', message = 'Module inconnu.';
  end if;
  insert into public.app_modules (key, enabled, updated_at, updated_by) values (p_key, coalesce(p_enabled, true), now(), auth.uid())
  on conflict (key) do update set enabled = excluded.enabled, updated_at = now(), updated_by = auth.uid();
end;
$$;
REVOKE ALL ON FUNCTION public.admin_set_module(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_module(text, boolean) TO authenticated;

DO $$
BEGIN
  IF to_regprocedure('public.audit_row()') IS NOT NULL THEN
    EXECUTE 'drop trigger if exists audit_app_modules on public.app_modules';
    EXECUTE 'create trigger audit_app_modules after insert or update or delete on public.app_modules for each row execute function public.audit_row()';
  END IF;
END;
$$;
