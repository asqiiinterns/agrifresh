-- Pros, step 2b (part 2 of 2): the switch.
--   * rights now come from the roles of the account's Pro (has_permission), with the modules;
--   * the Appro+ team gets the "platform" profile: no supplier or client right at all;
--   * Paramétrage keeps working as before: every change of a profile's or a person's rights is
--     copied into the roles (triggers), so both stay identical;
--   * the Appro+ console reads: the team, the Pros (validate / suspend).
-- Refuses to run while AgriFresh has no Responsable (run scripts/agrifresh_accounts.sql first).
-- Run in Supabase SQL Editor AFTER 20261110_1_platform_profile.sql. Safe to rerun.

DO $$
BEGIN
  IF not exists (
    select 1 from public.member_roles mr join public.org_roles r on r.id = mr.role_id
    join public.role_templates t on t.id = r.template_id
    join public.profiles pr on pr.id = mr.user_id
    where r.org_id = public.legacy_org_id() and t.key = 'supplier_owner' and not mr.transitional and not pr.is_superadmin
  ) THEN
    RAISE EXCEPTION 'AgriFresh n’a pas encore de Responsable : créez admin@agrifresh.tn dans l’application, lancez supabase/scripts/agrifresh_accounts.sql, puis relancez cette migration.';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Paramétrage → roles: profile rights (role_permissions) and personal exceptions
-- (user_permissions) are mirrored into the roles of each Pro.
-- ---------------------------------------------------------------------------
create or replace function public.sync_legacy_role(p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template text := public.legacy_role_template(p_role);
begin
  if v_template is null or p_role in ('admin', 'platform') then
    return;
  end if;
  -- The matching role in the original supplier (team profiles) or in every buyer Pro of its
  -- clients (client profile) stores only what differs from its template.
  delete from public.org_role_overrides o
  using public.org_roles r join public.role_templates t on t.id = r.template_id
  where o.role_id = r.id and t.key = v_template
    and (r.org_id = public.legacy_org_id()
         or r.org_id in (select c.buyer_org_id from public.clients c where c.supplier_org_id = public.legacy_org_id()));
  insert into public.org_role_overrides (role_id, permission, allowed)
  select r.id, p.key, coalesce(rp.allowed, false)
  from public.org_roles r
  join public.role_templates t on t.id = r.template_id and t.key = v_template
  cross join public.permissions p
  left join public.role_permissions rp on rp.role::text = p_role and rp.feature = p.key
  where (r.org_id = public.legacy_org_id()
         or r.org_id in (select c.buyer_org_id from public.clients c where c.supplier_org_id = public.legacy_org_id()))
    and coalesce(rp.allowed, false) <> exists (select 1 from public.role_template_permissions tp where tp.template_id = t.id and tp.permission = p.key);
end;
$$;
REVOKE ALL ON FUNCTION public.sync_legacy_role(text) FROM PUBLIC, anon, authenticated;

create or replace function public.role_permissions_mirror()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.permissions (key, side)
  values (coalesce(new.feature, old.feature), case when coalesce(new.feature, old.feature) like 'client.%' then 'buyer' else 'supplier' end)
  on conflict (key) do nothing;
  perform public.sync_legacy_role(coalesce(new.role, old.role)::text);
  if new.role = 'staff' or old.role = 'staff' then perform public.sync_legacy_role('supervisor'); end if;
  return null;
end;
$$;
drop trigger if exists role_permissions_mirror on public.role_permissions;
create trigger role_permissions_mirror after insert or update or delete on public.role_permissions
  for each row execute function public.role_permissions_mirror();

create or replace function public.user_permissions_mirror()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select pr.org_id from public.profiles pr where pr.id = coalesce(new.user_id, old.user_id));
begin
  if tg_op = 'DELETE' then
    delete from public.member_overrides where user_id = old.user_id and permission = old.feature;
  elsif v_org is not null and exists (select 1 from public.permissions p where p.key = new.feature) then
    insert into public.member_overrides (user_id, org_id, permission, allowed) values (new.user_id, v_org, new.feature, new.allowed)
    on conflict (user_id, org_id, permission) do update set allowed = excluded.allowed;
  end if;
  return null;
end;
$$;
drop trigger if exists user_permissions_mirror on public.user_permissions;
create trigger user_permissions_mirror after insert or update or delete on public.user_permissions
  for each row execute function public.user_permissions_mirror();

-- Catch up with every change made since 20261109.
insert into public.permissions (key, side)
select distinct rp.feature, case when rp.feature like 'client.%' then 'buyer' else 'supplier' end from public.role_permissions rp
on conflict (key) do nothing;
select public.sync_legacy_role(r) from unnest(array['supervisor', 'production', 'driver', 'customer']) as r;
delete from public.member_overrides mo where not exists (select 1 from public.user_permissions up where up.user_id = mo.user_id and up.feature = mo.permission);
insert into public.member_overrides (user_id, org_id, permission, allowed)
select up.user_id, pr.org_id, up.feature, up.allowed from public.user_permissions up join public.profiles pr on pr.id = up.user_id
where pr.org_id is not null and exists (select 1 from public.permissions p where p.key = up.feature)
on conflict (user_id, org_id, permission) do update set allowed = excluded.allowed;

-- ---------------------------------------------------------------------------
-- The Appro+ team: "platform" profile, outside every Pro.
-- ---------------------------------------------------------------------------
update public.profiles pr set role = 'platform', org_id = null, client_id = null, is_superadmin = (pm.role = 'superadmin')
from public.platform_members pm
where pm.user_id = pr.id and (pr.role <> 'platform' or pr.org_id is not null);
delete from public.member_roles where transitional;

-- Rights now come from the roles (the modules still apply on top, see 20261107).
create or replace function public.has_feature_base(p_feature text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_permission(p_feature);
$$;
REVOKE ALL ON FUNCTION public.has_feature_base(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Appro+ console (read and decide; full screens come next).
-- ---------------------------------------------------------------------------
create or replace function public.platform_team()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.platform_role() is null then
    raise exception using errcode = '42501', message = 'Réservé à l’équipe Appro+.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', pm.user_id, 'email', u.email, 'full_name', pr.full_name, 'role', pm.role, 'active', pm.active)
      order by pm.role = 'superadmin' desc, u.email)
    from public.platform_members pm join public.profiles pr on pr.id = pm.user_id left join auth.users u on u.id = pm.user_id
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.platform_team() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_team() TO authenticated;

-- Adds or changes an Appro+ team member (super-admin only). The account must exist and
-- belong to no Pro: Appro+ accounts and Pro accounts are never the same.
create or replace function public.platform_set_member(p_email text, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_profile public.profiles%rowtype;
begin
  if public.platform_role() is distinct from 'superadmin' then
    raise exception using errcode = '42501', message = 'Seul le super-admin gère l’équipe Appro+.';
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(p_email));
  if v_user is null then
    raise exception using errcode = 'P0002', message = 'Aucun compte avec cet e-mail : la personne doit d’abord créer son compte.';
  end if;
  if v_user = auth.uid() then
    raise exception using errcode = '22023', message = 'Vous ne pouvez pas modifier votre propre rôle.';
  end if;
  select * into v_profile from public.profiles where id = v_user;
  if p_role is null then
    delete from public.platform_members where user_id = v_user;
    update public.profiles set role = 'customer', is_superadmin = false, account_status = 'suspended' where id = v_user and role = 'platform';
    return;
  end if;
  if p_role not in ('superadmin', 'support', 'account_manager', 'verification', 'finance', 'viewer') then
    raise exception using errcode = '22023', message = 'Rôle Appro+ inconnu.';
  end if;
  if v_profile.org_id is not null or v_profile.client_id is not null then
    raise exception using errcode = '22023', message = 'Ce compte appartient à un Pro : utilisez une autre adresse pour l’équipe Appro+.';
  end if;
  insert into public.platform_members (user_id, role, invited_by) values (v_user, p_role, auth.uid())
  on conflict (user_id) do update set role = excluded.role, active = true;
  update public.profiles set role = 'platform', is_superadmin = (p_role = 'superadmin'), account_status = 'active' where id = v_user;
end;
$$;
REVOKE ALL ON FUNCTION public.platform_set_member(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_member(text, text) TO authenticated;

create or replace function public.platform_pros()
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
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'name', o.name, 'is_supplier', o.is_supplier, 'is_buyer', o.is_buyer, 'status', o.status,
      'email', o.email, 'phone', o.phone, 'created_at', o.created_at,
      'members', (select count(*) from public.profiles pr where pr.org_id = o.id),
      'clients', (select count(*) from public.clients c where c.supplier_org_id = o.id),
      'suppliers', (select count(*) from public.clients c where c.buyer_org_id = o.id)
    ) order by o.status = 'pending' desc, o.is_supplier desc, o.name)
    from public.organizations o
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.platform_pros() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_pros() TO authenticated;

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
  update public.organizations set status = p_status, updated_at = now() where id = p_org_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Pro introuvable.';
  end if;
  if p_status = 'active' then
    perform public.org_install_roles(p_org_id);
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.platform_set_pro_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_pro_status(uuid, text) TO authenticated;
