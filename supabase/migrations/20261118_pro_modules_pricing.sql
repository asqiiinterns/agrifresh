-- Lot 3 — the base of the business model:
--   * modules per Pro: Appro+ sets the default of each module (Appro+ → Paramétrage → Modules), then includes
--     or excludes a module for one Pro (its plan). Within what is included, the Pro's Responsable switches
--     each module on or off for its own team and clients;
--   * prices and discounts set by each supplier, in one rule engine:
--       kinds      percentage, negotiated net price, X bought + Y free, quantity tiers;
--       conditions minimum order amount, minimum quantity, period, weekday, first order, loyalty (N orders);
--       targets    all clients, a price group, or one client; on all products, categories or chosen products;
--     the best discount wins, "stackable" rules add up on top. Prices are computed by the server for the
--     live cart and for every order (placed by the buyer, entered by the supplier, recurring, changed).
-- Run in Supabase SQL Editor AFTER 20261117_buyer_journey.sql. Safe to rerun.

-- ===========================================================================
-- Modules per Pro.
-- ===========================================================================
create table if not exists public.org_modules (
  org_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,
  granted boolean,           -- Appro+: included (true) / excluded (false) / platform default (null)
  enabled boolean,           -- the Pro: switched off (false) / on (null)
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  primary key (org_id, key)
);
alter table public.org_modules enable row level security;
GRANT SELECT ON public.org_modules TO authenticated;
drop policy if exists "org_modules_read" on public.org_modules;
create policy "org_modules_read" on public.org_modules for select to authenticated
  using (org_id = public.current_org_id() or public.platform_can('platform.pros.view'));

create or replace function public.module_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['decide', 'production', 'planning', 'delivery', 'delivery_qr', 'signature', 'fleet', 'invoicing', 'reminders',
    'exports', 'returns', 'claims', 'client_messages', 'team_messages', 'attachments', 'needs_reply', 'staff_orders',
    'recurring', 'order_tags', 'stock', 'origin', 'reconfirm', 'calendar', 'leaves', 'incidents', 'location', 'stats',
    'audit', 'languages', 'home_custom', 'pricing'];
$$;

-- Modules about the account's own team follow its own Pro; the others follow the supplier
-- (for a buyer: the supplier of the relation it works with).
create or replace function public.module_own_scope(p_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_key = any(array['team_messages', 'calendar', 'leaves', 'location', 'audit', 'stats', 'languages', 'home_custom']);
$$;

create or replace function public.module_default(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select m.enabled from public.app_modules m where m.key = p_key), true);
$$;
REVOKE ALL ON FUNCTION public.module_default(text) FROM PUBLIC, anon, authenticated;

-- A module for one Pro: included in its plan (or by default), and not switched off by the Pro.
create or replace function public.module_enabled_for(p_org uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_org is null then public.module_default(p_key)
    else coalesce(om.granted, public.module_default(p_key)) and coalesce(om.enabled, true) end
  from (select 1) one
  left join public.org_modules om on om.org_id = p_org and om.key = p_key;
$$;
REVOKE ALL ON FUNCTION public.module_enabled_for(uuid, text) FROM PUBLIC, anon, authenticated;

-- The Pro whose modules apply to an account for a module.
create or replace function public.user_module_org(p_user uuid, p_key text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when pr.role = 'platform' then null
    when pr.role = 'customer' and not public.module_own_scope(p_key) then (select c.supplier_org_id from public.clients c where c.id = pr.client_id)
    else pr.org_id end
  from public.profiles pr where pr.id = p_user;
$$;
REVOKE ALL ON FUNCTION public.user_module_org(uuid, text) FROM PUBLIC, anon, authenticated;

-- Same signature as before, now for the Pro of the signed-in account (platform default without one).
create or replace function public.module_enabled(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.module_enabled_for(public.user_module_org((select auth.uid()), p_key), p_key);
$$;
REVOKE ALL ON FUNCTION public.module_enabled(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.module_enabled(text) TO authenticated;

-- Module guards: same as 20261107 (has_feature, client options), plus a second pass that makes a
-- client option follow the modules of that client's supplier.
create or replace function public.apply_module_guards()
returns int
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_def text;
  v_new text;
  v_count int := 0;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'has_feature' and p.prosrc like '%has_feature_base%') then
    v_def := pg_get_functiondef('public.has_feature(text)'::regprocedure);
    execute replace(v_def, 'FUNCTION public.has_feature(', 'FUNCTION public.has_feature_base(');
    execute 'REVOKE ALL ON FUNCTION public.has_feature_base(text) FROM PUBLIC, anon, authenticated';
    execute $f$
      create or replace function public.has_feature(p_feature text)
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $body$
        select (public.feature_module(p_feature) is null or public.module_enabled(public.feature_module(p_feature)))
          and public.has_feature_base(p_feature);
      $body$
    $f$;
    v_count := v_count + 1;
  end if;

  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname not in ('apply_module_guards', 'has_feature', 'has_feature_base', 'module_enabled', 'module_enabled_for')
      and p.prosrc ~ '\m(c|v_client)\.(delivery_signature|payment_reminders|scan_delivery_note|scan_client_qr|reception_qr|show_origin|show_stock|stock_managed|reconfirm_declined)\M'
      and p.prosrc not like '%public.module_enabled(''%'
      and p.prosrc not like '%public.module_enabled_for(%'
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := v_def;
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(delivery_signature)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''signature''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(payment_reminders)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''reminders''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(scan_delivery_note|scan_client_qr|reception_qr)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''delivery_qr''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(show_origin)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''origin''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(show_stock|stock_managed)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''stock''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(reconfirm_declined)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''reconfirm''))', 'g');
    if v_new <> v_def then
      execute v_new;
      v_count := v_count + 1;
    end if;
  end loop;

  -- Second pass: (c.option and module_enabled('m')) -> the modules of c's supplier.
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname not in ('apply_module_guards', 'has_feature', 'has_feature_base', 'module_enabled', 'module_enabled_for')
      and p.prosrc ~ '\((c|v_client)\.\w+ and public\.module_enabled\(''\w+''\)\)'
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def, '\((c|v_client)\.(\w+) and public\.module_enabled\(''(\w+)''\)\)',
      '(\1.\2 and public.module_enabled_for(\1.supplier_org_id, ''\3''))', 'g');
    if v_new <> v_def then
      execute v_new;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;
REVOKE ALL ON FUNCTION public.apply_module_guards() FROM PUBLIC, anon, authenticated;

select public.apply_module_guards();

-- Rights: the modules of the account's Pro (or of the relation's supplier for a buyer).
DO $$
DECLARE
  v_def text;
BEGIN
  v_def := pg_get_functiondef('public.user_has_permission(uuid, text)'::regprocedure);
  IF v_def like '%not public.module_enabled(public.feature_module(p_permission))%' THEN
    EXECUTE replace(v_def, 'not public.module_enabled(public.feature_module(p_permission))',
      'not public.module_enabled_for(public.user_module_org(pr.id, public.feature_module(p_permission)), public.feature_module(p_permission))');
  END IF;
  v_def := pg_get_functiondef('public.buyer_relation_can(uuid, text)'::regprocedure);
  IF v_def like '%not public.module_enabled(public.feature_module(p_permission))%' THEN
    EXECUTE replace(v_def, 'not public.module_enabled(public.feature_module(p_permission))',
      'not public.module_enabled_for((select c2.supplier_org_id from public.clients c2 where c2.id = p_client_id), public.feature_module(p_permission))');
  END IF;
END;
$$;

-- Appro+ → Paramétrage → Modules: the default of each module for every Pro.
create or replace function public.admin_set_module(p_key text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Seule l’équipe Appro+ fixe les modules par défaut. Pour votre Pro : Paramétrage → Modules.';
  end if;
  if not (p_key = any(public.module_keys())) then
    raise exception using errcode = '22023', message = 'Module inconnu.';
  end if;
  insert into public.app_modules (key, enabled, updated_at, updated_by) values (p_key, coalesce(p_enabled, true), now(), auth.uid())
  on conflict (key) do update set enabled = excluded.enabled, updated_at = now(), updated_by = auth.uid();
end;
$$;
REVOKE ALL ON FUNCTION public.admin_set_module(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_module(text, boolean) TO authenticated;

-- The platform defaults (for the Appro+ page), whoever asks.
create or replace function public.platform_modules_defaults()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_object_agg(k, public.module_default(k)) from unnest(public.module_keys()) as k;
$$;
REVOKE ALL ON FUNCTION public.platform_modules_defaults() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_modules_defaults() TO authenticated;

-- The modules of one Pro: default, Appro+ decision, Pro switch, result.
create or replace function public.org_modules_state(p_org_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(p_org_id, public.current_org_id());
begin
  if v_org is null or not (public.platform_can('platform.pros.view') or v_org = public.current_org_id()) then
    raise exception using errcode = '42501', message = 'Accès refusé.';
  end if;
  return (select jsonb_object_agg(k, jsonb_build_object(
      'default', public.module_default(k),
      'granted', om.granted,
      'included', coalesce(om.granted, public.module_default(k)),
      'enabled', coalesce(om.enabled, true),
      'effective', public.module_enabled_for(v_org, k)))
    from unnest(public.module_keys()) as k
    left join public.org_modules om on om.org_id = v_org and om.key = k);
end;
$$;
REVOKE ALL ON FUNCTION public.org_modules_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_modules_state(uuid) TO authenticated;

-- The Pro's Responsable switches a module of its plan on or off.
create or replace function public.org_set_module(p_key text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not (public.is_admin() or public.is_org_owner(v_org)) then
    raise exception using errcode = '42501', message = 'Seul le Responsable du Pro active ou désactive ses modules.';
  end if;
  if not (p_key = any(public.module_keys())) then
    raise exception using errcode = '22023', message = 'Module inconnu.';
  end if;
  if coalesce(p_enabled, true) and not coalesce((select om.granted from public.org_modules om where om.org_id = v_org and om.key = p_key), public.module_default(p_key)) then
    raise exception using errcode = '42501', message = 'Ce module n’est pas inclus dans votre formule. Contactez l’équipe Appro+.';
  end if;
  insert into public.org_modules (org_id, key, enabled, updated_at, updated_by)
  values (v_org, p_key, case when coalesce(p_enabled, true) then null else false end, now(), auth.uid())
  on conflict (org_id, key) do update set enabled = excluded.enabled, updated_at = now(), updated_by = auth.uid();
end;
$$;
REVOKE ALL ON FUNCTION public.org_set_module(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_set_module(text, boolean) TO authenticated;

-- Appro+ includes (true) or excludes (false) a module for one Pro, or puts it back on the default (null).
create or replace function public.platform_set_org_module(p_org_id uuid, p_key text, p_granted boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Seule l’équipe Appro+ gère la formule d’un Pro.';
  end if;
  if not (p_key = any(public.module_keys())) then
    raise exception using errcode = '22023', message = 'Module inconnu.';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org_id) then
    raise exception using errcode = 'P0002', message = 'Pro introuvable.';
  end if;
  insert into public.org_modules (org_id, key, granted, updated_at, updated_by) values (p_org_id, p_key, p_granted, now(), auth.uid())
  on conflict (org_id, key) do update set granted = excluded.granted, updated_at = now(), updated_by = auth.uid();
end;
$$;
REVOKE ALL ON FUNCTION public.platform_set_org_module(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_org_module(uuid, text, boolean) TO authenticated;

-- ===========================================================================
-- Prices and discounts.
-- ===========================================================================
create table if not exists public.price_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  created_at timestamptz not null default now()
);
create unique index if not exists price_groups_name_idx on public.price_groups(org_id, lower(name));
alter table public.price_groups enable row level security;
GRANT SELECT ON public.price_groups TO authenticated;
drop policy if exists "price_groups_read" on public.price_groups;
create policy "price_groups_read" on public.price_groups for select to authenticated using (org_id = public.current_org_id());

alter table public.clients add column if not exists price_group_id uuid references public.price_groups(id) on delete set null;

create table if not exists public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  kind text not null check (kind in ('percent', 'net_price', 'free_units', 'tiers')),
  value numeric(12,3),                       -- percentage (percent) or price excl. VAT (net_price)
  buy_qty numeric(12,3),                     -- free_units: for every buy_qty + free_qty ordered,
  free_qty numeric(12,3),                    --             free_qty are free
  tiers jsonb not null default '[]'::jsonb,  -- tiers: [{"min_qty": 10, "percent": 5}, ...]
  target text not null default 'all' check (target in ('all', 'group', 'client')),
  price_group_id uuid references public.price_groups(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  product_scope text not null default 'all' check (product_scope in ('all', 'category', 'products')),
  category_ids uuid[] not null default '{}',
  product_ids uuid[] not null default '{}',
  min_order_amount numeric(12,3),
  min_line_qty numeric(12,3),
  starts_on date,
  ends_on date,
  weekdays int[] not null default '{}',      -- ISO days 1 (Monday) .. 7; empty = every day
  first_order_only boolean not null default false,
  min_past_orders int,
  stackable boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);
create index if not exists pricing_rules_org_idx on public.pricing_rules(org_id) where active;
alter table public.pricing_rules enable row level security;
GRANT SELECT ON public.pricing_rules TO authenticated;
drop policy if exists "pricing_rules_read" on public.pricing_rules;
create policy "pricing_rules_read" on public.pricing_rules for select to authenticated using (org_id = public.current_org_id());

alter table public.order_items add column if not exists list_price numeric(12,3);
alter table public.order_items add column if not exists discount_label text;
alter table public.orders add column if not exists discount_total numeric(12,3) not null default 0;

-- Does a rule cover a product?
create or replace function public.pricing_rule_covers(p_rule public.pricing_rules, p_product public.products)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_rule.product_scope
    when 'all' then true
    when 'products' then p_product.id = any(p_rule.product_ids)
    else p_product.category_id = any(p_rule.category_ids)
      or exists (select 1 from public.categories cat where cat.id = p_product.category_id and cat.parent_id = any(p_rule.category_ids))
  end;
$$;
REVOKE ALL ON FUNCTION public.pricing_rule_covers(public.pricing_rules, public.products) FROM PUBLIC, anon, authenticated;

-- The heart of the engine: prices of a cart for one client record (supplier relation).
-- p_items: [{product_id, quantity}]; p_order_id: the order being priced (not counted as a past order).
-- Returns {lines: {product_id: {list_price, unit_price, line_total, discount, label}}, subtotal_list,
--          subtotal, discount, applied: [names], next: [{name, missing}]}.
create or replace function public.price_lines(p_client_id uuid, p_items jsonb, p_order_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_client public.clients%rowtype;
  v_today date := (now() at time zone 'Africa/Tunis')::date;
  v_dow int := extract(isodow from (now() at time zone 'Africa/Tunis'))::int;
  v_past int;
  v_on boolean;
  v_subtotal_list numeric := 0;
  v_cart jsonb;
  v_rules public.pricing_rules[];
  v_rule public.pricing_rules;
  v_line record;
  v_base numeric;
  v_net numeric;
  v_factor numeric;
  v_best numeric;
  v_best_label text;
  v_stack numeric;
  v_labels text[];
  v_total numeric;
  v_lines jsonb := '{}'::jsonb;
  v_subtotal numeric := 0;
  v_applied text[] := '{}';
  v_next jsonb := '[]'::jsonb;
begin
  select c.* into v_client from public.clients c where c.id = p_client_id;
  if not found then
    return jsonb_build_object('lines', '{}'::jsonb, 'subtotal_list', 0, 'subtotal', 0, 'discount', 0, 'applied', '[]'::jsonb, 'next', '[]'::jsonb);
  end if;
  v_on := public.module_enabled_for(v_client.supplier_org_id, 'pricing');

  select coalesce(jsonb_agg(jsonb_build_object('product_id', q.product_id, 'quantity', q.quantity)), '[]'::jsonb) into v_cart
  from (select (line.value ->> 'product_id')::uuid as product_id, sum((line.value ->> 'quantity')::numeric) as quantity
        from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) as line(value)
        where nullif(line.value ->> 'product_id', '') is not null and (line.value ->> 'quantity')::numeric > 0
        group by 1) q;

  select coalesce(sum(round(p.price * (q.value ->> 'quantity')::numeric, 3)), 0) into v_subtotal_list
  from jsonb_array_elements(v_cart) q join public.products p on p.id = (q.value ->> 'product_id')::uuid and p.org_id = v_client.supplier_org_id;

  select count(*) into v_past from public.orders o
  where o.client_id = v_client.id and o.status not in ('cancelled', 'declined') and o.id is distinct from p_order_id;

  if v_on then
    select coalesce(array_agg(r order by r.created_at), '{}') into v_rules
    from public.pricing_rules r
    where r.org_id = v_client.supplier_org_id and r.active
      and (r.target = 'all' or (r.target = 'group' and r.price_group_id = v_client.price_group_id) or (r.target = 'client' and r.client_id = v_client.id))
      and (r.starts_on is null or r.starts_on <= v_today) and (r.ends_on is null or r.ends_on >= v_today)
      and (cardinality(r.weekdays) = 0 or v_dow = any(r.weekdays))
      and (not r.first_order_only or v_past = 0)
      and (r.min_past_orders is null or v_past >= r.min_past_orders)
      and (r.min_order_amount is null or v_subtotal_list >= r.min_order_amount);

    -- What the buyer could still get by adding to the cart.
    select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'missing', round(r.min_order_amount - v_subtotal_list, 3)) order by r.min_order_amount), '[]'::jsonb)
    into v_next
    from public.pricing_rules r
    where r.org_id = v_client.supplier_org_id and r.active and r.min_order_amount is not null and v_subtotal_list < r.min_order_amount
      and (r.target = 'all' or (r.target = 'group' and r.price_group_id = v_client.price_group_id) or (r.target = 'client' and r.client_id = v_client.id))
      and (r.starts_on is null or r.starts_on <= v_today) and (r.ends_on is null or r.ends_on >= v_today)
      and (cardinality(r.weekdays) = 0 or v_dow = any(r.weekdays))
      and (not r.first_order_only or v_past = 0)
      and (r.min_past_orders is null or v_past >= r.min_past_orders);
  else
    v_rules := '{}';
  end if;

  for v_line in
    select p as product, (q.value ->> 'quantity')::numeric as quantity from jsonb_array_elements(v_cart) q
    join public.products p on p.id = (q.value ->> 'product_id')::uuid and p.org_id = v_client.supplier_org_id
  loop
    v_base := (v_line.product).price;
    v_labels := '{}';
    -- Negotiated net price: the lowest one that applies, if lower than the catalogue price.
    v_net := null;
    foreach v_rule in array v_rules loop
      if v_rule.kind = 'net_price' and v_rule.value is not null and public.pricing_rule_covers(v_rule, v_line.product)
         and (v_rule.min_line_qty is null or v_line.quantity >= v_rule.min_line_qty)
         and v_rule.value < coalesce(v_net, v_base) then
        v_net := v_rule.value;
        v_best_label := v_rule.name;
      end if;
    end loop;
    if v_net is not null then
      v_base := v_net;
      v_labels := array_append(v_labels, v_best_label);
      v_applied := array_append(v_applied, v_best_label);
    end if;

    -- Discounts: the best one, then the stackable ones on top.
    v_best := 1;
    v_best_label := null;
    v_stack := 1;
    foreach v_rule in array v_rules loop
      continue when v_rule.kind = 'net_price' or not public.pricing_rule_covers(v_rule, v_line.product)
        or (v_rule.min_line_qty is not null and v_line.quantity < v_rule.min_line_qty);
      v_factor := case v_rule.kind
        when 'percent' then 1 - least(greatest(coalesce(v_rule.value, 0), 0), 100) / 100
        when 'tiers' then 1 - coalesce((select least(greatest((t ->> 'percent')::numeric, 0), 100) from jsonb_array_elements(v_rule.tiers) t
            where (t ->> 'min_qty')::numeric <= v_line.quantity order by (t ->> 'min_qty')::numeric desc limit 1), 0) / 100
        when 'free_units' then case when coalesce(v_rule.buy_qty, 0) > 0 and coalesce(v_rule.free_qty, 0) > 0
            then (v_line.quantity - floor(v_line.quantity / (v_rule.buy_qty + v_rule.free_qty)) * v_rule.free_qty) / v_line.quantity
            else 1 end
        else 1 end;
      continue when v_factor >= 1;
      if v_rule.stackable then
        v_stack := v_stack * v_factor;
        v_labels := array_append(v_labels, v_rule.name);
        v_applied := array_append(v_applied, v_rule.name);
      elsif v_factor < v_best then
        v_best := v_factor;
        v_best_label := v_rule.name;
      end if;
    end loop;
    if v_best_label is not null then
      v_labels := array_append(v_labels, v_best_label);
      v_applied := array_append(v_applied, v_best_label);
    end if;

    v_total := round(v_base * v_line.quantity * v_best * v_stack, 3);
    v_subtotal := v_subtotal + v_total;
    v_lines := v_lines || jsonb_build_object((v_line.product).id::text, jsonb_build_object(
      'list_price', (v_line.product).price,
      'unit_price', round(v_total / v_line.quantity, 3),
      'quantity', v_line.quantity,
      'line_total', v_total,
      'discount', round((v_line.product).price * v_line.quantity, 3) - v_total,
      'label', nullif(array_to_string(v_labels, ' + '), '')));
  end loop;

  return jsonb_build_object('lines', v_lines, 'subtotal_list', v_subtotal_list, 'subtotal', v_subtotal,
    'discount', v_subtotal_list - v_subtotal,
    'applied', (select coalesce(jsonb_agg(distinct a), '[]'::jsonb) from unnest(v_applied) a),
    'next', v_next);
end;
$$;
REVOKE ALL ON FUNCTION public.price_lines(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;

-- Applies the engine to an order that has just been created or changed: lines, totals, pending payment.
create or replace function public.apply_order_pricing(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_price jsonb;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id;
  if not found or v_order.client_id is null then return; end if;
  v_price := public.price_lines(v_order.client_id,
    (select coalesce(jsonb_agg(jsonb_build_object('product_id', oi.product_id, 'quantity', oi.quantity)), '[]'::jsonb)
     from public.order_items oi where oi.order_id = p_order_id and oi.product_id is not null), p_order_id);
  update public.order_items oi set
    list_price = (v_price -> 'lines' -> oi.product_id::text ->> 'list_price')::numeric,
    unit_price = (v_price -> 'lines' -> oi.product_id::text ->> 'unit_price')::numeric,
    line_total = (v_price -> 'lines' -> oi.product_id::text ->> 'line_total')::numeric,
    discount_label = v_price -> 'lines' -> oi.product_id::text ->> 'label'
  where oi.order_id = p_order_id and oi.product_id is not null and (v_price -> 'lines') ? oi.product_id::text;
  update public.orders o set
    subtotal = s.subtotal, total = s.subtotal + coalesce(o.delivery_fee, 0), discount_total = s.discount, updated_at = now()
  from (select coalesce(sum(oi.line_total), 0) as subtotal,
               coalesce(sum(greatest(round(coalesce(oi.list_price, oi.unit_price) * oi.quantity, 3) - oi.line_total, 0)), 0) as discount
        from public.order_items oi where oi.order_id = p_order_id) s
  where o.id = p_order_id;
  update public.payments p set amount = o.total from public.orders o
  where o.id = p_order_id and p.order_id = p_order_id and p.status = 'pending';
end;
$$;
REVOKE ALL ON FUNCTION public.apply_order_pricing(uuid) FROM PUBLIC, anon, authenticated;

-- A pending order of the buyer, checked as its own: the buyer may then change or cancel it even when
-- another supplier is the selected one (the per-Pro write guard follows the selected supplier).
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.buyer_pending_order(uuid)'::regprocedure);
BEGIN
  IF v_def not like '%appro.link_write%' THEN
    v_def := replace(v_def, E'  return v_order;
end;',
      E'  perform set_config(''appro.link_write'', ''on'', true);
  return v_order;
end;');
    IF v_def not like '%appro.link_write%' THEN
      RAISE EXCEPTION 'buyer_pending_order: return not found';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$$;

-- Every new order (buyer, supplier entry, recurring) and every change by the buyer goes through the engine.
DO $$
DECLARE
  v_def text;
BEGIN
  v_def := pg_get_functiondef('public.create_client_order(uuid, uuid, uuid, jsonb, uuid, date, text, text)'::regprocedure);
  IF v_def not like '%apply_order_pricing%' THEN
    v_def := replace(v_def,
      E'  return jsonb_build_object(''id'', v_order_id, ''order_number'', v_order_number, ''total'', v_subtotal, ''status'', ''pending'');',
      E'  perform public.apply_order_pricing(v_order_id);\n  return jsonb_build_object(''id'', v_order_id, ''order_number'', v_order_number, ''total'', (select o.total from public.orders o where o.id = v_order_id), ''status'', ''pending'');');
    IF v_def not like '%apply_order_pricing%' THEN
      RAISE EXCEPTION 'create_client_order: return statement not found';
    END IF;
    EXECUTE v_def;
  END IF;

  v_def := pg_get_functiondef('public.client_modify_order(uuid, jsonb, text)'::regprocedure);
  IF v_def not like '%apply_order_pricing%' THEN
    v_def := replace(v_def,
      E'  insert into public.order_status_history (order_id, status, note, changed_by) values (v_order.id, ''pending'', ''Commande modifiée par le client.'', auth.uid());',
      E'  perform public.apply_order_pricing(v_order.id);\n  v_subtotal := (select o.total from public.orders o where o.id = v_order.id);\n  insert into public.order_status_history (order_id, status, note, changed_by) values (v_order.id, ''pending'', ''Commande modifiée par le client.'', auth.uid());');
    IF v_def not like '%apply_order_pricing%' THEN
      RAISE EXCEPTION 'client_modify_order: history statement not found';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$$;

-- The offers a buyer can see from one relation (for badges in the catalogue).
create or replace function public.relation_offers(p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'client_id', c.id, 'name', r.name, 'kind', r.kind, 'value', r.value, 'buy_qty', r.buy_qty, 'free_qty', r.free_qty,
      'tiers', r.tiers, 'product_scope', r.product_scope, 'category_ids', r.category_ids, 'product_ids', r.product_ids,
      'min_order_amount', r.min_order_amount, 'min_line_qty', r.min_line_qty, 'ends_on', r.ends_on, 'weekdays', r.weekdays,
      'first_order_only', r.first_order_only, 'min_past_orders', r.min_past_orders, 'stackable', r.stackable) order by r.created_at), '[]'::jsonb)
  from public.clients c
  join public.pricing_rules r on r.org_id = c.supplier_org_id and r.active
  where c.id = p_client_id and c.show_prices and public.module_enabled_for(c.supplier_org_id, 'pricing')
    and (r.target = 'all' or (r.target = 'group' and r.price_group_id = c.price_group_id) or (r.target = 'client' and r.client_id = c.id))
    and (r.starts_on is null or r.starts_on <= (now() at time zone 'Africa/Tunis')::date)
    and (r.ends_on is null or r.ends_on >= (now() at time zone 'Africa/Tunis')::date);
$$;
REVOKE ALL ON FUNCTION public.relation_offers(uuid) FROM PUBLIC, anon, authenticated;

-- The buyer catalogue (20261117) with the offers of each supplier and the category id of each product.
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
        'unit_label', p.unit_label, 'vat_rate', p.vat_rate, 'created_at', p.created_at, 'category', cat.name, 'category_sort', cat.sort_order,
        'category_id', p.category_id, 'category_parent_id', cat.parent_id,
        'price', case when c.show_prices then p.price end,
        'stock_quantity', case when c.show_stock then p.stock_quantity end,
        'origin_producer', case when c.show_origin then p.origin_producer end,
        'origin_region', case when c.show_origin then p.origin_region end,
        'origin_label', case when c.show_origin then p.origin_label end,
        'origin_note', case when c.show_origin then p.origin_note end) order by p.created_at desc)
      from public.buyer_order_relations() c
      join public.products p on p.org_id = c.supplier_org_id and p.active
      left join public.categories cat on cat.id = p.category_id), '[]'::jsonb),
    'offers', coalesce((select jsonb_agg(o) from public.buyer_order_relations() c, jsonb_array_elements(public.relation_offers(c.id)) o), '[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.buyer_catalog() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_catalog() TO authenticated;

-- Live prices of the buyer's cart: [{client_id, items}] -> [{client_id, ...price_lines}] (amounts hidden
-- when the supplier hides its prices from this buyer).
create or replace function public.buyer_price_cart(p_orders jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order jsonb;
  v_client public.clients%rowtype;
  v_price jsonb;
  v_result jsonb := '[]'::jsonb;
begin
  if public.active_uid() is null then
    raise exception using errcode = '28000', message = 'Connectez-vous.';
  end if;
  for v_order in select value from jsonb_array_elements(case when jsonb_typeof(p_orders) = 'array' then p_orders else '[]'::jsonb end) loop
    select c.* into v_client from public.buyer_order_relations() c where c.id = nullif(v_order ->> 'client_id', '')::uuid;
    continue when v_client.id is null;
    v_price := public.price_lines(v_client.id, v_order -> 'items');
    if not v_client.show_prices then
      v_price := jsonb_build_object('lines', '{}'::jsonb, 'applied', v_price -> 'applied', 'next', '[]'::jsonb, 'hidden', true);
    end if;
    v_result := v_result || jsonb_build_array(v_price || jsonb_build_object('client_id', v_client.id));
    v_client := null;
  end loop;
  return v_result;
end;
$$;
REVOKE ALL ON FUNCTION public.buyer_price_cart(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_price_cart(jsonb) TO authenticated;

-- Live prices when the supplier enters an order for one of its clients.
create or replace function public.staff_price_order(p_client_id uuid, p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_feature('orders.create') or not exists (select 1 from public.clients c where c.id = p_client_id and c.supplier_org_id = public.current_org_id()) then
    raise exception using errcode = '42501', message = 'Client introuvable.';
  end if;
  return public.price_lines(p_client_id, p_items);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_price_order(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_price_order(uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- Management by the supplier (right "Gérer les produits", module "Remises et tarifs clients").
-- ---------------------------------------------------------------------------
create or replace function public.pricing_manager_org()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not public.has_feature('products.manage') then
    raise exception using errcode = '42501', message = 'Vous n’avez pas le droit de gérer les tarifs.';
  end if;
  if not public.module_enabled_for(v_org, 'pricing') then
    raise exception using errcode = '42501', message = 'Le module « Remises et tarifs clients » n’est pas actif pour votre Pro.';
  end if;
  return v_org;
end;
$$;
REVOKE ALL ON FUNCTION public.pricing_manager_org() FROM PUBLIC, anon, authenticated;

create or replace function public.pricing_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.pricing_manager_org();
begin
  return jsonb_build_object(
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name,
        'clients', (select count(*) from public.clients c where c.price_group_id = g.id)) order by lower(g.name))
      from public.price_groups g where g.org_id = v_org), '[]'::jsonb),
    'clients', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'business_name', c.business_name, 'price_group_id', c.price_group_id) order by lower(c.business_name))
      from public.clients c where c.supplier_org_id = v_org and c.active and c.link_status = 'active'), '[]'::jsonb),
    'rules', coalesce((select jsonb_agg(to_jsonb(r) order by r.active desc, r.created_at desc) from public.pricing_rules r where r.org_id = v_org), '[]'::jsonb));
end;
$$;
REVOKE ALL ON FUNCTION public.pricing_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pricing_overview() TO authenticated;

create or replace function public.pricing_save_group(p_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.pricing_manager_org();
  v_id uuid;
begin
  if btrim(coalesce(p_name, '')) = '' then
    raise exception using errcode = '22023', message = 'Donnez un nom au groupe.';
  end if;
  if exists (select 1 from public.price_groups g where g.org_id = v_org and lower(g.name) = lower(btrim(p_name)) and g.id is distinct from p_id) then
    raise exception using errcode = '23505', message = 'Un groupe porte déjà ce nom.';
  end if;
  if p_id is null then
    insert into public.price_groups (org_id, name) values (v_org, btrim(p_name)) returning id into v_id;
  else
    update public.price_groups set name = btrim(p_name) where id = p_id and org_id = v_org returning id into v_id;
    if v_id is null then
      raise exception using errcode = 'P0002', message = 'Groupe introuvable.';
    end if;
  end if;
  return v_id;
end;
$$;
REVOKE ALL ON FUNCTION public.pricing_save_group(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pricing_save_group(uuid, text) TO authenticated;

create or replace function public.pricing_delete_group(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.pricing_manager_org();
begin
  perform set_config('appro.link_write', 'on', true);
  update public.clients set price_group_id = null where price_group_id = p_id and supplier_org_id = v_org;
  perform set_config('appro.link_write', 'off', true);
  delete from public.price_groups where id = p_id and org_id = v_org;
end;
$$;
REVOKE ALL ON FUNCTION public.pricing_delete_group(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pricing_delete_group(uuid) TO authenticated;

create or replace function public.pricing_set_client_group(p_client_id uuid, p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.pricing_manager_org();
begin
  if p_group_id is not null and not exists (select 1 from public.price_groups g where g.id = p_group_id and g.org_id = v_org) then
    raise exception using errcode = 'P0002', message = 'Groupe introuvable.';
  end if;
  if not exists (select 1 from public.clients c where c.id = p_client_id and c.supplier_org_id = v_org) then
    raise exception using errcode = 'P0002', message = 'Client introuvable.';
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.clients set price_group_id = p_group_id where id = p_client_id and supplier_org_id = v_org;
  perform set_config('appro.link_write', 'off', true);
end;
$$;
REVOKE ALL ON FUNCTION public.pricing_set_client_group(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pricing_set_client_group(uuid, uuid) TO authenticated;

-- Create (no id) or update a rule; every field is checked here.
create or replace function public.pricing_save_rule(p_rule jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.pricing_manager_org();
  v_id uuid := nullif(p_rule ->> 'id', '')::uuid;
  v_kind text := p_rule ->> 'kind';
  v_value numeric := nullif(p_rule ->> 'value', '')::numeric;
  v_buy numeric := nullif(p_rule ->> 'buy_qty', '')::numeric;
  v_free numeric := nullif(p_rule ->> 'free_qty', '')::numeric;
  v_tiers jsonb := coalesce(p_rule -> 'tiers', '[]'::jsonb);
  v_target text := coalesce(nullif(p_rule ->> 'target', ''), 'all');
  v_group uuid := nullif(p_rule ->> 'price_group_id', '')::uuid;
  v_client uuid := nullif(p_rule ->> 'client_id', '')::uuid;
  v_scope text := coalesce(nullif(p_rule ->> 'product_scope', ''), 'all');
  v_categories uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_rule -> 'category_ids', '[]'::jsonb)) x), '{}');
  v_products uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_rule -> 'product_ids', '[]'::jsonb)) x), '{}');
  v_weekdays int[] := coalesce((select array_agg(distinct x::int) from jsonb_array_elements_text(coalesce(p_rule -> 'weekdays', '[]'::jsonb)) x), '{}');
  v_starts date := nullif(p_rule ->> 'starts_on', '')::date;
  v_ends date := nullif(p_rule ->> 'ends_on', '')::date;
  v_min_amount numeric := nullif(p_rule ->> 'min_order_amount', '')::numeric;
  v_min_qty numeric := nullif(p_rule ->> 'min_line_qty', '')::numeric;
  v_min_past int := nullif(p_rule ->> 'min_past_orders', '')::int;
begin
  if btrim(coalesce(p_rule ->> 'name', '')) = '' then
    raise exception using errcode = '22023', message = 'Donnez un nom à la remise (il est affiché au client).';
  end if;
  if v_kind is null or v_kind not in ('percent', 'net_price', 'free_units', 'tiers') then
    raise exception using errcode = '22023', message = 'Choisissez le type de remise.';
  end if;
  if v_kind = 'percent' and (v_value is null or v_value <= 0 or v_value > 100) then
    raise exception using errcode = '22023', message = 'Le pourcentage doit être compris entre 0 et 100.';
  end if;
  if v_kind = 'net_price' then
    if v_value is null or v_value < 0 then
      raise exception using errcode = '22023', message = 'Indiquez le prix net HT négocié.';
    end if;
    if v_scope <> 'products' or cardinality(v_products) = 0 then
      raise exception using errcode = '22023', message = 'Un prix net s’applique à des produits choisis.';
    end if;
  end if;
  if v_kind = 'free_units' and (v_buy is null or v_buy <= 0 or v_free is null or v_free <= 0) then
    raise exception using errcode = '22023', message = 'Indiquez combien sont achetés et combien sont offerts.';
  end if;
  if v_kind = 'tiers' then
    if jsonb_typeof(v_tiers) <> 'array' or jsonb_array_length(v_tiers) = 0 then
      raise exception using errcode = '22023', message = 'Ajoutez au moins un palier.';
    end if;
    if exists (select 1 from jsonb_array_elements(v_tiers) t
               where coalesce(nullif(t ->> 'min_qty', '')::numeric, 0) <= 0 or coalesce(nullif(t ->> 'percent', '')::numeric, 0) <= 0 or (t ->> 'percent')::numeric > 100) then
      raise exception using errcode = '22023', message = 'Chaque palier a une quantité minimale et un pourcentage entre 0 et 100.';
    end if;
  end if;
  if v_target not in ('all', 'group', 'client') or v_scope not in ('all', 'category', 'products') then
    raise exception using errcode = '22023', message = 'Ciblage invalide.';
  end if;
  if v_target = 'group' and not exists (select 1 from public.price_groups g where g.id = v_group and g.org_id = v_org) then
    raise exception using errcode = '22023', message = 'Choisissez le groupe de clients.';
  end if;
  if v_target = 'client' and not exists (select 1 from public.clients c where c.id = v_client and c.supplier_org_id = v_org) then
    raise exception using errcode = '22023', message = 'Choisissez le client.';
  end if;
  if v_scope = 'category' and (cardinality(v_categories) = 0 or exists (select 1 from unnest(v_categories) x where not exists (select 1 from public.categories cat where cat.id = x))) then
    raise exception using errcode = '22023', message = 'Choisissez au moins une catégorie.';
  end if;
  if v_scope = 'products' and (cardinality(v_products) = 0 or exists (select 1 from unnest(v_products) x where not exists (select 1 from public.products p where p.id = x and p.org_id = v_org))) then
    raise exception using errcode = '22023', message = 'Choisissez au moins un de vos produits.';
  end if;
  if exists (select 1 from unnest(v_weekdays) d where d < 1 or d > 7) then
    raise exception using errcode = '22023', message = 'Jour de la semaine invalide.';
  end if;
  if v_starts is not null and v_ends is not null and v_ends < v_starts then
    raise exception using errcode = '22023', message = 'La date de fin est avant la date de début.';
  end if;
  if (v_min_amount is not null and v_min_amount < 0) or (v_min_qty is not null and v_min_qty < 0) or (v_min_past is not null and v_min_past < 0) then
    raise exception using errcode = '22023', message = 'Les conditions ne peuvent pas être négatives.';
  end if;

  if v_id is null then
    insert into public.pricing_rules (org_id, created_by, name, kind) values (v_org, auth.uid(), btrim(p_rule ->> 'name'), v_kind) returning id into v_id;
  elsif not exists (select 1 from public.pricing_rules r where r.id = v_id and r.org_id = v_org) then
    raise exception using errcode = 'P0002', message = 'Remise introuvable.';
  end if;
  update public.pricing_rules set
    name = btrim(p_rule ->> 'name'), kind = v_kind,
    value = case when v_kind in ('percent', 'net_price') then v_value end,
    buy_qty = case when v_kind = 'free_units' then v_buy end,
    free_qty = case when v_kind = 'free_units' then v_free end,
    tiers = case when v_kind = 'tiers' then (select jsonb_agg(jsonb_build_object('min_qty', (t ->> 'min_qty')::numeric, 'percent', (t ->> 'percent')::numeric) order by (t ->> 'min_qty')::numeric) from jsonb_array_elements(v_tiers) t) else '[]'::jsonb end,
    target = v_target,
    price_group_id = case when v_target = 'group' then v_group end,
    client_id = case when v_target = 'client' then v_client end,
    product_scope = v_scope,
    category_ids = case when v_scope = 'category' then v_categories else '{}' end,
    product_ids = case when v_scope = 'products' then v_products else '{}' end,
    min_order_amount = v_min_amount, min_line_qty = v_min_qty, starts_on = v_starts, ends_on = v_ends, weekdays = v_weekdays,
    first_order_only = coalesce((p_rule ->> 'first_order_only')::boolean, false),
    min_past_orders = v_min_past,
    stackable = coalesce((p_rule ->> 'stackable')::boolean, false),
    active = coalesce((p_rule ->> 'active')::boolean, true),
    updated_at = now()
  where id = v_id;
  return v_id;
end;
$$;
REVOKE ALL ON FUNCTION public.pricing_save_rule(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pricing_save_rule(jsonb) TO authenticated;

create or replace function public.pricing_set_rule_active(p_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.pricing_manager_org();
begin
  update public.pricing_rules set active = coalesce(p_active, false), updated_at = now() where id = p_id and org_id = v_org;
end;
$$;
REVOKE ALL ON FUNCTION public.pricing_set_rule_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pricing_set_rule_active(uuid, boolean) TO authenticated;

create or replace function public.pricing_delete_rule(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.pricing_manager_org();
begin
  delete from public.pricing_rules where id = p_id and org_id = v_org;
end;
$$;
REVOKE ALL ON FUNCTION public.pricing_delete_rule(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pricing_delete_rule(uuid) TO authenticated;

DO $$
BEGIN
  IF to_regprocedure('public.audit_row()') IS NOT NULL THEN
    EXECUTE 'drop trigger if exists audit_org_modules on public.org_modules';
    EXECUTE 'create trigger audit_org_modules after insert or update or delete on public.org_modules for each row execute function public.audit_row()';
    EXECUTE 'drop trigger if exists audit_pricing_rules on public.pricing_rules';
    EXECUTE 'create trigger audit_pricing_rules after insert or update or delete on public.pricing_rules for each row execute function public.audit_row()';
    EXECUTE 'drop trigger if exists audit_price_groups on public.price_groups';
    EXECUTE 'create trigger audit_price_groups after insert or update or delete on public.price_groups for each row execute function public.audit_row()';
  END IF;
END;
$$;

-- Make the new functions visible to the API right away.
notify pgrst, 'reload schema';
