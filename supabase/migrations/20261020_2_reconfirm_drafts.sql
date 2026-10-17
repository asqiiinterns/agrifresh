-- Reconfirmation by the client and invoice drafts, part 2/2.
-- Run in Supabase SQL Editor AFTER 20261020_1_enums.sql. Safe to rerun.
--
-- Orders: staff can reopen a declined order as "awaiting_client"; the client then
-- reconfirms it (→ confirmed, stock reserved again) or refuses it (→ cancelled).
-- Every step is recorded in order_status_history, shown to both sides.
-- Also: product origin (traceability, shown per client record), staff catalogue
-- management and client claims on orders.
-- Invoices: staff can save a draft (no number, editable, hidden from the client)
-- and issue it later; the FA-… number is assigned at issue so numbering has no gaps.

-- ---------------------------------------------------------------------------
-- Invoice drafts
-- ---------------------------------------------------------------------------

alter table public.client_invoices alter column invoice_number drop not null;
alter table public.client_invoices add column if not exists updated_at timestamptz not null default now();
alter table public.client_invoices drop constraint if exists client_invoices_status_check;
alter table public.client_invoices add constraint client_invoices_status_check
  check (status in ('draft', 'issued', 'paid', 'cancelled'));
alter table public.client_invoices drop constraint if exists client_invoices_number_check;
alter table public.client_invoices add constraint client_invoices_number_check
  check (status = 'draft' or invoice_number is not null);

drop policy if exists "client_invoices_read_own" on public.client_invoices;
create policy "client_invoices_read_own" on public.client_invoices
  for select to authenticated using (client_id = (select public.current_client_id()) and status <> 'draft');

create or replace function public.client_invoice_snapshot(p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'business_name', c.business_name,
    'contact_name', c.contact_name,
    'client_number', c.client_number,
    'email', c.email,
    'phone', c.phone,
    'tax_id', c.tax_id,
    'address', (select dp.address_line || ', ' || dp.city from public.client_delivery_points dp
                where dp.client_id = c.id and dp.active order by dp.created_at limit 1)
  )
  from public.clients c where c.id = p_client_id;
$$;
REVOKE ALL ON FUNCTION public.client_invoice_snapshot(uuid) FROM PUBLIC, anon, authenticated;

-- Totals: HT = sum of lines, VAT per rate, fixed fiscal stamp, TTC = HT + VAT + stamp.
create or replace function public.refresh_invoice_totals(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ht numeric(12,3);
  v_vat numeric(12,3);
  v_breakdown jsonb;
  v_stamp numeric(12,3) := 1;
begin
  select
    coalesce(sum(r.base), 0),
    coalesce(sum(r.vat), 0),
    coalesce(jsonb_agg(jsonb_build_object('rate', r.rate, 'base', r.base, 'vat', r.vat) order by r.rate), '[]'::jsonb)
  into v_ht, v_vat, v_breakdown
  from (
    select oi.vat_rate as rate, sum(oi.line_total) as base, round(sum(oi.line_total) * oi.vat_rate / 100, 3) as vat
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.client_invoice_id = p_invoice_id
    group by oi.vat_rate
  ) r;

  update public.client_invoices
  set total_ht = v_ht, total_vat = v_vat, vat_breakdown = v_breakdown,
      stamp_duty = v_stamp, total_ttc = v_ht + v_vat + v_stamp, updated_at = now()
  where id = p_invoice_id;
end;
$$;
REVOKE ALL ON FUNCTION public.refresh_invoice_totals(uuid) FROM PUBLIC, anon, authenticated;

-- Sets the exact list of delivery notes of an invoice (draft edits included).
create or replace function public.attach_invoice_orders(p_invoice_id uuid, p_client_id uuid, p_order_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requested int;
  v_matching int;
begin
  select count(distinct id) into v_requested from unnest(coalesce(p_order_ids, array[]::uuid[])) as t(id);
  if v_requested = 0 then
    raise exception using errcode = '22023', message = 'Sélectionnez au moins un bon de livraison.';
  end if;

  perform 1 from public.orders o
  where o.id = any(p_order_ids) or o.client_invoice_id = p_invoice_id
  order by o.id for update;

  select count(*) into v_matching
  from public.orders o
  where o.id = any(p_order_ids)
    and o.client_id = p_client_id
    and (o.client_invoice_id is null or o.client_invoice_id = p_invoice_id)
    and o.status in ('confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered');
  if v_matching <> v_requested then
    raise exception using errcode = '22023', message = 'Un bon sélectionné est déjà facturé, appartient à un autre client ou n’est pas accepté.';
  end if;

  update public.orders set client_invoice_id = null
  where client_invoice_id = p_invoice_id and not (id = any(p_order_ids));
  update public.orders set client_invoice_id = p_invoice_id where id = any(p_order_ids);
  perform public.refresh_invoice_totals(p_invoice_id);
end;
$$;
REVOKE ALL ON FUNCTION public.attach_invoice_orders(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;

create or replace function public.issue_invoice(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client_id uuid;
begin
  select i.client_id into v_client_id from public.client_invoices i where i.id = p_invoice_id;
  if not exists (select 1 from public.orders o where o.client_invoice_id = p_invoice_id) then
    raise exception using errcode = '22023', message = 'La facture ne contient aucun bon de livraison.';
  end if;
  perform public.refresh_invoice_totals(p_invoice_id);
  update public.client_invoices
  set status = 'issued',
      invoice_number = 'FA-' || to_char(now() at time zone 'Africa/Tunis', 'YYYY') || '-' || lpad(nextval('public.client_invoice_number_seq')::text, 5, '0'),
      issued_at = now(),
      client_snapshot = public.client_invoice_snapshot(v_client_id),
      updated_at = now()
  where id = p_invoice_id;
end;
$$;
REVOKE ALL ON FUNCTION public.issue_invoice(uuid) FROM PUBLIC, anon, authenticated;

drop function if exists public.create_client_invoice(uuid, uuid[], uuid);
create or replace function public.create_client_invoice(p_client_id uuid, p_order_ids uuid[], p_created_by uuid, p_draft boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice_id uuid;
begin
  if not exists (select 1 from public.clients c where c.id = p_client_id) then
    raise exception using errcode = 'P0002', message = 'Client introuvable.';
  end if;

  insert into public.client_invoices (
    invoice_number, client_id, status, client_snapshot, total_ht, total_vat, stamp_duty, total_ttc, created_by
  ) values (
    null, p_client_id, 'draft', public.client_invoice_snapshot(p_client_id), 0, 0, 1, 1, p_created_by
  ) returning id into v_invoice_id;

  perform public.attach_invoice_orders(v_invoice_id, p_client_id, p_order_ids);
  if not p_draft then
    perform public.issue_invoice(v_invoice_id);
  end if;
  return v_invoice_id;
end;
$$;
REVOKE ALL ON FUNCTION public.create_client_invoice(uuid, uuid[], uuid, boolean) FROM PUBLIC, anon, authenticated;

drop function if exists public.staff_create_invoice(uuid, uuid[]);
create or replace function public.staff_create_invoice(p_client_id uuid, p_order_ids uuid[], p_draft boolean default false)
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
  v_invoice_id := public.create_client_invoice(p_client_id, p_order_ids, auth.uid(), coalesce(p_draft, false));
  return (select jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number, 'status', i.status, 'total_ttc', i.total_ttc)
          from public.client_invoices i where i.id = v_invoice_id);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_create_invoice(uuid, uuid[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_create_invoice(uuid, uuid[], boolean) TO authenticated;

create or replace function public.staff_update_invoice_draft(p_invoice_id uuid, p_order_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.client_invoices%rowtype;
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Accès réservé au personnel AgriFresh.';
  end if;
  select i.* into v_invoice from public.client_invoices i where i.id = p_invoice_id for update;
  if not found or v_invoice.status <> 'draft' then
    raise exception using errcode = '22023', message = 'Seul un brouillon peut être modifié.';
  end if;
  perform public.attach_invoice_orders(p_invoice_id, v_invoice.client_id, p_order_ids);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_update_invoice_draft(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_update_invoice_draft(uuid, uuid[]) TO authenticated;

create or replace function public.staff_issue_invoice(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Accès réservé au personnel AgriFresh.';
  end if;
  select i.status into v_status from public.client_invoices i where i.id = p_invoice_id for update;
  if not found or v_status <> 'draft' then
    raise exception using errcode = '22023', message = 'Cette facture est déjà validée.';
  end if;
  perform public.issue_invoice(p_invoice_id);
  return (select jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number)
          from public.client_invoices i where i.id = p_invoice_id);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_issue_invoice(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_issue_invoice(uuid) TO authenticated;

create or replace function public.staff_delete_invoice_draft(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Accès réservé au personnel AgriFresh.';
  end if;
  select i.status into v_status from public.client_invoices i where i.id = p_invoice_id for update;
  if not found or v_status <> 'draft' then
    raise exception using errcode = '22023', message = 'Seul un brouillon peut être supprimé ; une facture validée s’annule.';
  end if;
  update public.orders set client_invoice_id = null where client_invoice_id = p_invoice_id;
  delete from public.client_invoices where id = p_invoice_id;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_delete_invoice_draft(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_delete_invoice_draft(uuid) TO authenticated;

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
  if v_current = 'draft' then
    raise exception using errcode = '22023', message = 'Validez d’abord le brouillon.';
  end if;
  if v_current = 'cancelled' or p_status not in ('issued', 'paid', 'cancelled') then
    raise exception using errcode = '22023', message = 'Cette facture ne peut plus être modifiée.';
  end if;

  update public.client_invoices
  set status = p_status, paid_at = case when p_status = 'paid' then now() else null end, updated_at = now()
  where id = p_invoice_id;

  if p_status = 'cancelled' then
    update public.orders set client_invoice_id = null where client_invoice_id = p_invoice_id;
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_set_invoice_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_invoice_status(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Staff workflow: reopen a declined order for client reconfirmation
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
  v_invoice_status text;
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
      updated_at = now()
  where id = p_order_id;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (p_order_id, p_status, v_note, v_staff_id);

  if p_status = 'confirmed' and v_order.client_invoice_id is null
     and exists (select 1 from public.clients c where c.id = v_order.client_id and c.invoice_mode = 'auto') then
    perform public.create_client_invoice(v_order.client_id, array[p_order_id], v_staff_id, false);
  end if;

  -- Stock is reserved from placement until decline/cancel; an order awaiting the
  -- client holds no stock (it was released when it was declined).
  if p_status in ('declined', 'cancelled') and v_order.status <> 'awaiting_client' then
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
-- Client answer to an order awaiting reconfirmation
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
  v_order public.orders%rowtype;
  v_line record;
  v_product public.products%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_client_id is null then
    raise exception using errcode = '42501', message = 'Votre compte n’est rattaché à aucune fiche client.';
  end if;

  select o.* into v_order from public.orders o where o.id = p_order_id and o.client_id = v_client_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  if v_order.status <> 'awaiting_client' then
    raise exception using errcode = '22023', message = 'Cette commande n’attend pas votre confirmation.';
  end if;

  if p_accept then
    -- Reserve the stock again, products locked in a stable order.
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

    update public.orders set status = 'confirmed', status_note = null, updated_at = now() where id = p_order_id;
    insert into public.order_status_history (order_id, status, note, changed_by)
    values (p_order_id, 'confirmed', coalesce(v_note, 'Commande reconfirmée par le client.'), v_customer_id);
    update public.payments set status = 'pending' where order_id = p_order_id and status = 'cancelled';

    if v_order.client_invoice_id is null
       and exists (select 1 from public.clients c where c.id = v_client_id and c.invoice_mode = 'auto') then
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
-- Product origin (traceability), shown to clients whose record enables it
-- ---------------------------------------------------------------------------

alter table public.products add column if not exists origin_producer text;
alter table public.products add column if not exists origin_region text;
alter table public.products add column if not exists origin_label text;
alter table public.products add column if not exists origin_note text;
alter table public.order_items add column if not exists origin_snapshot jsonb;
alter table public.clients add column if not exists show_origin boolean not null default false;

-- Staff manage the catalogue (including inactive products) from the app.
GRANT SELECT, INSERT, UPDATE ON public.products TO authenticated;
GRANT SELECT ON public.categories TO anon, authenticated;
drop policy if exists "products_staff_all" on public.products;
create policy "products_staff_all" on public.products
  for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

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

-- Order placement now freezes the product origin on each line.
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
-- Claims (réclamations) on an order
-- ---------------------------------------------------------------------------

create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  claim_number bigint generated always as identity unique,
  order_id uuid not null references public.orders(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  reason text not null check (reason in ('missing', 'quantity', 'quality', 'late', 'other')),
  description text not null check (char_length(btrim(description)) between 1 and 2000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'rejected')),
  staff_response text,
  created_by uuid references public.profiles(id) on delete set null,
  handled_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists claims_client_idx on public.claims(client_id, created_at desc);
create index if not exists claims_status_idx on public.claims(status, created_at desc);
create index if not exists claims_order_idx on public.claims(order_id);

alter table public.claims enable row level security;
GRANT SELECT ON public.claims TO authenticated;
drop policy if exists "claims_read_staff" on public.claims;
create policy "claims_read_staff" on public.claims
  for select to authenticated using ((select public.is_staff()));
drop policy if exists "claims_read_own" on public.claims;
create policy "claims_read_own" on public.claims
  for select to authenticated using (client_id = (select public.current_client_id()));

create or replace function public.client_create_claim(p_order_id uuid, p_reason text, p_description text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client_id uuid := public.current_client_id();
  v_status public.order_status;
  v_claim public.claims%rowtype;
begin
  if v_client_id is null then
    raise exception using errcode = '42501', message = 'Votre compte n’est rattaché à aucune fiche client.';
  end if;
  select o.status into v_status from public.orders o where o.id = p_order_id and o.client_id = v_client_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  if v_status in ('declined', 'cancelled') then
    raise exception using errcode = '22023', message = 'Cette commande est annulée : écrivez-nous dans Messages si besoin.';
  end if;
  if coalesce(p_reason, '') not in ('missing', 'quantity', 'quality', 'late', 'other') then
    raise exception using errcode = '22023', message = 'Choisissez le motif de la réclamation.';
  end if;
  if char_length(btrim(coalesce(p_description, ''))) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Décrivez le problème (2000 caractères maximum).';
  end if;

  insert into public.claims (order_id, client_id, reason, description, created_by)
  values (p_order_id, v_client_id, p_reason, btrim(p_description), auth.uid())
  returning * into v_claim;
  return jsonb_build_object('id', v_claim.id, 'claim_number', v_claim.claim_number, 'status', v_claim.status);
end;
$$;
REVOKE ALL ON FUNCTION public.client_create_claim(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_create_claim(uuid, text, text) TO authenticated;

create or replace function public.staff_update_claim(p_claim_id uuid, p_status text, p_response text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current text;
  v_response text := nullif(btrim(coalesce(p_response, '')), '');
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Accès réservé au personnel AgriFresh.';
  end if;
  select c.status into v_current from public.claims c where c.id = p_claim_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Réclamation introuvable.';
  end if;
  if p_status not in ('open', 'in_progress', 'resolved', 'rejected') then
    raise exception using errcode = '22023', message = 'Statut de réclamation invalide.';
  end if;
  if p_status in ('resolved', 'rejected') and v_response is null then
    raise exception using errcode = '22023', message = 'Indiquez la réponse apportée au client.';
  end if;

  update public.claims
  set status = p_status,
      staff_response = coalesce(v_response, staff_response),
      handled_by = auth.uid(),
      updated_at = now(),
      resolved_at = case when p_status in ('resolved', 'rejected') then now() else null end
  where id = p_claim_id;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_update_claim(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_update_claim(uuid, text, text) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'claims'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.claims';
  END IF;
END;
$$;
