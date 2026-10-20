-- Pros (step 1 of 3: foundations). Appro+ becomes a platform of professionals ("Pros"):
-- each Pro can be a supplier, a buyer, or both. This step only adds the structure and
-- files the existing data; access rules are unchanged (step 2), so the app works as before.
--   * organizations: one row per Pro; the original supplier is the "legacy" Pro;
--   * profiles: org_id (the Pro the account belongs to) and is_superadmin (platform owner);
--   * clients (the former client records) become supplier -> buyer relations, each buyer
--     being its own Pro; products, orders, vehicles and team conversations belong to a Pro.
-- Run in Supabase SQL Editor AFTER 20261107_modules.sql. Safe to rerun.

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  is_supplier boolean not null default false,
  is_buyer boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'active', 'suspended', 'refused')),
  legacy boolean not null default false,
  tagline text not null default '',
  address text not null default '',
  phone text not null default '',
  email text not null default '',
  tax_id text not null default '',
  rib text not null default '',
  brand_color text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists organizations_one_legacy on public.organizations (legacy) where legacy;
alter table public.organizations enable row level security;
GRANT SELECT ON public.organizations TO authenticated;

-- The original supplier, with the details entered in Paramétrage → Entreprise.
insert into public.organizations (name, is_supplier, is_buyer, status, legacy, tagline, address, phone, email, tax_id, rib, brand_color)
select coalesce(nullif(btrim(cp.name), ''), 'AgriFresh'), true, false, 'active', true,
       cp.tagline, cp.address, cp.phone, cp.email, cp.tax_id, cp.rib, cp.brand_color
from (select 1) one left join public.company_profile cp on cp.id = 1
where not exists (select 1 from public.organizations o where o.legacy);

create or replace function public.legacy_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select o.id from public.organizations o where o.legacy;
$$;
REVOKE ALL ON FUNCTION public.legacy_org_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.legacy_org_id() TO authenticated;

-- ---------------------------------------------------------------------------
-- Accounts: their Pro, and the platform owner (super-admin).
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists org_id uuid references public.organizations(id) on delete set null;
alter table public.profiles add column if not exists is_superadmin boolean not null default false;
create index if not exists profiles_org_idx on public.profiles(org_id);

create or replace function public.is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles pr where pr.id = (select auth.uid()) and pr.is_superadmin and pr.account_status = 'active');
$$;
REVOKE ALL ON FUNCTION public.is_superadmin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_superadmin() TO authenticated;

-- The Pro of the signed-in account (null for the super-admin and accounts not yet attached).
create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pr.org_id from public.profiles pr where pr.id = (select auth.uid()) and pr.account_status = 'active';
$$;
REVOKE ALL ON FUNCTION public.current_org_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_org_id() TO authenticated;

-- The current administrator(s) become the platform's super-admin (same e-mail, same account).
-- Only the first time: later administrators of a Pro (e.g. its Responsable) are not platform owners.
update public.profiles set is_superadmin = true
where role = 'admin' and not is_superadmin and org_id is null
  and not exists (select 1 from public.profiles other where other.is_superadmin);

-- ---------------------------------------------------------------------------
-- Client records become relations: supplier Pro -> buyer Pro.
-- ---------------------------------------------------------------------------
alter table public.clients add column if not exists supplier_org_id uuid references public.organizations(id) on delete cascade;
alter table public.clients add column if not exists buyer_org_id uuid references public.organizations(id) on delete set null;
create index if not exists clients_supplier_idx on public.clients(supplier_org_id);
create index if not exists clients_buyer_idx on public.clients(buyer_org_id);
update public.clients set supplier_org_id = public.legacy_org_id() where supplier_org_id is null;

-- Each existing record gets its own buyer Pro (named after the business, active like the record).
DO $$
DECLARE
  r record;
  v_org uuid;
BEGIN
  FOR r IN select c.id, c.business_name, c.phone, c.email, c.active from public.clients c where c.buyer_org_id is null LOOP
    insert into public.organizations (name, is_supplier, is_buyer, status, phone, email)
    values (r.business_name, false, true, case when r.active then 'active' else 'suspended' end, coalesce(r.phone, ''), coalesce(r.email, ''))
    returning id into v_org;
    update public.clients set buyer_org_id = v_org where id = r.id;
  END LOOP;
END;
$$;

-- New records keep working with today's screens: supplier = the creator's Pro (or the
-- original supplier), and a buyer Pro is created for the business when none is given.
create or replace function public.clients_fill_orgs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.supplier_org_id is null then
    new.supplier_org_id := coalesce(public.current_org_id(), public.legacy_org_id());
  end if;
  if new.buyer_org_id is null then
    insert into public.organizations (name, is_supplier, is_buyer, status, phone, email)
    values (new.business_name, false, true, case when new.active then 'active' else 'suspended' end, coalesce(new.phone, ''), coalesce(new.email, ''))
    returning id into new.buyer_org_id;
  end if;
  return new;
end;
$$;
drop trigger if exists clients_fill_orgs on public.clients;
create trigger clients_fill_orgs before insert on public.clients for each row execute function public.clients_fill_orgs();

-- ---------------------------------------------------------------------------
-- Accounts attached to their Pro: the supplier's team to the original supplier,
-- client accounts to the buyer Pro of their record. Kept up to date by a trigger.
-- ---------------------------------------------------------------------------
update public.profiles pr set org_id = public.legacy_org_id()
where pr.org_id is null and pr.role in ('staff', 'supervisor', 'production', 'driver');
update public.profiles pr set org_id = c.buyer_org_id
from public.clients c
where pr.org_id is null and pr.role = 'customer' and c.id = pr.client_id;

create or replace function public.profiles_fill_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_superadmin then
    return new;
  end if;
  if new.role = 'customer' and new.client_id is not null
     and (tg_op = 'INSERT' or new.client_id is distinct from old.client_id or new.org_id is null) then
    new.org_id := coalesce((select c.buyer_org_id from public.clients c where c.id = new.client_id), new.org_id);
  elsif new.org_id is null and new.role in ('staff', 'supervisor', 'production', 'driver') then
    new.org_id := public.legacy_org_id();
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_fill_org on public.profiles;
create trigger profiles_fill_org before insert or update of role, client_id, org_id on public.profiles
  for each row execute function public.profiles_fill_org();

-- ---------------------------------------------------------------------------
-- What belongs to a supplier Pro. Rows created by today's functions are filed
-- automatically (the creator's Pro, else the original supplier).
-- ---------------------------------------------------------------------------
create or replace function public.default_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_org_id(), public.legacy_org_id());
$$;
REVOKE ALL ON FUNCTION public.default_org_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.default_org_id() TO authenticated;

alter table public.products add column if not exists org_id uuid references public.organizations(id) on delete cascade;
update public.products set org_id = public.legacy_org_id() where org_id is null;
alter table public.products alter column org_id set default public.legacy_org_id();
create index if not exists products_org_idx on public.products(org_id);

alter table public.orders add column if not exists supplier_org_id uuid references public.organizations(id) on delete cascade;
update public.orders o set supplier_org_id = coalesce(c.supplier_org_id, public.legacy_org_id())
from public.clients c where o.supplier_org_id is null and c.id = o.client_id;
update public.orders set supplier_org_id = public.legacy_org_id() where supplier_org_id is null;
create index if not exists orders_supplier_idx on public.orders(supplier_org_id);

-- An order belongs to the supplier of its client record.
create or replace function public.orders_fill_supplier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.supplier_org_id is null then
    new.supplier_org_id := coalesce((select c.supplier_org_id from public.clients c where c.id = new.client_id), public.legacy_org_id());
  end if;
  return new;
end;
$$;
drop trigger if exists orders_fill_supplier on public.orders;
create trigger orders_fill_supplier before insert on public.orders for each row execute function public.orders_fill_supplier();

alter table public.vehicles add column if not exists org_id uuid references public.organizations(id) on delete cascade;
update public.vehicles set org_id = public.legacy_org_id() where org_id is null;
alter table public.vehicles alter column org_id set default public.legacy_org_id();

alter table public.team_conversations add column if not exists org_id uuid references public.organizations(id) on delete cascade;
update public.team_conversations set org_id = public.legacy_org_id() where org_id is null;
alter table public.team_conversations alter column org_id set default public.legacy_org_id();

-- Read access for now: every signed-in account sees the Pros' public card (name, roles,
-- status); legal details stay readable since they are printed on documents. Tightened in step 2.
drop policy if exists "organizations_read" on public.organizations;
create policy "organizations_read" on public.organizations for select to authenticated using (true);

DO $$
BEGIN
  IF to_regprocedure('public.audit_row()') IS NOT NULL THEN
    EXECUTE 'drop trigger if exists audit_organizations on public.organizations';
    EXECUTE 'create trigger audit_organizations after insert or update or delete on public.organizations for each row execute function public.audit_row()';
  END IF;
END;
$$;
