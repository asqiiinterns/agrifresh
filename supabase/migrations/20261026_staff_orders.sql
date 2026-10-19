-- Orders placed by the team for a client (phone orders), and client-wide order visibility.
-- Run in Supabase SQL Editor AFTER 20261025_alerts.sql. Safe to rerun.
-- New right "orders.create" (Passer une commande pour un client), on by default for supervisors.
-- Prices, stock and VAT rules are the same as for the client's own orders.

insert into public.role_permissions (role, feature, allowed)
values ('supervisor', 'orders.create', true), ('production', 'orders.create', false),
       ('driver', 'orders.create', false), ('customer', 'orders.create', false)
on conflict (role, feature) do nothing;

create or replace function public.create_client_order(
  p_client_id uuid,
  p_customer_id uuid,
  p_actor_id uuid,
  p_items jsonb,
  p_delivery_point_id uuid,
  p_requested_date date,
  p_note text,
  p_history_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid := p_customer_id;
  v_client public.clients%rowtype;
  v_point public.client_delivery_points%rowtype;
  v_point_count int;
  v_item record;
  v_product public.products%rowtype;
  v_line_total numeric(12,3);
  v_subtotal numeric(12,3) := 0;
  v_lines jsonb := '[]'::jsonb;
  v_order_id uuid;
  v_order_number bigint;
begin
  select c.* into v_client from public.clients c where c.id = p_client_id and c.active;
  if not found then
    raise exception using errcode = 'P0002', message = 'Fiche client introuvable ou inactive.';
  end if;

  select count(*) into v_point_count
  from public.client_delivery_points dp
  where dp.client_id = v_client.id and dp.active;

  if p_delivery_point_id is null and v_point_count = 1 then
    select dp.* into v_point from public.client_delivery_points dp
    where dp.client_id = v_client.id and dp.active;
  elsif p_delivery_point_id is not null then
    select dp.* into v_point from public.client_delivery_points dp
    where dp.id = p_delivery_point_id and dp.client_id = v_client.id and dp.active;
  end if;
  if v_point.id is null then
    raise exception using errcode = '22023', message = case when v_point_count = 0
      then 'Aucun point de livraison n’est configuré sur votre fiche. Contactez AgriFresh.'
      else 'Choisissez un point de livraison.' end;
  end if;

  if p_requested_date is not null and p_requested_date < (now() at time zone 'Africa/Tunis')::date then
    raise exception using errcode = '22023', message = 'La date de livraison souhaitée est déjà passée.';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'La commande est vide.';
  end if;

  for v_item in
    select
      (line.value ->> 'product_id')::uuid as product_id,
      sum((line.value ->> 'quantity')::numeric)::numeric(12,3) as quantity
    from jsonb_array_elements(p_items) as line(value)
    group by 1
    order by 1
  loop
    if v_item.product_id is null or v_item.quantity is null or v_item.quantity <= 0 or v_item.quantity > 100000 then
      raise exception using errcode = '22023', message = 'Une quantité de la commande est invalide.';
    end if;

    select p.* into v_product from public.products p where p.id = v_item.product_id for update;
    if not found or not v_product.active then
      raise exception using errcode = 'P0002', message = 'Un produit de la commande n’est plus disponible.';
    end if;
    if v_client.stock_managed and v_product.stock_quantity < v_item.quantity then
      raise exception using errcode = '22023', message = format('Stock insuffisant pour %s (disponible : %s).', v_product.name, v_product.stock_quantity);
    end if;

    v_line_total := round(v_product.price * v_item.quantity, 3);
    v_subtotal := v_subtotal + v_line_total;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id, 'name', v_product.name, 'unit', v_product.unit_label,
      'unit_price', v_product.price, 'quantity', v_item.quantity, 'line_total', v_line_total,
      'vat_rate', v_product.vat_rate,
      'origin', nullif(jsonb_strip_nulls(jsonb_build_object(
        'producer', nullif(btrim(v_product.origin_producer), ''),
        'region', nullif(btrim(v_product.origin_region), ''),
        'label', nullif(btrim(v_product.origin_label), ''),
        'note', nullif(btrim(v_product.origin_note), '')
      )), '{}'::jsonb)
    ));
  end loop;

  insert into public.orders (
    customer_id, client_id, delivery_point_id, requested_delivery_date, status,
    address_snapshot, subtotal, delivery_fee, total, currency, customer_note, stock_reserved
  ) values (
    v_customer_id, v_client.id, v_point.id, p_requested_date, 'pending',
    jsonb_build_object(
      'business_name', v_client.business_name,
      'recipient_name', coalesce(nullif(v_client.contact_name, ''), v_client.business_name),
      'phone', coalesce(nullif(v_point.phone, ''), v_client.phone),
      'point_label', v_point.label,
      'address_line', v_point.address_line,
      'city', v_point.city,
      'notes', v_point.instructions
    ),
    v_subtotal, 0, v_subtotal, 'TND', nullif(btrim(coalesce(p_note, '')), ''), v_client.stock_managed
  ) returning id, order_number into v_order_id, v_order_number;

  for v_item in select line.value from jsonb_array_elements(v_lines) as line(value)
  loop
    insert into public.order_items (
      order_id, product_id, product_name_snapshot, unit_snapshot, unit_price, quantity, line_total, vat_rate, origin_snapshot
    ) values (
      v_order_id,
      (v_item.value ->> 'product_id')::uuid,
      v_item.value ->> 'name',
      v_item.value ->> 'unit',
      (v_item.value ->> 'unit_price')::numeric,
      (v_item.value ->> 'quantity')::numeric,
      (v_item.value ->> 'line_total')::numeric,
      (v_item.value ->> 'vat_rate')::numeric,
      case when jsonb_typeof(v_item.value -> 'origin') = 'object' then v_item.value -> 'origin' end
    );
    if v_client.stock_managed then
      update public.products
      set stock_quantity = stock_quantity - (v_item.value ->> 'quantity')::numeric, updated_at = now()
      where id = (v_item.value ->> 'product_id')::uuid;
    end if;
  end loop;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (v_order_id, 'pending', p_history_note, p_actor_id);

  insert into public.payments (order_id, method, status, amount, currency)
  values (v_order_id, 'cash_on_delivery', 'pending', v_subtotal, 'TND');

  return jsonb_build_object('id', v_order_id, 'order_number', v_order_number, 'total', v_subtotal, 'status', 'pending');
end;
$$;
REVOKE ALL ON FUNCTION public.create_client_order(uuid, uuid, uuid, jsonb, uuid, date, text, text) FROM PUBLIC, anon, authenticated;


create or replace function public.place_client_order(
  p_items jsonb,
  p_delivery_point_id uuid default null,
  p_requested_date date default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid := public.active_uid();
  v_client_id uuid;
begin
  if v_customer_id is null then
    raise exception using errcode = '28000', message = 'Connectez-vous avant de passer commande (compte actif requis).';
  end if;
  select c.id into v_client_id
  from public.profiles pr join public.clients c on c.id = pr.client_id
  where pr.id = v_customer_id and c.active;
  if v_client_id is null then
    raise exception using errcode = '42501', message = 'Votre compte n’est rattaché à aucune fiche client active. Contactez AgriFresh.';
  end if;
  return public.create_client_order(v_client_id, v_customer_id, v_customer_id, p_items, p_delivery_point_id, p_requested_date, p_note, 'Commande transmise par le client.');
end;
$$;
REVOKE ALL ON FUNCTION public.place_client_order(jsonb, uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_client_order(jsonb, uuid, date, text) TO authenticated;

-- The order belongs to the client's account when there is one, so the client follows it,
-- gets its alerts and sees it in its history; otherwise to the team member who entered it.
create or replace function public.staff_place_order(
  p_client_id uuid,
  p_items jsonb,
  p_delivery_point_id uuid default null,
  p_requested_date date default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := public.active_uid();
  v_customer_id uuid;
  v_result jsonb;
  v_actor_name text;
begin
  if v_actor_id is null or not public.has_feature('orders.create') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de commander pour un client.';
  end if;
  select pr.id into v_customer_id from public.profiles pr
  where pr.client_id = p_client_id and pr.account_status = 'active'
  order by pr.created_at limit 1;
  select coalesce(nullif(pr.full_name, ''), u.email) into v_actor_name
  from public.profiles pr join auth.users u on u.id = pr.id where pr.id = v_actor_id;

  v_result := public.create_client_order(p_client_id, coalesce(v_customer_id, v_actor_id), v_actor_id,
    p_items, p_delivery_point_id, p_requested_date, p_note,
    format('Commande saisie par AgriFresh (%s) pour le client.', coalesce(v_actor_name, 'équipe')));

  if v_customer_id is not null then
    perform public.notify(array[v_customer_id], 'order.status',
      format('Commande #%s saisie par AgriFresh', v_result ->> 'order_number'),
      'AgriFresh a enregistré cette commande pour vous ; suivez-la dans Commandes.', (v_result ->> 'id')::uuid);
  end if;
  return v_result;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_place_order(uuid, jsonb, uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_place_order(uuid, jsonb, uuid, date, text) TO authenticated;

-- A client account sees every order of its client record, whoever entered it.
drop policy if exists "orders_read_own" on public.orders;
create policy "orders_read_own" on public.orders
  for select to authenticated using (
    customer_id = (select public.active_uid()) or client_id = (select public.current_client_id())
  );
drop policy if exists "order_items_read_own" on public.order_items;
create policy "order_items_read_own" on public.order_items
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = order_items.order_id
      and (o.customer_id = (select public.active_uid()) or o.client_id = (select public.current_client_id())))
  );
drop policy if exists "status_history_read_own" on public.order_status_history;
create policy "status_history_read_own" on public.order_status_history
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = order_status_history.order_id
      and (o.customer_id = (select public.active_uid()) or o.client_id = (select public.current_client_id())))
  );

-- The driver ships an order when picking it up: "orders.ship" is on for drivers.
update public.role_permissions set allowed = true, updated_at = now()
where role = 'driver' and feature = 'orders.ship' and not allowed;

-- Orders ready to be picked up, for whoever may ship them (driver, supervisor).
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
