-- One cart for a buyer across all of its suppliers:
--   * buyer_catalog(): the products of every active supplier of my Pro, with what each supplier lets me see
--     (prices, stock, origin) and my delivery points with each of them;
--   * place_multi_order(): sends the cart, one order per supplier, all or nothing. Each order follows exactly
--     the same rules as an order placed with that supplier selected (points, stock, credit limit, rights).
-- Run in Supabase SQL Editor AFTER 20261114_accounts.sql. Safe to rerun.

-- A right of mine within one of my supplier relations (same order as user_has_permission, for that relation).
create or replace function public.buyer_relation_can(p_client_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case when pr.account_status <> 'active' or pr.role <> 'customer' then false
      when public.feature_module(p_permission) is not null and not public.module_enabled(public.feature_module(p_permission)) then false
      else coalesce(
        (select mo.allowed from public.member_overrides mo where mo.user_id = pr.id and mo.org_id = pr.org_id and mo.permission = p_permission),
        (select (c.feature_overrides ->> p_permission)::boolean from public.clients c where c.id = p_client_id and p_permission like 'client.%'),
        (select bool_or(public.role_grants(r.id, p_permission)) from public.member_roles mr join public.org_roles r on r.id = mr.role_id
          where mr.user_id = pr.id and r.org_id = pr.org_id and (mr.valid_until is null or mr.valid_until > now()) and r.side = 'buyer'),
        false) end
    from public.profiles pr
    join public.clients c on c.id = p_client_id and c.buyer_org_id = pr.org_id and c.link_status = 'active' and c.active
    join public.organizations s on s.id = c.supplier_org_id and s.status = 'active'
    where pr.id = (select auth.uid())), false);
$$;
REVOKE ALL ON FUNCTION public.buyer_relation_can(uuid, text) FROM PUBLIC, anon, authenticated;

-- The suppliers I can order from right now (active link, active supplier, ordering allowed for me there).
create or replace function public.buyer_order_relations()
returns setof public.clients
language sql
stable
security definer
set search_path = ''
as $$
  select c.* from public.profiles pr
  join public.clients c on c.buyer_org_id = pr.org_id and c.link_status = 'active' and c.active
  join public.organizations s on s.id = c.supplier_org_id and s.status = 'active'
  where pr.id = (select auth.uid()) and pr.role = 'customer' and pr.account_status = 'active'
    and public.buyer_relation_can(c.id, 'client.order');
$$;
REVOKE ALL ON FUNCTION public.buyer_order_relations() FROM PUBLIC, anon, authenticated;

create or replace function public.buyer_catalog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'buyer_org_id', (select pr.org_id from public.profiles pr where pr.id = (select auth.uid())),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object(
        'client_id', c.id, 'org_id', s.id, 'name', s.name, 'business_name', c.business_name,
        'show_prices', c.show_prices, 'show_stock', c.show_stock, 'show_origin', c.show_origin,
        'current', c.id = (select pr.client_id from public.profiles pr where pr.id = (select auth.uid())),
        'delivery_points', coalesce((select jsonb_agg(jsonb_build_object('id', dp.id, 'label', dp.label, 'address_line', dp.address_line, 'city', dp.city) order by dp.label)
          from public.client_delivery_points dp where dp.client_id = c.id and dp.active), '[]'::jsonb)) order by s.name)
      from public.buyer_order_relations() c join public.organizations s on s.id = c.supplier_org_id), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'client_id', c.id, 'name', p.name, 'description', p.description, 'image_url', p.image_url,
        'unit_label', p.unit_label, 'created_at', p.created_at, 'category', cat.name,
        'price', case when c.show_prices then p.price end,
        'stock_quantity', case when c.show_stock then p.stock_quantity end,
        'origin_producer', case when c.show_origin then p.origin_producer end,
        'origin_region', case when c.show_origin then p.origin_region end,
        'origin_label', case when c.show_origin then p.origin_label end,
        'origin_note', case when c.show_origin then p.origin_note end) order by p.created_at desc)
      from public.buyer_order_relations() c
      join public.products p on p.org_id = c.supplier_org_id and p.active
      left join public.categories cat on cat.id = p.category_id), '[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.buyer_catalog() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_catalog() TO authenticated;

-- p_orders: [{client_id, items: [{product_id, quantity}], delivery_point_id?}]; date and note are shared.
-- Each order is placed with that supplier as the current one, then my current supplier is put back.
create or replace function public.place_multi_order(p_orders jsonb, p_requested_date date default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.active_uid();
  v_current uuid;
  v_order jsonb;
  v_client uuid;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'Connectez-vous avant de passer commande (compte actif requis).';
  end if;
  if jsonb_typeof(p_orders) is distinct from 'array' or jsonb_array_length(p_orders) = 0 then
    raise exception using errcode = '22023', message = 'La commande est vide.';
  end if;
  select pr.client_id into v_current from public.profiles pr where pr.id = v_uid;
  for v_order in select value from jsonb_array_elements(p_orders) loop
    v_client := nullif(v_order ->> 'client_id', '')::uuid;
    if v_client is null or not exists (select 1 from public.buyer_order_relations() c where c.id = v_client) then
      raise exception using errcode = '42501', message = 'Un des fournisseurs du panier ne vous permet pas de commander.';
    end if;
    -- Every product must belong to this supplier.
    if exists (select 1 from jsonb_array_elements(coalesce(v_order -> 'items', '[]'::jsonb)) line
               where not exists (select 1 from public.products p join public.clients c on c.id = v_client
                                 where p.id = nullif(line ->> 'product_id', '')::uuid and p.org_id = c.supplier_org_id)) then
      raise exception using errcode = '22023', message = 'Un produit du panier n’appartient pas à ce fournisseur.';
    end if;
    perform set_config('appro.link_write', 'on', true);
    update public.profiles set client_id = v_client where id = v_uid;
    perform set_config('appro.link_write', 'off', true);
    v_result := public.place_client_order(v_order -> 'items', nullif(v_order ->> 'delivery_point_id', '')::uuid, p_requested_date, p_note);
    v_results := v_results || jsonb_build_array(v_result || jsonb_build_object('client_id', v_client,
      'supplier_name', (select s.name from public.clients c join public.organizations s on s.id = c.supplier_org_id where c.id = v_client)));
  end loop;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set client_id = v_current where id = v_uid;
  perform set_config('appro.link_write', 'off', true);
  return v_results;
end;
$$;
REVOKE ALL ON FUNCTION public.place_multi_order(jsonb, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_multi_order(jsonb, date, text) TO authenticated;
