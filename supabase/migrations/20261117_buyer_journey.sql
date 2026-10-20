-- Lot 2 — a buyer with several suppliers, end to end:
--   * one reception QR per buyer, accepted by the drivers of all its suppliers (the former per-supplier QR still works);
--   * a buyer's notifications name the supplier they come from;
--   * invoices and accounts of all my suppliers (each with its own supplier details for the PDF);
--   * cancel or change an order as long as the supplier has not accepted it;
--   * messages: one conversation per supplier, a message to one or several suppliers (and, for a supplier,
--     to one or several clients);
--   * VAT rate in the buyer catalogue (prices shown excl. and incl. VAT);
--   * outstanding figures when a supplier enters an order for a client.
-- Run in Supabase SQL Editor AFTER 20261116_catalog_numbers.sql. Safe to rerun.

-- ---------------------------------------------------------------------------
-- Reception QR per buyer.
-- ---------------------------------------------------------------------------
alter table public.organizations add column if not exists reception_token uuid not null default gen_random_uuid();
create unique index if not exists organizations_reception_token_idx on public.organizations(reception_token);

DO $$
DECLARE
  v_def text := pg_get_functiondef('public.driver_deliver(uuid[], uuid[], text, uuid)'::regprocedure);
BEGIN
  IF v_def not like '%buyer reception QR%' THEN
    v_def := replace(v_def,
      'p_client_qr_kind is distinct from ''client'' or p_client_qr_token is distinct from v_client.reception_token',
      'p_client_qr_kind is distinct from ''client'' or (p_client_qr_token is distinct from v_client.reception_token /* buyer reception QR */
        and p_client_qr_token is distinct from (select b.reception_token from public.organizations b where b.id = v_client.buyer_org_id))');
    EXECUTE v_def;
  END IF;
END;
$$;

-- My reception QR, and whether one of my suppliers asks for it.
create or replace function public.my_reception_qr()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('token', b.reception_token, 'name', b.name,
    'required', exists (select 1 from public.clients c where c.buyer_org_id = b.id and c.link_status = 'active' and c.active and c.reception_qr and c.scan_client_qr))
  from public.profiles pr join public.organizations b on b.id = pr.org_id
  where pr.id = (select auth.uid()) and pr.role = 'customer' and pr.account_status = 'active';
$$;
REVOKE ALL ON FUNCTION public.my_reception_qr() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_reception_qr() TO authenticated;

-- ---------------------------------------------------------------------------
-- A buyer's notifications name the supplier (only for buyers with several suppliers).
-- ---------------------------------------------------------------------------
create or replace function public.notifications_name_supplier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if not exists (select 1 from public.profiles pr where pr.id = new.user_id and pr.role = 'customer') then
    return new;
  end if;
  if (select count(*) from public.profiles pr join public.clients c on c.buyer_org_id = pr.org_id and c.link_status = 'active' and c.active
      where pr.id = new.user_id) < 2 then
    return new;
  end if;
  select s.name into v_name from public.organizations s
  where s.id = coalesce((select o.supplier_org_id from public.orders o where o.id = new.order_id), public.acting_supplier_org_id());
  if v_name is not null and position(v_name in coalesce(new.title, '')) = 0 then
    new.title := v_name || ' · ' || coalesce(new.title, '');
  end if;
  return new;
end;
$$;
drop trigger if exists notifications_name_supplier on public.notifications;
create trigger notifications_name_supplier before insert on public.notifications for each row execute function public.notifications_name_supplier();

-- ---------------------------------------------------------------------------
-- Invoices and accounts of all my suppliers.
-- ---------------------------------------------------------------------------
create or replace function public.can_see_account(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (public.org_visible(public.client_org(p_client_id))
          and (public.has_feature('invoices.manage') or (p_client_id = public.current_client_id() and public.has_feature('client.invoices'))))
      or public.buyer_relation_can(p_client_id, 'client.invoices');
$$;
REVOKE ALL ON FUNCTION public.can_see_account(uuid) FROM PUBLIC, anon, authenticated;

-- The supplier's details printed on its documents.
create or replace function public.seller_card(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('name', o.name, 'tagline', o.tagline, 'address', o.address, 'phone', o.phone, 'email', o.email,
    'tax_id', o.tax_id, 'rib', o.rib, 'brand_color', o.brand_color)
  from public.organizations o where o.id = p_org_id;
$$;
REVOKE ALL ON FUNCTION public.seller_card(uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.buyer_accounts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('client_id', c.id, 'supplier_name', s.name, 'current', c.id = public.current_client_id())
    || public.account_figures(c.id) order by s.name), '[]'::jsonb)
  from public.buyer_relations('client.invoices') c join public.organizations s on s.id = c.supplier_org_id;
$$;
REVOKE ALL ON FUNCTION public.buyer_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_accounts() TO authenticated;

create or replace function public.buyer_invoices()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(i) || jsonb_build_object(
      'supplier_name', s.name, 'seller', public.seller_card(s.id),
      'invoice_payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.paid_on) from public.invoice_payments p where p.invoice_id = i.id), '[]'::jsonb),
      'orders', coalesce((select jsonb_agg(to_jsonb(o) || jsonb_build_object(
          'order_items', coalesce((select jsonb_agg(to_jsonb(oi) order by oi.product_name_snapshot) from public.order_items oi where oi.order_id = o.id), '[]'::jsonb),
          'order_status_history', '[]'::jsonb)) from public.orders o where o.client_invoice_id = i.id), '[]'::jsonb))
    order by coalesce(i.issued_at, i.created_at) desc), '[]'::jsonb)
  from public.buyer_relations('client.invoices') c
  join public.organizations s on s.id = c.supplier_org_id
  join public.client_invoices i on i.client_id = c.id and i.status <> 'draft';
$$;
REVOKE ALL ON FUNCTION public.buyer_invoices() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_invoices() TO authenticated;

-- ---------------------------------------------------------------------------
-- Cancel or change an order not yet accepted by the supplier.
-- ---------------------------------------------------------------------------
create or replace function public.buyer_pending_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if v_order.id is null or not exists (select 1 from public.buyer_relations('client.order') c where c.id = v_order.client_id) then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  if v_order.status <> 'pending' then
    raise exception using errcode = '22023', message = 'Votre fournisseur a déjà traité cette commande : contactez-le pour la changer.';
  end if;
  return v_order;
end;
$$;
REVOKE ALL ON FUNCTION public.buyer_pending_order(uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.release_order_stock(p_order_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.products p set stock_quantity = p.stock_quantity + oi.quantity, updated_at = now()
  from public.order_items oi join public.orders o on o.id = oi.order_id
  where oi.order_id = p_order_id and oi.product_id = p.id and o.stock_reserved;
$$;
REVOKE ALL ON FUNCTION public.release_order_stock(uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.client_cancel_order(p_order_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype := public.buyer_pending_order(p_order_id);
  v_note text := coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Annulée par le client avant acceptation.');
begin
  perform public.release_order_stock(v_order.id);
  update public.orders set status = 'cancelled', status_note = v_note, stock_reserved = false, updated_at = now() where id = v_order.id;
  insert into public.order_status_history (order_id, status, note, changed_by) values (v_order.id, 'cancelled', v_note, auth.uid());
  update public.payments set status = 'cancelled' where order_id = v_order.id and status = 'pending';
  perform public.notify(array(select public.team_with_feature('orders.decide', v_order.supplier_org_id)), 'order.status',
    format('Commande #%s annulée par le client', v_order.order_number), v_note, v_order.id);
  return jsonb_build_object('id', v_order.id, 'status', 'cancelled');
end;
$$;
REVOKE ALL ON FUNCTION public.client_cancel_order(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_cancel_order(uuid, text) TO authenticated;

-- New lines, same rules as a new order (products of this supplier, stock, prices of the day).
create or replace function public.client_modify_order(p_order_id uuid, p_items jsonb, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype := public.buyer_pending_order(p_order_id);
  v_stock boolean;
  v_item record;
  v_product public.products%rowtype;
  v_subtotal numeric(12,3) := 0;
  v_line numeric(12,3);
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'La commande est vide : annulez-la plutôt.';
  end if;
  v_stock := v_order.stock_reserved;
  perform public.release_order_stock(v_order.id);
  delete from public.order_items where order_id = v_order.id;
  for v_item in
    select (line.value ->> 'product_id')::uuid as product_id, sum((line.value ->> 'quantity')::numeric)::numeric(12,3) as quantity
    from jsonb_array_elements(p_items) as line(value) group by 1 order by 1
  loop
    if v_item.product_id is null or v_item.quantity is null or v_item.quantity <= 0 or v_item.quantity > 100000 then
      raise exception using errcode = '22023', message = 'Une quantité de la commande est invalide.';
    end if;
    select p.* into v_product from public.products p where p.id = v_item.product_id for update;
    if not found or not v_product.active or v_product.org_id is distinct from v_order.supplier_org_id then
      raise exception using errcode = 'P0002', message = 'Un produit de la commande n’est plus disponible chez ce fournisseur.';
    end if;
    if v_stock and v_product.stock_quantity < v_item.quantity then
      raise exception using errcode = '22023', message = format('Stock insuffisant pour %s (disponible : %s).', v_product.name, v_product.stock_quantity);
    end if;
    v_line := round(v_product.price * v_item.quantity, 3);
    v_subtotal := v_subtotal + v_line;
    insert into public.order_items (order_id, product_id, product_name_snapshot, unit_snapshot, unit_price, quantity, line_total, vat_rate, origin_snapshot)
    values (v_order.id, v_product.id, v_product.name, v_product.unit_label, v_product.price, v_item.quantity, v_line, v_product.vat_rate,
      nullif(jsonb_strip_nulls(jsonb_build_object('producer', nullif(btrim(v_product.origin_producer), ''), 'region', nullif(btrim(v_product.origin_region), ''),
        'label', nullif(btrim(v_product.origin_label), ''), 'note', nullif(btrim(v_product.origin_note), ''))), '{}'::jsonb));
    if v_stock then
      update public.products set stock_quantity = stock_quantity - v_item.quantity, updated_at = now() where id = v_product.id;
    end if;
  end loop;
  update public.orders set subtotal = v_subtotal, total = v_subtotal + coalesce(delivery_fee, 0),
    customer_note = case when p_note is null then customer_note else nullif(btrim(p_note), '') end, updated_at = now()
  where id = v_order.id;
  update public.payments set amount = v_subtotal + coalesce(v_order.delivery_fee, 0) where order_id = v_order.id and status = 'pending';
  insert into public.order_status_history (order_id, status, note, changed_by) values (v_order.id, 'pending', 'Commande modifiée par le client.', auth.uid());
  perform public.notify(array(select public.team_with_feature('orders.decide', v_order.supplier_org_id)), 'order.new',
    format('Commande #%s modifiée par le client', v_order.order_number), 'Vérifiez les nouvelles quantités avant de l’accepter.', v_order.id);
  return jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number, 'total', v_subtotal);
end;
$$;
REVOKE ALL ON FUNCTION public.client_modify_order(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_modify_order(uuid, jsonb, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Messages: one conversation per supplier, sent to one or several of them.
-- ---------------------------------------------------------------------------
create or replace function public.buyer_inbox()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('client_id', c.id, 'supplier_name', s.name,
      'last_body', m.body, 'last_at', m.created_at, 'last_from_staff', m.from_staff,
      'unread', (select count(*) from public.messages u where u.client_id = c.id and u.from_staff and u.read_at is null))
    order by m.created_at desc nulls last, s.name), '[]'::jsonb)
  from public.buyer_relations('client.messages') c
  join public.organizations s on s.id = c.supplier_org_id
  left join lateral (select x.body, x.created_at, x.from_staff from public.messages x where x.client_id = c.id order by x.created_at desc limit 1) m on true;
$$;
REVOKE ALL ON FUNCTION public.buyer_inbox() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_inbox() TO authenticated;

-- Reads one of my conversations (and marks the supplier's messages read).
create or replace function public.buyer_thread(p_client_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.buyer_relations('client.messages') c where c.id = p_client_id) then
    raise exception using errcode = '42501', message = 'Conversation introuvable.';
  end if;
  update public.messages set read_at = now() where client_id = p_client_id and from_staff and read_at is null;
  return coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at desc)
    from (select * from public.messages x where x.client_id = p_client_id order by x.created_at desc limit 200) m), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.buyer_thread(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_thread(uuid) TO authenticated;

-- One message to one or several of my suppliers (attachment and reply: one supplier at a time).
create or replace function public.buyer_send_message(p_client_ids uuid[], p_body text, p_attachment jsonb default null, p_needs_reply boolean default false, p_reply_to uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.active_uid();
  v_current uuid;
  v_id uuid;
  v_results jsonb := '[]'::jsonb;
begin
  if v_uid is null or coalesce(array_length(p_client_ids, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'Choisissez au moins un destinataire.';
  end if;
  if array_length(p_client_ids, 1) > 1 and (p_attachment is not null or p_reply_to is not null) then
    raise exception using errcode = '22023', message = 'Une pièce jointe ou une réponse ne part qu’à un seul fournisseur.';
  end if;
  select pr.client_id into v_current from public.profiles pr where pr.id = v_uid;
  foreach v_id in array p_client_ids loop
    if not exists (select 1 from public.buyer_relations('client.messages') c where c.id = v_id) then
      raise exception using errcode = '42501', message = 'Un des destinataires ne fait pas partie de vos fournisseurs.';
    end if;
    perform set_config('appro.link_write', 'on', true);
    update public.profiles set client_id = v_id where id = v_uid;
    perform set_config('appro.link_write', 'off', true);
    v_results := v_results || jsonb_build_array(public.send_message_v3(v_id, p_body, p_attachment, p_needs_reply, p_reply_to));
  end loop;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set client_id = v_current where id = v_uid;
  perform set_config('appro.link_write', 'off', true);
  return v_results;
end;
$$;
REVOKE ALL ON FUNCTION public.buyer_send_message(uuid[], text, jsonb, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_send_message(uuid[], text, jsonb, boolean, uuid) TO authenticated;

-- A supplier writes to one or several of its clients (same rules as a single message).
create or replace function public.staff_send_messages(p_client_ids uuid[], p_body text, p_needs_reply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_results jsonb := '[]'::jsonb;
begin
  if not public.is_staff() or not public.has_feature('messages.manage') then
    raise exception using errcode = '42501', message = 'La messagerie n’est pas activée pour votre profil.';
  end if;
  if coalesce(array_length(p_client_ids, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'Choisissez au moins un destinataire.';
  end if;
  foreach v_id in array p_client_ids loop
    if not exists (select 1 from public.clients c where c.id = v_id and c.supplier_org_id = public.current_org_id() and c.link_status = 'active') then
      raise exception using errcode = '42501', message = 'Un des destinataires n’est pas votre client.';
    end if;
    v_results := v_results || jsonb_build_array(public.send_message_v3(v_id, p_body, null, p_needs_reply, null));
  end loop;
  return v_results;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_send_messages(uuid[], text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_send_messages(uuid[], text, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- VAT in the buyer catalogue; outstanding figures for the supplier's order entry.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.buyer_catalog()'::regprocedure);
BEGIN
  IF v_def not like '%vat_rate%' THEN
    EXECUTE replace(v_def, '''unit_label'', p.unit_label,', '''unit_label'', p.unit_label, ''vat_rate'', p.vat_rate,');
  END IF;
END;
$$;

create or replace function public.staff_client_figures(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (public.has_feature('orders.create') or public.has_feature('invoices.manage'))
     or not exists (select 1 from public.clients c where c.id = p_client_id and c.supplier_org_id = public.current_org_id()) then
    raise exception using errcode = '42501', message = 'Client introuvable.';
  end if;
  return public.account_figures(p_client_id);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_client_figures(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_client_figures(uuid) TO authenticated;
