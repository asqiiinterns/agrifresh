-- Account administration: list every account, confirm (validate) an e-mail, disable or
-- re-enable an account. Run in Supabase SQL Editor AFTER 20261022_permissions.sql. Safe to rerun.
-- A disabled account cannot sign in (auth ban) and loses every right at once (profiles.disabled).

alter table public.profiles add column if not exists disabled boolean not null default false;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = (select auth.uid()) and pr.role in ('staff', 'admin', 'supervisor') and not pr.disabled
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles pr where pr.id = (select auth.uid()) and pr.role = 'admin' and not pr.disabled);
$$;

create or replace function public.current_client_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pr.client_id from public.profiles pr where pr.id = (select auth.uid()) and not pr.disabled;
$$;

create or replace function public.has_feature(p_feature text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when pr.disabled then false
      when pr.role = 'admin' then true
      else coalesce((
        select rp.allowed from public.role_permissions rp
        where rp.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role
          and rp.feature = p_feature
      ), false)
    end
    from public.profiles pr where pr.id = (select auth.uid())
  ), false);
$$;

create or replace function public.admin_list_accounts()
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
    select jsonb_agg(jsonb_build_object(
      'id', u.id,
      'email', u.email,
      'full_name', coalesce(pr.full_name, ''),
      'role', coalesce(pr.role::text, 'customer'),
      'confirmed', u.email_confirmed_at is not null,
      'disabled', coalesce(pr.disabled, false),
      'created_at', u.created_at,
      'last_sign_in_at', u.last_sign_in_at,
      'client_name', c.business_name,
      'is_self', u.id = auth.uid()
    ) order by (u.email_confirmed_at is null) desc, u.created_at desc)
    from auth.users u
    left join public.profiles pr on pr.id = u.id
    left join public.clients c on c.id = pr.client_id
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.admin_list_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_accounts() TO authenticated;

-- Validates the e-mail of a person the admin knows (lost or blocked confirmation e-mail).
create or replace function public.admin_confirm_account(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = p_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Compte introuvable.';
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.admin_confirm_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_confirm_account(uuid) TO authenticated;

create or replace function public.admin_set_account_disabled(p_user_id uuid, p_disabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if p_user_id = auth.uid() then
    raise exception using errcode = '22023', message = 'Vous ne pouvez pas désactiver votre propre compte.';
  end if;
  update public.profiles set disabled = p_disabled where id = p_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Compte introuvable.';
  end if;
  -- The ban blocks new sign-ins and token refreshes; profiles.disabled cuts rights at once.
  update auth.users set banned_until = case when p_disabled then now() + interval '100 years' else null end
  where id = p_user_id;
end;
$$;
REVOKE ALL ON FUNCTION public.admin_set_account_disabled(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_account_disabled(uuid, boolean) TO authenticated;


-- Own-row reads go through active_uid(): a disabled account reads nothing.
create or replace function public.active_uid()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pr.id from public.profiles pr where pr.id = (select auth.uid()) and not pr.disabled;
$$;
REVOKE ALL ON FUNCTION public.active_uid() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.active_uid() TO authenticated;

drop policy if exists "orders_read_own" on public.orders;
create policy "orders_read_own" on public.orders
  for select to authenticated using (customer_id = (select public.active_uid()));
drop policy if exists "order_items_read_own" on public.order_items;
create policy "order_items_read_own" on public.order_items
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = order_items.order_id and o.customer_id = (select public.active_uid()))
  );
drop policy if exists "status_history_read_own" on public.order_status_history;
create policy "status_history_read_own" on public.order_status_history
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = order_status_history.order_id and o.customer_id = (select public.active_uid()))
  );
drop policy if exists "invoices_read_own" on public.invoices;
create policy "invoices_read_own" on public.invoices
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = invoices.order_id and o.customer_id = (select public.active_uid()))
  );
drop policy if exists "payments_read_own" on public.payments;
create policy "payments_read_own" on public.payments
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = payments.order_id and o.customer_id = (select public.active_uid()))
  );

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
    'features', public.my_features(),
    'disabled', pr.disabled,
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
    raise exception using errcode = '28000', message = 'Connectez-vous avant de passer commande (compte actif requis).';
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
