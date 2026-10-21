-- Home and bottom menu per role of a Pro (Rôles et accès → a role → Accueil et menu):
--   * the Pro's administrator (or a delegate managing the roles) chooses, for each role, the figures and shortcuts of the
--     home screen and the entries of the bottom bar, when Appro+ includes « Personnaliser l'accueil » in its plan;
--   * Appro+ can always set them for a Pro;
--   * a person sees: its own home if it made one, else the one of its role, else the one of its profile (former setting).
-- Functions redefined whole. Run AFTER 20261130_workflow_steps.sql. Safe to rerun.

create table if not exists public.org_role_layouts (
  role_id uuid primary key references public.org_roles(id) on delete cascade,
  home jsonb,
  menu jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
alter table public.org_role_layouts enable row level security;
drop policy if exists "org_role_layouts_read" on public.org_role_layouts;
create policy "org_role_layouts_read" on public.org_role_layouts for select to authenticated
  using (exists (select 1 from public.org_roles r where r.id = role_id and (r.org_id = public.current_org_id() or public.platform_can('platform.pros.view'))));

-- The layout of the person's roles in its acting Pro: the first role that has one (Responsable last).
create or replace function public.my_role_layout()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('home', l.home, 'menu', l.menu, 'role', r.name)
  from public.member_roles mr
  join public.org_roles r on r.id = mr.role_id and r.org_id = public.current_org_id()
  join public.org_role_layouts l on l.role_id = r.id
  left join public.role_templates t on t.id = r.template_id
  where mr.user_id = (select auth.uid())
  order by coalesce(t.key in ('supplier_owner', 'buyer_owner'), false), r.name
  limit 1;
$$;
REVOKE ALL ON FUNCTION public.my_role_layout() FROM PUBLIC, anon, authenticated;

create or replace function public.org_role_layouts_list(p_org_id uuid default null)
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
  return jsonb_build_object(
    'allowed', public.platform_can('platform.pros.manage') or public.module_enabled_for(v_org, 'home_custom'),
    'layouts', coalesce((select jsonb_agg(jsonb_build_object('role_id', l.role_id, 'home', l.home, 'menu', l.menu))
      from public.org_role_layouts l join public.org_roles r on r.id = l.role_id where r.org_id = v_org), '[]'::jsonb));
end;
$$;
REVOKE ALL ON FUNCTION public.org_role_layouts_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_role_layouts_list(uuid) TO authenticated;

-- p_home / p_menu null: back to the default for that part.
create or replace function public.set_org_role_layout(p_role_id uuid, p_home jsonb, p_menu jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.org_roles%rowtype;
begin
  select * into v_role from public.org_roles where id = p_role_id;
  if v_role.id is null or not public.can_manage_org_roles(v_role.org_id, true) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas modifier ce rôle.';
  end if;
  if not public.platform_can('platform.pros.manage') and not public.module_enabled_for(v_role.org_id, 'home_custom') then
    raise exception using errcode = '42501', message = 'La personnalisation de l’accueil n’est pas incluse dans votre formule : contactez l’équipe Appro+.';
  end if;
  if p_home is not null and (jsonb_typeof(p_home -> 'tiles') is distinct from 'array' or jsonb_typeof(p_home -> 'shortcuts') is distinct from 'array'
      or jsonb_array_length(p_home -> 'tiles') > 30 or jsonb_array_length(p_home -> 'shortcuts') > 40) then
    raise exception using errcode = '22023', message = 'Accueil invalide.';
  end if;
  if p_menu is not null and (jsonb_typeof(p_menu -> 'bar') is distinct from 'array' or jsonb_array_length(p_menu -> 'bar') > 5) then
    raise exception using errcode = '22023', message = 'Cinq entrées au plus dans la barre du bas.';
  end if;
  if p_home is null and p_menu is null then
    delete from public.org_role_layouts where role_id = p_role_id;
  else
    insert into public.org_role_layouts (role_id, home, menu, updated_at, updated_by)
    values (p_role_id, p_home, p_menu, now(), auth.uid())
    on conflict (role_id) do update set home = excluded.home, menu = excluded.menu, updated_at = now(), updated_by = auth.uid();
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.set_org_role_layout(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_org_role_layout(uuid, jsonb, jsonb) TO authenticated;

-- The home of the person's role comes before the former one of its profile; the bottom bar of its role.
CREATE OR REPLACE FUNCTION public.my_account()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'id', pr.id,
    'role', case when public.assisted_org() is not null then 'admin'::public.app_role else pr.role end,
    'full_name', pr.full_name,
    'features', public.my_features(),
    'locked_features', public.my_locked_features(),
    'assisting', (select jsonb_build_object('org_id', a.org_id, 'org_name', o.name, 'can_edit', a.can_edit, 'expires_at', a.expires_at, 'reason', a.reason)
                  from public.platform_assist a join public.organizations o on o.id = a.org_id
                  where a.user_id = pr.id and a.expires_at > now() and public.assisted_org() is not null),
    'disabled', pr.account_status <> 'active',
    'status', pr.account_status,
    'home_layout', coalesce(pr.home_layout, public.my_role_layout() -> 'home', (select hl.layout from public.home_layouts hl
      where hl.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role)),
    'role_home_layout', coalesce(public.my_role_layout() -> 'home', (select hl.layout from public.home_layouts hl
      where hl.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role)),
    -- 20261201: the bottom bar chosen for the person's role (null: the built-in order).
    'menu', public.my_role_layout() -> 'menu',
    'client', case when c.id is null or not c.active or public.assisted_org() is not null then null else jsonb_build_object(
      'id', c.id,
      'client_number', c.client_number,
      'business_name', c.business_name,
      'contact_name', c.contact_name,
      'phone', c.phone,
      'show_prices', c.show_prices,
      'show_origin', (c.show_origin and public.module_enabled_for(c.supplier_org_id, 'origin')),
      'show_stock', (c.show_stock and public.module_enabled_for(c.supplier_org_id, 'stock')),
      'stock_managed', (c.stock_managed and public.module_enabled_for(c.supplier_org_id, 'stock')),
      'reception_qr', (c.reception_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')) and (c.scan_client_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')),
      'reception_token', case when (c.reception_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')) and (c.scan_client_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')) then c.reception_token end,
      'history_enabled', c.history_enabled, 'delivery_note', c.delivery_note_client,
      'payment_reminders', (c.payment_reminders and public.module_enabled_for(c.supplier_org_id, 'reminders')),
      'reminder_opt_out_allowed', c.reminder_opt_out_allowed,
      'reminder_opt_out', c.reminder_opt_out,
      'delivery_points', coalesce((
        select jsonb_agg(jsonb_build_object('id', dp.id, 'label', dp.label, 'address_line', dp.address_line, 'city', dp.city) order by dp.created_at)
        from public.client_delivery_points dp where dp.client_id = c.id and dp.active), '[]'::jsonb)
    ) end
  )
  from public.profiles pr
  left join public.clients c on c.id = pr.client_id
  where pr.id = (select auth.uid());
$function$
;
REVOKE ALL ON FUNCTION public.my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_account() TO authenticated;

notify pgrst, 'reload schema';
