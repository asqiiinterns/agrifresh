-- Pros, step 2a: roles. Two separate worlds:
--   * the Appro+ team (platform_members): platform roles only, managed in "Équipe Appro+";
--   * the Pros' users: roles that only count inside their Pro, managed in "Pros".
-- Pro roles come from templates kept by Appro+ (a role follows its template and stores only
-- its differences); people get one or more roles, possibly for a limited time, and personal
-- exceptions. has_permission() computes rights this way; it runs NEXT TO the current engine
-- (has_feature) until the switch, and the tests check both give the same answers.
-- Run in Supabase SQL Editor AFTER 20261108_pros_foundation.sql. Safe to rerun.

-- ---------------------------------------------------------------------------
-- Appro+ team
-- ---------------------------------------------------------------------------
create table if not exists public.platform_members (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  role text not null check (role in ('superadmin', 'support', 'account_manager', 'verification', 'finance', 'viewer')),
  active boolean not null default true,
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.platform_members enable row level security;
GRANT SELECT ON public.platform_members TO authenticated;
insert into public.platform_members (user_id, role)
select pr.id, 'superadmin' from public.profiles pr where pr.is_superadmin
on conflict (user_id) do nothing;

create or replace function public.platform_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pm.role from public.platform_members pm join public.profiles pr on pr.id = pm.user_id
  where pm.user_id = (select auth.uid()) and pm.active and pr.account_status = 'active';
$$;
REVOKE ALL ON FUNCTION public.platform_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_role() TO authenticated;

-- Platform rights, by platform role (never a Pro right).
create or replace function public.platform_can(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case public.platform_role()
    when 'superadmin' then true
    when 'support' then p_permission in ('platform.pros.view', 'platform.support.access', 'platform.audit')
    when 'account_manager' then p_permission in ('platform.pros.view', 'platform.pros.manage', 'platform.roles.assign', 'platform.support.access')
    when 'verification' then p_permission in ('platform.pros.view', 'platform.pros.validate')
    when 'finance' then p_permission in ('platform.pros.view', 'platform.billing')
    when 'viewer' then p_permission in ('platform.pros.view', 'platform.audit')
    else false
  end;
$$;
REVOKE ALL ON FUNCTION public.platform_can(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_can(text) TO authenticated;

drop policy if exists "platform_members_read" on public.platform_members;
create policy "platform_members_read" on public.platform_members for select to authenticated
  using (user_id = (select auth.uid()) or (select public.platform_role()) is not null);

-- ---------------------------------------------------------------------------
-- Pro rights: catalogue, templates, roles of each Pro, people
-- ---------------------------------------------------------------------------
create table if not exists public.permissions (
  key text primary key,
  side text not null check (side in ('supplier', 'buyer')),
  label text not null default ''
);
alter table public.permissions enable row level security;
GRANT SELECT ON public.permissions TO authenticated;
drop policy if exists "permissions_read" on public.permissions;
create policy "permissions_read" on public.permissions for select to authenticated using (true);
insert into public.permissions (key, side)
select distinct rp.feature, case when rp.feature like 'client.%' then 'buyer' else 'supplier' end
from public.role_permissions rp
on conflict (key) do nothing;

create table if not exists public.role_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  side text not null check (side in ('supplier', 'buyer')),
  name text not null,
  pack text not null default 'standard',
  description text not null default '',
  sort_order int not null default 0
);
create table if not exists public.role_template_permissions (
  template_id uuid not null references public.role_templates(id) on delete cascade,
  permission text not null references public.permissions(key) on delete cascade,
  primary key (template_id, permission)
);
alter table public.role_templates enable row level security;
alter table public.role_template_permissions enable row level security;
GRANT SELECT ON public.role_templates, public.role_template_permissions TO authenticated;
drop policy if exists "role_templates_read" on public.role_templates;
create policy "role_templates_read" on public.role_templates for select to authenticated using (true);
drop policy if exists "role_template_permissions_read" on public.role_template_permissions;
create policy "role_template_permissions_read" on public.role_template_permissions for select to authenticated using (true);

insert into public.role_templates (key, side, name, description, sort_order) values
  ('supplier_owner', 'supplier', 'Responsable', 'Tous les droits du Pro fournisseur, dont l’affectation des rôles.', 1),
  ('supplier_supervisor', 'supplier', 'Superviseur', 'Décide des commandes, suit la production, la livraison et la facturation.', 2),
  ('supplier_sales', 'supplier', 'Commercial', 'Clients, commandes saisies pour eux, messages.', 3),
  ('supplier_production', 'supplier', 'Production', 'Préparation des commandes.', 4),
  ('supplier_driver', 'supplier', 'Livreur', 'Tournées, remise au client, incidents.', 5),
  ('supplier_billing', 'supplier', 'Facturation', 'Factures, paiements, retours et avoirs.', 6),
  ('supplier_viewer', 'supplier', 'Lecture seule', 'Consulte sans rien modifier.', 7),
  ('buyer_owner', 'buyer', 'Responsable', 'Tous les droits du Pro acheteur.', 11),
  ('buyer_purchaser', 'buyer', 'Acheteur', 'Commande, suit ses commandes, échange avec les fournisseurs.', 12),
  ('buyer_receiver', 'buyer', 'Réceptionnaire', 'Suit les livraisons, réclamations et retours.', 13),
  ('buyer_accounting', 'buyer', 'Comptabilité', 'Factures et paiements.', 14),
  ('buyer_viewer', 'buyer', 'Lecture seule', 'Consulte sans rien modifier.', 15)
on conflict (key) do nothing;

-- Template contents. Superviseur, Production, Livreur and Acheteur start from today's role
-- settings, so the original supplier and its clients keep exactly the same rights.
DO $$
DECLARE
  v_count int;
BEGIN
  select count(*) into v_count from public.role_template_permissions;
  IF v_count = 0 THEN
    insert into public.role_template_permissions (template_id, permission)
    select t.id, p.key from public.role_templates t join public.permissions p on p.side = t.side
    where t.key in ('supplier_owner', 'buyer_owner');
    insert into public.role_template_permissions (template_id, permission)
    select t.id, rp.feature from public.role_templates t
    join public.role_permissions rp on rp.allowed and rp.role::text = case t.key
      when 'supplier_supervisor' then 'supervisor' when 'supplier_production' then 'production'
      when 'supplier_driver' then 'driver' when 'buyer_purchaser' then 'customer' end
    where t.key in ('supplier_supervisor', 'supplier_production', 'supplier_driver', 'buyer_purchaser')
    on conflict do nothing;
    insert into public.role_template_permissions (template_id, permission)
    select t.id, x.permission from public.role_templates t
    join (values
      ('supplier_sales', array['home.view', 'alerts.view', 'orders.view', 'orders.create', 'clients.view', 'clients.edit', 'messages.manage', 'team.messages', 'calendar.view', 'leave.request', 'client.recurring']),
      ('supplier_billing', array['home.view', 'alerts.view', 'orders.view', 'invoices.manage', 'returns.manage', 'clients.view', 'messages.manage', 'team.messages', 'calendar.view', 'leave.request']),
      ('supplier_viewer', array['home.view', 'alerts.view', 'orders.view', 'production.view', 'clients.view', 'stats.view']),
      ('buyer_receiver', array['client.home', 'client.orders', 'client.alerts', 'client.claims', 'client.returns', 'client.messages']),
      ('buyer_accounting', array['client.home', 'client.invoices', 'client.alerts', 'client.messages']),
      ('buyer_viewer', array['client.home', 'client.orders', 'client.invoices'])
    ) as v(key, perms) on v.key = t.key
    cross join lateral unnest(v.perms) as x(permission)
    where exists (select 1 from public.permissions p where p.key = x.permission)
    on conflict do nothing;
  END IF;
END;
$$;

create table if not exists public.org_roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  side text not null check (side in ('supplier', 'buyer')),
  template_id uuid references public.role_templates(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, template_id)
);
-- A role stores only its differences from its template (or every right, if it has none).
create table if not exists public.org_role_overrides (
  role_id uuid not null references public.org_roles(id) on delete cascade,
  permission text not null references public.permissions(key) on delete cascade,
  allowed boolean not null,
  primary key (role_id, permission)
);
create table if not exists public.member_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid not null references public.org_roles(id) on delete cascade,
  valid_until timestamptz,
  transitional boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, role_id)
);
create table if not exists public.member_overrides (
  user_id uuid not null references public.profiles(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  permission text not null references public.permissions(key) on delete cascade,
  allowed boolean not null,
  primary key (user_id, org_id, permission)
);
create index if not exists org_roles_org_idx on public.org_roles(org_id);
create index if not exists member_roles_role_idx on public.member_roles(role_id);
alter table public.org_roles enable row level security;
alter table public.org_role_overrides enable row level security;
alter table public.member_roles enable row level security;
alter table public.member_overrides enable row level security;
GRANT SELECT ON public.org_roles, public.org_role_overrides, public.member_roles, public.member_overrides TO authenticated;

drop policy if exists "org_roles_read" on public.org_roles;
create policy "org_roles_read" on public.org_roles for select to authenticated
  using (org_id = (select public.current_org_id()) or (select public.platform_role()) is not null);
drop policy if exists "org_role_overrides_read" on public.org_role_overrides;
create policy "org_role_overrides_read" on public.org_role_overrides for select to authenticated
  using (exists (select 1 from public.org_roles r where r.id = role_id
    and (r.org_id = (select public.current_org_id()) or (select public.platform_role()) is not null)));
drop policy if exists "member_roles_read" on public.member_roles;
create policy "member_roles_read" on public.member_roles for select to authenticated
  using (user_id = (select auth.uid()) or (select public.platform_role()) is not null
    or exists (select 1 from public.org_roles r where r.id = role_id and r.org_id = (select public.current_org_id())));
drop policy if exists "member_overrides_read" on public.member_overrides;
create policy "member_overrides_read" on public.member_overrides for select to authenticated
  using (user_id = (select auth.uid()) or org_id = (select public.current_org_id()) or (select public.platform_role()) is not null);

-- Gives a Pro the roles of its side(s), following the templates (used at creation / validation).
create or replace function public.org_install_roles(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.org_roles (org_id, name, side, template_id)
  select o.id, t.name, t.side, t.id
  from public.organizations o join public.role_templates t
    on (t.side = 'supplier' and o.is_supplier) or (t.side = 'buyer' and o.is_buyer)
  where o.id = p_org_id
  on conflict (org_id, template_id) do nothing;
end;
$$;
REVOKE ALL ON FUNCTION public.org_install_roles(uuid) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN select id from public.organizations LOOP
    PERFORM public.org_install_roles(r.id);
  END LOOP;
END;
$$;

-- Today's accounts get the role matching their current profile; the current administrator
-- keeps running the original supplier as its Responsable until its owner account is named
-- (transitional: removed when the owner takes over).
insert into public.member_roles (user_id, role_id, transitional)
select pr.id, r.id, pr.is_superadmin
from public.profiles pr
join public.org_roles r on r.org_id = coalesce(pr.org_id, case when pr.role = 'admin' then public.legacy_org_id() end)
join public.role_templates t on t.id = r.template_id
where t.key = case pr.role::text
  when 'admin' then 'supplier_owner' when 'supervisor' then 'supplier_supervisor' when 'staff' then 'supplier_supervisor'
  when 'production' then 'supplier_production' when 'driver' then 'supplier_driver' when 'customer' then 'buyer_purchaser' end
on conflict (user_id, role_id) do nothing;

insert into public.member_overrides (user_id, org_id, permission, allowed)
select up.user_id, pr.org_id, up.feature, up.allowed
from public.user_permissions up
join public.profiles pr on pr.id = up.user_id
where pr.org_id is not null and exists (select 1 from public.permissions p where p.key = up.feature)
on conflict (user_id, org_id, permission) do update set allowed = excluded.allowed;

-- Until the role screens replace them, today's profile (supervisor, driver…) keeps giving the
-- matching role in the account's Pro: a new or changed account is never left without rights.
create or replace function public.legacy_role_template(p_role text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_role when 'admin' then 'supplier_owner' when 'supervisor' then 'supplier_supervisor' when 'staff' then 'supplier_supervisor'
    when 'production' then 'supplier_production' when 'driver' then 'supplier_driver' when 'customer' then 'buyer_purchaser' end;
$$;

create or replace function public.profiles_sync_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (old.role is distinct from new.role or old.org_id is distinct from new.org_id) then
    delete from public.member_roles mr
    using public.org_roles r join public.role_templates t on t.id = r.template_id
    where mr.role_id = r.id and mr.user_id = new.id and not mr.transitional
      and (r.org_id is distinct from new.org_id or t.key = public.legacy_role_template(old.role::text));
  end if;
  if new.is_superadmin or new.org_id is null then
    return new;
  end if;
  perform public.org_install_roles(new.org_id);
  insert into public.member_roles (user_id, role_id)
  select new.id, r.id from public.org_roles r join public.role_templates t on t.id = r.template_id
  where r.org_id = new.org_id and t.key = public.legacy_role_template(new.role::text)
  on conflict (user_id, role_id) do nothing;
  return new;
end;
$$;
drop trigger if exists profiles_sync_roles on public.profiles;
create trigger profiles_sync_roles after insert or update of role, org_id, is_superadmin on public.profiles
  for each row execute function public.profiles_sync_roles();

-- ---------------------------------------------------------------------------
-- The new engine (not used by the app yet).
-- ---------------------------------------------------------------------------
create or replace function public.role_grants(p_role_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select o.allowed from public.org_role_overrides o where o.role_id = p_role_id and o.permission = p_permission),
    exists (select 1 from public.org_roles r join public.role_template_permissions tp on tp.template_id = r.template_id
            where r.id = p_role_id and tp.permission = p_permission));
$$;
REVOKE ALL ON FUNCTION public.role_grants(uuid, text) FROM PUBLIC, anon, authenticated;

-- Personal exception, then the client record's option (buyer rights), then the person's roles.
create or replace function public.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case when pr.account_status <> 'active' then false else coalesce(
      (select mo.allowed from public.member_overrides mo where mo.user_id = pr.id and mo.org_id = pr.org_id and mo.permission = p_permission),
      (select (c.feature_overrides ->> p_permission)::boolean from public.clients c
        where c.id = pr.client_id and pr.role = 'customer' and p_permission like 'client.%'),
      (select bool_or(public.role_grants(r.id, p_permission))
        from public.member_roles mr join public.org_roles r on r.id = mr.role_id
        where mr.user_id = pr.id and r.org_id = coalesce(pr.org_id, case when mr.transitional then r.org_id end)
          and (mr.valid_until is null or mr.valid_until > now())),
      false) end
    from public.profiles pr where pr.id = (select auth.uid())
  ), false);
$$;
REVOKE ALL ON FUNCTION public.has_permission(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated;

DO $$
DECLARE
  t text;
BEGIN
  IF to_regprocedure('public.audit_row()') IS NOT NULL THEN
    FOREACH t IN ARRAY array['platform_members', 'org_roles', 'org_role_overrides', 'member_roles', 'member_overrides', 'role_template_permissions'] LOOP
      EXECUTE format('drop trigger if exists audit_%1$s on public.%1$I', t);
      EXECUTE format('create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute function public.audit_row()', t);
    END LOOP;
  END IF;
END;
$$;
