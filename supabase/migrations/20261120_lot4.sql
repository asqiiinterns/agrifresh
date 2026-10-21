-- Lot 4: delivery (amounts shown to the driver, deposit received at delivery), invitations, products visible
-- to everyone or to the network only, new accounts (browse, 48 h trial), directory and messages outside the network.
-- Run in Supabase SQL Editor AFTER 20261119_write_guard_fixes.sql. Safe to rerun.

-- ===========================================================================
-- A. Delivery
--   * client option "driver_prices": the driver sees the amount (incl. VAT) of each delivery note, to collect
--     a payment; default set by each supplier (Paramétrage), changeable per client record;
--   * the driver records a deposit received at delivery: it goes to the client's account, is applied at once
--     to the invoices of the delivered orders already issued, the rest stays available.
-- ===========================================================================

alter table public.clients add column if not exists driver_prices boolean not null default false;
insert into public.client_setting_defaults (org_id, key, value)
select o.id, 'driver_prices', 'false'::jsonb from public.organizations o
on conflict (org_id, key) do nothing;

DO $$
DECLARE
  v_def text := pg_get_functiondef('public.apply_client_defaults()'::regprocedure);
BEGIN
  IF v_def not like '%driver_prices%' THEN
    v_def := replace(v_def, E'''reminder_opt_out_allowed'', ''delivery_signature'')', E'''reminder_opt_out_allowed'', ''delivery_signature'', ''driver_prices'')');
    v_def := replace(v_def, E'  new.feature_overrides := coalesce((',
      E'  if not (''driver_prices'' = any(k)) and d ? ''driver_prices'' then new.driver_prices := (d ->> ''driver_prices'')::boolean; end if;\n  new.feature_overrides := coalesce((');
    IF v_def not like '%new.driver_prices :=%' or v_def not like '%''delivery_signature'', ''driver_prices'')%' THEN
      RAISE EXCEPTION 'apply_client_defaults: text not found';
    END IF;
    EXECUTE v_def;
  END IF;
  v_def := pg_get_functiondef('public.admin_set_client_default(text, jsonb)'::regprocedure);
  IF v_def not like '%driver_prices%' THEN
    v_def := replace(v_def, E'''reminder_opt_out_allowed'', ''delivery_signature'') then', E'''reminder_opt_out_allowed'', ''delivery_signature'', ''driver_prices'') then');
    IF v_def not like '%driver_prices%' THEN
      RAISE EXCEPTION 'admin_set_client_default: text not found';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$$;

-- The driver's list: the amount of each delivery note when the client's option allows it.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.driver_shipments()'::regprocedure);
BEGIN
  IF v_def not like '%driver_prices%' THEN
    v_def := replace(v_def, E'''total'', o.total,', E'''total'', case when c.driver_prices then o.total end,');
    v_def := replace(v_def, E'''driver_name'', dr.full_name',
      E'''driver_name'', dr.full_name,\n      ''show_prices'', c.driver_prices,\n      ''total_ttc'', case when c.driver_prices then (select coalesce(sum(oi.line_total * (1 + coalesce(oi.vat_rate, 0) / 100)), 0) from public.order_items oi where oi.order_id = o.id) + coalesce(o.delivery_fee, 0) end');
    IF v_def not like '%total_ttc%' or v_def not like '%case when c.driver_prices then o.total end%' THEN
      RAISE EXCEPTION 'driver_shipments: text not found';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$$;

alter table public.account_entries add column if not exists order_id uuid references public.orders(id) on delete set null;

create or replace function public.driver_deliver_v3(
  p_order_ids uuid[], p_delivery_tokens uuid[], p_client_qr_kind text default null, p_client_qr_token uuid default null,
  p_signature jsonb default null, p_signer text default null, p_deposit numeric default null, p_deposit_method text default 'cash'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_count int;
  v_client uuid;
  v_org uuid;
  v_refs text;
  v_amount numeric := round(coalesce(p_deposit, 0), 3);
  v_left numeric;
  v_invoice record;
  v_part numeric;
  v_method text := coalesce(nullif(p_deposit_method, ''), 'cash');
  v_words text;
begin
  if v_amount < 0 or v_amount > 10000000 then
    raise exception using errcode = '22023', message = 'Montant d’acompte invalide.';
  end if;
  if v_method not in ('cash', 'check', 'transfer', 'card', 'other') then
    raise exception using errcode = '22023', message = 'Mode de paiement inconnu.';
  end if;
  select array_agg(o.id order by o.order_number) into v_ids from public.orders o
  where o.id = any(coalesce(p_order_ids, '{}'::uuid[])) or o.delivery_token = any(coalesce(p_delivery_tokens, '{}'::uuid[]));
  v_count := public.driver_deliver_v2(p_order_ids, p_delivery_tokens, p_client_qr_kind, p_client_qr_token, p_signature, p_signer);
  v_left := v_amount;
  if v_amount > 0 then
    select (array_agg(o.client_id))[1], (array_agg(o.supplier_org_id))[1],
           string_agg(coalesce(o.delivery_note_number, '#' || o.order_number), ', ' order by o.order_number)
    into v_client, v_org, v_refs
    from public.orders o where o.id = any(v_ids);
    v_words := case v_method when 'cash' then 'espèces' when 'check' then 'chèque' when 'transfer' then 'virement' when 'card' then 'carte' else 'autre' end;
    insert into public.account_entries (client_id, kind, amount, method, entry_date, reference, note, created_by, order_id)
    values (v_client, 'deposit', v_amount, v_method, current_date, left(coalesce(v_refs, ''), 120),
            'Reçu par le livreur ' || coalesce((select nullif(btrim(pr.full_name), '') from public.profiles pr where pr.id = auth.uid()), '') || ' à la livraison.',
            auth.uid(), v_ids[1]);
    -- Applied at once to the invoices of these orders already issued; the rest stays on the account.
    for v_invoice in
      select distinct i.id, i.total_ttc - i.amount_paid as rest, i.issued_at
      from public.client_invoices i join public.orders o on o.client_invoice_id = i.id
      where o.id = any(v_ids) and i.status = 'issued'
      order by i.issued_at, i.id
    loop
      exit when v_left <= 0;
      v_part := least(v_left, round(v_invoice.rest, 3));
      if v_part > 0 then
        insert into public.invoice_payments (invoice_id, amount, method, paid_on, reference, created_by)
        values (v_invoice.id, v_part, 'deposit', current_date, 'Acompte reçu à la livraison', auth.uid());
        perform public.refresh_invoice_payment(v_invoice.id);
        v_left := v_left - v_part;
      end if;
    end loop;
    update public.order_status_history h
    set note = coalesce(h.note, '') || format(' Acompte reçu : %s TND (%s).', to_char(v_amount, 'FM999G999G990D000'), v_words)
    where h.order_id = any(v_ids) and h.status = 'delivered' and h.created_at > now() - interval '1 minute';
    perform public.notify(array(select public.team_with_feature('invoices.manage', v_org)), 'account.deposit',
      format('Acompte reçu à la livraison · %s TND', to_char(v_amount, 'FM999G999G990D000')),
      format('%s · %s · %s', (select c.business_name from public.clients c where c.id = v_client), coalesce(v_refs, ''), v_words), v_ids[1]);
  end if;
  return jsonb_build_object('count', v_count, 'deposit', v_amount, 'applied', v_amount - v_left);
end;
$$;
REVOKE ALL ON FUNCTION public.driver_deliver_v3(uuid[], uuid[], text, uuid, jsonb, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_deliver_v3(uuid[], uuid[], text, uuid, jsonb, text, numeric, text) TO authenticated;

-- ===========================================================================
-- B. Platform settings (Appro+): trial of new accounts, address of the web app (invitation links).
-- ===========================================================================
create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
alter table public.platform_settings enable row level security;
insert into public.platform_settings (key, value) values ('new_accounts_trial_hours', '0'::jsonb), ('app_url', '""'::jsonb)
on conflict (key) do nothing;

create or replace function public.platform_setting(p_key text)
returns jsonb language sql stable security definer set search_path = ''
as $$ select s.value from public.platform_settings s where s.key = p_key; $$;
REVOKE ALL ON FUNCTION public.platform_setting(text) FROM PUBLIC, anon, authenticated;

-- What every screen may know (also before signing in: the invitation screen).
create or replace function public.public_settings()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'app_url', coalesce(public.platform_setting('app_url') #>> '{}', ''),
    'trial_hours', coalesce((public.platform_setting('new_accounts_trial_hours') #>> '{}')::int, 0));
$$;
REVOKE ALL ON FUNCTION public.public_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_settings() TO anon, authenticated;

create or replace function public.platform_set_setting(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas de modifier ce réglage.';
  end if;
  if p_key = 'new_accounts_trial_hours' then
    if jsonb_typeof(p_value) is distinct from 'number' or (p_value #>> '{}')::numeric not between 0 and 720 then
      raise exception using errcode = '22023', message = 'Durée invalide (0 à 720 heures).';
    end if;
    p_value := to_jsonb(round((p_value #>> '{}')::numeric)::int);
  elsif p_key = 'app_url' then
    if jsonb_typeof(p_value) is distinct from 'string' or ((p_value #>> '{}') <> '' and (p_value #>> '{}') !~ '^https?://[^ ]+$') then
      raise exception using errcode = '22023', message = 'Adresse invalide : elle commence par https://';
    end if;
    p_value := to_jsonb(regexp_replace(p_value #>> '{}', '/+$', ''));
  else
    raise exception using errcode = '22023', message = 'Réglage inconnu.';
  end if;
  insert into public.platform_settings (key, value, updated_at, updated_by) values (p_key, p_value, now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end;
$$;
REVOKE ALL ON FUNCTION public.platform_set_setting(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_setting(text, jsonb) TO authenticated;

-- ===========================================================================
-- C. New accounts: a trial of N hours (Appro+ setting), then suspended until Appro+ validates them.
--    Without trial (0 h), a new Pro waits for Appro+: it can browse the public catalogue, not order.
-- ===========================================================================
alter table public.organizations add column if not exists trial_until timestamptz;
alter table public.profiles add column if not exists trial_suspended boolean not null default false;

-- Starts the trial of a Pro waiting for Appro+ (when the setting allows it): active with its Responsable(s).
create or replace function public.start_trial(p_org_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hours int := coalesce((public.platform_setting('new_accounts_trial_hours') #>> '{}')::int, 0);
begin
  if v_hours <= 0 or not exists (select 1 from public.organizations o where o.id = p_org_id and o.status = 'pending') then
    return false;
  end if;
  update public.organizations set status = 'active', trial_until = now() + make_interval(hours => v_hours), updated_at = now() where id = p_org_id;
  perform public.org_install_roles(p_org_id);
  if exists (select 1 from public.organizations o where o.id = p_org_id and o.is_supplier) then
    perform public.org_install_numbering(p_org_id);
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set account_status = 'active' where org_id = p_org_id and account_status = 'pending' and role <> 'platform';
  perform set_config('appro.link_write', 'off', true);
  perform public.notify(array(select pm.user_id from public.platform_members pm where pm.active and pm.role in ('superadmin', 'verification', 'account_manager')),
    'pro.trial', 'Nouveau Pro en essai',
    format('%s est actif pour %s h : validez-le (Appro+ → Pros) pour qu’il le reste.', (select o.name from public.organizations o where o.id = p_org_id), v_hours));
  return true;
end;
$$;
REVOKE ALL ON FUNCTION public.start_trial(uuid) FROM PUBLIC, anon, authenticated;

-- Trials over: the Pro and its accounts are suspended (Appro+ reactivates them by validating the Pro).
-- Called when the app opens, and every hour by pg_cron when it is installed.
create or replace function public.expire_trials()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  with expired as (
    update public.organizations set status = 'suspended', updated_at = now()
    where trial_until is not null and trial_until < now() and status = 'active'
    returning id)
  select array_agg(id) into v_ids from expired;
  if v_ids is null then
    return 0;
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set account_status = 'suspended', trial_suspended = true
  where org_id = any(v_ids) and account_status = 'active' and role <> 'platform';
  perform set_config('appro.link_write', 'off', true);
  return cardinality(v_ids);
end;
$$;
REVOKE ALL ON FUNCTION public.expire_trials() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expire_trials() TO authenticated;
DO $$
BEGIN
  IF exists (select 1 from pg_extension where extname = 'pg_cron') THEN
    EXECUTE $cron$select cron.schedule('appro-expire-trials', '7 * * * *', 'select public.expire_trials()')$cron$;
  END IF;
EXCEPTION WHEN others THEN NULL;
END;
$$;

-- Validating a Pro ends its trial and reactivates the accounts its trial had suspended.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.platform_set_pro_status(uuid, text)'::regprocedure);
BEGIN
  IF v_def not like '%trial_until%' THEN
    v_def := replace(v_def, 'update public.organizations set status = p_status, updated_at = now() where id = p_org_id;',
      'update public.organizations set status = p_status, trial_until = case when p_status = ''active'' then null else trial_until end, updated_at = now() where id = p_org_id;');
    -- (Two replacements: the line break between them may be CRLF.)
    v_def := replace(v_def, 'update public.profiles set account_status = ''active''', 'update public.profiles set account_status = ''active'', trial_suspended = false');
    v_def := replace(v_def, 'and role in (''admin'', ''customer'') and account_status = ''pending'';',
      'and role in (''admin'', ''customer'') and (account_status = ''pending'' or (account_status = ''suspended'' and trial_suspended));');
    IF v_def not like '%trial_until = case%' or v_def not like '%trial_suspended = false%' or v_def not like '%and trial_suspended))%' THEN
      RAISE EXCEPTION 'platform_set_pro_status: text not found';
    END IF;
    EXECUTE v_def;
  END IF;
  v_def := pg_get_functiondef('public.platform_pros()'::regprocedure);
  IF v_def not like '%trial_until%' THEN
    v_def := replace(v_def, '''status'', o.status,', '''status'', o.status, ''trial_until'', o.trial_until, ''kind'', o.kind,');
    v_def := replace(v_def, 'order by o.status = ''pending'' desc', 'order by (o.status = ''pending'' or o.trial_until is not null) desc');
    IF v_def not like '%trial_until%' THEN
      RAISE EXCEPTION 'platform_pros: text not found';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$$;

-- ===========================================================================
-- D. Visibility of a supplier's products, directory and messages settings of each Pro.
-- ===========================================================================
alter table public.organizations add column if not exists catalog_visibility text not null default 'network' check (catalog_visibility in ('network', 'public'));
alter table public.organizations add column if not exists listed_in_directory boolean not null default true;
alter table public.organizations add column if not exists open_to_messages boolean not null default false;
alter table public.clients add column if not exists joined_via text;

create or replace function public.my_pro()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when o.id is null then null else jsonb_build_object(
    'id', o.id, 'name', o.name, 'kind', o.kind, 'status', o.status, 'is_supplier', o.is_supplier, 'is_buyer', o.is_buyer,
    'roles_delegated', o.roles_delegated, 'trial_until', o.trial_until, 'catalog_visibility', o.catalog_visibility,
    'listed_in_directory', o.listed_in_directory, 'open_to_messages', o.open_to_messages, 'open_to_new', o.open_to_new) end
  from public.profiles pr left join public.organizations o on o.id = pr.org_id
  where pr.id = (select auth.uid());
$$;
REVOKE ALL ON FUNCTION public.my_pro() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_pro() TO authenticated;

-- The Responsable chooses; p_* null keeps the current value.
create or replace function public.set_pro_visibility(p_catalog text default null, p_listed boolean default null, p_messages boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not (public.is_admin() or public.is_org_owner(v_org)) then
    raise exception using errcode = '42501', message = 'Seul le Responsable du Pro peut changer ce réglage.';
  end if;
  if p_catalog is not null and p_catalog not in ('network', 'public') then
    raise exception using errcode = '22023', message = 'Visibilité inconnue.';
  end if;
  if p_catalog = 'public' and not exists (select 1 from public.organizations o where o.id = v_org and o.is_supplier) then
    raise exception using errcode = '22023', message = 'Seul un fournisseur a un catalogue.';
  end if;
  update public.organizations set catalog_visibility = coalesce(p_catalog, catalog_visibility),
    listed_in_directory = coalesce(p_listed, listed_in_directory), open_to_messages = coalesce(p_messages, open_to_messages), updated_at = now()
  where id = v_org;
  return public.my_pro();
end;
$$;
REVOKE ALL ON FUNCTION public.set_pro_visibility(text, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_pro_visibility(text, boolean, boolean) TO authenticated;

-- The directory lists only the Pros that chose to appear in it, with what they accept.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.pro_directory(text, text)'::regprocedure);
BEGIN
  IF v_def not like '%listed_in_directory%' THEN
    v_def := replace(v_def, '''open_to_new'', o.open_to_new,', '''open_to_new'', o.open_to_new, ''open_to_messages'', o.open_to_messages, ''catalog_visibility'', o.catalog_visibility,');
    v_def := replace(v_def, 'where o.status = ''active'' and o.id <> v_me.id', 'where o.status = ''active'' and o.id <> v_me.id and o.listed_in_directory');
    IF v_def not like '%and o.listed_in_directory%' or v_def not like '%''open_to_messages''%' THEN
      RAISE EXCEPTION 'pro_directory: text not found';
    END IF;
    EXECUTE v_def;
  END IF;
  v_def := pg_get_functiondef('public.my_links()'::regprocedure);
  IF v_def not like '%listed_in_directory%' THEN
    v_def := replace(v_def, '''open_to_new'', o.open_to_new)', '''open_to_new'', o.open_to_new, ''listed_in_directory'', o.listed_in_directory, ''open_to_messages'', o.open_to_messages, ''catalog_visibility'', o.catalog_visibility, ''kind'', o.kind)');
    IF v_def not like '%listed_in_directory%' THEN
      RAISE EXCEPTION 'my_links: text not found';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$$;

-- A buyer's tabs (Commander, Commandes, Factures, Messages…) open when any of its suppliers allows them,
-- not only the one selected: those screens cover all suppliers.
create or replace function public.my_features()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(f.feature order by f.feature), '[]'::jsonb)
  from (select distinct rp.feature from public.role_permissions rp) f
  where public.has_feature(f.feature)
     or (f.feature in ('client.home', 'client.order', 'client.orders', 'client.messages', 'client.invoices', 'client.alerts')
         and exists (select 1 from public.buyer_relations(f.feature)));
$$;
REVOKE ALL ON FUNCTION public.my_features() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_features() TO authenticated;

-- ===========================================================================
-- E. Public catalogue: the products of the suppliers visible to everyone, for any signed-in account
--    (also a new one waiting for Appro+). The first order with such a supplier creates the relation;
--    the order arrives "à décider" like any other.
-- ===========================================================================
create or replace function public.public_catalog(p_search text default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select pr.org_id from public.profiles pr where pr.id = (select auth.uid())),
  sup as (
    select o.id, o.name, o.address, o.tagline,
      coalesce((select (d.value #>> '{}')::boolean from public.client_setting_defaults d where d.org_id = o.id and d.key = 'show_prices'), true) as show_prices
    from public.organizations o
    where (select auth.uid()) is not null and o.status = 'active' and o.is_supplier and o.catalog_visibility = 'public'
      and o.id is distinct from (select me.org_id from me)
      and not exists (select 1 from public.clients c where c.supplier_org_id = o.id and c.buyer_org_id = (select me.org_id from me)
                      and c.link_status = 'active' and c.active)),
  prod as (
    select p.*, s.show_prices, s.name as supplier_name, cat.name as category
    from sup s join public.products p on p.org_id = s.id and p.active
    left join public.categories cat on cat.id = p.category_id
    where p_search is null or btrim(p_search) = ''
       or lower(p.name || ' ' || coalesce(p.description, '') || ' ' || s.name || ' ' || coalesce(cat.name, '')) like '%' || lower(btrim(p_search)) || '%'
    order by p.name
    limit 600)
  select jsonb_build_object(
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('org_id', s.id, 'name', s.name, 'address', s.address, 'tagline', s.tagline, 'show_prices', s.show_prices) order by s.name)
      from sup s where exists (select 1 from prod p where p.org_id = s.id)), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'org_id', p.org_id, 'supplier_name', p.supplier_name, 'name', p.name,
        'description', p.description, 'image_url', p.image_url, 'unit_label', p.unit_label, 'category', p.category,
        'price', case when p.show_prices then p.price end, 'vat_rate', p.vat_rate) order by p.supplier_name, p.name) from prod p), '[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.public_catalog(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.public_catalog(text) TO authenticated;

-- An active relation between a supplier and a buyer, created or reactivated, with a delivery point.
create or replace function public.ensure_relation(p_supplier uuid, p_buyer uuid, p_via text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_buyer public.organizations%rowtype;
begin
  select * into v_buyer from public.organizations where id = p_buyer;
  perform set_config('appro.link_write', 'on', true);
  select c.id into v_id from public.clients c where c.supplier_org_id = p_supplier and c.buyer_org_id = p_buyer order by c.created_at limit 1;
  if v_id is null then
    insert into public.clients (business_name, contact_name, phone, email, supplier_org_id, buyer_org_id, active, link_status, link_requested_at, joined_via)
    values (v_buyer.name, '', coalesce(v_buyer.phone, ''), nullif(v_buyer.email, ''), p_supplier, p_buyer, true, 'active', now(), p_via)
    returning id into v_id;
  else
    update public.clients set link_status = 'active', active = true, joined_via = coalesce(joined_via, p_via) where id = v_id and (link_status <> 'active' or not active);
  end if;
  if not exists (select 1 from public.client_delivery_points dp where dp.client_id = v_id and dp.active) then
    insert into public.client_delivery_points (client_id, label, address_line, city, phone)
    values (v_id, 'Principal', coalesce(nullif(btrim(v_buyer.address), ''), 'Adresse à préciser'), 'À préciser', coalesce(v_buyer.phone, ''));
  end if;
  -- The buyer's people with no supplier yet start with this one.
  update public.profiles set client_id = v_id where org_id = p_buyer and role = 'customer' and client_id is null;
  perform set_config('appro.link_write', 'off', true);
  return v_id;
end;
$$;
REVOKE ALL ON FUNCTION public.ensure_relation(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

create or replace function public.order_from_public(p_supplier_org_id uuid, p_items jsonb, p_requested_date date default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles%rowtype;
  v_buyer public.organizations%rowtype;
  v_supplier public.organizations%rowtype;
  v_link public.clients%rowtype;
  v_client uuid;
  v_new boolean := false;
  v_result jsonb;
begin
  perform public.expire_trials();
  select * into v_me from public.profiles where id = auth.uid();
  if v_me.id is null then
    raise exception using errcode = '28000', message = 'Connectez-vous pour commander.';
  end if;
  select * into v_buyer from public.organizations where id = v_me.org_id;
  if v_me.account_status <> 'active' or v_buyer.status is distinct from 'active' then
    raise exception using errcode = '42501', message = case when v_buyer.id is null then 'Créez d’abord votre espace (entreprise ou particulier) pour commander.'
      when v_buyer.status = 'suspended' then 'Votre espace est suspendu en attendant sa validation par l’équipe Appro+ : vous pourrez commander dès qu’il sera validé.'
      else 'Votre compte attend sa validation par l’équipe Appro+ : vous pourrez commander dès qu’il sera validé.' end;
  end if;
  if not v_buyer.is_buyer or v_me.role <> 'customer' then
    raise exception using errcode = '22023', message = 'Passez dans votre espace Acheteur pour commander.';
  end if;
  select * into v_supplier from public.organizations where id = p_supplier_org_id and status = 'active' and is_supplier and catalog_visibility = 'public';
  if v_supplier.id is null or v_supplier.id = v_buyer.id then
    raise exception using errcode = 'P0002', message = 'Ce fournisseur n’est pas disponible.';
  end if;
  select * into v_link from public.clients where supplier_org_id = v_supplier.id and buyer_org_id = v_buyer.id order by created_at limit 1;
  if v_link.id is not null and v_link.link_status = 'refused' and v_link.link_requested_at > now() - interval '30 days' then
    raise exception using errcode = '22023', message = 'Ce fournisseur n’a pas donné suite à votre mise en relation : contactez-le directement.';
  end if;
  v_new := v_link.id is null or v_link.link_status <> 'active' or not v_link.active;
  v_client := public.ensure_relation(v_supplier.id, v_buyer.id, 'public_catalog');
  v_result := public.place_multi_order(jsonb_build_array(jsonb_build_object('client_id', v_client, 'items', p_items)), p_requested_date, p_note) -> 0;
  if v_new then
    perform public.notify(array(select public.team_with_feature('orders.decide', v_supplier.id)), 'link.new_client',
      format('Nouveau client · %s', v_buyer.name),
      'Première commande depuis votre catalogue public : acceptez-la ou déclinez-la comme d’habitude.', nullif(v_result ->> 'id', '')::uuid);
  end if;
  return v_result || jsonb_build_object('new_relation', v_new, 'client_id', v_client, 'supplier_name', v_supplier.name);
end;
$$;
REVOKE ALL ON FUNCTION public.order_from_public(uuid, jsonb, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_from_public(uuid, jsonb, date, text) TO authenticated;

-- ===========================================================================
-- F. Invitations: a code (link) to send by e-mail, WhatsApp, Messenger or SMS. The person who opens it
--    creates its account; the relation with the one who invited is made as soon as it has its space.
--    From a client record: the person becomes the Responsable of that client's space.
-- ===========================================================================
create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  org_id uuid not null references public.organizations(id) on delete cascade,
  invited_by uuid references public.profiles(id) on delete set null,
  side text not null check (side in ('client', 'supplier')),
  client_id uuid references public.clients(id) on delete cascade,
  name text,
  contact text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  uses int not null default 0
);
create table if not exists public.invitation_acceptances (
  invitation_id uuid not null references public.invitations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  accepted_at timestamptz not null default now(),
  linked_at timestamptz,
  primary key (invitation_id, user_id)
);
alter table public.invitations enable row level security;
alter table public.invitation_acceptances enable row level security;

-- p_side: what the invited person becomes for me ('client' when I sell, 'supplier' when I buy).
create or replace function public.create_invitation(p_side text, p_client_id uuid default null, p_name text default null, p_contact text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations%rowtype;
  v_code text;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  select * into v_org from public.organizations where id = public.current_org_id();
  if v_org.id is null then
    raise exception using errcode = '42501', message = 'Votre espace doit être actif pour inviter.';
  end if;
  if p_side = 'client' and not v_org.is_supplier then
    raise exception using errcode = '22023', message = 'Seul un fournisseur invite des clients.';
  elsif p_side = 'supplier' and not v_org.is_buyer then
    raise exception using errcode = '22023', message = 'Seul un acheteur invite des fournisseurs.';
  elsif p_side not in ('client', 'supplier') then
    raise exception using errcode = '22023', message = 'Précisez qui vous invitez.';
  end if;
  if p_client_id is not null then
    if p_side <> 'client' or not exists (select 1 from public.clients c where c.id = p_client_id and c.supplier_org_id = v_org.id) then
      raise exception using errcode = 'P0002', message = 'Client introuvable.';
    end if;
    v_name := coalesce(v_name, (select c.business_name from public.clients c where c.id = p_client_id));
  end if;
  -- The same invitation is reused while it is valid (one per client record, one per person invited).
  select i.code into v_code from public.invitations i
  where i.org_id = v_org.id and i.side = p_side and i.client_id is not distinct from p_client_id and i.expires_at > now() + interval '7 days'
    and (p_client_id is not null or (i.invited_by = auth.uid() and i.name is not distinct from v_name))
  order by i.created_at desc limit 1;
  if v_code is null then
    loop
      v_code := upper(substr(md5(random()::text || clock_timestamp()::text || coalesce(auth.uid()::text, '')), 1, 8));
      exit when not exists (select 1 from public.invitations i where i.code = v_code);
    end loop;
    insert into public.invitations (code, org_id, invited_by, side, client_id, name, contact)
    values (v_code, v_org.id, auth.uid(), p_side, p_client_id, v_name, nullif(btrim(coalesce(p_contact, '')), ''));
  end if;
  return jsonb_build_object('code', v_code, 'org_name', v_org.name, 'side', p_side, 'name', v_name,
    'app_url', coalesce(public.platform_setting('app_url') #>> '{}', ''));
end;
$$;
REVOKE ALL ON FUNCTION public.create_invitation(text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invitation(text, uuid, text, text) TO authenticated;

-- What the sign-in screen shows about an invitation (no personal data).
create or replace function public.invitation_info(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('org_name', o.name, 'side', i.side, 'client_name', c.business_name, 'valid', i.expires_at > now())
  from public.invitations i join public.organizations o on o.id = i.org_id
  left join public.clients c on c.id = i.client_id
  where i.code = upper(btrim(coalesce(p_code, '')));
$$;
REVOKE ALL ON FUNCTION public.invitation_info(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invitation_info(text) TO anon, authenticated;

-- Makes the relation of one accepted invitation once the person has its space. Returns true when done.
create or replace function public.invitation_link(p_invitation_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_me public.profiles%rowtype;
  v_org public.organizations%rowtype;
  v_record public.clients%rowtype;
begin
  select * into v_inv from public.invitations where id = p_invitation_id;
  select * into v_me from public.profiles where id = p_user_id;
  select * into v_org from public.organizations where id = v_me.org_id;
  if v_inv.id is null or v_me.id is null then
    return false;
  end if;
  if v_inv.client_id is not null then
    select * into v_record from public.clients where id = v_inv.client_id;
  end if;
  -- No space yet, invited from a client record whose space has nobody: the person becomes its Responsable.
  if v_org.id is null then
    if v_record.id is null or v_record.buyer_org_id is null
       or exists (select 1 from public.profiles pr where pr.org_id = v_record.buyer_org_id and pr.id <> p_user_id) then
      return false;
    end if;
    perform set_config('appro.link_write', 'on', true);
    perform public.attach_org_owner(v_record.buyer_org_id, p_user_id);
    update public.profiles set client_id = v_record.id where id = p_user_id;
    perform set_config('appro.link_write', 'off', true);
    perform public.start_trial(v_record.buyer_org_id);
  elsif v_inv.side = 'client' then
    if not v_org.is_buyer then
      return false;
    end if;
    -- The client record waiting for its buyer is given to this buyer's space.
    if v_record.id is not null and v_record.buyer_org_id is distinct from v_org.id
       and not exists (select 1 from public.profiles pr where pr.org_id = v_record.buyer_org_id)
       and not exists (select 1 from public.clients c where c.supplier_org_id = v_inv.org_id and c.buyer_org_id = v_org.id) then
      perform set_config('appro.link_write', 'on', true);
      update public.clients set buyer_org_id = v_org.id, link_status = 'active', active = true, joined_via = coalesce(joined_via, 'invitation') where id = v_record.id;
      perform set_config('appro.link_write', 'off', true);
    end if;
    perform public.ensure_relation(v_inv.org_id, v_org.id, 'invitation');
  else
    if not v_org.is_supplier then
      return false;
    end if;
    perform public.ensure_relation(v_org.id, v_inv.org_id, 'invitation');
  end if;
  update public.invitation_acceptances set linked_at = now() where invitation_id = p_invitation_id and user_id = p_user_id;
  perform public.notify(array(select mr.user_id from public.member_roles mr join public.org_roles r on r.id = mr.role_id
      join public.role_templates t on t.id = r.template_id where r.org_id = v_inv.org_id and t.key in ('supplier_owner', 'buyer_owner')
      union select v_inv.invited_by),
    'invitation.accepted', 'Invitation acceptée',
    format('%s a rejoint Appro+ : vous êtes maintenant en relation.', coalesce((select o.name from public.organizations o where o.id = (select pr.org_id from public.profiles pr where pr.id = p_user_id)), v_me.full_name, 'Votre invité')));
  return true;
end;
$$;
REVOKE ALL ON FUNCTION public.invitation_link(uuid, uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.accept_invitation(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_me public.profiles%rowtype;
  v_linked boolean;
begin
  select * into v_me from public.profiles where id = auth.uid();
  if v_me.id is null then
    raise exception using errcode = '28000', message = 'Connectez-vous pour accepter l’invitation.';
  end if;
  select * into v_inv from public.invitations where code = upper(btrim(coalesce(p_code, '')));
  if v_inv.id is null or v_inv.expires_at < now() then
    raise exception using errcode = 'P0002', message = 'Invitation inconnue ou expirée : demandez un nouveau lien.';
  end if;
  if v_inv.org_id = v_me.org_id then
    raise exception using errcode = '22023', message = 'Cette invitation vient de votre propre espace.';
  end if;
  if v_me.role = 'platform' then
    raise exception using errcode = '22023', message = 'Un compte Appro+ ne peut pas accepter d’invitation.';
  end if;
  if not exists (select 1 from public.invitation_acceptances a where a.invitation_id = v_inv.id and a.user_id = v_me.id) then
    insert into public.invitation_acceptances (invitation_id, user_id) values (v_inv.id, v_me.id);
    update public.invitations set uses = uses + 1 where id = v_inv.id;
  end if;
  v_linked := public.invitation_link(v_inv.id, v_me.id);
  return jsonb_build_object('linked', v_linked, 'org_name', (select o.name from public.organizations o where o.id = v_inv.org_id), 'side', v_inv.side,
    'needs_space', not v_linked and (select pr.org_id from public.profiles pr where pr.id = v_me.id) is null);
end;
$$;
REVOKE ALL ON FUNCTION public.accept_invitation(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text) TO authenticated;

-- Creating one's space: business or private person, with the trial when Appro+ allows it, and the
-- relations of the invitations already accepted.
create or replace function public.register_pro(p_profile jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles%rowtype;
  v_org uuid;
  v_kind text := case when p_profile ->> 'kind' = 'person' then 'person' else 'business' end;
  v_supplier boolean := coalesce((p_profile ->> 'is_supplier')::boolean, false) and v_kind = 'business';
  v_buyer boolean := coalesce((p_profile ->> 'is_buyer')::boolean, true) or v_kind = 'person';
  v_acceptance record;
begin
  select * into v_me from public.profiles where id = auth.uid();
  if v_me.id is null then
    raise exception using errcode = '42501', message = 'Connectez-vous d’abord.';
  end if;
  if v_me.role = 'platform' or v_me.org_id is not null or v_me.client_id is not null then
    raise exception using errcode = '22023', message = 'Ce compte appartient déjà à un Pro ou à l’équipe Appro+.';
  end if;
  if char_length(btrim(coalesce(p_profile ->> 'name', ''))) < 2 then
    raise exception using errcode = '22023', message = case when v_kind = 'person' then 'Indiquez votre nom.' else 'Indiquez le nom de votre entreprise.' end;
  end if;
  if not (v_supplier or v_buyer) then
    raise exception using errcode = '22023', message = 'Choisissez au moins une activité : fournisseur ou acheteur.';
  end if;
  insert into public.organizations (name, kind, is_supplier, is_buyer, status, phone, address, tax_id, email, created_by)
  values (left(btrim(p_profile ->> 'name'), 120), v_kind, v_supplier, v_buyer, 'pending',
          left(btrim(coalesce(p_profile ->> 'phone', '')), 60), left(btrim(coalesce(p_profile ->> 'address', '')), 300),
          left(btrim(coalesce(p_profile ->> 'tax_id', '')), 60),
          coalesce((select u.email from auth.users u where u.id = auth.uid()), ''), auth.uid())
  returning id into v_org;
  perform public.org_install_roles(v_org);
  update public.profiles set org_id = v_org, role = (case when v_supplier then 'admin' else 'customer' end)::public.app_role, account_status = 'pending'
  where id = auth.uid();
  insert into public.member_roles (user_id, role_id)
  select auth.uid(), r.id from public.org_roles r join public.role_templates t on t.id = r.template_id
  where r.org_id = v_org and t.key in ('supplier_owner', 'buyer_owner')
  on conflict do nothing;
  perform public.start_trial(v_org);
  for v_acceptance in select a.invitation_id from public.invitation_acceptances a where a.user_id = auth.uid() and a.linked_at is null loop
    perform public.invitation_link(v_acceptance.invitation_id, auth.uid());
  end loop;
  return v_org;
end;
$$;
REVOKE ALL ON FUNCTION public.register_pro(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_pro(jsonb) TO authenticated;

-- ===========================================================================
-- G. Messages between Pros outside their network: one conversation per pair of Pros. Starting one needs
--    the other Pro to accept messages from outside its network (or a relation between them).
-- ===========================================================================
create table if not exists public.org_conversations (
  id uuid primary key default gen_random_uuid(),
  org_a uuid not null references public.organizations(id) on delete cascade,
  org_b uuid not null references public.organizations(id) on delete cascade,
  started_by uuid references public.organizations(id) on delete set null,
  created_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  check (org_a < org_b),
  unique (org_a, org_b)
);
create table if not exists public.org_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.org_conversations(id) on delete cascade,
  sender_org_id uuid not null references public.organizations(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists org_messages_conversation_idx on public.org_messages(conversation_id, created_at);
alter table public.org_conversations enable row level security;
alter table public.org_messages enable row level security;

create or replace function public.org_related(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.clients c where c.link_status = 'active'
    and ((c.supplier_org_id = p_a and c.buyer_org_id = p_b) or (c.supplier_org_id = p_b and c.buyer_org_id = p_a)));
$$;
REVOKE ALL ON FUNCTION public.org_related(uuid, uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.org_inbox()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null then
    raise exception using errcode = '42501', message = 'Réservé aux espaces actifs.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'conversation_id', cv.id, 'org_id', o.id, 'name', o.name, 'kind', o.kind, 'last_at', cv.last_at,
      'last_body', (select m.body from public.org_messages m where m.conversation_id = cv.id order by m.created_at desc limit 1),
      'unread', (select count(*) from public.org_messages m where m.conversation_id = cv.id and m.sender_org_id <> v_org and m.read_at is null),
      'related', public.org_related(v_org, o.id)) order by cv.last_at desc)
    from public.org_conversations cv
    join public.organizations o on o.id = case when cv.org_a = v_org then cv.org_b else cv.org_a end
    where v_org in (cv.org_a, cv.org_b)), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.org_inbox() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_inbox() TO authenticated;

create or replace function public.org_thread(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
  v_cv public.org_conversations%rowtype;
begin
  select * into v_cv from public.org_conversations where id = p_conversation_id;
  if v_org is null or v_cv.id is null or v_org not in (v_cv.org_a, v_cv.org_b) then
    raise exception using errcode = '42501', message = 'Conversation introuvable.';
  end if;
  update public.org_messages set read_at = now() where conversation_id = v_cv.id and sender_org_id <> v_org and read_at is null;
  return jsonb_build_object(
    'conversation_id', v_cv.id,
    'org', (select jsonb_build_object('id', o.id, 'name', o.name, 'kind', o.kind) from public.organizations o
            where o.id = case when v_cv.org_a = v_org then v_cv.org_b else v_cv.org_a end),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'mine', m.sender_org_id = v_org,
        'sender_name', pr.full_name, 'created_at', m.created_at, 'read_at', m.read_at) order by m.created_at desc)
      from (select * from public.org_messages x where x.conversation_id = v_cv.id order by x.created_at desc limit 300) m
      left join public.profiles pr on pr.id = m.sender_id), '[]'::jsonb));
end;
$$;
REVOKE ALL ON FUNCTION public.org_thread(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_thread(uuid) TO authenticated;

create or replace function public.org_send(p_org_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
  v_other public.organizations%rowtype;
  v_cv uuid;
  v_a uuid;
  v_b uuid;
begin
  if v_org is null then
    raise exception using errcode = '42501', message = 'Votre espace doit être actif pour écrire.';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 4000 then
    raise exception using errcode = '22023', message = 'Écrivez votre message (4000 caractères maximum).';
  end if;
  select * into v_other from public.organizations where id = p_org_id and status = 'active';
  if v_other.id is null or v_other.id = v_org then
    raise exception using errcode = 'P0002', message = 'Ce Pro n’est pas disponible.';
  end if;
  v_a := least(v_org, v_other.id);
  v_b := greatest(v_org, v_other.id);
  select cv.id into v_cv from public.org_conversations cv where cv.org_a = v_a and cv.org_b = v_b;
  if v_cv is null then
    if not v_other.open_to_messages and not public.org_related(v_org, v_other.id) then
      raise exception using errcode = '42501', message = 'Ce Pro ne reçoit pas de messages hors de son réseau.';
    end if;
    insert into public.org_conversations (org_a, org_b, started_by) values (v_a, v_b, v_org) returning id into v_cv;
  end if;
  insert into public.org_messages (conversation_id, sender_org_id, sender_id, body) values (v_cv, v_org, auth.uid(), btrim(p_body));
  update public.org_conversations set last_at = now() where id = v_cv;
  perform public.notify(array(select mr.user_id from public.member_roles mr join public.org_roles r on r.id = mr.role_id
      join public.role_templates t on t.id = r.template_id where r.org_id = v_other.id and t.key in ('supplier_owner', 'buyer_owner')),
    'org.message', format('Message de %s', (select o.name from public.organizations o where o.id = v_org)), left(btrim(p_body), 140));
  return v_cv;
end;
$$;
REVOKE ALL ON FUNCTION public.org_send(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_send(uuid, text) TO authenticated;

notify pgrst, 'reload schema';
