-- Rights in cascade (Appro+ → administrator of the account → roles → accounts):
--   1. the catalogue of functions: each one in an area, as "lecture" or "modification";
--   2. what an account sees of a function it does not have: hidden (default) or shown locked ("grisé"),
--      set by Appro+ for every Pro (default) and for each Pro;
--   3. delegation: the Responsable gives "Gérer les rôles et les droits" to a role; its members then set the
--      other roles, never beyond their own rights;
--   4. Appro+ assists a Pro ("co-admin"): for a limited time, it sees everything the Pro sees and, when allowed,
--      changes its settings and data like its administrator; the Pro's Responsables are told, every change is
--      in the Pro's journal under the name of the Appro+ person.
-- Functions are redefined whole (see supabase/reference). Run AFTER 20261123_location.sql. Safe to rerun.

-- ---------------------------------------------------------------------------
-- 1. Catalogue of functions
-- ---------------------------------------------------------------------------
alter table public.permissions add column if not exists area text;
alter table public.permissions add column if not exists kind text check (kind in ('read', 'write'));
alter table public.permissions add column if not exists sort int not null default 100;

insert into public.permissions (key, side, label) values
  ('roles.manage', 'supplier', 'Gérer les rôles et les droits des comptes')
on conflict (key) do nothing;

update public.permissions p set area = x.area, kind = x.kind, sort = x.sort, label = case when coalesce(p.label, '') = '' then x.label else p.label end
from (values
  ('home.view', 'Accueil et alertes', 'read', 1, 'Onglet Accueil (tableau de bord)'),
  ('alerts.view', 'Accueil et alertes', 'read', 2, 'Onglet Alertes'),
  ('orders.view', 'Commandes', 'read', 10, 'Voir les commandes'),
  ('orders.delivery_note', 'Commandes', 'read', 11, 'Imprimer les bons de livraison'),
  ('orders.create', 'Commandes', 'write', 12, 'Passer une commande pour un client'),
  ('orders.decide', 'Commandes', 'write', 13, 'Accepter, décliner, mettre en attente, arrêter'),
  ('orders.revert', 'Commandes', 'write', 14, 'Revenir à l’étape précédente'),
  ('orders.plan', 'Commandes', 'write', 15, 'Planifier la file de production'),
  ('production.view', 'Production', 'read', 20, 'Voir la production'),
  ('production.update', 'Production', 'write', 21, 'Commencer et terminer les préparations'),
  ('deliveries', 'Livraison', 'write', 30, 'Livrer (remise au client)'),
  ('orders.ship', 'Livraison', 'write', 31, 'Expédier les commandes préparées'),
  ('fleet.manage', 'Livraison', 'write', 32, 'Gérer la flotte de véhicules'),
  ('clients.view', 'Clients et catalogue', 'read', 40, 'Voir les fiches clients'),
  ('clients.edit', 'Clients et catalogue', 'write', 41, 'Modifier les fiches clients'),
  ('clients.create', 'Clients et catalogue', 'write', 42, 'Créer des clients'),
  ('products.manage', 'Clients et catalogue', 'write', 43, 'Gérer les produits et les tarifs'),
  ('invoices.manage', 'Facturation', 'write', 50, 'Factures, règlements, comptes clients'),
  ('returns.manage', 'Retours et réclamations', 'write', 60, 'Traiter les retours et les avoirs'),
  ('claims.manage', 'Retours et réclamations', 'write', 61, 'Traiter les réclamations'),
  ('messages.manage', 'Messages', 'write', 70, 'Messages avec les clients'),
  ('team.messages', 'Messages', 'write', 71, 'Messages entre collègues'),
  ('calendar.view', 'Équipe', 'read', 80, 'Calendrier et rappels'),
  ('leave.request', 'Équipe', 'write', 81, 'Demander des congés'),
  ('leave.manage', 'Équipe', 'write', 82, 'Valider les congés'),
  ('incidents.report', 'Équipe', 'write', 83, 'Signaler un incident'),
  ('incidents.manage', 'Équipe', 'write', 84, 'Traiter les incidents'),
  ('location.share', 'Équipe', 'write', 85, 'Partager sa position (avec son accord)'),
  ('location.view', 'Équipe', 'read', 86, 'Demander la position des comptes'),
  ('stats.view', 'Pilotage', 'read', 90, 'Statistiques'),
  ('audit.view', 'Pilotage', 'read', 91, 'Journal des actions'),
  ('roles.manage', 'Administration', 'write', 95, 'Gérer les rôles et les droits des comptes'),
  ('client.home', 'Espace client', 'read', 200, 'Accueil'),
  ('client.orders', 'Espace client', 'read', 201, 'Mes commandes'),
  ('client.invoices', 'Espace client', 'read', 202, 'Mes factures'),
  ('client.alerts', 'Espace client', 'read', 203, 'Alertes'),
  ('client.order', 'Espace client', 'write', 204, 'Commander'),
  ('client.messages', 'Espace client', 'write', 205, 'Messages'),
  ('client.claims', 'Espace client', 'write', 206, 'Réclamations'),
  ('client.returns', 'Espace client', 'write', 207, 'Demandes de retour'),
  ('client.recurring', 'Espace client', 'write', 208, 'Commandes récurrentes')
) as x(key, area, kind, sort, label)
where p.key = x.key;
update public.permissions set area = coalesce(area, case when side = 'buyer' then 'Espace client' else 'Autres' end), kind = coalesce(kind, 'write');

-- The Responsable templates hold every function; roles.manage is new.
insert into public.role_template_permissions (template_id, permission)
select t.id, 'roles.manage' from public.role_templates t where t.key = 'supplier_owner'
on conflict do nothing;

create or replace function public.permission_kind(p_permission text)
returns text language sql stable security definer set search_path = ''
as $$ select coalesce((select p.kind from public.permissions p where p.key = p_permission), 'write'); $$;
REVOKE ALL ON FUNCTION public.permission_kind(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Hidden or shown locked (Appro+ decides: for every Pro, then for one Pro)
-- ---------------------------------------------------------------------------
create table if not exists public.feature_display (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  permission text not null references public.permissions(key) on delete cascade,
  display text not null check (display in ('hidden', 'locked'))
);
create unique index if not exists feature_display_scope_idx on public.feature_display(coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), permission);
alter table public.feature_display enable row level security;

create or replace function public.feature_display_of(p_org_id uuid, p_permission text)
returns text language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select d.display from public.feature_display d where d.org_id = p_org_id and d.permission = p_permission),
    (select d.display from public.feature_display d where d.org_id is null and d.permission = p_permission),
    'hidden');
$$;
REVOKE ALL ON FUNCTION public.feature_display_of(uuid, text) FROM PUBLIC, anon, authenticated;

-- The functions I do not have but see locked.
create or replace function public.my_locked_features()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(p.key order by p.sort, p.key), '[]'::jsonb)
  from public.permissions p
  where not public.has_feature(p.key)
    and public.feature_display_of(coalesce(public.current_org_id(), (select pr.org_id from public.profiles pr where pr.id = (select auth.uid()))), p.key) = 'locked';
$$;
REVOKE ALL ON FUNCTION public.my_locked_features() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_locked_features() TO authenticated;

-- p_org_id null: the default for every Pro; p_display null: back to the default.
create or replace function public.platform_set_feature_display(p_org_id uuid, p_permission text, p_display text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas ce réglage.';
  end if;
  if not exists (select 1 from public.permissions p where p.key = p_permission) then
    raise exception using errcode = '22023', message = 'Fonction inconnue.';
  end if;
  if p_display is not null and p_display not in ('hidden', 'locked') then
    raise exception using errcode = '22023', message = 'Affichage inconnu.';
  end if;
  delete from public.feature_display d where d.org_id is not distinct from p_org_id and d.permission = p_permission;
  if p_display is not null then
    insert into public.feature_display (org_id, permission, display) values (p_org_id, p_permission, p_display);
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.platform_set_feature_display(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_feature_display(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4 (first, used below). Appro+ assisting a Pro
-- ---------------------------------------------------------------------------
create table if not exists public.platform_assist (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  can_edit boolean not null default false,
  reason text,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.platform_assist enable row level security;

create or replace function public.assisted_org()
returns uuid language sql stable security definer set search_path = ''
as $$
  select a.org_id from public.platform_assist a
  join public.platform_members pm on pm.user_id = a.user_id and pm.active
  join public.organizations o on o.id = a.org_id and o.status in ('active', 'pending', 'suspended')
  where a.user_id = (select auth.uid()) and a.expires_at > now();
$$;
REVOKE ALL ON FUNCTION public.assisted_org() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assisted_org() TO authenticated;

create or replace function public.assist_can_edit()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select a.can_edit from public.platform_assist a where a.user_id = (select auth.uid()) and a.expires_at > now()), false) and public.assisted_org() is not null; $$;
REVOKE ALL ON FUNCTION public.assist_can_edit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assist_can_edit() TO authenticated;

create or replace function public.platform_start_assist(p_org_id uuid, p_edit boolean default false, p_reason text default null, p_hours int default 2)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations%rowtype;
begin
  if not public.platform_can('platform.support.access') or (coalesce(p_edit, false) and not public.platform_can('platform.pros.manage')) then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas d’assister ce Pro.';
  end if;
  select * into v_org from public.organizations where id = p_org_id;
  if v_org.id is null then
    raise exception using errcode = 'P0002', message = 'Pro introuvable.';
  end if;
  insert into public.platform_assist (user_id, org_id, can_edit, reason, started_at, expires_at)
  values (auth.uid(), p_org_id, coalesce(p_edit, false), nullif(btrim(coalesce(p_reason, '')), ''), now(), now() + make_interval(hours => least(greatest(coalesce(p_hours, 2), 1), 12)))
  on conflict (user_id) do update set org_id = excluded.org_id, can_edit = excluded.can_edit, reason = excluded.reason, started_at = now(), expires_at = excluded.expires_at;
  -- The Pro knows who assists it.
  perform public.notify(array(select mr.user_id from public.member_roles mr join public.org_roles r on r.id = mr.role_id
      join public.role_templates t on t.id = r.template_id where r.org_id = p_org_id and t.key in ('supplier_owner', 'buyer_owner')),
    'platform.assist', 'L’équipe Appro+ assiste votre espace',
    format('%s %s%s.', public.location_name(auth.uid()), case when coalesce(p_edit, false) then 'peut voir et régler votre espace' else 'consulte votre espace' end,
      coalesce(' · ' || nullif(btrim(coalesce(p_reason, '')), ''), '')));
  if to_regclass('public.audit_log') is not null then
    insert into public.audit_log (actor_id, actor_name, actor_role, action, entity, entity_id, label, changes, org_id)
    values (auth.uid(), public.location_name(auth.uid()), 'platform', 'insert', 'platform_assist', p_org_id::text,
            case when coalesce(p_edit, false) then 'Assistance Appro+ (lecture et modification)' else 'Assistance Appro+ (lecture)' end,
            jsonb_build_object('reason', p_reason), p_org_id);
  end if;
  return jsonb_build_object('org_id', p_org_id, 'org_name', v_org.name, 'can_edit', coalesce(p_edit, false));
end;
$$;
REVOKE ALL ON FUNCTION public.platform_start_assist(uuid, boolean, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_start_assist(uuid, boolean, text, int) TO authenticated;

create or replace function public.platform_stop_assist()
returns void language sql security definer set search_path = ''
as $$ delete from public.platform_assist where user_id = (select auth.uid()); $$;
REVOKE ALL ON FUNCTION public.platform_stop_assist() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_stop_assist() TO authenticated;

-- The journal knows in which Pro each change was made (an Appro+ person has no Pro of its own): the assisted
-- Pro sees what Appro+ did in it.
alter table public.audit_log add column if not exists org_id uuid references public.organizations(id) on delete set null;
create or replace function public.audit_fill_org()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.org_id is null then
    new.org_id := public.current_org_id();
  end if;
  return new;
end;
$$;
drop trigger if exists a_audit_fill_org on public.audit_log;
create trigger a_audit_fill_org before insert on public.audit_log for each row execute function public.audit_fill_org();
drop policy if exists "audit_log_read_org" on public.audit_log;
create policy "audit_log_read_org" on public.audit_log for select to authenticated
  using (org_id is not null and public.org_visible(org_id) and (select public.has_feature('audit.view')));

-- The acting Pro and the administrator's rights follow the assistance.
create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = ''
as $$
  select coalesce(public.assisted_org(), (
    select pr.org_id from public.profiles pr join public.organizations o on o.id = pr.org_id
    where pr.id = (select auth.uid()) and pr.account_status = 'active' and o.status = 'active'));
$$;

create or replace function public.acting_supplier_org_id()
returns uuid language sql stable security definer set search_path = ''
as $$
  select coalesce(public.assisted_org(), (
    select o.id
    from public.profiles pr
    join public.organizations o on o.id = case
      when pr.role = 'customer' then (select c.supplier_org_id from public.clients c where c.id = pr.client_id)
      when pr.role = 'platform' then null
      else pr.org_id end
    where pr.id = (select auth.uid()) and pr.account_status = 'active' and o.status = 'active'
      and (pr.role <> 'customer' or exists (select 1 from public.organizations b where b.id = pr.org_id and b.status = 'active'))));
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles pr where pr.id = (select auth.uid()) and pr.role = 'admin' and pr.account_status = 'active')
      or public.assist_can_edit();
$$;

-- Assisting: what the Pro's Responsable may do (reading functions only, unless changes are allowed).
create or replace function public.has_feature_base(p_feature text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select case when public.assisted_org() is not null then
      (public.assist_can_edit() or public.permission_kind(p_feature) = 'read')
      and (public.org_owner_ceiling(public.assisted_org(), 'supplier', p_feature) or public.org_owner_ceiling(public.assisted_org(), 'buyer', p_feature))
    else public.has_permission(p_feature) end;
$$;

-- Writes of Appro+ only while assisting with changes allowed, inside the assisted Pro.
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
  if (select auth.uid()) is null or public.org_write_guard_bypassed() then
    return coalesce(new, old);
  end if;
  if exists (select 1 from public.profiles pr where pr.id = (select auth.uid()) and pr.role = 'platform') and not public.assist_can_edit() then
    raise exception using errcode = '42501', message = 'L’équipe Appro+ ne modifie les données d’un Pro qu’en l’assistant, avec les modifications autorisées.';
  end if;
  v_acting := public.acting_supplier_org_id();
  if tg_op <> 'DELETE' then
    v_new := public.row_org(tg_table_name, to_jsonb(new));
    if v_new is distinct from v_acting and not (v_new is null and tg_table_name in ('shipments', 'team_messages')) then
      raise exception using errcode = '42501', message = case when v_acting is null then 'Votre espace Pro n’est pas actif (en attente de validation par Appro+ ou suspendu) : vous ne pouvez pas encore modifier ses données.' else 'Cette donnée appartient à un autre Pro.' end;
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
      raise exception using errcode = '42501', message = case when v_acting is null then 'Votre espace Pro n’est pas actif (en attente de validation par Appro+ ou suspendu) : vous ne pouvez pas encore modifier ses données.' else 'Cette donnée appartient à un autre Pro.' end;
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function public.my_pro()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select case when o.id is null then null else jsonb_build_object(
    'id', o.id, 'name', o.name, 'kind', o.kind, 'status', o.status, 'is_supplier', o.is_supplier, 'is_buyer', o.is_buyer,
    'roles_delegated', o.roles_delegated, 'trial_until', o.trial_until, 'catalog_visibility', o.catalog_visibility,
    'listed_in_directory', o.listed_in_directory, 'open_to_messages', o.open_to_messages, 'open_to_new', o.open_to_new) end
  from public.profiles pr left join public.organizations o on o.id = coalesce(public.assisted_org(), pr.org_id)
  where pr.id = (select auth.uid());
$$;

-- The account: assisting Appro+ appears as the Pro's administrator, with the assistance described.
create or replace function public.my_account()
returns jsonb language sql stable security definer set search_path = ''
as $$
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
    'home_layout', coalesce(pr.home_layout, (select hl.layout from public.home_layouts hl
      where hl.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role)),
    'role_home_layout', (select hl.layout from public.home_layouts hl
      where hl.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role),
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
$$;

-- ---------------------------------------------------------------------------
-- 3. Delegation of the roles to a role ("Gérer les rôles et les droits")
-- ---------------------------------------------------------------------------
create or replace function public.can_manage_org_roles(p_org_id uuid, p_edit boolean)
returns boolean language sql stable security definer set search_path = ''
as $$
  select public.platform_can('platform.pros.manage')
      or (not p_edit and public.platform_can('platform.roles.assign'))
      or ((public.is_admin() or public.is_org_owner(p_org_id) or public.has_feature('roles.manage')) and public.current_org_id() = p_org_id);
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
  v_full boolean;
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
    -- A delegate (not the Responsable) never gives a right it does not have.
    v_full := public.is_admin() or public.is_org_owner(v_role.org_id);
    if not v_full and coalesce(p_allowed, false) and not public.has_feature(p_permission) then
      raise exception using errcode = '42501', message = 'Vous ne pouvez pas donner un droit que vous n’avez pas.';
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

-- The catalogue as the matrices show it (area, reading or changing, label, and how a Pro sees what it lacks).
create or replace function public.rights_catalogue(p_org_id uuid default null)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'side', p.side, 'area', p.area, 'kind', p.kind, 'label', p.label, 'sort', p.sort,
      'module', public.feature_module(p.key),
      'display', public.feature_display_of(coalesce(p_org_id, public.current_org_id()), p.key),
      'display_default', public.feature_display_of(null, p.key),
      'display_own', (select d.display from public.feature_display d where d.org_id = coalesce(p_org_id, public.current_org_id()) and d.permission = p.key))
    order by p.side desc, p.sort, p.key), '[]'::jsonb)
  from public.permissions p;
$$;
REVOKE ALL ON FUNCTION public.rights_catalogue(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rights_catalogue(uuid) TO authenticated;

notify pgrst, 'reload schema';
