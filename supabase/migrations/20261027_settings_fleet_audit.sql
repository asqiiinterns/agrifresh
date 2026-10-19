-- Settings by theme, role and user; client options with defaults and per-client exceptions;
-- delivery fleet and grouped shipments; full audit trail; configurable home screen.
-- Run in Supabase SQL Editor AFTER 20261026_staff_orders.sql. Safe to rerun.

-- ---------------------------------------------------------------------------
-- 1. Every tab can be switched on or off
-- ---------------------------------------------------------------------------

insert into public.role_permissions (role, feature, allowed)
select r.role::public.app_role, f.feature, f.feature = any(r.allowed)
from (values
  ('supervisor', array['home.view', 'alerts.view', 'orders.view']),
  ('production', array['home.view', 'alerts.view']),
  ('driver', array['alerts.view']),
  ('customer', array['client.home', 'client.order', 'client.orders', 'client.alerts'])
) as r(role, allowed)
cross join (values
  ('home.view'), ('alerts.view'), ('orders.view'), ('fleet.manage'), ('audit.view'),
  ('client.home'), ('client.order'), ('client.orders'), ('client.alerts')
) as f(feature)
on conflict (role, feature) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Exceptions per user (on top of the role) and per client record (client tabs)
-- ---------------------------------------------------------------------------

create table if not exists public.user_permissions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  feature text not null,
  allowed boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, feature)
);
alter table public.user_permissions enable row level security;
GRANT SELECT ON public.user_permissions TO authenticated;
drop policy if exists "user_permissions_read" on public.user_permissions;
create policy "user_permissions_read" on public.user_permissions
  for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));

alter table public.clients add column if not exists history_enabled boolean not null default true;
alter table public.clients add column if not exists reconfirm_declined boolean not null default true;
alter table public.clients add column if not exists scan_delivery_note boolean not null default true;
alter table public.clients add column if not exists scan_client_qr boolean not null default true;
alter table public.clients add column if not exists feature_overrides jsonb not null default '{}'::jsonb;

-- Options that follow the "all clients" default unless listed in custom_settings.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'custom_settings'
  ) THEN
    ALTER TABLE public.clients ADD COLUMN custom_settings text[] NOT NULL DEFAULT '{}';
    -- Existing records keep their choices: options set apart from the default become specific.
    UPDATE public.clients SET custom_settings = array_remove(array[
      case when not show_prices then 'show_prices' end,
      case when show_origin then 'show_origin' end,
      case when show_stock then 'show_stock' end,
      case when not stock_managed then 'stock_managed' end,
      case when invoice_mode <> 'manual' then 'invoice_mode' end,
      case when reception_qr then 'reception_qr' end
    ], null);
  END IF;
END;
$$;

create table if not exists public.client_setting_defaults (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.client_setting_defaults enable row level security;
GRANT SELECT ON public.client_setting_defaults TO authenticated;
drop policy if exists "client_setting_defaults_read" on public.client_setting_defaults;
create policy "client_setting_defaults_read" on public.client_setting_defaults
  for select to authenticated using (true);
insert into public.client_setting_defaults (key, value) values
  ('show_prices', 'true'), ('show_origin', 'false'), ('show_stock', 'false'), ('stock_managed', 'true'),
  ('invoice_mode', '"manual"'), ('reception_qr', 'false'), ('history_enabled', 'true'),
  ('reconfirm_declined', 'true'), ('scan_delivery_note', 'true'), ('scan_client_qr', 'true')
on conflict (key) do nothing;

-- Every write to a client record re-applies the defaults to the options it does not customise.
create or replace function public.apply_client_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d jsonb := coalesce((select jsonb_object_agg(s.key, s.value) from public.client_setting_defaults s), '{}'::jsonb);
  k text[];
begin
  new.custom_settings := array(
    select distinct x from unnest(coalesce(new.custom_settings, '{}'::text[])) as t(x)
    where x in ('show_prices', 'show_origin', 'show_stock', 'stock_managed', 'invoice_mode', 'reception_qr',
                'history_enabled', 'reconfirm_declined', 'scan_delivery_note', 'scan_client_qr')
    order by x);
  k := new.custom_settings;
  if not ('show_prices' = any(k)) and d ? 'show_prices' then new.show_prices := (d ->> 'show_prices')::boolean; end if;
  if not ('show_origin' = any(k)) and d ? 'show_origin' then new.show_origin := (d ->> 'show_origin')::boolean; end if;
  if not ('show_stock' = any(k)) and d ? 'show_stock' then new.show_stock := (d ->> 'show_stock')::boolean; end if;
  if not ('stock_managed' = any(k)) and d ? 'stock_managed' then new.stock_managed := (d ->> 'stock_managed')::boolean; end if;
  if not ('invoice_mode' = any(k)) and d ? 'invoice_mode' then new.invoice_mode := d ->> 'invoice_mode'; end if;
  if not ('reception_qr' = any(k)) and d ? 'reception_qr' then new.reception_qr := (d ->> 'reception_qr')::boolean; end if;
  if not ('history_enabled' = any(k)) and d ? 'history_enabled' then new.history_enabled := (d ->> 'history_enabled')::boolean; end if;
  if not ('reconfirm_declined' = any(k)) and d ? 'reconfirm_declined' then new.reconfirm_declined := (d ->> 'reconfirm_declined')::boolean; end if;
  if not ('scan_delivery_note' = any(k)) and d ? 'scan_delivery_note' then new.scan_delivery_note := (d ->> 'scan_delivery_note')::boolean; end if;
  if not ('scan_client_qr' = any(k)) and d ? 'scan_client_qr' then new.scan_client_qr := (d ->> 'scan_client_qr')::boolean; end if;
  -- Client records may only adjust client-side features.
  new.feature_overrides := coalesce((
    select jsonb_object_agg(e.key, e.value) from jsonb_each(
      case when jsonb_typeof(new.feature_overrides) = 'object' then new.feature_overrides else '{}'::jsonb end) e
    where e.key like 'client.%' and jsonb_typeof(e.value) = 'boolean'
  ), '{}'::jsonb);
  return new;
end;
$$;
drop trigger if exists clients_apply_defaults on public.clients;
create trigger clients_apply_defaults before insert or update on public.clients
  for each row execute function public.apply_client_defaults();

create or replace function public.admin_set_client_default(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if p_key not in ('show_prices', 'show_origin', 'show_stock', 'stock_managed', 'invoice_mode', 'reception_qr',
                   'history_enabled', 'reconfirm_declined', 'scan_delivery_note', 'scan_client_qr') then
    raise exception using errcode = '22023', message = 'Option client inconnue.';
  end if;
  if p_key = 'invoice_mode' then
    if jsonb_typeof(p_value) is distinct from 'string' or (p_value #>> '{}') not in ('auto', 'manual') then
      raise exception using errcode = '22023', message = 'Mode de facturation invalide.';
    end if;
  elsif jsonb_typeof(p_value) is distinct from 'boolean' then
    raise exception using errcode = '22023', message = 'Valeur invalide.';
  end if;
  insert into public.client_setting_defaults (key, value, updated_at) values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  -- Re-applies the default to every client that does not customise this option.
  update public.clients set custom_settings = custom_settings where not (p_key = any(custom_settings));
end;
$$;
REVOKE ALL ON FUNCTION public.admin_set_client_default(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_client_default(text, jsonb) TO authenticated;

-- User exception first, then the client record (client features only), then the role.
create or replace function public.has_feature(p_feature text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when pr.account_status <> 'active' then false
      when pr.role = 'admin' then true
      else coalesce(
        (select up.allowed from public.user_permissions up where up.user_id = pr.id and up.feature = p_feature),
        (select (c.feature_overrides ->> p_feature)::boolean from public.clients c
          where c.id = pr.client_id and pr.role = 'customer' and p_feature like 'client.%'),
        (select rp.allowed from public.role_permissions rp
          where rp.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role
            and rp.feature = p_feature),
        false)
    end
    from public.profiles pr where pr.id = (select auth.uid())
  ), false);
$$;

create or replace function public.admin_set_user_permission(p_user_id uuid, p_feature text, p_allowed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user_id;
  if v_role is null then
    raise exception using errcode = 'P0002', message = 'Compte introuvable.';
  end if;
  if v_role = 'admin' then
    raise exception using errcode = '22023', message = 'Un administrateur a toujours tous les droits.';
  end if;
  if not exists (select 1 from public.role_permissions rp where rp.feature = p_feature) then
    raise exception using errcode = '22023', message = 'Fonctionnalité inconnue.';
  end if;
  if (v_role = 'customer') <> (p_feature like 'client.%') then
    raise exception using errcode = '22023', message = 'Cette fonctionnalité ne concerne pas ce type de compte.';
  end if;
  if p_allowed is null then
    delete from public.user_permissions where user_id = p_user_id and feature = p_feature;
  else
    insert into public.user_permissions (user_id, feature, allowed, updated_at) values (p_user_id, p_feature, p_allowed, now())
    on conflict (user_id, feature) do update set allowed = excluded.allowed, updated_at = now();
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.admin_set_user_permission(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_permission(uuid, text, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Client history can be switched off: finished orders and timelines are hidden
-- ---------------------------------------------------------------------------

create or replace function public.my_client_history()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select c.history_enabled from public.profiles pr join public.clients c on c.id = pr.client_id
    where pr.id = (select auth.uid())
  ), true);
$$;
REVOKE ALL ON FUNCTION public.my_client_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_client_history() TO authenticated;

drop policy if exists "orders_read_own" on public.orders;
create policy "orders_read_own" on public.orders
  for select to authenticated using (
    (customer_id = (select public.active_uid()) or client_id = (select public.current_client_id()))
    and ((select public.my_client_history()) or status not in ('delivered', 'cancelled'))
  );
drop policy if exists "order_items_read_own" on public.order_items;
create policy "order_items_read_own" on public.order_items
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = order_items.order_id
      and (o.customer_id = (select public.active_uid()) or o.client_id = (select public.current_client_id()))
      and ((select public.my_client_history()) or o.status not in ('delivered', 'cancelled')))
  );
drop policy if exists "status_history_read_own" on public.order_status_history;
create policy "status_history_read_own" on public.order_status_history
  for select to authenticated using (
    (select public.my_client_history())
    and exists (select 1 from public.orders o where o.id = order_status_history.order_id
      and (o.customer_id = (select public.active_uid()) or o.client_id = (select public.current_client_id())))
  );

-- Who did it, by name, on every step of an order.
alter table public.order_status_history add column if not exists changed_by_name text;
create or replace function public.stamp_status_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.changed_by is not null and new.changed_by_name is null then
    select coalesce(nullif(btrim(pr.full_name), ''), u.email) into new.changed_by_name
    from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = new.changed_by;
  end if;
  return new;
end;
$$;
drop trigger if exists order_status_history_actor on public.order_status_history;
create trigger order_status_history_actor before insert on public.order_status_history
  for each row execute function public.stamp_status_actor();
update public.order_status_history h
set changed_by_name = (select coalesce(nullif(btrim(pr.full_name), ''), u.email)
                       from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = h.changed_by)
where h.changed_by is not null and h.changed_by_name is null;

-- ---------------------------------------------------------------------------
-- 4. Reopening a declined order without client reconfirmation (client option)
-- ---------------------------------------------------------------------------

create or replace function public.reopen_order_accepted(p_order_id uuid, p_note text, p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_client public.clients%rowtype;
  v_line record;
  v_product public.products%rowtype;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  select c.* into v_client from public.clients c where c.id = v_order.client_id;
  if v_client.stock_managed then
    for v_line in
      select oi.product_id, sum(oi.quantity) as quantity, min(oi.product_name_snapshot) as name
      from public.order_items oi where oi.order_id = p_order_id
      group by oi.product_id order by oi.product_id
    loop
      if v_line.product_id is null then
        raise exception using errcode = 'P0002', message = format('%s n’est plus au catalogue.', v_line.name);
      end if;
      select p.* into v_product from public.products p where p.id = v_line.product_id for update;
      if not found or not v_product.active or v_product.stock_quantity < v_line.quantity then
        raise exception using errcode = '22023', message = format('Stock insuffisant pour %s.', v_line.name);
      end if;
      update public.products set stock_quantity = stock_quantity - v_line.quantity, updated_at = now()
      where id = v_line.product_id;
    end loop;
  end if;

  update public.orders
  set status = 'confirmed', status_note = null, stock_reserved = v_client.stock_managed,
      production_rank = (select coalesce(max(q.production_rank), 0) + 1 from public.orders q
                         where q.status in ('confirmed', 'preparing', 'ready') and q.id <> p_order_id),
      updated_at = now()
  where id = p_order_id;
  insert into public.order_status_history (order_id, status, note, changed_by)
  values (p_order_id, 'confirmed',
          concat_ws(' — ', 'Rouverte et acceptée directement (reconfirmation du client désactivée)', nullif(btrim(coalesce(p_note, '')), '')),
          p_actor_id);
  update public.payments set status = 'pending' where order_id = p_order_id and status = 'cancelled';
  if v_order.client_invoice_id is null and v_client.invoice_mode = 'auto' then
    perform public.create_client_invoice(v_client.id, array[p_order_id], p_actor_id, false);
  end if;
  return jsonb_build_object('id', p_order_id, 'previous_status', v_order.status, 'status', 'confirmed');
end;
$$;
REVOKE ALL ON FUNCTION public.reopen_order_accepted(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Delivery fleet and grouped shipments
-- ---------------------------------------------------------------------------

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  plate text not null default '',
  notes text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.vehicles enable row level security;
GRANT SELECT, INSERT, UPDATE ON public.vehicles TO authenticated;
drop policy if exists "vehicles_read" on public.vehicles;
create policy "vehicles_read" on public.vehicles
  for select to authenticated using ((select public.is_staff()) or (select public.has_feature('orders.ship')) or (select public.has_feature('fleet.manage')));
drop policy if exists "vehicles_insert" on public.vehicles;
create policy "vehicles_insert" on public.vehicles
  for insert to authenticated with check ((select public.has_feature('fleet.manage')));
drop policy if exists "vehicles_update" on public.vehicles;
create policy "vehicles_update" on public.vehicles
  for update to authenticated using ((select public.has_feature('fleet.manage'))) with check ((select public.has_feature('fleet.manage')));

create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),
  shipment_number bigint generated always as identity unique,
  vehicle_id uuid references public.vehicles(id),
  driver_id uuid references public.profiles(id),
  order_count int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.shipments enable row level security;
GRANT SELECT ON public.shipments TO authenticated;
drop policy if exists "shipments_read" on public.shipments;
create policy "shipments_read" on public.shipments
  for select to authenticated using ((select public.is_staff()) or driver_id = (select auth.uid()));
alter table public.orders add column if not exists shipment_id uuid references public.shipments(id);

-- The driver takes several prepared orders at once, in the chosen vehicle.
create or replace function public.driver_ship_orders(p_order_ids uuid[], p_vehicle_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.active_uid();
  v_count int;
  v_ready int;
  v_vehicle public.vehicles%rowtype;
  v_vehicle_text text := '';
  v_shipment_id uuid;
  v_number bigint;
begin
  if v_actor is null or not public.has_feature('orders.ship') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas d’expédier les commandes.';
  end if;
  select count(distinct x) into v_count from unnest(coalesce(p_order_ids, '{}'::uuid[])) as t(x);
  if v_count = 0 then
    raise exception using errcode = '22023', message = 'Sélectionnez au moins un bon de livraison.';
  end if;
  if p_vehicle_id is not null then
    select v.* into v_vehicle from public.vehicles v where v.id = p_vehicle_id and v.active;
    if not found then
      raise exception using errcode = 'P0002', message = 'Véhicule introuvable ou retiré de la flotte.';
    end if;
    v_vehicle_text := ' · ' || v_vehicle.label || case when v_vehicle.plate <> '' then ' (' || v_vehicle.plate || ')' else '' end;
  elsif exists (select 1 from public.vehicles v where v.active) then
    raise exception using errcode = '22023', message = 'Choisissez le véhicule utilisé pour cette expédition.';
  end if;

  perform 1 from public.orders o where o.id = any(p_order_ids) order by o.id for update;
  select count(*) into v_ready from public.orders o where o.id = any(p_order_ids) and o.status = 'ready';
  if v_ready <> v_count then
    raise exception using errcode = '22023', message = 'Une commande sélectionnée n’est plus prête à expédier : actualisez la liste.';
  end if;

  insert into public.shipments (vehicle_id, driver_id, order_count) values (p_vehicle_id, v_actor, v_count)
  returning id, shipment_number into v_shipment_id, v_number;
  update public.orders set status = 'out_for_delivery', shipment_id = v_shipment_id, production_rank = null, updated_at = now()
  where id = any(p_order_ids);
  insert into public.order_status_history (order_id, status, note, changed_by)
  select o.id, 'out_for_delivery', format('Expédition #%s%s', v_number, v_vehicle_text), v_actor
  from public.orders o where o.id = any(p_order_ids);
  return jsonb_build_object('shipment_id', v_shipment_id, 'shipment_number', v_number, 'count', v_count);
end;
$$;
REVOKE ALL ON FUNCTION public.driver_ship_orders(uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_ship_orders(uuid[], uuid) TO authenticated;

-- Delivery proof follows the client's options: delivery-note scan and/or client QR.
create or replace function public.driver_deliver(
  p_order_ids uuid[],
  p_delivery_tokens uuid[],
  p_client_qr_kind text default null,
  p_client_qr_token uuid default null
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver_id uuid := auth.uid();
  v_ids uuid[];
  v_unknown int;
  v_count int;
  v_matching int;
  v_clients int;
  v_points int;
  v_client_id uuid;
  v_point_id uuid;
  v_missing int;
  v_client public.clients%rowtype;
  v_proof text;
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs AgriFresh.';
  end if;
  select count(*) into v_unknown from unnest(coalesce(p_delivery_tokens, '{}'::uuid[])) as t(token)
  where not exists (select 1 from public.orders o where o.delivery_token = t.token);
  if v_unknown > 0 then
    raise exception using errcode = 'P0002', message = 'Bon de livraison inconnu.';
  end if;
  select array_agg(o.id order by o.id) into v_ids from public.orders o
  where o.id = any(coalesce(p_order_ids, '{}'::uuid[])) or o.delivery_token = any(coalesce(p_delivery_tokens, '{}'::uuid[]));
  if v_ids is null then
    raise exception using errcode = '22023', message = 'Sélectionnez ou scannez au moins une commande.';
  end if;

  perform 1 from public.orders o where o.id = any(v_ids) order by o.id for update;
  select count(*), count(*) filter (where o.status = 'out_for_delivery'), count(distinct o.client_id), count(distinct o.delivery_point_id),
         (array_agg(o.client_id))[1], (array_agg(o.delivery_point_id))[1]
  into v_count, v_matching, v_clients, v_points, v_client_id, v_point_id
  from public.orders o where o.id = any(v_ids);
  if v_matching <> v_count then
    raise exception using errcode = '22023', message = 'Une commande n’est pas (ou plus) en cours de livraison.';
  end if;
  if v_clients <> 1 then
    raise exception using errcode = '22023', message = 'Ces commandes concernent plusieurs clients : livrez-les séparément.';
  end if;

  select c.* into v_client from public.clients c where c.id = v_client_id;
  if v_client.scan_delivery_note then
    select count(*) into v_missing from public.orders o
    where o.id = any(v_ids) and not (o.delivery_token = any(coalesce(p_delivery_tokens, '{}'::uuid[])));
    if v_missing > 0 then
      raise exception using errcode = '22023', message = 'Scannez le bon de livraison de chaque commande (exigé pour ce client).';
    end if;
  end if;
  if v_client.scan_client_qr then
    if v_client.reception_qr then
      if p_client_qr_kind is distinct from 'client' or p_client_qr_token is distinct from v_client.reception_token then
        raise exception using errcode = '22023', message = 'QR client invalide : demandez au client d’afficher son QR de réception dans l’application AgriFresh.';
      end if;
    else
      if v_points <> 1 then
        raise exception using errcode = '22023', message = 'Ces commandes concernent plusieurs points de livraison : livrez-les séparément.';
      end if;
      if p_client_qr_kind is distinct from 'point' or not exists (
        select 1 from public.client_delivery_points dp where dp.id = v_point_id and dp.qr_token = p_client_qr_token
      ) then
        raise exception using errcode = '22023', message = 'Le QR scanné ne correspond pas au point de livraison de ces commandes.';
      end if;
    end if;
  end if;

  v_proof := concat_ws(' + ',
    case when v_client.scan_delivery_note then 'bon de livraison scanné' else 'sans scan du bon' end,
    case when not v_client.scan_client_qr then 'sans QR client'
         when v_client.reception_qr then 'QR de réception du client'
         else 'QR du point de livraison' end);

  update public.orders
  set status = 'delivered', delivered_at = now(), delivered_by = v_driver_id, updated_at = now()
  where id = any(v_ids);
  insert into public.order_status_history (order_id, status, note, changed_by)
  select o.id, 'delivered', 'Livraison confirmée : ' || v_proof || '.', v_driver_id
  from public.orders o where o.id = any(v_ids);
  update public.payments p set status = 'paid'
  from public.orders o
  where o.id = any(v_ids) and p.order_id = o.id and p.method = 'cash_on_delivery' and p.status = 'pending';
  return v_count;
end;
$$;
REVOKE ALL ON FUNCTION public.driver_deliver(uuid[], uuid[], text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_deliver(uuid[], uuid[], text, uuid) TO authenticated;

create or replace function public.driver_shipments()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs AgriFresh.';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'requested_delivery_date', o.requested_delivery_date,
      'total', o.total,
      'business_name', c.business_name,
      'point_label', dp.label,
      'address_line', dp.address_line,
      'city', dp.city,
      'phone', coalesce(nullif(dp.phone, ''), c.phone),
      'item_count', (select count(*) from public.order_items oi where oi.order_id = o.id),
      'client_id', c.id,
      'point_id', dp.id,
      'reception_qr', c.reception_qr,
      'scan_delivery_note', c.scan_delivery_note,
      'scan_client_qr', c.scan_client_qr,
      'shipment_number', s.shipment_number,
      'vehicle_label', v.label,
      'driver_name', dr.full_name
    ) order by o.requested_delivery_date nulls last, c.business_name, o.order_number)
    from public.orders o
    join public.clients c on c.id = o.client_id
    join public.client_delivery_points dp on dp.id = o.delivery_point_id
    left join public.shipments s on s.id = o.shipment_id
    left join public.vehicles v on v.id = s.vehicle_id
    left join public.profiles dr on dr.id = s.driver_id
    where o.status = 'out_for_delivery'
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.driver_shipments() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_shipments() TO authenticated;
REVOKE ALL ON FUNCTION public.driver_shipments() FROM PUBLIC, anon;

create or replace function public.driver_lookup_delivery(p_delivery_token uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_status public.order_status;
  v_number bigint;
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs AgriFresh.';
  end if;

  select o.status, o.order_number into v_status, v_number from public.orders o where o.delivery_token = p_delivery_token;
  if not found then
    raise exception using errcode = 'P0002', message = 'Bon de livraison inconnu.';
  end if;
  if v_status <> 'out_for_delivery' then
    raise exception using errcode = '22023', message = format('La commande #%s n’est pas en cours de livraison.', v_number);
  end if;

  select jsonb_build_object(
    'id', o.id,
    'order_number', o.order_number,
    'delivery_token', o.delivery_token,
    'client_id', c.id,
    'business_name', c.business_name,
    'reception_qr', c.reception_qr,
    'scan_delivery_note', c.scan_delivery_note,
    'scan_client_qr', c.scan_client_qr,
    'point_id', dp.id,
    'point_label', dp.label,
    'address_line', dp.address_line,
    'city', dp.city,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', oi.product_name_snapshot, 'quantity', oi.quantity, 'unit', oi.unit_snapshot
      )), '[]'::jsonb) from public.order_items oi where oi.order_id = o.id)
  ) into v_result
  from public.orders o
  join public.clients c on c.id = o.client_id
  join public.client_delivery_points dp on dp.id = o.delivery_point_id
  where o.delivery_token = p_delivery_token;

  return v_result;
end;
$$;
REVOKE ALL ON FUNCTION public.driver_lookup_delivery(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_lookup_delivery(uuid) TO authenticated;

create or replace function public.driver_history(p_since date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_is_staff boolean := public.is_staff();
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs AgriFresh.';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'delivered_at', o.delivered_at,
      'client_id', c.id,
      'business_name', c.business_name,
      'point_label', dp.label,
      'address_line', dp.address_line,
      'city', dp.city,
      'total', o.total,
      'driver_name', pr.full_name,
      'shipment_number', s.shipment_number,
      'vehicle_label', v.label,
      'item_count', (select count(*) from public.order_items oi where oi.order_id = o.id)
    ) order by o.delivered_at desc)
    from public.orders o
    join public.clients c on c.id = o.client_id
    join public.client_delivery_points dp on dp.id = o.delivery_point_id
    left join public.profiles pr on pr.id = o.delivered_by
    left join public.shipments s on s.id = o.shipment_id
    left join public.vehicles v on v.id = s.vehicle_id
    where o.status = 'delivered'
      and o.delivered_at >= p_since
      and (v_is_staff or o.delivered_by = auth.uid())
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.driver_history(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_history(date) TO authenticated;

create or replace function public.driver_pickups()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_feature('orders.ship') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas d’expédier les commandes.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'client_id', c.id,
      'requested_delivery_date', o.requested_delivery_date,
      'business_name', c.business_name,
      'point_label', dp.label,
      'address_line', dp.address_line,
      'city', dp.city,
      'phone', coalesce(nullif(dp.phone, ''), c.phone),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('name', oi.product_name_snapshot, 'quantity', oi.quantity, 'unit', oi.unit_snapshot)), '[]'::jsonb)
                from public.order_items oi where oi.order_id = o.id)
    ) order by o.requested_delivery_date nulls last, o.production_rank nulls last, o.order_number)
    from public.orders o
    join public.clients c on c.id = o.client_id
    join public.client_delivery_points dp on dp.id = o.delivery_point_id
    where o.status = 'ready'
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.driver_pickups() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_pickups() TO authenticated;

create or replace function public.staff_update_order_status(
  p_order_id uuid,
  p_status public.order_status,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_order public.orders%rowtype;
  v_allowed public.order_status[];
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_invoice_status text;
  v_other_orders int;
begin
  if not public.has_feature(case
      when p_status in ('preparing', 'ready') then 'production.update'
      when p_status = 'out_for_delivery' then 'orders.ship'
      else 'orders.decide' end) then
    raise exception using errcode = '42501', message = 'Accès réservé au personnel AgriFresh.';
  end if;

  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;

  -- Clients whose reconfirmation is switched off get the reopened order accepted at once.
  if p_status = 'awaiting_client' and v_order.status = 'declined'
     and exists (select 1 from public.clients c where c.id = v_order.client_id and not c.reconfirm_declined) then
    return public.reopen_order_accepted(p_order_id, v_note, v_actor_id);
  end if;

  -- With a fleet, shipping goes through driver_ship_orders so the vehicle is recorded.
  if p_status = 'out_for_delivery' and exists (select 1 from public.vehicles v where v.active) then
    raise exception using errcode = '22023', message = 'Choisissez le véhicule : expédiez depuis Livraisons → À récupérer.';
  end if;

  v_allowed := case v_order.status
    when 'pending' then array['confirmed', 'declined', 'on_hold']::public.order_status[]
    when 'on_hold' then array['confirmed', 'declined']::public.order_status[]
    when 'declined' then array['awaiting_client']::public.order_status[]
    when 'awaiting_client' then array['cancelled']::public.order_status[]
    when 'confirmed' then array['preparing', 'cancelled']::public.order_status[]
    when 'preparing' then array['ready', 'cancelled']::public.order_status[]
    when 'ready' then array['out_for_delivery', 'cancelled']::public.order_status[]
    else array[]::public.order_status[]
  end;

  if not (p_status = any(v_allowed)) then
    raise exception using errcode = '22023', message = case
      when p_status = 'delivered' then 'La livraison se confirme uniquement en scannant le bon de livraison et le QR code du client.'
      when p_status = 'confirmed' and v_order.status = 'awaiting_client' then 'Seul le client peut reconfirmer cette commande.'
      else format('Transition impossible : %s → %s.', v_order.status, p_status) end;
  end if;

  if p_status = 'cancelled' and v_order.client_invoice_id is not null then
    select i.status into v_invoice_status from public.client_invoices i where i.id = v_order.client_invoice_id for update;
    if v_invoice_status = 'draft' then
      update public.orders set client_invoice_id = null where id = p_order_id;
      perform public.refresh_invoice_totals(v_order.client_invoice_id);
    else
      select count(*) into v_other_orders from public.orders o
      where o.client_invoice_id = v_order.client_invoice_id and o.id <> p_order_id;
      if v_other_orders > 0 then
        raise exception using errcode = '22023', message = 'Cette commande figure sur une facture avec d’autres bons : annulez d’abord la facture.';
      end if;
      update public.client_invoices set status = 'cancelled', paid_at = null, updated_at = now() where id = v_order.client_invoice_id;
    end if;
  end if;

  update public.orders
  set status = p_status,
      status_note = case when p_status in ('declined', 'on_hold', 'cancelled', 'awaiting_client') then v_note else status_note end,
      -- Accepted orders join the end of the queue; staff may then move them.
      production_rank = case
        when p_status = 'confirmed' then coalesce(production_rank, (
          select coalesce(max(q.production_rank), 0) + 1 from public.orders q
          where q.status in ('confirmed', 'preparing', 'ready') and q.id <> p_order_id))
        when p_status in ('preparing', 'ready') then production_rank
        else null end,
      updated_at = now()
  where id = p_order_id;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (p_order_id, p_status, v_note, v_actor_id);

  if p_status = 'confirmed' and v_order.client_invoice_id is null
     and exists (select 1 from public.clients c where c.id = v_order.client_id and c.invoice_mode = 'auto') then
    perform public.create_client_invoice(v_order.client_id, array[p_order_id], v_actor_id, false);
  end if;

  if p_status in ('declined', 'cancelled') then
    if v_order.stock_reserved then
      update public.products p
      set stock_quantity = p.stock_quantity + oi.quantity, updated_at = now()
      from public.order_items oi
      where oi.order_id = p_order_id and oi.product_id = p.id;
      update public.orders set stock_reserved = false where id = p_order_id;
    end if;

    update public.payments set status = 'cancelled'
    where order_id = p_order_id and status = 'pending';
  end if;

  return jsonb_build_object('id', p_order_id, 'previous_status', v_order.status, 'status', p_status);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_update_order_status(uuid, public.order_status, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_update_order_status(uuid, public.order_status, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Home screen: shortcuts and figures, by role (admin) then by user
-- ---------------------------------------------------------------------------

create table if not exists public.home_layouts (
  role public.app_role primary key,
  layout jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.home_layouts enable row level security;
GRANT SELECT ON public.home_layouts TO authenticated;
drop policy if exists "home_layouts_read" on public.home_layouts;
create policy "home_layouts_read" on public.home_layouts for select to authenticated using (true);
alter table public.profiles add column if not exists home_layout jsonb;

create or replace function public.valid_home_layout(p_layout jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_layout is null or (
    jsonb_typeof(p_layout) = 'object'
    and jsonb_typeof(coalesce(p_layout -> 'tiles', '[]'::jsonb)) = 'array'
    and jsonb_typeof(coalesce(p_layout -> 'shortcuts', '[]'::jsonb)) = 'array'
    and jsonb_array_length(coalesce(p_layout -> 'tiles', '[]'::jsonb)) <= 30
    and jsonb_array_length(coalesce(p_layout -> 'shortcuts', '[]'::jsonb)) <= 30
  );
$$;

create or replace function public.set_my_home_layout(p_layout jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.active_uid() is null then
    raise exception using errcode = '28000', message = 'Compte actif requis.';
  end if;
  if not public.valid_home_layout(p_layout) then
    raise exception using errcode = '22023', message = 'Disposition de l’accueil invalide.';
  end if;
  update public.profiles set home_layout = p_layout where id = auth.uid();
end;
$$;
REVOKE ALL ON FUNCTION public.set_my_home_layout(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_home_layout(jsonb) TO authenticated;

create or replace function public.admin_set_home_layout(p_role public.app_role, p_layout jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if not public.valid_home_layout(p_layout) then
    raise exception using errcode = '22023', message = 'Disposition de l’accueil invalide.';
  end if;
  if p_layout is null then
    delete from public.home_layouts where role = p_role;
  else
    insert into public.home_layouts (role, layout, updated_at) values (p_role, p_layout, now())
    on conflict (role) do update set layout = excluded.layout, updated_at = now();
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.admin_set_home_layout(public.app_role, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_home_layout(public.app_role, jsonb) TO authenticated;

create or replace function public.my_account()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', pr.id,
    'role', pr.role,
    'full_name', pr.full_name,
    'features', public.my_features(),
    'disabled', pr.account_status <> 'active',
    'status', pr.account_status,
    'home_layout', coalesce(pr.home_layout, (select hl.layout from public.home_layouts hl
      where hl.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role)),
    'role_home_layout', (select hl.layout from public.home_layouts hl
      where hl.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role),
    'client', case when c.id is null or not c.active then null else jsonb_build_object(
      'id', c.id,
      'client_number', c.client_number,
      'business_name', c.business_name,
      'contact_name', c.contact_name,
      'phone', c.phone,
      'show_prices', c.show_prices,
      'show_origin', c.show_origin,
      'show_stock', c.show_stock,
      'stock_managed', c.stock_managed,
      'reception_qr', c.reception_qr and c.scan_client_qr,
      'reception_token', case when c.reception_qr and c.scan_client_qr then c.reception_token end,
      'history_enabled', c.history_enabled,
      'delivery_points', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', dp.id, 'label', dp.label, 'address_line', dp.address_line, 'city', dp.city
        ) order by dp.created_at)
        from public.client_delivery_points dp
        where dp.client_id = c.id and dp.active
      ), '[]'::jsonb)
    ) end
  )
  from public.profiles pr
  left join public.clients c on c.id = pr.client_id
  where pr.id = (select auth.uid());
$$;
REVOKE ALL ON FUNCTION public.my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_account() TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Audit trail: every change, who made it and when
-- ---------------------------------------------------------------------------

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_name text,
  actor_role text,
  entity text not null,
  entity_id text,
  label text,
  action text not null,
  changes jsonb
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
create index if not exists audit_log_actor_idx on public.audit_log (actor_id, at desc);
alter table public.audit_log enable row level security;
GRANT SELECT ON public.audit_log TO authenticated;
drop policy if exists "audit_log_read" on public.audit_log;
create policy "audit_log_read" on public.audit_log
  for select to authenticated using ((select public.has_feature('audit.view')));

create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_row jsonb;
  v_changes jsonb;
  v_actor uuid := auth.uid();
  v_name text;
  v_role text;
  v_label text;
  v_hidden text[] := array['updated_at', 'delivery_token', 'reception_token', 'qr_token', 'body', 'home_layout'];
begin
  v_row := coalesce(v_new, v_old);
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_array(v_old -> n.key, n.value)) into v_changes
    from jsonb_each(v_new) n
    where not (n.key = any(v_hidden)) and (v_old -> n.key) is distinct from n.value;
    if v_changes is null then
      return null;
    end if;
  else
    select jsonb_object_agg(e.key, e.value) into v_changes
    from jsonb_each(v_row) e
    where not (e.key = any(v_hidden)) and e.value <> 'null'::jsonb;
  end if;

  if v_actor is not null then
    select coalesce(nullif(btrim(pr.full_name), ''), u.email), pr.role::text into v_name, v_role
    from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = v_actor;
  end if;

  v_label := case tg_table_name
    when 'orders' then 'Commande #' || (v_row ->> 'order_number')
    when 'clients' then v_row ->> 'business_name'
    when 'client_delivery_points' then 'Point ' || (v_row ->> 'label') || coalesce(' · ' || (select c.business_name from public.clients c where c.id = (v_row ->> 'client_id')::uuid), '')
    when 'products' then v_row ->> 'name'
    when 'role_permissions' then 'Droit ' || (v_row ->> 'feature') || ' · rôle ' || (v_row ->> 'role')
    when 'user_permissions' then 'Droit ' || (v_row ->> 'feature') || ' · ' || coalesce((
      select coalesce(nullif(btrim(pr.full_name), ''), u.email) from public.profiles pr left join auth.users u on u.id = pr.id
      where pr.id = (v_row ->> 'user_id')::uuid), 'compte')
    when 'client_setting_defaults' then 'Option par défaut des clients · ' || (v_row ->> 'key')
    when 'profiles' then coalesce(nullif(btrim(v_row ->> 'full_name'), ''), (select u.email from auth.users u where u.id = (v_row ->> 'id')::uuid), 'Compte')
    when 'client_invoices' then coalesce('Facture ' || (v_row ->> 'invoice_number'), 'Facture (brouillon)')
    when 'claims' then 'Réclamation n° ' || (v_row ->> 'claim_number')
    when 'vehicles' then 'Véhicule ' || (v_row ->> 'label')
    when 'shipments' then 'Expédition #' || (v_row ->> 'shipment_number')
    when 'messages' then 'Message · ' || coalesce((select c.business_name from public.clients c where c.id = (v_row ->> 'client_id')::uuid), 'client')
    when 'notification_settings' then 'Alerte · ' || (v_row ->> 'label')
    when 'app_settings' then 'Réglages e-mail'
    when 'home_layouts' then 'Accueil · rôle ' || (v_row ->> 'role')
    else tg_table_name
  end;

  insert into public.audit_log (actor_id, actor_name, actor_role, entity, entity_id, label, action, changes)
  values (
    v_actor,
    coalesce(v_name, case when v_actor is null then 'Système' else 'Compte supprimé' end),
    v_role,
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'key', v_row ->> 'event',
             concat_ws(':', v_row ->> 'role', v_row ->> 'user_id', v_row ->> 'feature')),
    v_label,
    lower(tg_op),
    v_changes
  );
  return null;
end;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY array['orders', 'clients', 'client_delivery_points', 'products', 'role_permissions',
    'user_permissions', 'client_setting_defaults', 'profiles', 'client_invoices', 'claims', 'vehicles',
    'shipments', 'messages', 'notification_settings', 'app_settings', 'home_layouts'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('drop trigger if exists audit_%1$s on public.%1$I', t);
      EXECUTE format('create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute function public.audit_row()', t);
    END IF;
  END LOOP;
END;
$$;
