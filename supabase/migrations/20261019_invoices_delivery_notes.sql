-- Invoices, delivery notes with QR codes and two-scan delivery.
-- Run in Supabase SQL Editor AFTER 20261018_b2b_2_flow.sql. Safe to rerun.
--
-- Delivery note (bon de livraison, BL): one per order, carries the order QR code.
-- Delivery: the driver scans the BL QR code(s), then the client's QR code:
--   - the wall QR code of the delivery point (default), or
--   - the reception QR code shown in the client's app when the client record enables it.
-- Invoice (facture): groups one or more accepted orders of a client. VAT per product
-- (prices are excluded of tax) plus the fiscal stamp. Created automatically when an order
-- is accepted for clients in "auto" mode, or by staff from the uninvoiced delivery notes.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.products add column if not exists vat_rate numeric(5,2) not null default 0;
alter table public.order_items add column if not exists vat_rate numeric(5,2) not null default 0;

alter table public.clients add column if not exists tax_id text;
alter table public.clients add column if not exists show_prices boolean not null default true;
alter table public.clients add column if not exists invoice_mode text not null default 'manual';
alter table public.clients add column if not exists reception_qr boolean not null default false;
alter table public.clients add column if not exists reception_token uuid not null default gen_random_uuid();
create unique index if not exists clients_reception_token_idx on public.clients(reception_token);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'products_vat_rate_check') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_vat_rate_check CHECK (vat_rate IN (0, 7, 13, 19));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'clients_invoice_mode_check') THEN
    ALTER TABLE public.clients ADD CONSTRAINT clients_invoice_mode_check CHECK (invoice_mode IN ('auto', 'manual'));
  END IF;
END;
$$;

create sequence if not exists public.client_invoice_number_seq;

create table if not exists public.client_invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  client_id uuid not null references public.clients(id),
  status text not null default 'issued' check (status in ('issued', 'paid', 'cancelled')),
  issued_at timestamptz not null default now(),
  paid_at timestamptz,
  client_snapshot jsonb not null,
  total_ht numeric(12,3) not null check (total_ht >= 0),
  vat_breakdown jsonb not null default '[]'::jsonb,
  total_vat numeric(12,3) not null check (total_vat >= 0),
  stamp_duty numeric(12,3) not null default 1 check (stamp_duty >= 0),
  total_ttc numeric(12,3) not null check (total_ttc >= 0),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists client_invoices_client_idx on public.client_invoices(client_id, issued_at desc);

alter table public.orders add column if not exists client_invoice_id uuid references public.client_invoices(id);
alter table public.orders add column if not exists delivery_token uuid not null default gen_random_uuid();
create unique index if not exists orders_delivery_token_idx on public.orders(delivery_token);
create index if not exists orders_client_invoice_idx on public.orders(client_invoice_id);
create index if not exists orders_delivered_by_idx on public.orders(delivered_by, delivered_at desc);

alter table public.client_invoices enable row level security;
GRANT SELECT ON public.client_invoices TO authenticated;

drop policy if exists "client_invoices_read_staff" on public.client_invoices;
create policy "client_invoices_read_staff" on public.client_invoices
  for select to authenticated using ((select public.is_staff()));
drop policy if exists "client_invoices_read_own" on public.client_invoices;
create policy "client_invoices_read_own" on public.client_invoices
  for select to authenticated using (client_id = (select public.current_client_id()));

-- ---------------------------------------------------------------------------
-- Account summary: display and reception options for the client app
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
      'show_prices', c.show_prices,
      'reception_qr', c.reception_qr,
      'reception_token', case when c.reception_qr then c.reception_token end,
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
-- Client order placement (now snapshots the product VAT rate)
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
      'unit_price', v_product.price, 'quantity', v_item.quantity, 'line_total', v_line_total,
      'vat_rate', v_product.vat_rate
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
      order_id, product_id, product_name_snapshot, unit_snapshot, unit_price, quantity, line_total, vat_rate
    ) values (
      v_order_id,
      (v_item.value ->> 'product_id')::uuid,
      v_item.value ->> 'name',
      v_item.value ->> 'unit',
      (v_item.value ->> 'unit_price')::numeric,
      (v_item.value ->> 'quantity')::numeric,
      (v_item.value ->> 'line_total')::numeric,
      (v_item.value ->> 'vat_rate')::numeric
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

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------

-- Internal: callers check permissions. Totals: HT = sum of lines, VAT per rate,
-- fixed fiscal stamp, TTC = HT + VAT + stamp.
create or replace function public.create_client_invoice(p_client_id uuid, p_order_ids uuid[], p_created_by uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.clients%rowtype;
  v_requested int;
  v_matching int;
  v_ht numeric(12,3);
  v_vat numeric(12,3);
  v_breakdown jsonb;
  v_stamp numeric(12,3) := 1;
  v_invoice_id uuid;
begin
  select c.* into v_client from public.clients c where c.id = p_client_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Client introuvable.';
  end if;

  select count(distinct id) into v_requested from unnest(p_order_ids) as t(id);
  if v_requested = 0 then
    raise exception using errcode = '22023', message = 'Sélectionnez au moins un bon de livraison.';
  end if;

  perform 1 from public.orders o where o.id = any(p_order_ids) order by o.id for update;
  select count(*) into v_matching
  from public.orders o
  where o.id = any(p_order_ids)
    and o.client_id = p_client_id
    and o.client_invoice_id is null
    and o.status in ('confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered');
  if v_matching <> v_requested then
    raise exception using errcode = '22023', message = 'Un bon sélectionné est déjà facturé, appartient à un autre client ou n’est pas accepté.';
  end if;

  select
    coalesce(sum(r.base), 0),
    coalesce(sum(r.vat), 0),
    coalesce(jsonb_agg(jsonb_build_object('rate', r.rate, 'base', r.base, 'vat', r.vat) order by r.rate), '[]'::jsonb)
  into v_ht, v_vat, v_breakdown
  from (
    select oi.vat_rate as rate, sum(oi.line_total) as base, round(sum(oi.line_total) * oi.vat_rate / 100, 3) as vat
    from public.order_items oi
    where oi.order_id = any(p_order_ids)
    group by oi.vat_rate
  ) r;

  insert into public.client_invoices (
    invoice_number, client_id, client_snapshot, total_ht, vat_breakdown, total_vat, stamp_duty, total_ttc, created_by
  ) values (
    'FA-' || to_char(now() at time zone 'Africa/Tunis', 'YYYY') || '-' || lpad(nextval('public.client_invoice_number_seq')::text, 5, '0'),
    p_client_id,
    jsonb_build_object(
      'business_name', v_client.business_name,
      'contact_name', v_client.contact_name,
      'client_number', v_client.client_number,
      'email', v_client.email,
      'phone', v_client.phone,
      'tax_id', v_client.tax_id,
      'address', (select dp.address_line || ', ' || dp.city from public.client_delivery_points dp
                  where dp.client_id = p_client_id and dp.active order by dp.created_at limit 1)
    ),
    v_ht, v_breakdown, v_vat, v_stamp, v_ht + v_vat + v_stamp, p_created_by
  ) returning id into v_invoice_id;

  update public.orders set client_invoice_id = v_invoice_id where id = any(p_order_ids);
  return v_invoice_id;
end;
$$;
REVOKE ALL ON FUNCTION public.create_client_invoice(uuid, uuid[], uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.staff_create_invoice(p_client_id uuid, p_order_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice_id uuid;
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Accès réservé au personnel AgriFresh.';
  end if;
  v_invoice_id := public.create_client_invoice(p_client_id, p_order_ids, auth.uid());
  return (select jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number, 'total_ttc', i.total_ttc)
          from public.client_invoices i where i.id = v_invoice_id);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_create_invoice(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_create_invoice(uuid, uuid[]) TO authenticated;

-- issued ⇄ paid; cancelling releases the delivery notes so they can be invoiced again.
create or replace function public.staff_set_invoice_status(p_invoice_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current text;
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Accès réservé au personnel AgriFresh.';
  end if;
  select i.status into v_current from public.client_invoices i where i.id = p_invoice_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Facture introuvable.';
  end if;
  if v_current = 'cancelled' or p_status not in ('issued', 'paid', 'cancelled') then
    raise exception using errcode = '22023', message = 'Cette facture ne peut plus être modifiée.';
  end if;

  update public.client_invoices
  set status = p_status, paid_at = case when p_status = 'paid' then now() else null end
  where id = p_invoice_id;

  if p_status = 'cancelled' then
    update public.orders set client_invoice_id = null where client_invoice_id = p_invoice_id;
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_set_invoice_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_invoice_status(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Staff workflow: automatic invoice on acceptance, invoice-aware cancellation
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
  v_order public.orders%rowtype;
  v_allowed public.order_status[];
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_other_orders int;
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Accès réservé au personnel AgriFresh.';
  end if;

  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;

  v_allowed := case v_order.status
    when 'pending' then array['confirmed', 'declined', 'on_hold']::public.order_status[]
    when 'on_hold' then array['confirmed', 'declined']::public.order_status[]
    when 'confirmed' then array['preparing', 'cancelled']::public.order_status[]
    when 'preparing' then array['ready', 'cancelled']::public.order_status[]
    when 'ready' then array['out_for_delivery', 'cancelled']::public.order_status[]
    else array[]::public.order_status[]
  end;

  if not (p_status = any(v_allowed)) then
    raise exception using errcode = '22023', message = case
      when p_status = 'delivered' then 'La livraison se confirme uniquement en scannant le bon de livraison et le QR code du client.'
      else format('Transition impossible : %s → %s.', v_order.status, p_status) end;
  end if;

  if p_status = 'cancelled' and v_order.client_invoice_id is not null then
    select count(*) into v_other_orders from public.orders o
    where o.client_invoice_id = v_order.client_invoice_id and o.id <> p_order_id;
    if v_other_orders > 0 then
      raise exception using errcode = '22023', message = 'Cette commande figure sur une facture avec d’autres bons : annulez d’abord la facture.';
    end if;
    update public.client_invoices set status = 'cancelled', paid_at = null where id = v_order.client_invoice_id;
  end if;

  update public.orders
  set status = p_status,
      status_note = case when p_status in ('declined', 'on_hold', 'cancelled') then v_note else status_note end,
      updated_at = now()
  where id = p_order_id;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (p_order_id, p_status, v_note, v_staff_id);

  if p_status = 'confirmed' and v_order.client_invoice_id is null
     and exists (select 1 from public.clients c where c.id = v_order.client_id and c.invoice_mode = 'auto') then
    perform public.create_client_invoice(v_order.client_id, array[p_order_id], v_staff_id);
  end if;

  if p_status in ('declined', 'cancelled') then
    update public.products p
    set stock_quantity = p.stock_quantity + oi.quantity, updated_at = now()
    from public.order_items oi
    where oi.order_id = p_order_id and oi.product_id = p.id;

    update public.payments set status = 'cancelled'
    where order_id = p_order_id and status = 'pending';
  end if;

  return jsonb_build_object('id', p_order_id, 'previous_status', v_order.status, 'status', p_status);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_update_order_status(uuid, public.order_status, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_update_order_status(uuid, public.order_status, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Driver: two-scan delivery and history
-- ---------------------------------------------------------------------------

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

create or replace function public.driver_confirm_handover(p_delivery_tokens uuid[], p_client_qr_kind text, p_client_qr_token uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver_id uuid := auth.uid();
  v_requested int;
  v_matching int;
  v_clients int;
  v_points int;
  v_client_id uuid;
  v_point_id uuid;
  v_client public.clients%rowtype;
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs AgriFresh.';
  end if;

  select count(distinct token) into v_requested from unnest(p_delivery_tokens) as t(token);
  if v_requested = 0 then
    raise exception using errcode = '22023', message = 'Scannez au moins un bon de livraison.';
  end if;

  perform 1 from public.orders o where o.delivery_token = any(p_delivery_tokens) order by o.id for update;
  select count(*), count(distinct o.client_id), count(distinct o.delivery_point_id),
         (array_agg(o.client_id))[1], (array_agg(o.delivery_point_id))[1]
  into v_matching, v_clients, v_points, v_client_id, v_point_id
  from public.orders o
  where o.delivery_token = any(p_delivery_tokens) and o.status = 'out_for_delivery';

  if v_matching <> v_requested then
    raise exception using errcode = '22023', message = 'Un bon de livraison scanné n’est pas (ou plus) en cours de livraison.';
  end if;
  if v_clients <> 1 then
    raise exception using errcode = '22023', message = 'Les bons scannés concernent plusieurs clients : livrez-les séparément.';
  end if;

  select c.* into v_client from public.clients c where c.id = v_client_id;
  if v_client.reception_qr then
    if p_client_qr_kind is distinct from 'client' or p_client_qr_token is distinct from v_client.reception_token then
      raise exception using errcode = '22023', message = 'QR client invalide : demandez au client d’afficher son QR de réception dans l’application AgriFresh.';
    end if;
  else
    if v_points <> 1 then
      raise exception using errcode = '22023', message = 'Les bons scannés concernent plusieurs points de livraison : livrez-les séparément.';
    end if;
    if p_client_qr_kind is distinct from 'point' or not exists (
      select 1 from public.client_delivery_points dp where dp.id = v_point_id and dp.qr_token = p_client_qr_token
    ) then
      raise exception using errcode = '22023', message = 'Le QR scanné ne correspond pas au point de livraison de ces commandes.';
    end if;
  end if;

  update public.orders
  set status = 'delivered', delivered_at = now(), delivered_by = v_driver_id, updated_at = now()
  where delivery_token = any(p_delivery_tokens);

  insert into public.order_status_history (order_id, status, note, changed_by)
  select o.id, 'delivered',
         case when v_client.reception_qr then 'Livraison confirmée : bon de livraison + QR de réception du client.'
              else 'Livraison confirmée : bon de livraison + QR du point de livraison.' end,
         v_driver_id
  from public.orders o where o.delivery_token = any(p_delivery_tokens);

  update public.payments p set status = 'paid'
  from public.orders o
  where o.delivery_token = any(p_delivery_tokens) and p.order_id = o.id
    and p.method = 'cash_on_delivery' and p.status = 'pending';

  return v_matching;
end;
$$;
REVOKE ALL ON FUNCTION public.driver_confirm_handover(uuid[], text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_confirm_handover(uuid[], text, uuid) TO authenticated;

-- Single-scan delivery is replaced by the two-scan handover.
REVOKE EXECUTE ON FUNCTION public.driver_confirm_delivery(uuid, uuid[]) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.driver_lookup_point(uuid) FROM authenticated;

-- Drivers see their own deliveries, staff see all of them.
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
      'item_count', (select count(*) from public.order_items oi where oi.order_id = o.id)
    ) order by o.delivered_at desc)
    from public.orders o
    join public.clients c on c.id = o.client_id
    join public.client_delivery_points dp on dp.id = o.delivery_point_id
    left join public.profiles pr on pr.id = o.delivered_by
    where o.status = 'delivered'
      and o.delivered_at >= p_since
      and (v_is_staff or o.delivered_by = auth.uid())
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.driver_history(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_history(date) TO authenticated;

-- ---------------------------------------------------------------------------
-- VAT rates: set them per product in Table Editor → products → vat_rate (0, 7, 13 or 19).
-- ---------------------------------------------------------------------------
