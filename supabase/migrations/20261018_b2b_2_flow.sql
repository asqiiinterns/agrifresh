-- B2B ordering, part 2/2: client records, delivery points with QR codes,
-- staff decisions, driver delivery by QR scan and direct messages.
-- Run in Supabase SQL Editor AFTER 20261018_b2b_1_enums.sql. Safe to rerun.
--
-- Status flow:
--   pending (Nouvelle) → confirmed (Acceptée) | declined (Déclinée) | on_hold (En attente)
--   on_hold → confirmed | declined
--   confirmed → preparing (En préparation) → ready (Préparée) → out_for_delivery (Expédiée)
--   out_for_delivery → delivered (Livrée), only through a driver scanning the delivery point QR code.

-- ---------------------------------------------------------------------------
-- Client records and delivery points
-- ---------------------------------------------------------------------------

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  client_number bigint generated always as identity unique,
  business_name text not null check (btrim(business_name) <> ''),
  contact_name text not null default '',
  email text unique check (email is null or email = lower(btrim(email))),
  phone text not null default '',
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_delivery_points (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  label text not null default 'Principal' check (btrim(label) <> ''),
  address_line text not null check (btrim(address_line) <> ''),
  city text not null check (btrim(city) <> ''),
  phone text not null default '',
  instructions text,
  qr_token uuid not null unique default gen_random_uuid(),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists client_delivery_points_client_idx on public.client_delivery_points(client_id);

alter table public.profiles add column if not exists client_id uuid unique references public.clients(id) on delete set null;

alter table public.orders add column if not exists client_id uuid references public.clients(id);
alter table public.orders add column if not exists delivery_point_id uuid references public.client_delivery_points(id);
alter table public.orders add column if not exists requested_delivery_date date;
alter table public.orders add column if not exists status_note text;
alter table public.orders add column if not exists delivered_at timestamptz;
alter table public.orders add column if not exists delivered_by uuid references public.profiles(id);
create index if not exists orders_client_created_idx on public.orders(client_id, created_at desc);
create index if not exists orders_point_status_idx on public.orders(delivery_point_id, status);

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

create or replace function public.is_driver()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = (select auth.uid()) and pr.role in ('driver', 'staff', 'admin')
  );
$$;
REVOKE ALL ON FUNCTION public.is_driver() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_driver() TO authenticated;

create or replace function public.current_client_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pr.client_id from public.profiles pr where pr.id = (select auth.uid());
$$;
REVOKE ALL ON FUNCTION public.current_client_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_client_id() TO authenticated;

-- ---------------------------------------------------------------------------
-- Account ↔ client record linking (by e-mail)
-- Keep "Confirm email" enabled in Supabase Auth so nobody can claim a
-- client's e-mail without access to that mailbox.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, phone, client_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    (select c.id from public.clients c
     where c.email = lower(new.email)
       and not exists (select 1 from public.profiles p where p.client_id = c.id))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.link_client_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is not null
     and not exists (select 1 from public.profiles p where p.client_id = new.id) then
    update public.profiles p
    set client_id = new.id
    from auth.users u
    where u.id = p.id
      and lower(u.email) = new.email
      and p.client_id is null
      and p.role = 'customer';
  end if;
  return new;
end;
$$;
REVOKE ALL ON FUNCTION public.link_client_account() FROM PUBLIC, anon, authenticated;

drop trigger if exists clients_link_account on public.clients;
create trigger clients_link_account
  after insert or update of email on public.clients
  for each row execute procedure public.link_client_account();

-- ---------------------------------------------------------------------------
-- Access rules
-- ---------------------------------------------------------------------------

alter table public.clients enable row level security;
alter table public.client_delivery_points enable row level security;

GRANT SELECT, INSERT, UPDATE ON public.clients, public.client_delivery_points TO authenticated;
GRANT SELECT ON public.profiles TO authenticated;

drop policy if exists "clients_staff_all" on public.clients;
create policy "clients_staff_all" on public.clients
  for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "clients_read_own" on public.clients;
create policy "clients_read_own" on public.clients
  for select to authenticated using (id = (select public.current_client_id()));

drop policy if exists "delivery_points_staff_all" on public.client_delivery_points;
create policy "delivery_points_staff_all" on public.client_delivery_points
  for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "delivery_points_read_own" on public.client_delivery_points;
create policy "delivery_points_read_own" on public.client_delivery_points
  for select to authenticated using (client_id = (select public.current_client_id()));

drop policy if exists "profiles_read_staff" on public.profiles;
create policy "profiles_read_staff" on public.profiles
  for select to authenticated using ((select public.is_staff()));

-- ---------------------------------------------------------------------------
-- Current account summary for the app
-- ---------------------------------------------------------------------------

create or replace function public.my_account()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'role', pr.role,
    'full_name', pr.full_name,
    'client', case when c.id is null or not c.active then null else jsonb_build_object(
      'id', c.id,
      'client_number', c.client_number,
      'business_name', c.business_name,
      'contact_name', c.contact_name,
      'phone', c.phone,
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
-- Client order placement
-- ---------------------------------------------------------------------------

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
  v_customer_id uuid := auth.uid();
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
  if v_customer_id is null then
    raise exception using errcode = '28000', message = 'Connectez-vous avant de passer commande.';
  end if;

  select c.* into v_client
  from public.profiles pr
  join public.clients c on c.id = pr.client_id
  where pr.id = v_customer_id and c.active;
  if not found then
    raise exception using errcode = '42501', message = 'Votre compte n’est rattaché à aucune fiche client active. Contactez AgriFresh.';
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

  -- Aggregate duplicate lines and lock products in a stable order; prices and
  -- stock always come from the database, never from the client.
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
    if v_product.stock_quantity < v_item.quantity then
      raise exception using errcode = '22023', message = format('Stock insuffisant pour %s (disponible : %s).', v_product.name, v_product.stock_quantity);
    end if;

    v_line_total := round(v_product.price * v_item.quantity, 3);
    v_subtotal := v_subtotal + v_line_total;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id, 'name', v_product.name, 'unit', v_product.unit_label,
      'unit_price', v_product.price, 'quantity', v_item.quantity, 'line_total', v_line_total
    ));
  end loop;

  insert into public.orders (
    customer_id, client_id, delivery_point_id, requested_delivery_date, status,
    address_snapshot, subtotal, delivery_fee, total, currency, customer_note
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
    v_subtotal, 0, v_subtotal, 'TND', nullif(btrim(coalesce(p_note, '')), '')
  ) returning id, order_number into v_order_id, v_order_number;

  for v_item in select line.value from jsonb_array_elements(v_lines) as line(value)
  loop
    insert into public.order_items (
      order_id, product_id, product_name_snapshot, unit_snapshot, unit_price, quantity, line_total
    ) values (
      v_order_id,
      (v_item.value ->> 'product_id')::uuid,
      v_item.value ->> 'name',
      v_item.value ->> 'unit',
      (v_item.value ->> 'unit_price')::numeric,
      (v_item.value ->> 'quantity')::numeric,
      (v_item.value ->> 'line_total')::numeric
    );
    update public.products
    set stock_quantity = stock_quantity - (v_item.value ->> 'quantity')::numeric, updated_at = now()
    where id = (v_item.value ->> 'product_id')::uuid;
  end loop;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (v_order_id, 'pending', 'Commande transmise par le client.', v_customer_id);

  insert into public.payments (order_id, method, status, amount, currency)
  values (v_order_id, 'cash_on_delivery', 'pending', v_subtotal, 'TND');

  return jsonb_build_object('id', v_order_id, 'order_number', v_order_number, 'total', v_subtotal, 'status', 'pending');
end;
$$;
REVOKE ALL ON FUNCTION public.place_client_order(jsonb, uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_client_order(jsonb, uuid, date, text) TO authenticated;

-- Orders must now belong to a client record.
REVOKE EXECUTE ON FUNCTION public.place_customer_order(jsonb, jsonb, text) FROM authenticated;

-- ---------------------------------------------------------------------------
-- Staff decisions and preparation workflow
-- ---------------------------------------------------------------------------

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
  v_staff_id uuid := auth.uid();
  v_current public.order_status;
  v_allowed public.order_status[];
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Accès réservé au personnel AgriFresh.';
  end if;

  select o.status into v_current from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;

  v_allowed := case v_current
    when 'pending' then array['confirmed', 'declined', 'on_hold']::public.order_status[]
    when 'on_hold' then array['confirmed', 'declined']::public.order_status[]
    when 'confirmed' then array['preparing', 'cancelled']::public.order_status[]
    when 'preparing' then array['ready', 'cancelled']::public.order_status[]
    when 'ready' then array['out_for_delivery', 'cancelled']::public.order_status[]
    else array[]::public.order_status[]
  end;

  if not (p_status = any(v_allowed)) then
    raise exception using errcode = '22023', message = case
      when p_status = 'delivered' then 'La livraison se confirme uniquement en scannant le QR code du point de livraison.'
      else format('Transition impossible : %s → %s.', v_current, p_status) end;
  end if;

  update public.orders
  set status = p_status,
      status_note = case when p_status in ('declined', 'on_hold', 'cancelled') then v_note else status_note end,
      updated_at = now()
  where id = p_order_id;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (p_order_id, p_status, v_note, v_staff_id);

  if p_status in ('declined', 'cancelled') then
    update public.products p
    set stock_quantity = p.stock_quantity + oi.quantity, updated_at = now()
    from public.order_items oi
    where oi.order_id = p_order_id and oi.product_id = p.id;

    update public.payments set status = 'cancelled'
    where order_id = p_order_id and status = 'pending';
  end if;

  return jsonb_build_object('id', p_order_id, 'previous_status', v_current, 'status', p_status);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_update_order_status(uuid, public.order_status, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_update_order_status(uuid, public.order_status, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Driver: shipped orders and delivery confirmation by QR scan
-- ---------------------------------------------------------------------------

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
      'item_count', (select count(*) from public.order_items oi where oi.order_id = o.id)
    ) order by o.requested_delivery_date nulls last, c.business_name, o.order_number)
    from public.orders o
    join public.clients c on c.id = o.client_id
    join public.client_delivery_points dp on dp.id = o.delivery_point_id
    where o.status = 'out_for_delivery'
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.driver_shipments() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_shipments() TO authenticated;

create or replace function public.driver_lookup_point(p_qr_token uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_point public.client_delivery_points%rowtype;
  v_client public.clients%rowtype;
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs AgriFresh.';
  end if;

  select dp.* into v_point from public.client_delivery_points dp where dp.qr_token = p_qr_token;
  if not found then
    raise exception using errcode = 'P0002', message = 'QR code inconnu.';
  end if;
  select c.* into v_client from public.clients c where c.id = v_point.client_id;

  return jsonb_build_object(
    'point', jsonb_build_object(
      'id', v_point.id, 'label', v_point.label, 'address_line', v_point.address_line, 'city', v_point.city,
      'business_name', v_client.business_name, 'client_number', v_client.client_number
    ),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id,
        'order_number', o.order_number,
        'requested_delivery_date', o.requested_delivery_date,
        'total', o.total,
        'items', (select coalesce(jsonb_agg(jsonb_build_object(
            'name', oi.product_name_snapshot, 'quantity', oi.quantity, 'unit', oi.unit_snapshot
          )), '[]'::jsonb) from public.order_items oi where oi.order_id = o.id)
      ) order by o.order_number)
      from public.orders o
      where o.delivery_point_id = v_point.id and o.status = 'out_for_delivery'
    ), '[]'::jsonb)
  );
end;
$$;
REVOKE ALL ON FUNCTION public.driver_lookup_point(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_lookup_point(uuid) TO authenticated;

create or replace function public.driver_confirm_delivery(p_qr_token uuid, p_order_ids uuid[])
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver_id uuid := auth.uid();
  v_point_id uuid;
  v_requested int;
  v_matching int;
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs AgriFresh.';
  end if;

  select dp.id into v_point_id from public.client_delivery_points dp where dp.qr_token = p_qr_token;
  if not found then
    raise exception using errcode = 'P0002', message = 'QR code inconnu.';
  end if;

  select count(distinct id) into v_requested from unnest(p_order_ids) as t(id);
  if v_requested = 0 then
    raise exception using errcode = '22023', message = 'Sélectionnez au moins une commande.';
  end if;

  -- Lock the selected orders, then check they are all shipped to this point.
  perform 1 from public.orders o where o.id = any(p_order_ids) order by o.id for update;
  select count(*) into v_matching
  from public.orders o
  where o.id = any(p_order_ids) and o.delivery_point_id = v_point_id and o.status = 'out_for_delivery';
  if v_matching <> v_requested then
    raise exception using errcode = '22023', message = 'Une commande sélectionnée n’est pas expédiée vers ce point de livraison.';
  end if;

  update public.orders
  set status = 'delivered', delivered_at = now(), delivered_by = v_driver_id, updated_at = now()
  where id = any(p_order_ids);

  insert into public.order_status_history (order_id, status, note, changed_by)
  select o.id, 'delivered', 'Livraison confirmée par scan du QR code.', v_driver_id
  from public.orders o where o.id = any(p_order_ids);

  update public.payments set status = 'paid'
  where order_id = any(p_order_ids) and method = 'cash_on_delivery' and status = 'pending';

  return v_matching;
end;
$$;
REVOKE ALL ON FUNCTION public.driver_confirm_delivery(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_confirm_delivery(uuid, uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- Direct messages between a client and the AgriFresh team (one thread per client)
-- ---------------------------------------------------------------------------

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null,
  from_staff boolean not null,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists messages_client_created_idx on public.messages(client_id, created_at desc);
create index if not exists messages_unread_idx on public.messages(from_staff, read_at) where read_at is null;

alter table public.messages enable row level security;
GRANT SELECT ON public.messages TO authenticated;

drop policy if exists "messages_read_staff" on public.messages;
create policy "messages_read_staff" on public.messages
  for select to authenticated using ((select public.is_staff()));
drop policy if exists "messages_read_own" on public.messages;
create policy "messages_read_own" on public.messages
  for select to authenticated using (client_id = (select public.current_client_id()));

-- Writes go through these functions so the sender side cannot be forged.
create or replace function public.send_message(p_client_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_staff boolean := public.is_staff();
  v_client_id uuid;
  v_message public.messages%rowtype;
begin
  if v_is_staff then
    v_client_id := p_client_id;
  else
    v_client_id := public.current_client_id();
    if v_client_id is null then
      raise exception using errcode = '42501', message = 'Votre compte n’est rattaché à aucune fiche client.';
    end if;
    if p_client_id is not null and p_client_id <> v_client_id then
      raise exception using errcode = '42501', message = 'Vous ne pouvez écrire que dans votre propre conversation.';
    end if;
  end if;

  if not exists (select 1 from public.clients c where c.id = v_client_id) then
    raise exception using errcode = 'P0002', message = 'Client introuvable.';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Le message doit contenir entre 1 et 2000 caractères.';
  end if;

  insert into public.messages (client_id, sender_id, from_staff, body)
  values (v_client_id, auth.uid(), v_is_staff, btrim(p_body))
  returning * into v_message;

  return jsonb_build_object(
    'id', v_message.id, 'client_id', v_message.client_id, 'from_staff', v_message.from_staff,
    'body', v_message.body, 'created_at', v_message.created_at, 'read_at', v_message.read_at
  );
end;
$$;
REVOKE ALL ON FUNCTION public.send_message(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_message(uuid, text) TO authenticated;

create or replace function public.mark_messages_read(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.is_staff() then
    update public.messages set read_at = now()
    where client_id = p_client_id and not from_staff and read_at is null;
  elsif p_client_id = public.current_client_id() then
    update public.messages set read_at = now()
    where client_id = p_client_id and from_staff and read_at is null;
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.mark_messages_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_messages_read(uuid) TO authenticated;

create or replace function public.staff_inbox()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Accès réservé au personnel AgriFresh.';
  end if;
  return coalesce((
    select jsonb_agg(entry order by entry ->> 'last_at' desc nulls last, entry ->> 'business_name')
    from (
      select jsonb_build_object(
        'client_id', c.id,
        'business_name', c.business_name,
        'client_number', c.client_number,
        'last_body', last_message.body,
        'last_at', last_message.created_at,
        'last_from_staff', last_message.from_staff,
        'unread', (select count(*) from public.messages m
                   where m.client_id = c.id and not m.from_staff and m.read_at is null)
      ) as entry
      from public.clients c
      left join lateral (
        select m.body, m.created_at, m.from_staff from public.messages m
        where m.client_id = c.id order by m.created_at desc limit 1
      ) last_message on true
      where c.active or last_message.created_at is not null
    ) entries
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_inbox() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_inbox() TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.messages';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Accounts (run separately, replacing the e-mail):
--   update public.profiles set role = 'staff'
--   where id = (select id from auth.users where email = 'staff@exemple.com');
--   update public.profiles set role = 'driver'
--   where id = (select id from auth.users where email = 'livreur@exemple.com');
-- ---------------------------------------------------------------------------
