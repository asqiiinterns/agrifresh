-- Pros, step 2d: data isolation between suppliers.
-- Everything is judged against ONE notion: the supplier the signed-in person acts for
-- (acting_supplier_org_id): a team member -> its Pro; a client -> the supplier of its record;
-- the Appro+ team -> none (it never reads nor writes a Pro's business data).
--   1. reads: every business access rule also requires the row to belong to that supplier;
--   2. lists built by functions: every read of a business table is limited to that supplier;
--   3. writes: a guard on every business table refuses a row of another supplier, and an order
--      line whose product belongs to another supplier;
--   4. alerts go to the right supplier's team only (rights from the roles);
--   5. per-supplier settings: document numbering, company details, client defaults.
-- Run in Supabase SQL Editor AFTER 20261110_2_switch.sql. Safe to rerun.

-- ---------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------
-- Settings that become per supplier get their owner column first (used by the rules below).
alter table public.document_numbering add column if not exists org_id uuid references public.organizations(id) on delete cascade;
update public.document_numbering set org_id = public.legacy_org_id() where org_id is null;
alter table public.client_setting_defaults add column if not exists org_id uuid references public.organizations(id) on delete cascade;
update public.client_setting_defaults set org_id = public.legacy_org_id() where org_id is null;

create or replace function public.acting_supplier_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when pr.role = 'platform' then null
    when pr.role = 'customer' then (select c.supplier_org_id from public.clients c where c.id = pr.client_id)
    else pr.org_id end
  from public.profiles pr where pr.id = (select auth.uid()) and pr.account_status = 'active';
$$;
REVOKE ALL ON FUNCTION public.acting_supplier_org_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acting_supplier_org_id() TO authenticated;

-- System work (no signed-in user, run by the database itself: scheduled jobs, sign-up) is not
-- limited; a visitor who is not signed in (anon) sees nothing. Runs as the caller on purpose:
-- inside the app's functions the caller is the database owner, in access rules it is anon/authenticated.
create or replace function public.org_visible(p_org uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select ((select auth.uid()) is null and current_user not in ('anon', 'authenticated'))
      or p_org = public.acting_supplier_org_id();
$$;
REVOKE ALL ON FUNCTION public.org_visible(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_visible(uuid) TO authenticated;

create or replace function public.client_org(p_client_id uuid) returns uuid language sql stable security definer set search_path = ''
as $$ select c.supplier_org_id from public.clients c where c.id = p_client_id; $$;
create or replace function public.order_org(p_order_id uuid) returns uuid language sql stable security definer set search_path = ''
as $$ select o.supplier_org_id from public.orders o where o.id = p_order_id; $$;
create or replace function public.user_org(p_user_id uuid) returns uuid language sql stable security definer set search_path = ''
as $$ select pr.org_id from public.profiles pr where pr.id = p_user_id; $$;
REVOKE ALL ON FUNCTION public.client_org(uuid), public.order_org(uuid), public.user_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_org(uuid), public.order_org(uuid), public.user_org(uuid) TO authenticated;

-- The condition that keeps a row of a table inside the acting supplier.
create or replace function public.org_condition(p_table text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_table
    when 'orders' then 'public.org_visible(supplier_org_id)'
    when 'clients' then 'public.org_visible(supplier_org_id)'
    when 'products' then 'public.org_visible(org_id)'
    when 'vehicles' then 'public.org_visible(org_id)'
    when 'team_conversations' then 'public.org_visible(org_id)'
    when 'document_numbering' then 'public.org_visible(org_id)'
    when 'client_setting_defaults' then 'public.org_visible(org_id)'
    when 'order_items' then 'public.org_visible(public.order_org(order_id))'
    when 'order_status_history' then 'public.org_visible(public.order_org(order_id))'
    when 'invoices' then 'public.org_visible(public.order_org(order_id))'
    when 'payments' then 'public.org_visible(public.order_org(order_id))'
    when 'client_delivery_points' then 'public.org_visible(public.client_org(client_id))'
    when 'client_invoices' then 'public.org_visible(public.client_org(client_id))'
    when 'claims' then 'public.org_visible(public.client_org(client_id))'
    when 'messages' then 'public.org_visible(public.client_org(client_id))'
    when 'returns' then 'public.org_visible(public.client_org(client_id))'
    when 'credit_notes' then 'public.org_visible(public.client_org(client_id))'
    when 'recurring_orders' then 'public.org_visible(public.client_org(client_id))'
    when 'invoice_payments' then 'public.org_visible(public.client_org((select i.client_id from public.client_invoices i where i.id = invoice_id)))'
    when 'credit_note_items' then 'public.org_visible(public.client_org((select cn.client_id from public.credit_notes cn where cn.id = credit_note_id)))'
    when 'return_items' then 'public.org_visible(public.client_org((select r.client_id from public.returns r where r.id = return_id)))'
    when 'shipments' then 'public.org_visible(public.user_org(driver_id))'
    when 'leave_requests' then 'public.org_visible(public.user_org(user_id))'
    when 'user_locations' then 'public.org_visible(public.user_org(user_id))'
    when 'incidents' then 'public.org_visible(public.user_org(reported_by))'
    when 'audit_log' then 'public.org_visible(public.user_org(actor_id))'
    when 'profiles' then '(public.org_visible(org_id) or public.org_visible(public.client_org(client_id)))'
  end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Access rules: each business rule also requires the acting supplier.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  p record;
  v_cond text;
  v_using text;
  v_check text;
BEGIN
  FOR p IN
    select * from pg_policies
    where schemaname = 'public'
      and tablename in ('orders', 'clients', 'products', 'vehicles', 'document_numbering', 'client_setting_defaults', 'order_items',
        'order_status_history', 'invoices', 'payments', 'client_delivery_points', 'client_invoices', 'claims', 'messages', 'returns',
        'credit_notes', 'recurring_orders', 'invoice_payments', 'credit_note_items', 'return_items', 'shipments', 'leave_requests',
        'user_locations', 'incidents', 'audit_log', 'profiles')
      and policyname not in ('profiles_read_own', 'profiles_update_own')
      and coalesce(qual, '') not like '%org_visible%' and coalesce(with_check, '') not like '%org_visible%'
  LOOP
    v_cond := public.org_condition(p.tablename);
    v_using := case when p.qual is null then null else format('((%s) and %s)', p.qual, v_cond) end;
    v_check := case when p.with_check is null then null else format('((%s) and %s)', p.with_check, v_cond) end;
    IF p.cmd = 'INSERT' AND v_check IS NULL THEN v_check := v_cond; END IF;
    EXECUTE format('drop policy %I on public.%I', p.policyname, p.tablename);
    EXECUTE format('create policy %I on public.%I as %s for %s to %s%s%s',
      p.policyname, p.tablename, p.permissive, p.cmd, array_to_string(p.roles, ', '),
      case when v_using is null then '' else ' using (' || v_using || ')' end,
      case when v_check is null then '' else ' with check (' || v_check || ')' end);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Lists built by functions: every read of a business table is limited to the acting supplier.
-- ---------------------------------------------------------------------------
create or replace function public.scope_function(p_name text, p_tables text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_def text;
  t text;
  v_cond text;
  v_kw text := '(?:where|on|join|left|right|inner|full|cross|group|order|limit|using|set|returning|union|for|natural|lateral|as|and|or|having|window|offset|except|intersect)';
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = p_name loop
    v_def := pg_get_functiondef(r.oid);
    continue when v_def like '%/* org-scoped */%';
    foreach t in array p_tables loop
      v_cond := public.org_condition(t);
      -- "from public.t x" / "join public.t x"
      v_def := regexp_replace(v_def,
        '(?<!delete\s)\m(from|join)(\s+)public\.' || t || '(\s+)(?!' || v_kw || '\M)([a-z_][a-z0-9_]*)\M',
        '\1\2(select * from public.' || t || ' where ' || v_cond || ')\3\4', 'gi');
      -- "from public.t where…" (no alias): the table's own name becomes the alias
      v_def := regexp_replace(v_def,
        '(?<!delete\s)\m(from|join)(\s+)public\.' || t || '\M(?=\s*(?:where|on|join|left|group|order|limit|\)|;|,)|\s*$)',
        '\1\2(select * from public.' || t || ' where ' || v_cond || ') ' || t, 'gi');
    end loop;
    v_def := regexp_replace(v_def, 'AS \$function\$', 'AS $function$ /* org-scoped */');
    execute v_def;
  end loop;
end;
$$;
REVOKE ALL ON FUNCTION public.scope_function(text, text[]) FROM PUBLIC, anon, authenticated;

select public.scope_function(f, t) from (values
  ('driver_shipments', array['orders', 'clients']),
  ('driver_pickups', array['orders', 'clients']),
  ('driver_history', array['orders', 'clients']),
  ('driver_lookup_delivery', array['orders', 'clients']),
  ('driver_lookup_point', array['orders', 'clients', 'client_delivery_points']),
  ('billing_board', array['orders', 'clients', 'client_invoices']),
  ('staff_inbox', array['clients', 'messages']),
  ('messages_needing_reply', array['messages', 'clients']),
  ('admin_list_team', array['profiles']),
  ('team_directory', array['profiles']),
  ('team_member_ids', array['profiles', 'team_conversations']),
  ('team_start_conversation', array['profiles']),
  ('team_conversations_list', array['team_conversations']),
  ('team_unread_count', array['team_conversations']),
  ('team_locations', array['profiles', 'user_locations']),
  ('leave_list', array['leave_requests', 'profiles']),
  ('staff_send_payment_reminders', array['clients', 'client_invoices']),
  ('run_recurring_orders', array['recurring_orders'])
) as x(f, t)
where exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = x.f);

-- Accounts list: the Pro's own team and its clients' accounts (plus, for the original supplier,
-- the sign-ups not attached yet). Never the Appro+ team.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.admin_list_accounts()'::regprocedure);
BEGIN
  IF v_def not like '%/* org-scoped */%' THEN
    v_def := replace(v_def, 'left join public.clients c on c.id = pr.client_id',
      'left join public.clients c on c.id = pr.client_id
    where coalesce(pr.role::text, ''customer'') <> ''platform''
      and (public.org_visible(pr.org_id) or public.org_visible(public.client_org(pr.client_id))
           or (pr.org_id is null and pr.client_id is null and public.acting_supplier_org_id() = public.legacy_org_id()))');
    v_def := regexp_replace(v_def, 'AS \$function\$', 'AS $function$ /* org-scoped */');
    EXECUTE v_def;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Writes: guard on every business table.
-- ---------------------------------------------------------------------------
create or replace function public.row_org(p_table text, p_row jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return case p_table
    when 'orders' then (p_row ->> 'supplier_org_id')::uuid
    when 'clients' then (p_row ->> 'supplier_org_id')::uuid
    when 'products' then (p_row ->> 'org_id')::uuid
    when 'vehicles' then (p_row ->> 'org_id')::uuid
    when 'team_conversations' then (p_row ->> 'org_id')::uuid
    when 'document_numbering' then (p_row ->> 'org_id')::uuid
    when 'client_setting_defaults' then (p_row ->> 'org_id')::uuid
    when 'order_items' then public.order_org((p_row ->> 'order_id')::uuid)
    when 'order_status_history' then public.order_org((p_row ->> 'order_id')::uuid)
    when 'client_delivery_points' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'client_invoices' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'claims' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'messages' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'returns' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'credit_notes' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'recurring_orders' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'invoice_payments' then public.client_org((select i.client_id from public.client_invoices i where i.id = (p_row ->> 'invoice_id')::uuid))
    when 'credit_note_items' then public.client_org((select cn.client_id from public.credit_notes cn where cn.id = (p_row ->> 'credit_note_id')::uuid))
    when 'return_items' then public.client_org((select r.client_id from public.returns r where r.id = (p_row ->> 'return_id')::uuid))
    when 'shipments' then public.user_org((p_row ->> 'driver_id')::uuid)
    when 'team_messages' then (select c.org_id from public.team_conversations c where c.id = (p_row ->> 'conversation_id')::uuid)
  end;
end;
$$;
REVOKE ALL ON FUNCTION public.row_org(text, jsonb) FROM PUBLIC, anon, authenticated;

create or replace function public.org_write_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acting uuid;
  v_new uuid;
  v_old uuid;
begin
  if (select auth.uid()) is null then
    return coalesce(new, old);
  end if;
  if exists (select 1 from public.profiles pr where pr.id = (select auth.uid()) and pr.role = 'platform') then
    raise exception using errcode = '42501', message = 'L’équipe Appro+ ne modifie pas les données des Pros.';
  end if;
  v_acting := public.acting_supplier_org_id();
  if tg_op <> 'DELETE' then
    v_new := public.row_org(tg_table_name, to_jsonb(new));
    if v_new is distinct from v_acting and not (v_new is null and tg_table_name in ('shipments', 'team_messages')) then
      raise exception using errcode = '42501', message = 'Cette donnée appartient à un autre Pro.';
    end if;
    if tg_table_name = 'order_items' then
      if (to_jsonb(new) ->> 'product_id') is not null
         and (select p.org_id from public.products p where p.id = (to_jsonb(new) ->> 'product_id')::uuid) is distinct from v_new then
        raise exception using errcode = '42501', message = 'Ce produit n’est pas proposé par ce fournisseur.';
      end if;
    end if;
  end if;
  if tg_op <> 'INSERT' then
    v_old := public.row_org(tg_table_name, to_jsonb(old));
    if v_old is distinct from v_acting and not (v_old is null and tg_table_name in ('shipments', 'team_messages')) then
      raise exception using errcode = '42501', message = 'Cette donnée appartient à un autre Pro.';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY array['orders', 'clients', 'products', 'vehicles', 'team_conversations', 'order_items', 'order_status_history',
    'client_delivery_points', 'client_invoices', 'claims', 'messages', 'returns', 'credit_notes', 'recurring_orders', 'invoice_payments',
    'credit_note_items', 'return_items', 'shipments', 'team_messages'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('drop trigger if exists zz_org_guard on public.%I', t);
      EXECUTE format('create trigger zz_org_guard before insert or update or delete on public.%I for each row execute function public.org_write_guard()', t);
    END IF;
  END LOOP;
END;
$$;

-- Accounts: a Pro's administrator only acts on its own team and its clients' accounts.
create or replace function public.profiles_org_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acting uuid;
begin
  if (select auth.uid()) is null or new.id = (select auth.uid()) or public.platform_role() is not null then
    return new;
  end if;
  v_acting := public.acting_supplier_org_id();
  -- Every comparison is made explicit: an unknown (null) owner never counts as "mine".
  if v_acting is null
     or not (coalesce(old.org_id = v_acting, false) or coalesce(public.client_org(old.client_id) = v_acting, false)
             or (old.org_id is null and old.client_id is null and old.role <> 'platform'))
     or not (new.org_id is null or coalesce(new.org_id = v_acting, false) or coalesce(public.client_org(new.client_id) = v_acting, false)) then
    raise exception using errcode = '42501', message = 'Ce compte appartient à un autre Pro.';
  end if;
  return new;
end;
$$;
drop trigger if exists zz_profiles_org_guard on public.profiles;
create trigger zz_profiles_org_guard before update on public.profiles for each row execute function public.profiles_org_guard();

-- New rows of a Pro belong to the acting supplier (not to the original one).
create or replace function public.acting_or_legacy_org_id() returns uuid language sql stable security definer set search_path = ''
as $$ select coalesce(public.acting_supplier_org_id(), public.legacy_org_id()); $$;
REVOKE ALL ON FUNCTION public.acting_or_legacy_org_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acting_or_legacy_org_id() TO authenticated;
alter table public.products alter column org_id set default public.acting_or_legacy_org_id();
alter table public.vehicles alter column org_id set default public.acting_or_legacy_org_id();
alter table public.team_conversations alter column org_id set default public.acting_or_legacy_org_id();

-- Team accounts created without a Pro join the creator's Pro.
create or replace function public.profiles_fill_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_superadmin or new.role = 'platform' then
    return new;
  end if;
  if new.role = 'customer' and new.client_id is not null
     and (tg_op = 'INSERT' or new.client_id is distinct from old.client_id or new.org_id is null) then
    new.org_id := coalesce((select c.buyer_org_id from public.clients c where c.id = new.client_id), new.org_id);
  elsif new.org_id is null and new.role in ('staff', 'supervisor', 'production', 'driver', 'admin') then
    new.org_id := public.acting_or_legacy_org_id();
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Alerts: the right supplier's team, rights from the roles.
-- ---------------------------------------------------------------------------
create or replace function public.user_has_permission(p_user_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case when pr.account_status <> 'active' or pr.role = 'platform' then false
      when public.feature_module(p_permission) is not null and not public.module_enabled(public.feature_module(p_permission)) then false
      else coalesce(
        (select mo.allowed from public.member_overrides mo where mo.user_id = pr.id and mo.org_id = pr.org_id and mo.permission = p_permission),
        (select (c.feature_overrides ->> p_permission)::boolean from public.clients c where c.id = pr.client_id and pr.role = 'customer' and p_permission like 'client.%'),
        (select bool_or(public.role_grants(r.id, p_permission)) from public.member_roles mr join public.org_roles r on r.id = mr.role_id
          where mr.user_id = pr.id and r.org_id = pr.org_id and (mr.valid_until is null or mr.valid_until > now())),
        false) end
    from public.profiles pr where pr.id = p_user_id), false);
$$;
REVOKE ALL ON FUNCTION public.user_has_permission(uuid, text) FROM PUBLIC, anon, authenticated;

drop function if exists public.team_with_feature(text);
create or replace function public.team_with_feature(p_feature text, p_org_id uuid default null)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pr.id from public.profiles pr
  where pr.account_status = 'active' and pr.role not in ('customer', 'platform')
    and pr.org_id = coalesce(p_org_id, public.acting_supplier_org_id())
    and public.user_has_permission(pr.id, p_feature);
$$;
REVOKE ALL ON FUNCTION public.team_with_feature(text, uuid) FROM PUBLIC, anon, authenticated;

-- Alerts raised by an order, a claim or a message go to the supplier the row belongs to.
DO $$
DECLARE
  v_def text;
BEGIN
  v_def := pg_get_functiondef('public.alert_on_order()'::regprocedure);
  EXECUTE replace(v_def, 'public.team_with_feature(''orders.decide'')', 'public.team_with_feature(''orders.decide'', new.supplier_org_id)');
  v_def := pg_get_functiondef('public.alert_on_claim()'::regprocedure);
  EXECUTE replace(v_def, 'public.team_with_feature(''claims.manage'')', 'public.team_with_feature(''claims.manage'', public.client_org(new.client_id))');
  v_def := pg_get_functiondef('public.alert_on_message()'::regprocedure);
  EXECUTE replace(v_def, 'public.team_with_feature(''messages.manage'')', 'public.team_with_feature(''messages.manage'', public.client_org(new.client_id))');
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Per-supplier settings.
-- ---------------------------------------------------------------------------
-- Document numbering: one series per supplier.
alter table public.document_numbering add column if not exists org_id uuid references public.organizations(id) on delete cascade;
update public.document_numbering set org_id = public.legacy_org_id() where org_id is null;
DO $$
BEGIN
  IF exists (select 1 from pg_constraint where conname = 'document_numbering_pkey'
             and pg_get_constraintdef(oid) = 'PRIMARY KEY (doc_type)') THEN
    alter table public.document_numbering drop constraint document_numbering_pkey;
    alter table public.document_numbering alter column org_id set not null;
    alter table public.document_numbering add primary key (org_id, doc_type);
  END IF;
END;
$$;

create or replace function public.org_install_numbering(p_org_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.document_numbering (org_id, doc_type, prefix, with_year, digits, next_number, yearly_reset)
  select p_org_id, n.doc_type, n.prefix, n.with_year, n.digits, 1, n.yearly_reset
  from public.document_numbering n where n.org_id = public.legacy_org_id()
  on conflict (org_id, doc_type) do nothing;
$$;
REVOKE ALL ON FUNCTION public.org_install_numbering(uuid) FROM PUBLIC, anon, authenticated;
select public.org_install_numbering(o.id) from public.organizations o where o.is_supplier;

drop function if exists public.next_document_number(text);
create or replace function public.next_document_number(p_type text, p_org_id uuid default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(p_org_id, public.acting_supplier_org_id(), public.legacy_org_id());
  v_row public.document_numbering%rowtype;
  v_year int := extract(year from (now() at time zone 'Africa/Tunis'))::int;
  v_number bigint;
begin
  perform public.org_install_numbering(v_org);
  select n.* into v_row from public.document_numbering n where n.org_id = v_org and n.doc_type = p_type for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Numérotation inconnue.';
  end if;
  v_number := case when v_row.yearly_reset and v_row.current_year is distinct from v_year then 1 else v_row.next_number end;
  update public.document_numbering set next_number = v_number + 1, current_year = v_year where org_id = v_org and doc_type = p_type;
  return public.format_document_number(v_row.prefix, v_row.with_year, v_row.digits, v_number, v_year);
end;
$$;
REVOKE ALL ON FUNCTION public.next_document_number(text, uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.admin_set_numbering(p_type text, p_prefix text, p_with_year boolean, p_digits integer, p_next_number bigint, p_yearly_reset boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if not public.is_admin() or v_org is null then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if char_length(coalesce(p_prefix, '')) > 12 or coalesce(p_prefix, '') ~ '[^A-Za-z0-9/_.-]' then
    raise exception using errcode = '22023', message = 'Préfixe : 12 caractères au plus (lettres, chiffres, - / _ .).';
  end if;
  if p_digits not between 1 and 10 or p_next_number < 1 then
    raise exception using errcode = '22023', message = 'Nombre de chiffres (1 à 10) ou numéro de départ invalide.';
  end if;
  perform public.org_install_numbering(v_org);
  update public.document_numbering
  set prefix = coalesce(p_prefix, ''), with_year = p_with_year, digits = p_digits, next_number = p_next_number,
      yearly_reset = p_yearly_reset, current_year = extract(year from (now() at time zone 'Africa/Tunis'))::int, updated_at = now()
  where org_id = v_org and doc_type = p_type;
  if not found then
    raise exception using errcode = 'P0002', message = 'Numérotation inconnue.';
  end if;
end;
$$;

-- Client options by default: one set per supplier.
alter table public.client_setting_defaults add column if not exists org_id uuid references public.organizations(id) on delete cascade;
update public.client_setting_defaults set org_id = public.legacy_org_id() where org_id is null;
DO $$
BEGIN
  IF exists (select 1 from pg_constraint where conname = 'client_setting_defaults_pkey'
             and pg_get_constraintdef(oid) = 'PRIMARY KEY (key)') THEN
    alter table public.client_setting_defaults drop constraint client_setting_defaults_pkey;
    alter table public.client_setting_defaults alter column org_id set not null;
    alter table public.client_setting_defaults add primary key (org_id, key);
  END IF;
END;
$$;
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.apply_client_defaults()'::regprocedure);
BEGIN
  IF v_def not like '%s.org_id%' THEN
    EXECUTE replace(v_def, 'from public.client_setting_defaults s)',
      'from public.client_setting_defaults s where s.org_id = coalesce(new.supplier_org_id, public.acting_or_legacy_org_id()))');
  END IF;
END;
$$;
create or replace function public.admin_set_client_default(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if not public.is_admin() or v_org is null then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if p_key not in ('show_prices', 'show_origin', 'show_stock', 'stock_managed', 'invoice_mode', 'reception_qr',
                   'history_enabled', 'reconfirm_declined', 'scan_delivery_note', 'scan_client_qr',
                   'payment_reminders', 'reminder_opt_out_allowed', 'delivery_signature') then
    raise exception using errcode = '22023', message = 'Option client inconnue.';
  end if;
  if p_key = 'invoice_mode' then
    if jsonb_typeof(p_value) is distinct from 'string' or (p_value #>> '{}') not in ('auto', 'manual') then
      raise exception using errcode = '22023', message = 'Mode de facturation invalide.';
    end if;
  elsif jsonb_typeof(p_value) is distinct from 'boolean' then
    raise exception using errcode = '22023', message = 'Valeur invalide.';
  end if;
  insert into public.client_setting_defaults (org_id, key, value, updated_at) values (v_org, p_key, p_value, now())
  on conflict (org_id, key) do update set value = excluded.value, updated_at = now();
  update public.clients set custom_settings = custom_settings where supplier_org_id = v_org and not (p_key = any(custom_settings));
end;
$$;

-- Company details: each supplier's own, printed on its documents.
update public.organizations o set tagline = cp.tagline, address = cp.address, phone = cp.phone, email = cp.email,
  tax_id = cp.tax_id, rib = cp.rib, brand_color = cp.brand_color
from public.company_profile cp
where o.legacy and cp.id = 1 and o.address = '' and o.tax_id = '' and (cp.address <> '' or cp.tax_id <> '');

create or replace function public.my_company_profile()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('name', o.name, 'tagline', o.tagline, 'address', o.address, 'phone', o.phone, 'email', o.email,
    'tax_id', o.tax_id, 'rib', o.rib, 'brand_color', o.brand_color)
  from public.organizations o where o.id = public.acting_supplier_org_id();
$$;
REVOKE ALL ON FUNCTION public.my_company_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_company_profile() TO authenticated;

create or replace function public.set_company_profile(p_profile jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if not public.is_admin() or v_org is null then
    raise exception using errcode = '42501', message = 'Seul le Responsable du Pro peut modifier les informations de l’entreprise.';
  end if;
  if p_profile ? 'brand_color' and coalesce(p_profile ->> 'brand_color', '') !~ '^(#[0-9a-fA-F]{6})?$' then
    raise exception using errcode = '22023', message = 'Couleur invalide : utilisez le format #RRVVBB.';
  end if;
  update public.organizations set
    name = coalesce(nullif(left(btrim(coalesce(p_profile ->> 'name', '')), 120), ''), name),
    tagline = left(btrim(coalesce(p_profile ->> 'tagline', tagline)), 160),
    address = left(btrim(coalesce(p_profile ->> 'address', address)), 300),
    phone = left(btrim(coalesce(p_profile ->> 'phone', phone)), 60),
    email = left(btrim(coalesce(p_profile ->> 'email', email)), 160),
    tax_id = left(btrim(coalesce(p_profile ->> 'tax_id', tax_id)), 60),
    rib = left(btrim(coalesce(p_profile ->> 'rib', rib)), 80),
    brand_color = coalesce(p_profile ->> 'brand_color', brand_color),
    updated_at = now()
  where id = v_org;
end;
$$;

-- Settings that still apply to the whole platform stay with the original supplier's
-- administrator until each Pro has its own (e-mail service, alert events, modules, roles,
-- home screens by profile, leave approval).
create or replace function public.is_legacy_admin() returns boolean language sql stable security definer set search_path = ''
as $$ select public.is_admin() and public.current_org_id() = public.legacy_org_id(); $$;
REVOKE ALL ON FUNCTION public.is_legacy_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_legacy_admin() TO authenticated;
DO $$
DECLARE
  f text;
  v_def text;
BEGIN
  FOREACH f IN ARRAY array['admin_set_permission', 'admin_set_email_settings', 'admin_set_email_api_key', 'admin_send_test_email',
    'admin_email_status', 'admin_set_notification_setting', 'admin_set_module', 'admin_set_home_layout', 'admin_set_leave_approval'] LOOP
    FOR v_def IN select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = f LOOP
      IF v_def like '%public.is_admin()%' THEN
        EXECUTE replace(v_def, 'public.is_admin()', 'public.is_legacy_admin()');
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
drop policy if exists "app_settings_read_admin" on public.app_settings;
create policy "app_settings_read_admin" on public.app_settings for select to authenticated using ((select public.is_legacy_admin()));

-- Re-apply the module guards to the functions rewritten above.
select public.apply_module_guards();
