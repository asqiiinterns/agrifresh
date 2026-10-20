-- Pros, step 2c: onboarding and roles management.
--   * anyone signed in can create a Pro (supplier, buyer or both); it waits for Appro+;
--   * validating a Pro activates it and its Responsable; a suspended Pro cannot work;
--   * Appro+ sets a Pro's activities, sees its team, and decides whether the Pro may edit its roles;
--   * roles: rights of a role (differences from its template), custom roles, who has which role,
--     effective rights of a person. Appro+ can do everything; a Pro's Responsable assigns roles to
--     its team and edits roles only when Appro+ allows it.
-- Run in Supabase SQL Editor AFTER 20261111_isolation.sql. Safe to rerun.

alter table public.organizations add column if not exists roles_delegated boolean not null default false;
alter table public.organizations add column if not exists created_by uuid references public.profiles(id) on delete set null;

-- ---------------------------------------------------------------------------
-- A Pro that is not active does not work: no "current Pro", no rights.
-- ---------------------------------------------------------------------------
create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pr.org_id from public.profiles pr join public.organizations o on o.id = pr.org_id
  where pr.id = (select auth.uid()) and pr.account_status = 'active' and o.status = 'active';
$$;

create or replace function public.acting_supplier_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select o.id
  from public.profiles pr
  join public.organizations o on o.id = case
    when pr.role = 'customer' then (select c.supplier_org_id from public.clients c where c.id = pr.client_id)
    when pr.role = 'platform' then null
    else pr.org_id end
  where pr.id = (select auth.uid()) and pr.account_status = 'active' and o.status = 'active'
    and (pr.role <> 'customer' or exists (select 1 from public.organizations b where b.id = pr.org_id and b.status = 'active'));
$$;

create or replace function public.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles pr join public.organizations o on o.id = pr.org_id
                 where pr.id = (select auth.uid()) and o.status = 'active')
     and public.user_has_permission((select auth.uid()), p_permission);
$$;

-- ---------------------------------------------------------------------------
-- Creating a Pro (self-service), waiting for Appro+.
-- ---------------------------------------------------------------------------
create or replace function public.my_pro()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when o.id is null then null else jsonb_build_object(
    'id', o.id, 'name', o.name, 'status', o.status, 'is_supplier', o.is_supplier, 'is_buyer', o.is_buyer,
    'roles_delegated', o.roles_delegated) end
  from public.profiles pr left join public.organizations o on o.id = pr.org_id
  where pr.id = (select auth.uid());
$$;
REVOKE ALL ON FUNCTION public.my_pro() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_pro() TO authenticated;

create or replace function public.org_owner_template(p_supplier boolean)
returns text language sql immutable set search_path = ''
as $$ select case when p_supplier then 'supplier_owner' else 'buyer_owner' end; $$;

create or replace function public.register_pro(p_profile jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles%rowtype;
  v_org uuid;
  v_supplier boolean := coalesce((p_profile ->> 'is_supplier')::boolean, false);
  v_buyer boolean := coalesce((p_profile ->> 'is_buyer')::boolean, true);
begin
  select * into v_me from public.profiles where id = auth.uid();
  if v_me.id is null then
    raise exception using errcode = '42501', message = 'Connectez-vous d’abord.';
  end if;
  if v_me.role = 'platform' or v_me.org_id is not null or v_me.client_id is not null then
    raise exception using errcode = '22023', message = 'Ce compte appartient déjà à un Pro ou à l’équipe Appro+.';
  end if;
  if char_length(btrim(coalesce(p_profile ->> 'name', ''))) < 2 then
    raise exception using errcode = '22023', message = 'Indiquez le nom de votre entreprise.';
  end if;
  if not (v_supplier or v_buyer) then
    raise exception using errcode = '22023', message = 'Choisissez au moins une activité : fournisseur ou acheteur.';
  end if;
  insert into public.organizations (name, is_supplier, is_buyer, status, phone, address, tax_id, email, created_by)
  values (left(btrim(p_profile ->> 'name'), 120), v_supplier, v_buyer, 'pending',
          left(btrim(coalesce(p_profile ->> 'phone', '')), 60), left(btrim(coalesce(p_profile ->> 'address', '')), 300),
          left(btrim(coalesce(p_profile ->> 'tax_id', '')), 60),
          coalesce((select u.email from auth.users u where u.id = auth.uid()), ''), auth.uid())
  returning id into v_org;
  perform public.org_install_roles(v_org);
  update public.profiles set org_id = v_org, role = 'admin', account_status = 'pending' where id = auth.uid();
  insert into public.member_roles (user_id, role_id)
  select auth.uid(), r.id from public.org_roles r join public.role_templates t on t.id = r.template_id
  where r.org_id = v_org and t.key in ('supplier_owner', 'buyer_owner')
  on conflict do nothing;
  return v_org;
end;
$$;
REVOKE ALL ON FUNCTION public.register_pro(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_pro(jsonb) TO authenticated;

-- Validating a Pro activates its Responsable(s); a supplier gets its document numbering.
create or replace function public.platform_set_pro_status(p_org_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (public.platform_can('platform.pros.validate') or public.platform_can('platform.pros.manage')) then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas de valider ou suspendre un Pro.';
  end if;
  if p_status not in ('active', 'suspended', 'refused', 'pending') then
    raise exception using errcode = '22023', message = 'Statut inconnu.';
  end if;
  if exists (select 1 from public.organizations where id = p_org_id and legacy) and p_status <> 'active' then
    raise exception using errcode = '22023', message = 'Le premier fournisseur de la plateforme ne peut pas être suspendu ici.';
  end if;
  update public.organizations set status = p_status, updated_at = now() where id = p_org_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Pro introuvable.';
  end if;
  if p_status = 'active' then
    perform public.org_install_roles(p_org_id);
    if exists (select 1 from public.organizations where id = p_org_id and is_supplier) then
      perform public.org_install_numbering(p_org_id);
    end if;
    update public.profiles set account_status = 'active'
    where org_id = p_org_id and role = 'admin' and account_status = 'pending';
  end if;
end;
$$;

create or replace function public.platform_set_pro_profile(p_org_id uuid, p_is_supplier boolean, p_is_buyer boolean, p_roles_delegated boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas de modifier un Pro.';
  end if;
  if not (coalesce(p_is_supplier, false) or coalesce(p_is_buyer, false)) then
    raise exception using errcode = '22023', message = 'Un Pro est au moins fournisseur ou acheteur.';
  end if;
  update public.organizations set is_supplier = p_is_supplier, is_buyer = p_is_buyer,
    roles_delegated = coalesce(p_roles_delegated, roles_delegated), updated_at = now()
  where id = p_org_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Pro introuvable.';
  end if;
  perform public.org_install_roles(p_org_id);
  if p_is_supplier then
    perform public.org_install_numbering(p_org_id);
  end if;
  -- Its Responsable(s) get the Responsable role of the new activity too.
  insert into public.member_roles (user_id, role_id)
  select pr.id, r.id from public.profiles pr
  join public.org_roles r on r.org_id = p_org_id
  join public.role_templates t on t.id = r.template_id and t.key in ('supplier_owner', 'buyer_owner')
  where pr.org_id = p_org_id and pr.role = 'admin'
  on conflict do nothing;
end;
$$;
REVOKE ALL ON FUNCTION public.platform_set_pro_profile(uuid, boolean, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_pro_profile(uuid, boolean, boolean, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- Roles of a Pro: who may manage them.
-- ---------------------------------------------------------------------------
-- p_edit: change what a role allows (Appro+, or the Pro's Responsable if delegated);
-- otherwise: assign roles to people (Appro+ or the Pro's Responsable).
create or replace function public.can_manage_org_roles(p_org_id uuid, p_edit boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.platform_can('platform.pros.manage')
      or (not p_edit and public.platform_can('platform.roles.assign'))
      or (public.is_admin() and public.current_org_id() = p_org_id
          and (not p_edit or exists (select 1 from public.organizations o where o.id = p_org_id and o.roles_delegated)));
$$;
REVOKE ALL ON FUNCTION public.can_manage_org_roles(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_org_roles(uuid, boolean) TO authenticated;

-- Everything the roles screen needs, for one Pro (default: mine).
create or replace function public.org_roles_matrix(p_org_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(p_org_id, public.current_org_id());
begin
  if v_org is null or not public.can_manage_org_roles(v_org, false) then
    raise exception using errcode = '42501', message = 'Réservé au Responsable du Pro et à l’équipe Appro+.';
  end if;
  return jsonb_build_object(
    'org', (select jsonb_build_object('id', o.id, 'name', o.name, 'is_supplier', o.is_supplier, 'is_buyer', o.is_buyer, 'roles_delegated', o.roles_delegated)
            from public.organizations o where o.id = v_org),
    'can_edit', public.can_manage_org_roles(v_org, true),
    'permissions', (select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'side', p.side, 'module', public.feature_module(p.key)) order by p.side, p.key), '[]'::jsonb)
                    from public.permissions p),
    'roles', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name, 'side', r.side, 'template', t.name, 'template_key', t.key,
        'granted', (select coalesce(jsonb_agg(p.key order by p.key), '[]'::jsonb) from public.permissions p
                    where p.side = r.side and public.role_grants(r.id, p.key)),
        'overrides', (select coalesce(jsonb_object_agg(o.permission, o.allowed), '{}'::jsonb) from public.org_role_overrides o where o.role_id = r.id),
        'members', (select count(*) from public.member_roles mr where mr.role_id = r.id)
      ) order by r.side, coalesce(t.sort_order, 99), r.name), '[]'::jsonb)
      from public.org_roles r left join public.role_templates t on t.id = r.template_id where r.org_id = v_org),
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', pr.id, 'email', u.email, 'full_name', pr.full_name, 'status', pr.account_status,
        'roles', (select coalesce(jsonb_agg(mr.role_id), '[]'::jsonb) from public.member_roles mr join public.org_roles r on r.id = mr.role_id
                  where mr.user_id = pr.id and r.org_id = v_org)
      ) order by pr.full_name, u.email), '[]'::jsonb)
      from public.profiles pr left join auth.users u on u.id = pr.id
      where pr.org_id = v_org and pr.role <> 'platform')
  );
end;
$$;
REVOKE ALL ON FUNCTION public.org_roles_matrix(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_roles_matrix(uuid) TO authenticated;

-- A right of a role: true / false, or null to follow its template again.
create or replace function public.org_set_role_permission(p_role_id uuid, p_permission text, p_allowed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.org_roles%rowtype;
  v_template boolean;
begin
  select * into v_role from public.org_roles where id = p_role_id;
  if v_role.id is null or not public.can_manage_org_roles(v_role.org_id, true) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas modifier ce rôle.';
  end if;
  if not exists (select 1 from public.permissions p where p.key = p_permission and p.side = v_role.side) then
    raise exception using errcode = '22023', message = 'Ce droit ne concerne pas ce rôle.';
  end if;
  v_template := exists (select 1 from public.role_template_permissions tp where tp.template_id = v_role.template_id and tp.permission = p_permission);
  if p_allowed is null or (v_role.template_id is not null and p_allowed = v_template) then
    delete from public.org_role_overrides where role_id = p_role_id and permission = p_permission;
  else
    insert into public.org_role_overrides (role_id, permission, allowed) values (p_role_id, p_permission, p_allowed)
    on conflict (role_id, permission) do update set allowed = excluded.allowed;
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.org_set_role_permission(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_set_role_permission(uuid, text, boolean) TO authenticated;

-- A role made to measure: starts from a template's rights (copied) or from nothing.
create or replace function public.org_create_role(p_org_id uuid, p_name text, p_side text, p_from_role uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(p_org_id, public.current_org_id());
  v_id uuid;
begin
  if v_org is null or not public.can_manage_org_roles(v_org, true) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas créer de rôle pour ce Pro.';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) < 2 or p_side not in ('supplier', 'buyer') then
    raise exception using errcode = '22023', message = 'Indiquez un nom et le côté (fournisseur ou acheteur).';
  end if;
  insert into public.org_roles (org_id, name, side) values (v_org, left(btrim(p_name), 60), p_side) returning id into v_id;
  if p_from_role is not null then
    insert into public.org_role_overrides (role_id, permission, allowed)
    select v_id, p.key, true from public.permissions p
    where p.side = p_side and public.role_grants(p_from_role, p.key)
      and exists (select 1 from public.org_roles src where src.id = p_from_role and src.org_id = v_org);
  end if;
  return v_id;
end;
$$;
REVOKE ALL ON FUNCTION public.org_create_role(uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_create_role(uuid, text, text, uuid) TO authenticated;

-- Gives or removes a role. A Pro always keeps at least one active Responsable, and nobody
-- removes their own Responsable role.
create or replace function public.org_set_member_role(p_user_id uuid, p_role_id uuid, p_enabled boolean, p_valid_until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.org_roles%rowtype;
  v_owner boolean;
begin
  select * into v_role from public.org_roles where id = p_role_id;
  if v_role.id is null or not public.can_manage_org_roles(v_role.org_id, false) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas attribuer ce rôle.';
  end if;
  if not exists (select 1 from public.profiles pr where pr.id = p_user_id and pr.org_id = v_role.org_id) then
    raise exception using errcode = 'P0002', message = 'Cette personne n’appartient pas à ce Pro.';
  end if;
  v_owner := exists (select 1 from public.role_templates t where t.id = v_role.template_id and t.key in ('supplier_owner', 'buyer_owner'));
  if p_enabled then
    insert into public.member_roles (user_id, role_id, valid_until) values (p_user_id, p_role_id, p_valid_until)
    on conflict (user_id, role_id) do update set valid_until = excluded.valid_until;
  else
    if v_owner and p_user_id = auth.uid() then
      raise exception using errcode = '22023', message = 'Vous ne pouvez pas retirer votre propre rôle de Responsable.';
    end if;
    if v_owner and not exists (select 1 from public.member_roles mr join public.profiles pr on pr.id = mr.user_id
                               where mr.role_id = p_role_id and mr.user_id <> p_user_id and pr.account_status = 'active') then
      raise exception using errcode = '22023', message = 'Le Pro doit garder au moins un Responsable actif.';
    end if;
    delete from public.member_roles where user_id = p_user_id and role_id = p_role_id;
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.org_set_member_role(uuid, uuid, boolean, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_set_member_role(uuid, uuid, boolean, timestamptz) TO authenticated;

-- "See as": what a person of the Pro can actually do (roles, exceptions and modules together).
create or replace function public.org_member_permissions(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select pr.org_id from public.profiles pr where pr.id = p_user_id);
begin
  if v_org is null or not public.can_manage_org_roles(v_org, false) then
    raise exception using errcode = '42501', message = 'Réservé au Responsable du Pro et à l’équipe Appro+.';
  end if;
  return (select coalesce(jsonb_agg(p.key order by p.key), '[]'::jsonb) from public.permissions p
          where public.user_has_permission(p_user_id, p.key));
end;
$$;
REVOKE ALL ON FUNCTION public.org_member_permissions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_member_permissions(uuid) TO authenticated;

-- A product, vehicle or team conversation created without an owner belongs to the acting Pro.
create or replace function public.fill_org_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    new.org_id := public.acting_or_legacy_org_id();
  end if;
  return new;
end;
$$;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY array['products', 'vehicles', 'team_conversations'] LOOP
    EXECUTE format('drop trigger if exists a_fill_org_id on public.%I', t);
    EXECUTE format('create trigger a_fill_org_id before insert on public.%I for each row execute function public.fill_org_id()', t);
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF to_regprocedure('public.audit_row()') IS NOT NULL THEN
    EXECUTE 'drop trigger if exists audit_organizations on public.organizations';
    EXECUTE 'create trigger audit_organizations after insert or update or delete on public.organizations for each row execute function public.audit_row()';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Appro+ creates and manages Pros (businesses or private persons) completely.
-- ---------------------------------------------------------------------------
alter table public.organizations add column if not exists kind text not null default 'business' check (kind in ('business', 'person'));
alter table public.organizations add column if not exists owner_email text;

-- The Responsable named by Appro+: attached now if the account exists, otherwise as soon as
-- that e-mail creates its account.
create or replace function public.attach_org_owner(p_org_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := (select o.status from public.organizations o where o.id = p_org_id);
begin
  update public.profiles set org_id = p_org_id, role = 'admin', client_id = null,
    account_status = case when v_status = 'active' then 'active' else 'pending' end
  where id = p_user_id and org_id is null and client_id is null and role <> 'platform';
  if not found then
    return;
  end if;
  perform public.org_install_roles(p_org_id);
  insert into public.member_roles (user_id, role_id)
  select p_user_id, r.id from public.org_roles r join public.role_templates t on t.id = r.template_id
  where r.org_id = p_org_id and t.key in ('supplier_owner', 'buyer_owner')
  on conflict do nothing;
end;
$$;
REVOKE ALL ON FUNCTION public.attach_org_owner(uuid, uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.platform_save_pro(p_org_id uuid, p_profile jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := p_org_id;
  v_owner text := nullif(lower(btrim(coalesce(p_profile ->> 'owner_email', ''))), '');
  v_user uuid;
  v_supplier boolean := coalesce((p_profile ->> 'is_supplier')::boolean, false);
  v_buyer boolean := coalesce((p_profile ->> 'is_buyer')::boolean, true);
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas de créer ou modifier un Pro.';
  end if;
  if char_length(btrim(coalesce(p_profile ->> 'name', ''))) < 2 then
    raise exception using errcode = '22023', message = 'Indiquez le nom du Pro.';
  end if;
  if not (v_supplier or v_buyer) then
    raise exception using errcode = '22023', message = 'Un Pro est au moins fournisseur ou acheteur.';
  end if;
  if coalesce(p_profile ->> 'kind', 'business') = 'person' and v_supplier then
    raise exception using errcode = '22023', message = 'Un particulier est acheteur, pas fournisseur.';
  end if;
  if v_owner is not null then
    select u.id into v_user from auth.users u where lower(u.email) = v_owner;
    if v_user is not null and exists (select 1 from public.profiles pr where pr.id = v_user
         and (pr.role = 'platform' or (pr.org_id is not null and pr.org_id is distinct from v_org) or pr.client_id is not null)) then
      raise exception using errcode = '22023', message = 'Cet e-mail appartient déjà à un autre Pro ou à l’équipe Appro+.';
    end if;
  end if;
  if v_org is null then
    insert into public.organizations (name, kind, is_supplier, is_buyer, status, created_by)
    values (left(btrim(p_profile ->> 'name'), 120), coalesce(p_profile ->> 'kind', 'business'), v_supplier, v_buyer,
            coalesce(p_profile ->> 'status', 'active'), auth.uid())
    returning id into v_org;
  end if;
  update public.organizations set
    name = left(btrim(p_profile ->> 'name'), 120),
    kind = coalesce(p_profile ->> 'kind', kind),
    is_supplier = v_supplier, is_buyer = v_buyer,
    roles_delegated = coalesce((p_profile ->> 'roles_delegated')::boolean, roles_delegated),
    tagline = left(btrim(coalesce(p_profile ->> 'tagline', tagline)), 160),
    address = left(btrim(coalesce(p_profile ->> 'address', address)), 300),
    phone = left(btrim(coalesce(p_profile ->> 'phone', phone)), 60),
    email = left(btrim(coalesce(p_profile ->> 'email', email)), 160),
    tax_id = left(btrim(coalesce(p_profile ->> 'tax_id', tax_id)), 60),
    rib = left(btrim(coalesce(p_profile ->> 'rib', rib)), 80),
    owner_email = coalesce(v_owner, owner_email),
    updated_at = now()
  where id = v_org;
  if not found then
    raise exception using errcode = 'P0002', message = 'Pro introuvable.';
  end if;
  perform public.org_install_roles(v_org);
  if v_supplier and exists (select 1 from public.organizations where id = v_org and status = 'active') then
    perform public.org_install_numbering(v_org);
  end if;
  if v_user is not null then
    perform public.attach_org_owner(v_org, v_user);
  end if;
  return v_org;
end;
$$;
REVOKE ALL ON FUNCTION public.platform_save_pro(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_save_pro(uuid, jsonb) TO authenticated;

-- Sign-up with the e-mail Appro+ named: the account joins its Pro as Responsable.
create or replace function public.profiles_attach_named_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if new.org_id is null and new.client_id is null and new.role <> 'platform' then
    select o.id into v_org from public.organizations o join auth.users u on lower(u.email) = o.owner_email
    where u.id = new.id order by o.created_at limit 1;
    if v_org is not null then
      perform public.attach_org_owner(v_org, new.id);
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists profiles_attach_named_owner on public.profiles;
create trigger profiles_attach_named_owner after insert on public.profiles for each row execute function public.profiles_attach_named_owner();

-- Full card of a Pro for Appro+.
create or replace function public.platform_pro(p_org_id uuid)
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
  return (select to_jsonb(o) || jsonb_build_object(
      'members', (select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'email', u.email, 'full_name', pr.full_name,
                    'status', pr.account_status, 'role', pr.role) order by pr.role = 'admin' desc, u.email), '[]'::jsonb)
                  from public.profiles pr left join auth.users u on u.id = pr.id where pr.org_id = o.id),
      'clients', (select count(*) from public.clients c where c.supplier_org_id = o.id),
      'suppliers', (select count(*) from public.clients c where c.buyer_org_id = o.id),
      'products', (select count(*) from public.products p where p.org_id = o.id))
    from public.organizations o where o.id = p_org_id);
end;
$$;
REVOKE ALL ON FUNCTION public.platform_pro(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_pro(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Platform settings belong to the Appro+ super-admin: modules, role templates, e-mail
-- service and alert events, every account of the platform.
-- ---------------------------------------------------------------------------
create or replace function public.is_legacy_admin() returns boolean language sql stable security definer set search_path = ''
as $$ select public.platform_role() = 'superadmin' or (public.is_admin() and public.current_org_id() = public.legacy_org_id()); $$;

-- What a role template allows (every Pro role following it changes with it).
create or replace function public.platform_set_template_permission(p_template_key text, p_permission text, p_allowed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template public.role_templates%rowtype;
begin
  if public.platform_role() is distinct from 'superadmin' then
    raise exception using errcode = '42501', message = 'Seul le super-admin modifie les modèles de rôles.';
  end if;
  select * into v_template from public.role_templates where key = p_template_key;
  if v_template.id is null then
    raise exception using errcode = 'P0002', message = 'Modèle introuvable.';
  end if;
  if not exists (select 1 from public.permissions p where p.key = p_permission and p.side = v_template.side) then
    raise exception using errcode = '22023', message = 'Ce droit ne concerne pas ce modèle.';
  end if;
  if p_allowed then
    insert into public.role_template_permissions (template_id, permission) values (v_template.id, p_permission) on conflict do nothing;
  else
    delete from public.role_template_permissions where template_id = v_template.id and permission = p_permission;
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.platform_set_template_permission(text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_template_permission(text, text, boolean) TO authenticated;

create or replace function public.platform_templates()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.platform_role() is null then null else jsonb_build_object(
    'permissions', (select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'side', p.side, 'module', public.feature_module(p.key)) order by p.side, p.key), '[]'::jsonb) from public.permissions p),
    'templates', (select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'name', t.name, 'side', t.side, 'description', t.description,
        'granted', (select coalesce(jsonb_agg(tp.permission order by tp.permission), '[]'::jsonb) from public.role_template_permissions tp where tp.template_id = t.id),
        'roles', (select count(*) from public.org_roles r where r.template_id = t.id)
      ) order by t.sort_order), '[]'::jsonb) from public.role_templates t)) end;
$$;
REVOKE ALL ON FUNCTION public.platform_templates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_templates() TO authenticated;

-- Every account of the platform (search), with its Pro.
create or replace function public.platform_accounts(p_search text default null)
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
  return coalesce((
    select jsonb_agg(x order by (x ->> 'status') = 'pending' desc, x ->> 'email') from (
      select jsonb_build_object('id', u.id, 'email', u.email, 'full_name', coalesce(pr.full_name, ''), 'role', pr.role,
        'status', pr.account_status, 'org_id', o.id, 'org_name', coalesce(o.name, c.business_name), 'org_kind', o.kind,
        'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at) as x
      from auth.users u left join public.profiles pr on pr.id = u.id
      left join public.organizations o on o.id = pr.org_id left join public.clients c on c.id = pr.client_id
      where p_search is null or btrim(p_search) = ''
         or lower(u.email || ' ' || coalesce(pr.full_name, '') || ' ' || coalesce(o.name, '') || ' ' || coalesce(c.business_name, '')) like '%' || lower(btrim(p_search)) || '%'
      order by u.created_at desc limit 300) s
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.platform_accounts(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_accounts(text) TO authenticated;

create or replace function public.platform_set_account_status(p_user_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas de modifier un compte.';
  end if;
  if p_user_id = auth.uid() then
    raise exception using errcode = '22023', message = 'Vous ne pouvez pas modifier votre propre compte ici.';
  end if;
  if p_status not in ('active', 'suspended', 'pending', 'refused') then
    raise exception using errcode = '22023', message = 'Statut inconnu.';
  end if;
  update public.profiles set account_status = p_status where id = p_user_id and role <> 'platform';
  if not found then
    raise exception using errcode = 'P0002', message = 'Compte introuvable (les comptes Appro+ se gèrent dans Équipe Appro+).';
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.platform_set_account_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_account_status(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Who handles a new account — no confusion between Appro+ and a Pro:
--   * linked to a client record (same e-mail): that supplier validates it;
--   * named Responsable of a Pro by Appro+: joins that Pro;
--   * anything else (free sign-up): Appro+ only.
-- ---------------------------------------------------------------------------
create or replace function public.alert_on_new_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_supplier uuid;
begin
  if new.account_status = 'pending' then
    select u.email into v_email from auth.users u where u.id = new.id;
    v_supplier := public.client_org(new.client_id);
    if v_supplier is not null then
      perform public.notify(array(select pr.id from public.profiles pr
          where pr.org_id = v_supplier and pr.role = 'admin' and pr.account_status = 'active'),
        'account.pending', 'Nouveau compte client à valider', format('%s attend votre validation (Admin → Comptes).', coalesce(v_email, 'Un client')));
    elsif new.org_id is null then
      perform public.notify(array(select pm.user_id from public.platform_members pm
          where pm.active and pm.role in ('superadmin', 'verification', 'account_manager')),
        'account.pending', 'Nouvelle inscription', format('%s vient de s’inscrire (Appro+ → Paramétrage → Comptes).', coalesce(v_email, 'Un utilisateur')));
    end if;
  end if;
  return new;
end;
$$;

-- A Pro's accounts list: its team and its clients' accounts only (free sign-ups are Appro+'s).
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.admin_list_accounts()'::regprocedure);
BEGIN
  v_def := replace(v_def, '
           or (pr.org_id is null and pr.client_id is null and public.acting_supplier_org_id() = public.legacy_org_id())', '');
  EXECUTE v_def;
END;
$$;

-- A Pro's Responsable may take a free account only to add it to its own team (not validate it).
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
  if v_acting is null
     or not (coalesce(old.org_id = v_acting, false) or coalesce(public.client_org(old.client_id) = v_acting, false)
             or (old.org_id is null and old.client_id is null and old.role <> 'platform' and coalesce(new.org_id = v_acting, false)))
     or not (new.org_id is null or coalesce(new.org_id = v_acting, false) or coalesce(public.client_org(new.client_id) = v_acting, false)) then
    raise exception using errcode = '42501', message = 'Ce compte n’est pas rattaché à votre Pro : sa validation revient à Appro+.';
  end if;
  return new;
end;
$$;
