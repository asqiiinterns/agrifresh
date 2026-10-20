-- Recurring orders, customer signature at delivery, data for the driver's offline mode.
-- Run in Supabase SQL Editor AFTER 20261103_location_reminders_leaves.sql. Safe to rerun.

insert into public.role_permissions (role, feature, allowed) values
  ('supervisor', 'client.recurring', false), ('production', 'client.recurring', false), ('driver', 'client.recurring', false), ('customer', 'client.recurring', true)
on conflict (role, feature) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Signature at delivery (client option, default for all clients + per client)
-- ---------------------------------------------------------------------------

alter table public.clients add column if not exists delivery_signature boolean not null default false;
insert into public.client_setting_defaults (key, value) values ('delivery_signature', 'false') on conflict (key) do nothing;
alter table public.orders add column if not exists delivery_signature jsonb;

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
                'history_enabled', 'reconfirm_declined', 'scan_delivery_note', 'scan_client_qr',
                'payment_reminders', 'reminder_opt_out_allowed', 'delivery_signature')
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
  if not ('payment_reminders' = any(k)) and d ? 'payment_reminders' then new.payment_reminders := (d ->> 'payment_reminders')::boolean; end if;
  if not ('reminder_opt_out_allowed' = any(k)) and d ? 'reminder_opt_out_allowed' then new.reminder_opt_out_allowed := (d ->> 'reminder_opt_out_allowed')::boolean; end if;
  if not ('delivery_signature' = any(k)) and d ? 'delivery_signature' then new.delivery_signature := (d ->> 'delivery_signature')::boolean; end if;
  new.feature_overrides := coalesce((
    select jsonb_object_agg(e.key, e.value) from jsonb_each(
      case when jsonb_typeof(new.feature_overrides) = 'object' then new.feature_overrides else '{}'::jsonb end) e
    where e.key like 'client.%' and jsonb_typeof(e.value) = 'boolean'
  ), '{}'::jsonb);
  return new;
end;
$$;

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
  insert into public.client_setting_defaults (key, value, updated_at) values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  update public.clients set custom_settings = custom_settings where not (p_key = any(custom_settings));
end;
$$;

-- Hand-over with the customer's signature drawn on the screen ({path, width, height}, plus the signer's name).
create or replace function public.driver_deliver_v2(
  p_order_ids uuid[], p_delivery_tokens uuid[], p_client_qr_kind text default null, p_client_qr_token uuid default null,
  p_signature jsonb default null, p_signer text default null
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_needs boolean;
  v_count int;
begin
  select array_agg(o.id) into v_ids from public.orders o
  where o.id = any(coalesce(p_order_ids, '{}'::uuid[])) or o.delivery_token = any(coalesce(p_delivery_tokens, '{}'::uuid[]));
  select bool_or(c.delivery_signature) into v_needs from public.orders o join public.clients c on c.id = o.client_id where o.id = any(coalesce(v_ids, '{}'::uuid[]));
  if p_signature is not null and (jsonb_typeof(p_signature) <> 'object' or char_length(coalesce(p_signature ->> 'path', '')) not between 10 and 60000) then
    raise exception using errcode = '22023', message = 'Signature invalide.';
  end if;
  if coalesce(v_needs, false) and p_signature is null then
    raise exception using errcode = '22023', message = 'Ce client signe à la livraison : faites signer sur l’écran.';
  end if;
  v_count := public.driver_deliver(p_order_ids, p_delivery_tokens, p_client_qr_kind, p_client_qr_token);
  if p_signature is not null then
    update public.orders
    set delivery_signature = jsonb_build_object('path', p_signature ->> 'path', 'width', coalesce((p_signature ->> 'width')::numeric, 300),
          'height', coalesce((p_signature ->> 'height')::numeric, 150), 'signer', left(nullif(btrim(coalesce(p_signer, '')), ''), 80), 'signed_at', now())
    where id = any(v_ids);
    update public.order_status_history h set note = h.note || ' Signé par ' || coalesce(nullif(btrim(coalesce(p_signer, '')), ''), 'le client') || '.'
    where h.order_id = any(v_ids) and h.status = 'delivered' and h.created_at > now() - interval '1 minute';
  end if;
  return v_count;
end;
$$;
REVOKE ALL ON FUNCTION public.driver_deliver_v2(uuid[], uuid[], text, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_deliver_v2(uuid[], uuid[], text, uuid, jsonb, text) TO authenticated;

-- Delivery tokens in the driver's list: lets the phone recognise delivery-note QR codes without network.
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
      'delivery_token', o.delivery_token,
      'delivery_signature', c.delivery_signature,
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

-- ---------------------------------------------------------------------------
-- 2. Recurring orders
-- ---------------------------------------------------------------------------

create table if not exists public.recurring_orders (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  customer_id uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  items jsonb not null,
  delivery_point_id uuid references public.client_delivery_points(id) on delete set null,
  weekdays int[] not null,
  lead_days int not null default 1 check (lead_days between 0 and 7),
  next_delivery date not null,
  note text,
  active boolean not null default true,
  last_order_id uuid references public.orders(id) on delete set null,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.recurring_orders enable row level security;
GRANT SELECT ON public.recurring_orders TO authenticated;
drop policy if exists "recurring_orders_read" on public.recurring_orders;
create policy "recurring_orders_read" on public.recurring_orders for select to authenticated using (
  (select public.has_feature('orders.create')) or (select public.has_feature('orders.decide')) or client_id = (select public.current_client_id())
);

-- First date on or after p_from whose ISO weekday (1 = Monday) is in p_days.
create or replace function public.next_weekday_date(p_from date, p_days int[])
returns date
language sql
immutable
set search_path = ''
as $$
  select min(d)::date from generate_series(p_from, p_from + 6, interval '1 day') as g(d)
  where extract(isodow from d)::int = any(p_days);
$$;

create or replace function public.save_recurring_order(
  p_id uuid, p_client_id uuid, p_items jsonb, p_delivery_point_id uuid, p_weekdays int[], p_lead_days int default 1,
  p_note text default null, p_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid;
  v_customer uuid;
  v_id uuid := p_id;
  v_days int[];
begin
  if public.active_uid() is null then
    raise exception using errcode = '28000', message = 'Compte actif requis.';
  end if;
  if public.current_client_id() is not null and not public.is_staff() then
    if not public.has_feature('client.recurring') then
      raise exception using errcode = '42501', message = 'Les commandes récurrentes ne sont pas activées pour votre compte.';
    end if;
    v_client := public.current_client_id();
    v_customer := auth.uid();
  else
    if not public.has_feature('orders.create') then
      raise exception using errcode = '42501', message = 'Votre profil ne permet pas de programmer des commandes.';
    end if;
    v_client := p_client_id;
    select pr.id into v_customer from public.profiles pr where pr.client_id = v_client and pr.account_status = 'active' order by pr.created_at limit 1;
  end if;
  if not exists (select 1 from public.clients c where c.id = v_client and c.active) then
    raise exception using errcode = 'P0002', message = 'Fiche client introuvable ou inactive.';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'La commande récurrente est vide.';
  end if;
  v_days := array(select distinct d from unnest(coalesce(p_weekdays, '{}'::int[])) d where d between 1 and 7 order by d);
  if cardinality(v_days) = 0 then
    raise exception using errcode = '22023', message = 'Choisissez au moins un jour de livraison.';
  end if;
  if v_id is not null and not exists (select 1 from public.recurring_orders r where r.id = v_id and r.client_id = v_client) then
    raise exception using errcode = 'P0002', message = 'Commande récurrente introuvable.';
  end if;
  if v_id is null then
    insert into public.recurring_orders (client_id, customer_id, created_by, items, delivery_point_id, weekdays, lead_days, next_delivery, note, active)
    values (v_client, coalesce(v_customer, auth.uid()), auth.uid(), p_items, p_delivery_point_id, v_days, coalesce(p_lead_days, 1),
            public.next_weekday_date(current_date + coalesce(p_lead_days, 1), v_days), nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_active, true))
    returning id into v_id;
  else
    update public.recurring_orders
    set items = p_items, delivery_point_id = p_delivery_point_id, weekdays = v_days, lead_days = coalesce(p_lead_days, 1),
        next_delivery = public.next_weekday_date(current_date + coalesce(p_lead_days, 1), v_days),
        note = nullif(btrim(coalesce(p_note, '')), ''), active = coalesce(p_active, true), last_error = null, updated_at = now()
    where id = v_id;
  end if;
  return v_id;
end;
$$;
REVOKE ALL ON FUNCTION public.save_recurring_order(uuid, uuid, jsonb, uuid, int[], int, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_recurring_order(uuid, uuid, jsonb, uuid, int[], int, text, boolean) TO authenticated;

create or replace function public.delete_recurring_order(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.recurring_orders r
  where r.id = p_id and (r.client_id = public.current_client_id() or public.has_feature('orders.create'));
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande récurrente introuvable.';
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.delete_recurring_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_recurring_order(uuid) TO authenticated;

-- Creates the orders that are due (each one lead_days before its delivery day), then moves to the next day.
-- Called by the app when the team opens it, and every hour by pg_cron when the extension is enabled.
create or replace function public.run_recurring_orders()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.recurring_orders%rowtype;
  v_result jsonb;
  v_count int := 0;
begin
  if auth.uid() is not null and public.active_uid() is null then
    return 0;
  end if;
  for v_row in
    select r.* from public.recurring_orders r
    where r.active and r.next_delivery - r.lead_days <= current_date
    for update skip locked
  loop
    begin
      if v_row.next_delivery >= current_date then
        v_result := public.create_client_order(v_row.client_id, v_row.customer_id, null, v_row.items, v_row.delivery_point_id,
          v_row.next_delivery, v_row.note, 'Commande récurrente créée automatiquement.');
        update public.recurring_orders set last_order_id = (v_result ->> 'id')::uuid, last_error = null where id = v_row.id;
        perform public.notify(public.client_users(v_row.client_id), 'order.status',
          format('Commande récurrente #%s créée', v_result ->> 'order_number'),
          format('Livraison prévue le %s.', to_char(v_row.next_delivery, 'DD/MM/YYYY')), (v_result ->> 'id')::uuid);
        v_count := v_count + 1;
      end if;
    exception when others then
      update public.recurring_orders set last_error = left(sqlerrm, 300) where id = v_row.id;
    end;
    update public.recurring_orders
    set next_delivery = public.next_weekday_date(greatest(v_row.next_delivery + 1, current_date + lead_days), weekdays), updated_at = now()
    where id = v_row.id;
  end loop;
  return v_count;
end;
$$;
REVOKE ALL ON FUNCTION public.run_recurring_orders() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_recurring_orders() TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('agrifresh-recurring-orders', '5 * * * *', 'select public.run_recurring_orders()');
  END IF;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'pg_cron non disponible : les commandes récurrentes sont créées à l’ouverture de l’application.';
END;
$$;

DO $$
BEGIN
  EXECUTE 'drop trigger if exists audit_recurring_orders on public.recurring_orders';
  EXECUTE 'create trigger audit_recurring_orders after insert or update or delete on public.recurring_orders for each row execute function public.audit_row()';
END;
$$;
