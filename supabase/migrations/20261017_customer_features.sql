-- Customer features migration: favorites and secure cash-on-delivery checkout.
-- Run once in Supabase SQL Editor AFTER schema.sql.

create table if not exists public.customer_favorites (
  customer_id uuid not null references public.profiles(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (customer_id, product_id)
);

alter table public.customer_favorites enable row level security;
grant select, insert, delete on public.customer_favorites to authenticated;

drop policy if exists "favorites_read_own" on public.customer_favorites;
create policy "favorites_read_own" on public.customer_favorites
  for select to authenticated using (customer_id = (select auth.uid()));
drop policy if exists "favorites_insert_own" on public.customer_favorites;
create policy "favorites_insert_own" on public.customer_favorites
  for insert to authenticated with check (customer_id = (select auth.uid()));
drop policy if exists "favorites_delete_own" on public.customer_favorites;
create policy "favorites_delete_own" on public.customer_favorites
  for delete to authenticated using (customer_id = (select auth.uid()));

create or replace function public.place_customer_order(
  p_items jsonb,
  p_address jsonb,
  p_customer_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid := auth.uid();
  v_item record;
  v_product public.products%rowtype;
  v_product_id uuid;
  v_quantity numeric(12,3);
  v_line_total numeric(12,3);
  v_subtotal numeric(12,3) := 0;
  v_delivery_fee numeric(12,3) := 0;
  v_total numeric(12,3);
  v_lines jsonb := '[]'::jsonb;
  v_address jsonb;
  v_recipient_name text;
  v_phone text;
  v_address_line text;
  v_city text;
  v_notes text;
  v_order_id uuid;
  v_order_number bigint;
begin
  if v_customer_id is null then
    raise exception using errcode = '28000', message = 'Connectez-vous avant de passer commande.';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Le panier est vide.';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'Le panier est vide.';
  end if;

  if jsonb_typeof(p_address) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Les informations de livraison sont invalides.';
  end if;

  v_recipient_name := btrim(coalesce(p_address ->> 'recipient_name', ''));
  v_phone := btrim(coalesce(p_address ->> 'phone', ''));
  v_address_line := btrim(coalesce(p_address ->> 'address_line', ''));
  v_city := btrim(coalesce(p_address ->> 'city', ''));
  v_notes := nullif(btrim(coalesce(p_address ->> 'notes', '')), '');

  if v_recipient_name = '' or v_phone = '' or v_address_line = '' or v_city = '' then
    raise exception using errcode = '22023', message = 'Nom, téléphone, adresse et ville sont obligatoires.';
  end if;

  if not exists (select 1 from public.profiles pr where pr.id = v_customer_id) then
    raise exception using errcode = '23503', message = 'Le profil client est introuvable. Reconnectez-vous ou recréez votre compte.';
  end if;

  v_address := jsonb_build_object(
    'recipient_name', v_recipient_name,
    'phone', v_phone,
    'address_line', v_address_line,
    'city', v_city,
    'notes', v_notes
  );

  -- Aggregate duplicate product lines and lock products in a stable order to
  -- validate stock and prices atomically, preventing client-supplied totals.
  for v_item in
    select
      (line.value ->> 'product_id')::uuid as product_id,
      sum((line.value ->> 'quantity')::numeric)::numeric(12,3) as quantity
    from jsonb_array_elements(p_items) as line(value)
    group by (line.value ->> 'product_id')::uuid
    order by (line.value ->> 'product_id')::uuid
  loop
    v_product_id := v_item.product_id;
    v_quantity := v_item.quantity;

    if v_quantity <= 0 or v_quantity > 1000 then
      raise exception using errcode = '22023', message = 'La quantité demandée est invalide.';
    end if;

    select p.* into v_product
    from public.products p
    where p.id = v_product_id
    for update;

    if not found or not v_product.active then
      raise exception using errcode = 'P0002', message = 'Un produit du panier n’est plus disponible.';
    end if;

    if v_product.stock_quantity < v_quantity then
      raise exception using errcode = '22023', message = format('Stock insuffisant pour %s.', v_product.name);
    end if;

    v_line_total := round(v_product.price * v_quantity, 3);
    v_subtotal := v_subtotal + v_line_total;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id,
      'name', v_product.name,
      'unit', v_product.unit_label,
      'unit_price', v_product.price,
      'quantity', v_quantity,
      'line_total', v_line_total
    ));
  end loop;

  if jsonb_array_length(v_lines) = 0 then
    raise exception using errcode = '22023', message = 'Le panier ne contient aucun produit valide.';
  end if;

  v_total := v_subtotal + v_delivery_fee;

  insert into public.orders (
    customer_id, status, address_snapshot, subtotal, delivery_fee, total, currency, customer_note
  ) values (
    v_customer_id, 'pending', v_address, v_subtotal, v_delivery_fee, v_total, 'TND', nullif(btrim(coalesce(p_customer_note, '')), '')
  ) returning id, order_number into v_order_id, v_order_number;

  insert into public.customer_addresses (
    customer_id, label, recipient_name, phone, address_line, city, notes, is_default
  ) values (
    v_customer_id, 'Livraison', v_recipient_name, v_phone, v_address_line, v_city, v_notes, false
  );

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
    set stock_quantity = stock_quantity - (v_item.value ->> 'quantity')::numeric,
        updated_at = now()
    where id = (v_item.value ->> 'product_id')::uuid;
  end loop;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (v_order_id, 'pending', 'Commande reçue depuis AgriFresh.', v_customer_id);

  insert into public.payments (order_id, method, status, amount, currency)
  values (v_order_id, 'cash_on_delivery', 'pending', v_total, 'TND');

  return jsonb_build_object(
    'id', v_order_id,
    'order_number', v_order_number,
    'subtotal', v_subtotal,
    'delivery_fee', v_delivery_fee,
    'total', v_total,
    'currency', 'TND',
    'status', 'pending',
    'payment_method', 'cash_on_delivery'
  );
end;
$$;

revoke all on function public.place_customer_order(jsonb, jsonb, text) from public, anon;
grant execute on function public.place_customer_order(jsonb, jsonb, text) to authenticated;
