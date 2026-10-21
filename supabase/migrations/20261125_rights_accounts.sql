-- Rights per account (the "comptes" matrix): the effective rights of every person of a Pro in one call, and an
-- exception for one person (added or removed function), within the Pro's ceiling and, for a delegate, its own rights.
-- Run AFTER 20261124_rights.sql. Safe to rerun.

create or replace function public.org_members_rights(p_org_id uuid default null)
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
    raise exception using errcode = '42501', message = 'Réservé aux personnes qui gèrent les rôles de ce Pro et à l’équipe Appro+.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', pr.id, 'name', coalesce(nullif(btrim(pr.full_name), ''), u.email), 'email', u.email, 'status', pr.account_status,
      'side', case when pr.role = 'customer' then 'buyer' else 'supplier' end,
      'granted', (select coalesce(jsonb_agg(p.key order by p.key), '[]'::jsonb) from public.permissions p where public.user_has_permission(pr.id, p.key)),
      'overrides', (select coalesce(jsonb_object_agg(mo.permission, mo.allowed), '{}'::jsonb) from public.member_overrides mo where mo.user_id = pr.id and mo.org_id = v_org))
    order by pr.full_name, u.email)
    from public.profiles pr left join auth.users u on u.id = pr.id
    where pr.org_id = v_org and pr.role <> 'platform'), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.org_members_rights(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_members_rights(uuid) TO authenticated;

-- p_allowed null: the person follows its roles again.
create or replace function public.org_set_member_permission(p_user_id uuid, p_permission text, p_allowed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.profiles%rowtype;
  v_side text;
begin
  select * into v_member from public.profiles where id = p_user_id;
  if v_member.id is null or v_member.org_id is null or not public.can_manage_org_roles(v_member.org_id, true) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas modifier les droits de cette personne.';
  end if;
  v_side := case when v_member.role = 'customer' then 'buyer' else 'supplier' end;
  if not exists (select 1 from public.permissions p where p.key = p_permission and p.side = v_side) then
    raise exception using errcode = '22023', message = 'Ce droit ne concerne pas cette personne.';
  end if;
  if not public.platform_can('platform.pros.manage') and coalesce(p_allowed, false) then
    if not public.org_owner_ceiling(v_member.org_id, v_side, p_permission) then
      raise exception using errcode = '42501', message = 'Ce droit dépasse ce qu’Appro+ a ouvert à votre Pro.';
    end if;
    if not (public.is_admin() or public.is_org_owner(v_member.org_id)) and not public.has_feature(p_permission) then
      raise exception using errcode = '42501', message = 'Vous ne pouvez pas donner un droit que vous n’avez pas.';
    end if;
  end if;
  if p_user_id = auth.uid() and not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '22023', message = 'Vos propres droits sont réglés par une autre personne.';
  end if;
  delete from public.member_overrides where user_id = p_user_id and org_id = v_member.org_id and permission = p_permission;
  if p_allowed is not null then
    insert into public.member_overrides (user_id, org_id, permission, allowed) values (p_user_id, v_member.org_id, p_permission, p_allowed);
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.org_set_member_permission(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_set_member_permission(uuid, text, boolean) TO authenticated;

notify pgrst, 'reload schema';
