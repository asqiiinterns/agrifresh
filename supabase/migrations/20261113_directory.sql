-- Directory of validated Pros and links between them.
--   * every active Pro finds validated Pros: a supplier looks for clients, a buyer for suppliers;
--   * a link is asked by one side and accepted (or refused) by the other; once accepted it is the
--     supplier's client record (options by default, a delivery point from the buyer's address);
--   * a buyer may close itself to new suppliers;
--   * a buyer with several suppliers chooses which one it works with (switch_supplier);
--   * a buyer-only Pro's people are client accounts; its Responsable still manages its roles.
-- Run in Supabase SQL Editor AFTER 20261112_pro_onboarding.sql. Safe to rerun.

alter table public.organizations add column if not exists open_to_new boolean not null default true;
alter table public.clients add column if not exists link_status text not null default 'active'
  check (link_status in ('active', 'requested_by_supplier', 'requested_by_buyer', 'refused'));
alter table public.clients add column if not exists link_requested_at timestamptz;

-- The guard of 20261111 lets these functions write the other side's link (and nothing else).
create or replace function public.org_write_guard_bypassed()
returns boolean language sql stable set search_path = ''
as $$ select coalesce(current_setting('appro.link_write', true), '') = 'on'; $$;

DO $$
DECLARE
  v_def text := pg_get_functiondef('public.org_write_guard()'::regprocedure);
BEGIN
  IF v_def not like '%org_write_guard_bypassed%' THEN
    EXECUTE replace(v_def, 'if (select auth.uid()) is null then', 'if (select auth.uid()) is null or public.org_write_guard_bypassed() then');
  END IF;
END;
$$;

DO $$
DECLARE
  v_def text := pg_get_functiondef('public.profiles_org_guard()'::regprocedure);
BEGIN
  IF v_def not like '%org_write_guard_bypassed%' THEN
    EXECUTE replace(v_def, 'if (select auth.uid()) is null or new.id', 'if (select auth.uid()) is null or public.org_write_guard_bypassed() or new.id');
  END IF;
END;
$$;

-- The Responsable of a Pro = holder of its Responsable role (also for buyer-only Pros, whose
-- people have client accounts).
create or replace function public.is_org_owner(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.member_roles mr join public.org_roles r on r.id = mr.role_id
    join public.role_templates t on t.id = r.template_id
    where mr.user_id = (select auth.uid()) and r.org_id = p_org_id and t.key in ('supplier_owner', 'buyer_owner'))
    and public.current_org_id() = p_org_id;
$$;
REVOKE ALL ON FUNCTION public.is_org_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_owner(uuid) TO authenticated;

create or replace function public.can_manage_org_roles(p_org_id uuid, p_edit boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.platform_can('platform.pros.manage')
      or (not p_edit and public.platform_can('platform.roles.assign'))
      or ((public.is_admin() or public.is_org_owner(p_org_id)) and public.current_org_id() = p_org_id
          and (not p_edit or exists (select 1 from public.organizations o where o.id = p_org_id and o.roles_delegated)));
$$;

-- A buyer-only Pro's Responsable is a client account (it buys); a supplier's stays "admin".
create or replace function public.attach_org_owner(p_org_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations%rowtype;
begin
  select * into v_org from public.organizations where id = p_org_id;
  update public.profiles set org_id = p_org_id, role = case when v_org.is_supplier then 'admin' else 'customer' end::public.app_role, client_id = null,
    account_status = case when v_org.status = 'active' then 'active' else 'pending' end
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

DO $$
DECLARE
  v_def text := pg_get_functiondef('public.register_pro(jsonb)'::regprocedure);
BEGIN
  IF v_def like '%set org_id = v_org, role = ''admin'', account_status = ''pending''%' THEN
    EXECUTE replace(v_def, 'set org_id = v_org, role = ''admin'', account_status = ''pending''',
      'set org_id = v_org, role = (case when v_supplier then ''admin'' else ''customer'' end)::public.app_role, account_status = ''pending''');
  END IF;
END;
$$;

-- Buyer-only Pros already created with an "admin" Responsable become client accounts.
update public.profiles pr set role = 'customer'
from public.organizations o
where o.id = pr.org_id and pr.role = 'admin' and not o.is_supplier and o.is_buyer and not o.legacy;

-- ---------------------------------------------------------------------------
-- Directory and links
-- ---------------------------------------------------------------------------
-- p_looking_for: 'clients' (I am a supplier) or 'suppliers' (I am a buyer).
create or replace function public.pro_directory(p_looking_for text, p_search text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.organizations%rowtype;
begin
  select * into v_me from public.organizations where id = public.current_org_id();
  if v_me.id is null then
    raise exception using errcode = '42501', message = 'Réservé aux Pros actifs.';
  end if;
  if (p_looking_for = 'clients' and not v_me.is_supplier) or (p_looking_for = 'suppliers' and not v_me.is_buyer) then
    raise exception using errcode = '22023', message = 'Votre Pro n’a pas cette activité.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'name', o.name, 'kind', o.kind, 'is_supplier', o.is_supplier, 'is_buyer', o.is_buyer,
      'address', o.address, 'tagline', o.tagline, 'open_to_new', o.open_to_new,
      'link', (select jsonb_build_object('id', c.id, 'status', c.link_status)
               from public.clients c
               where (p_looking_for = 'clients' and c.supplier_org_id = v_me.id and c.buyer_org_id = o.id)
                  or (p_looking_for = 'suppliers' and c.supplier_org_id = o.id and c.buyer_org_id = v_me.id)
               limit 1)
    ) order by o.name)
    from public.organizations o
    where o.status = 'active' and o.id <> v_me.id
      and ((p_looking_for = 'clients' and o.is_buyer) or (p_looking_for = 'suppliers' and o.is_supplier and o.kind = 'business'))
      and (p_search is null or btrim(p_search) = '' or lower(o.name || ' ' || o.address || ' ' || o.tagline) like '%' || lower(btrim(p_search)) || '%')
    limit 200
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.pro_directory(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pro_directory(text, text) TO authenticated;

-- Asks for a link with another validated Pro. As a supplier: "be my client"; as a buyer:
-- "be my supplier" (refused when the supplier is unknown or the buyer is closed to new ones).
create or replace function public.pro_link_request(p_other_org_id uuid, p_as text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.organizations%rowtype;
  v_other public.organizations%rowtype;
  v_supplier uuid;
  v_buyer uuid;
  v_id uuid;
begin
  if not (public.is_admin() or public.is_org_owner(public.current_org_id())) then
    raise exception using errcode = '42501', message = 'Seul le Responsable du Pro peut demander une mise en relation.';
  end if;
  select * into v_me from public.organizations where id = public.current_org_id();
  select * into v_other from public.organizations where id = p_other_org_id and status = 'active';
  if v_other.id is null or v_other.id = v_me.id then
    raise exception using errcode = 'P0002', message = 'Ce Pro n’est pas disponible dans l’annuaire.';
  end if;
  if p_as = 'supplier' then
    if not v_me.is_supplier or not v_other.is_buyer then
      raise exception using errcode = '22023', message = 'Ce Pro ne peut pas devenir votre client.';
    end if;
    if not v_other.open_to_new then
      raise exception using errcode = '22023', message = 'Ce Pro ne souhaite pas de nouveau fournisseur pour l’instant.';
    end if;
    v_supplier := v_me.id; v_buyer := v_other.id;
  elsif p_as = 'buyer' then
    if not v_me.is_buyer or not v_other.is_supplier then
      raise exception using errcode = '22023', message = 'Ce Pro ne peut pas devenir votre fournisseur.';
    end if;
    v_supplier := v_other.id; v_buyer := v_me.id;
  else
    raise exception using errcode = '22023', message = 'Précisez si vous êtes fournisseur ou acheteur.';
  end if;
  select c.id into v_id from public.clients c where c.supplier_org_id = v_supplier and c.buyer_org_id = v_buyer;
  if v_id is not null then
    update public.clients set link_status = case when link_status = 'refused' then
        (case when p_as = 'supplier' then 'requested_by_supplier' else 'requested_by_buyer' end) else link_status end,
      link_requested_at = now()
    where id = v_id and link_status = 'refused';
    return v_id;
  end if;
  perform set_config('appro.link_write', 'on', true);
  insert into public.clients (business_name, contact_name, phone, supplier_org_id, buyer_org_id, active, link_status, link_requested_at)
  values ((select o.name from public.organizations o where o.id = v_buyer), '', (select o.phone from public.organizations o where o.id = v_buyer),
          v_supplier, v_buyer, false, case when p_as = 'supplier' then 'requested_by_supplier' else 'requested_by_buyer' end, now())
  returning id into v_id;
  perform set_config('appro.link_write', 'off', true);
  -- The other side's Responsable(s) are told.
  perform public.notify(array(select mr.user_id from public.member_roles mr join public.org_roles r on r.id = mr.role_id
      join public.role_templates t on t.id = r.template_id
      where r.org_id = v_other.id and t.key in ('supplier_owner', 'buyer_owner')),
    'link.request', 'Demande de mise en relation',
    format('%s souhaite %s.', v_me.name, case when p_as = 'supplier' then 'devenir votre fournisseur' else 'devenir votre client' end));
  return v_id;
end;
$$;
REVOKE ALL ON FUNCTION public.pro_link_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pro_link_request(uuid, text) TO authenticated;

-- Accepts or refuses a request made by the other side. Accepted: the record becomes active,
-- with a delivery point from the buyer's address, and the buyer's accounts can order.
create or replace function public.pro_link_respond(p_client_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.clients%rowtype;
  v_org uuid := public.current_org_id();
  v_buyer public.organizations%rowtype;
begin
  if not (public.is_admin() or public.is_org_owner(v_org)) then
    raise exception using errcode = '42501', message = 'Seul le Responsable du Pro peut répondre.';
  end if;
  select * into v_link from public.clients where id = p_client_id;
  if v_link.id is null
     or not ((v_link.link_status = 'requested_by_supplier' and v_link.buyer_org_id = v_org)
          or (v_link.link_status = 'requested_by_buyer' and v_link.supplier_org_id = v_org)) then
    raise exception using errcode = 'P0002', message = 'Aucune demande en attente de votre réponse.';
  end if;
  perform set_config('appro.link_write', 'on', true);
  if p_accept then
    update public.clients set link_status = 'active', active = true where id = p_client_id;
    select * into v_buyer from public.organizations where id = v_link.buyer_org_id;
    if not exists (select 1 from public.client_delivery_points dp where dp.client_id = p_client_id and dp.active) then
      insert into public.client_delivery_points (client_id, label, address_line, city, phone)
      values (p_client_id, 'Principal', coalesce(nullif(btrim(v_buyer.address), ''), 'Adresse à préciser'), 'À préciser', v_buyer.phone);
    end if;
    -- The buyer's people who work with no supplier yet start with this one.
    update public.profiles set client_id = p_client_id
    where org_id = v_link.buyer_org_id and role = 'customer' and client_id is null;
  else
    update public.clients set link_status = 'refused', active = false where id = p_client_id;
  end if;
  perform set_config('appro.link_write', 'off', true);
end;
$$;
REVOKE ALL ON FUNCTION public.pro_link_respond(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pro_link_respond(uuid, boolean) TO authenticated;

-- My links: clients (as a supplier) and suppliers (as a buyer), with what waits for an answer.
create or replace function public.my_links()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'org', (select jsonb_build_object('id', o.id, 'name', o.name, 'is_supplier', o.is_supplier, 'is_buyer', o.is_buyer, 'open_to_new', o.open_to_new)
            from public.organizations o where o.id = public.current_org_id()),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('client_id', c.id, 'org_id', s.id, 'name', s.name, 'status', c.link_status,
                  'to_answer', c.link_status = 'requested_by_supplier') order by s.name)
                from public.clients c join public.organizations s on s.id = c.supplier_org_id
                where c.buyer_org_id = public.current_org_id() and c.link_status <> 'refused'), '[]'::jsonb),
    'clients', coalesce((select jsonb_agg(jsonb_build_object('client_id', c.id, 'org_id', b.id, 'name', b.name, 'status', c.link_status,
                  'to_answer', c.link_status = 'requested_by_buyer') order by b.name)
                from public.clients c join public.organizations b on b.id = c.buyer_org_id
                where c.supplier_org_id = public.current_org_id() and c.link_status <> 'refused'), '[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.my_links() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_links() TO authenticated;

create or replace function public.set_open_to_new(p_open boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (public.is_admin() or public.is_org_owner(public.current_org_id())) then
    raise exception using errcode = '42501', message = 'Seul le Responsable du Pro peut changer ce réglage.';
  end if;
  update public.organizations set open_to_new = coalesce(p_open, true), updated_at = now() where id = public.current_org_id();
end;
$$;
REVOKE ALL ON FUNCTION public.set_open_to_new(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_open_to_new(boolean) TO authenticated;

-- A buyer with several suppliers chooses which one it works with now.
create or replace function public.switch_supplier(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.clients c join public.profiles pr on pr.id = auth.uid()
                 where c.id = p_client_id and c.buyer_org_id = pr.org_id and c.link_status = 'active' and c.active and pr.role = 'customer') then
    raise exception using errcode = '42501', message = 'Ce fournisseur n’est pas lié à votre Pro.';
  end if;
  update public.profiles set client_id = p_client_id where id = auth.uid();
end;
$$;
REVOKE ALL ON FUNCTION public.switch_supplier(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switch_supplier(uuid) TO authenticated;

create or replace function public.my_suppliers()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('client_id', c.id, 'name', s.name, 'current', c.id = pr.client_id) order by s.name), '[]'::jsonb)
  from public.profiles pr
  join public.clients c on c.buyer_org_id = pr.org_id and c.link_status = 'active' and c.active
  join public.organizations s on s.id = c.supplier_org_id and s.status = 'active'
  where pr.id = (select auth.uid()) and pr.role = 'customer';
$$;
REVOKE ALL ON FUNCTION public.my_suppliers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_suppliers() TO authenticated;

-- A supplier never creates a client record itself: every Pro is created by its owner (sign-up)
-- or by Appro+, validated by Appro+, and only then chosen in the directory.
create or replace function public.clients_only_by_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or public.org_write_guard_bypassed() or public.platform_role() is not null then
    return new;
  end if;
  raise exception using errcode = '42501', message = 'Les clients se choisissent dans l’annuaire des Pros validés (Réseau).';
end;
$$;
drop trigger if exists a_clients_only_by_link on public.clients;
create trigger a_clients_only_by_link before insert on public.clients for each row execute function public.clients_only_by_link();

-- ---------------------------------------------------------------------------
-- A Pro's Responsable builds its team and sets their functions, within the frame Appro+ gave:
-- the Responsable role (set by Appro+) is the ceiling; a Pro never edits its Responsable role.
-- ---------------------------------------------------------------------------
create or replace function public.org_owner_ceiling(p_org_id uuid, p_side text, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.org_roles r join public.role_templates t on t.id = r.template_id
    where r.org_id = p_org_id and r.side = p_side and t.key in ('supplier_owner', 'buyer_owner') and public.role_grants(r.id, p_permission));
$$;
REVOKE ALL ON FUNCTION public.org_owner_ceiling(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- The Responsable edits its roles (no delegation needed any more), Appro+ edits everything.
create or replace function public.can_manage_org_roles(p_org_id uuid, p_edit boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.platform_can('platform.pros.manage')
      or (not p_edit and public.platform_can('platform.roles.assign'))
      or ((public.is_admin() or public.is_org_owner(p_org_id)) and public.current_org_id() = p_org_id);
$$;

create or replace function public.org_set_role_permission(p_role_id uuid, p_permission text, p_allowed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.org_roles%rowtype;
  v_template boolean;
  v_platform boolean := public.platform_can('platform.pros.manage');
begin
  select * into v_role from public.org_roles where id = p_role_id;
  if v_role.id is null or not public.can_manage_org_roles(v_role.org_id, true) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas modifier ce rôle.';
  end if;
  if not exists (select 1 from public.permissions p where p.key = p_permission and p.side = v_role.side) then
    raise exception using errcode = '22023', message = 'Ce droit ne concerne pas ce rôle.';
  end if;
  if not v_platform then
    if exists (select 1 from public.role_templates t where t.id = v_role.template_id and t.key in ('supplier_owner', 'buyer_owner')) then
      raise exception using errcode = '42501', message = 'Le rôle de Responsable est réglé par Appro+.';
    end if;
    if coalesce(p_allowed, false) and not public.org_owner_ceiling(v_role.org_id, v_role.side, p_permission) then
      raise exception using errcode = '42501', message = 'Ce droit dépasse ce qu’Appro+ a ouvert à votre Pro.';
    end if;
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

-- What a role finally gives is also capped by the ceiling (a template right Appro+ did not open
-- to this Pro stays closed).
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
            where r.id = p_role_id and tp.permission = p_permission))
    and (exists (select 1 from public.org_roles r join public.role_templates t on t.id = r.template_id
                 where r.id = p_role_id and t.key in ('supplier_owner', 'buyer_owner'))
         or not exists (select 1 from public.org_roles r join public.org_roles o on o.org_id = r.org_id and o.side = r.side
                        join public.role_templates ot on ot.id = o.template_id and ot.key in ('supplier_owner', 'buyer_owner')
                        where r.id = p_role_id)
         or exists (select 1 from public.org_roles r join public.org_roles o on o.org_id = r.org_id and o.side = r.side
                    join public.role_templates ot on ot.id = o.template_id and ot.key in ('supplier_owner', 'buyer_owner')
                    left join public.org_role_overrides oo on oo.role_id = o.id and oo.permission = p_permission
                    where r.id = p_role_id
                      and coalesce(oo.allowed, exists (select 1 from public.role_template_permissions tp where tp.template_id = o.template_id and tp.permission = p_permission))));
$$;

-- Adds a collaborator (an account created by its owner, not attached to any Pro) with a role.
create or replace function public.org_add_member(p_email text, p_role_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.org_roles%rowtype;
  v_user uuid;
  v_profile public.profiles%rowtype;
  v_template text;
begin
  select * into v_role from public.org_roles where id = p_role_id;
  if v_role.id is null or not public.can_manage_org_roles(v_role.org_id, false) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas ajouter de collaborateur à ce Pro.';
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(p_email));
  if v_user is null then
    raise exception using errcode = 'P0002', message = 'Aucun compte avec cet e-mail : la personne doit d’abord créer son compte.';
  end if;
  select * into v_profile from public.profiles where id = v_user;
  if v_profile.role = 'platform' or v_profile.client_id is not null or (v_profile.org_id is not null and v_profile.org_id <> v_role.org_id) then
    raise exception using errcode = '22023', message = 'Ce compte appartient déjà à un autre Pro ou à l’équipe Appro+.';
  end if;
  select t.key into v_template from public.role_templates t where t.id = v_role.template_id;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set org_id = v_role.org_id,
    role = (case when v_role.side = 'buyer' then 'customer'
                 when v_template = 'supplier_owner' then 'admin' when v_template = 'supplier_production' then 'production'
                 when v_template = 'supplier_driver' then 'driver' else 'supervisor' end)::public.app_role
  where id = v_user;
  -- Only the chosen role (the automatic one of the profile is removed).
  delete from public.member_roles where user_id = v_user and role_id <> p_role_id
    and role_id in (select r.id from public.org_roles r where r.org_id = v_role.org_id);
  insert into public.member_roles (user_id, role_id) values (v_user, p_role_id) on conflict do nothing;
  -- A buyer collaborator works with the Pro's first active supplier.
  if v_role.side = 'buyer' then
    update public.profiles set client_id = (select c.id from public.clients c where c.buyer_org_id = v_role.org_id and c.link_status = 'active' and c.active order by c.created_at limit 1)
    where id = v_user and client_id is null;
  end if;
  perform set_config('appro.link_write', 'off', true);
  return v_user;
end;
$$;
REVOKE ALL ON FUNCTION public.org_add_member(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_add_member(text, uuid) TO authenticated;

-- Removes a collaborator from the team (the account stays, attached to no Pro).
create or replace function public.org_remove_member(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select pr.org_id from public.profiles pr where pr.id = p_user_id);
begin
  if v_org is null or not public.can_manage_org_roles(v_org, false) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas retirer ce compte.';
  end if;
  if p_user_id = auth.uid() then
    raise exception using errcode = '22023', message = 'Vous ne pouvez pas vous retirer vous-même.';
  end if;
  if exists (select 1 from public.member_roles mr join public.org_roles r on r.id = mr.role_id join public.role_templates t on t.id = r.template_id
             where mr.user_id = p_user_id and t.key in ('supplier_owner', 'buyer_owner'))
     and not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Un Responsable ne peut être retiré que par Appro+.';
  end if;
  perform set_config('appro.link_write', 'on', true);
  delete from public.member_roles where user_id = p_user_id and role_id in (select r.id from public.org_roles r where r.org_id = v_org);
  update public.profiles set org_id = null, client_id = null, role = 'customer' where id = p_user_id;
  delete from public.pro_memberships where user_id = p_user_id and org_id = v_org;
  perform set_config('appro.link_write', 'off', true);
end;
$$;
REVOKE ALL ON FUNCTION public.org_remove_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_remove_member(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Spaces: one account may work in several Pros, and as a supplier or a buyer. Each space is a
-- membership (Pro + mode); the account chooses its space, and menus, rights and visible data
-- follow it (the profile carries the current space).
-- ---------------------------------------------------------------------------
create table if not exists public.pro_memberships (
  user_id uuid not null references public.profiles(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  mode text not null check (mode in ('supplier', 'buyer')),
  role public.app_role not null,
  client_id uuid references public.clients(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, org_id, mode)
);
alter table public.pro_memberships enable row level security;
GRANT SELECT ON public.pro_memberships TO authenticated;
drop policy if exists "pro_memberships_own" on public.pro_memberships;
create policy "pro_memberships_own" on public.pro_memberships for select to authenticated using (user_id = (select auth.uid()));

-- The current space is always one of the account's spaces.
create or replace function public.profiles_track_space()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is not null and new.role <> 'platform' then
    insert into public.pro_memberships (user_id, org_id, mode, role, client_id)
    values (new.id, new.org_id, case when new.role = 'customer' then 'buyer' else 'supplier' end, new.role, new.client_id)
    on conflict (user_id, org_id, mode) do update set role = excluded.role, client_id = coalesce(excluded.client_id, public.pro_memberships.client_id);
  end if;
  return null;
end;
$$;
drop trigger if exists profiles_track_space on public.profiles;
create trigger profiles_track_space after insert or update of org_id, role, client_id on public.profiles
  for each row execute function public.profiles_track_space();

insert into public.pro_memberships (user_id, org_id, mode, role, client_id)
select pr.id, pr.org_id, case when pr.role = 'customer' then 'buyer' else 'supplier' end, pr.role, pr.client_id
from public.profiles pr where pr.org_id is not null and pr.role <> 'platform'
on conflict do nothing;

-- The Responsable of a Pro that both sells and buys has both spaces.
insert into public.pro_memberships (user_id, org_id, mode, role)
select mr.user_id, r.org_id, 'buyer', 'customer'
from public.member_roles mr join public.org_roles r on r.id = mr.role_id join public.role_templates t on t.id = r.template_id
join public.organizations o on o.id = r.org_id
where t.key = 'buyer_owner' and o.is_supplier and o.is_buyer
on conflict do nothing;

create or replace function public.my_spaces()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('org_id', m.org_id, 'org_name', o.name, 'mode', m.mode, 'status', o.status,
      'current', m.org_id = pr.org_id and m.mode = case when pr.role = 'customer' then 'buyer' else 'supplier' end)
    order by o.name, m.mode desc), '[]'::jsonb)
  from public.pro_memberships m join public.organizations o on o.id = m.org_id
  join public.profiles pr on pr.id = m.user_id
  where m.user_id = (select auth.uid());
$$;
REVOKE ALL ON FUNCTION public.my_spaces() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_spaces() TO authenticated;

create or replace function public.switch_space(p_org_id uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_space public.pro_memberships%rowtype;
begin
  select * into v_space from public.pro_memberships where user_id = auth.uid() and org_id = p_org_id and mode = p_mode;
  if v_space.user_id is null then
    raise exception using errcode = '42501', message = 'Cet espace n’est pas le vôtre.';
  end if;
  if v_space.mode = 'buyer' and v_space.client_id is null then
    v_space.client_id := (select c.id from public.clients c where c.buyer_org_id = p_org_id and c.link_status = 'active' and c.active order by c.created_at limit 1);
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set org_id = v_space.org_id, role = v_space.role, client_id = case when v_space.mode = 'buyer' then v_space.client_id end
  where id = auth.uid();
  perform set_config('appro.link_write', 'off', true);
end;
$$;
REVOKE ALL ON FUNCTION public.switch_space(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switch_space(uuid, text) TO authenticated;

-- Rights follow the current space: the roles of the current Pro, for the current side.
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
          where mr.user_id = pr.id and r.org_id = pr.org_id and (mr.valid_until is null or mr.valid_until > now())
            and r.side = case when pr.role = 'customer' then 'buyer' else 'supplier' end),
        false) end
    from public.profiles pr where pr.id = p_user_id), false);
$$;

-- A collaborator who already works elsewhere gets one more space (nothing taken away).
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.org_add_member(text, uuid)'::regprocedure);
BEGIN
  IF v_def not like '%one more space%' THEN
    v_def := replace(v_def,
      'if v_profile.role = ''platform'' or v_profile.client_id is not null or (v_profile.org_id is not null and v_profile.org_id <> v_role.org_id) then
    raise exception using errcode = ''22023'', message = ''Ce compte appartient déjà à un autre Pro ou à l’équipe Appro+.'';
  end if;',
      'if v_profile.role = ''platform'' then
    raise exception using errcode = ''22023'', message = ''Ce compte appartient à l’équipe Appro+.'';
  end if;
  -- one more space: the account already works elsewhere; its current space is not changed.
  if v_profile.org_id is not null and v_profile.org_id <> v_role.org_id then
    insert into public.pro_memberships (user_id, org_id, mode, role)
    values (v_user, v_role.org_id, v_role.side, (case when v_role.side = ''buyer'' then ''customer'' else ''supervisor'' end)::public.app_role)
    on conflict do nothing;
    insert into public.member_roles (user_id, role_id) values (v_user, p_role_id) on conflict do nothing;
    return v_user;
  end if;');
    EXECUTE v_def;
  END IF;
END;
$$;
