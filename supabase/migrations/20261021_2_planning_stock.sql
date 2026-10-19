-- Team roles, production planning and per-client stock options, part 2/2.
-- Run in Supabase SQL Editor AFTER 20261021_1_roles.sql. Safe to rerun.
--
-- Roles: admin (everything, only role allowed to create clients and manage the team),
-- supervisor (orders, planning, invoices, claims, messages; "staff" is the legacy name),
-- production (production tab: preparation totals, execution queue, history),
-- driver (deliveries), customer (client).
-- Planning: accepted orders get a production_rank; staff choose before which order a
-- newly accepted order is executed.
-- Stock: per client record, "stock_managed" decides whether its orders check and reserve
-- stock, "show_stock" whether the client sees available quantities.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = (select auth.uid()) and pr.role in ('staff', 'admin', 'supervisor')
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles pr where pr.id = (select auth.uid()) and pr.role = 'admin');
$$;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

create or replace function public.is_production()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = (select auth.uid()) and pr.role in ('production', 'staff', 'admin', 'supervisor')
  );
$$;
REVOKE ALL ON FUNCTION public.is_production() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_production() TO authenticated;

create or replace function public.is_driver()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = (select auth.uid()) and pr.role in ('driver', 'staff', 'admin', 'supervisor')
  );
$$;

-- Production reads orders, lines and client names to plan the work.
drop policy if exists "orders_read_production" on public.orders;
create policy "orders_read_production" on public.orders
  for select to authenticated using ((select public.is_production()));
drop policy if exists "order_items_read_production" on public.order_items;
create policy "order_items_read_production" on public.order_items
  for select to authenticated using ((select public.is_production()));
drop policy if exists "status_history_read_production" on public.order_status_history;
create policy "status_history_read_production" on public.order_status_history
  for select to authenticated using ((select public.is_production()));
drop policy if exists "clients_read_production" on public.clients;
create policy "clients_read_production" on public.clients
  for select to authenticated using ((select public.is_production()));

-- Only admins create client records; supervisors view and edit them.
drop policy if exists "clients_staff_all" on public.clients;
drop policy if exists "clients_staff_select" on public.clients;
create policy "clients_staff_select" on public.clients
  for select to authenticated using ((select public.is_staff()));
drop policy if exists "clients_staff_update" on public.clients;
create policy "clients_staff_update" on public.clients
  for update to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "clients_admin_insert" on public.clients;
create policy "clients_admin_insert" on public.clients
  for insert to authenticated with check ((select public.is_admin()));

-- Team management by admins (roles are never editable from the profiles table).
create or replace function public.admin_list_team()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', pr.id, 'email', u.email, 'full_name', pr.full_name, 'role', pr.role)
                     order by pr.role, u.email)
    from public.profiles pr
    join auth.users u on u.id = pr.id
    where pr.role <> 'customer'
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.admin_list_team() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_team() TO authenticated;

create or replace function public.admin_set_role(p_email text, p_role public.app_role)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  select u.id into v_user_id from auth.users u where lower(u.email) = lower(btrim(p_email));
  if not found then
    raise exception using errcode = 'P0002', message = 'Aucun compte avec cet e-mail : la personne doit d’abord activer son accès dans l’application.';
  end if;
  if v_user_id = auth.uid() then
    raise exception using errcode = '22023', message = 'Vous ne pouvez pas modifier votre propre rôle.';
  end if;
  if p_role <> 'customer' and exists (select 1 from public.profiles pr where pr.id = v_user_id and pr.client_id is not null) then
    raise exception using errcode = '22023', message = 'Ce compte est rattaché à une fiche client : utilisez une autre adresse pour l’équipe.';
  end if;
  update public.profiles set role = p_role where id = v_user_id;
  return jsonb_build_object('id', v_user_id, 'role', p_role);
end;
$$;
REVOKE ALL ON FUNCTION public.admin_set_role(text, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_role(text, public.app_role) TO authenticated;

-- Legacy "staff" accounts become supervisors.
update public.profiles set role = 'supervisor' where role = 'staff';

-- ---------------------------------------------------------------------------
-- Planning and stock columns
-- ---------------------------------------------------------------------------

alter table public.orders add column if not exists production_rank numeric;
alter table public.orders add column if not exists stock_reserved boolean not null default true;
create index if not exists orders_production_rank_idx on public.orders(production_rank) where production_rank is not null;

alter table public.clients add column if not exists stock_managed boolean not null default true;
alter table public.clients add column if not exists show_stock boolean not null default false;

-- Orders that already gave their stock back.
update public.orders set stock_reserved = false
where status in ('declined', 'cancelled', 'awaiting_client') and stock_reserved;

-- Existing accepted orders join the queue by delivery day, then order number.
update public.orders o set production_rank = q.rank
from (
  select id, row_number() over (order by requested_delivery_date nulls last, order_number) as rank
  from public.orders
  where status in ('confirmed', 'preparing', 'ready') and production_rank is null
) q
where o.id = q.id and o.production_rank is null;

-- Places an accepted order before another one in the execution queue (or at the end).
create or replace function public.staff_schedule_order(p_order_id uuid, p_before_order_id uuid default null)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.order_status;
  v_before_rank numeric;
  v_previous_rank numeric;
  v_rank numeric;
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Accès réservé à l’administration.';
  end if;

  -- Serialize queue changes.
  perform pg_advisory_xact_lock(hashtext('agrifresh_production_queue'));

  select o.status into v_status from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  if v_status not in ('confirmed', 'preparing', 'ready') then
    raise exception using errcode = '22023', message = 'Seules les commandes acceptées se planifient.';
  end if;

  if p_before_order_id is null or p_before_order_id = p_order_id then
    select coalesce(max(o.production_rank), 0) + 1 into v_rank
    from public.orders o
    where o.status in ('confirmed', 'preparing', 'ready') and o.id <> p_order_id;
  else
    select o.production_rank into v_before_rank
    from public.orders o
    where o.id = p_before_order_id and o.status in ('confirmed', 'preparing', 'ready');
    if v_before_rank is null then
      raise exception using errcode = '22023', message = 'La commande de référence n’est plus dans la file de production.';
    end if;
    select max(o.production_rank) into v_previous_rank
    from public.orders o
    where o.status in ('confirmed', 'preparing', 'ready') and o.id <> p_order_id and o.production_rank < v_before_rank;
    v_rank := case when v_previous_rank is null then v_before_rank - 1 else (v_previous_rank + v_before_rank) / 2 end;
  end if;

  update public.orders set production_rank = v_rank, updated_at = now() where id = p_order_id;
  return v_rank;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_schedule_order(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_schedule_order(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Status workflow: production may start and finish preparation; stock is given
-- back only when the order actually holds it.
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
  v_actor_id uuid := auth.uid();
  v_order public.orders%rowtype;
  v_allowed public.order_status[];
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_invoice_status text;
  v_other_orders int;
begin
  if not public.is_staff() and not (public.is_production() and p_status in ('preparing', 'ready')) then
    raise exception using errcode = '42501', message = 'Accès réservé au personnel AgriFresh.';
  end if;

  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
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
-- Client reconfirmation: reserves stock only for clients under stock management
-- ---------------------------------------------------------------------------

create or replace function public.client_respond_order(p_order_id uuid, p_accept boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid := auth.uid();
  v_client_id uuid := public.current_client_id();
  v_client public.clients%rowtype;
  v_order public.orders%rowtype;
  v_line record;
  v_product public.products%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_client_id is null then
    raise exception using errcode = '42501', message = 'Votre compte n’est rattaché à aucune fiche client.';
  end if;
  select c.* into v_client from public.clients c where c.id = v_client_id;

  select o.* into v_order from public.orders o where o.id = p_order_id and o.client_id = v_client_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  if v_order.status <> 'awaiting_client' then
    raise exception using errcode = '22023', message = 'Cette commande n’attend pas votre confirmation.';
  end if;

  if p_accept then
    if v_client.stock_managed then
      for v_line in
        select oi.product_id, sum(oi.quantity) as quantity, min(oi.product_name_snapshot) as name
        from public.order_items oi where oi.order_id = p_order_id
        group by oi.product_id order by oi.product_id
      loop
        if v_line.product_id is null then
          raise exception using errcode = 'P0002', message = format('%s n’est plus disponible : contactez AgriFresh.', v_line.name);
        end if;
        select p.* into v_product from public.products p where p.id = v_line.product_id for update;
        if not found or not v_product.active or v_product.stock_quantity < v_line.quantity then
          raise exception using errcode = '22023', message = format('Stock insuffisant pour %s : contactez AgriFresh.', v_line.name);
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
    values (p_order_id, 'confirmed', coalesce(v_note, 'Commande reconfirmée par le client.'), v_customer_id);
    update public.payments set status = 'pending' where order_id = p_order_id and status = 'cancelled';

    if v_order.client_invoice_id is null and v_client.invoice_mode = 'auto' then
      perform public.create_client_invoice(v_client_id, array[p_order_id], v_customer_id, false);
    end if;
  else
    update public.orders set status = 'cancelled', status_note = v_note, updated_at = now() where id = p_order_id;
    insert into public.order_status_history (order_id, status, note, changed_by)
    values (p_order_id, 'cancelled', coalesce(v_note, 'Refusée par le client.'), v_customer_id);
  end if;

  return jsonb_build_object('id', p_order_id, 'status', case when p_accept then 'confirmed' else 'cancelled' end);
end;
$$;
REVOKE ALL ON FUNCTION public.client_respond_order(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_respond_order(uuid, boolean, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Account summary: stock display option
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
      'show_origin', c.show_origin,
      'show_stock', c.show_stock,
      'stock_managed', c.stock_managed,
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
-- Order placement: stock checked and reserved only under stock management
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
  values (v_order_id, 'pending', 'Commande transmise par le client.', v_customer_id);

  insert into public.payments (order_id, method, status, amount, currency)
  values (v_order_id, 'cash_on_delivery', 'pending', v_subtotal, 'TND');

  return jsonb_build_object('id', v_order_id, 'order_number', v_order_number, 'total', v_subtotal, 'status', 'pending');
end;
$$;
REVOKE ALL ON FUNCTION public.place_client_order(jsonb, uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_client_order(jsonb, uuid, date, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- First admin (run once, replacing the e-mail):
--   update public.profiles set role = 'admin'
--   where id = (select id from auth.users where email = 'admin@exemple.com');
-- Then manage the team from the app: Compte → Équipe.
-- ---------------------------------------------------------------------------
