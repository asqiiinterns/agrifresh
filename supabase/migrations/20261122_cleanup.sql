-- Cleanup (decided 2026-10-21):
--   * client reconfirmation removed: a declined order that the supplier reopens is accepted at once
--     (orders already "à reconfirmer" can still be answered by their client);
--   * returns, credit notes and recurring orders of a buyer work with all its suppliers (no "selected supplier").
-- Run in Supabase SQL Editor AFTER 20261121_lot5_workflow.sql. Safe to rerun.

-- ---------------------------------------------------------------------------
-- 1. No more client reconfirmation
-- ---------------------------------------------------------------------------
update public.client_setting_defaults set value = 'false'::jsonb, updated_at = now() where key = 'reconfirm_declined' and value <> 'false'::jsonb;
DO $$
BEGIN
  -- Bypass of the per-Pro write guard (the SQL editor has no signed-in user, but stay explicit).
  PERFORM set_config('appro.link_write', 'on', true);
  UPDATE public.clients SET custom_settings = array_remove(custom_settings, 'reconfirm_declined'), reconfirm_declined = false
  WHERE reconfirm_declined OR 'reconfirm_declined' = any(custom_settings);
  PERFORM set_config('appro.link_write', 'off', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 1b. Document numbers unique per supplier. Since every supplier numbers its own documents (20261111), two
--     suppliers reach the same "BL/2026-0001": the numbers were still unique on the whole platform, so the
--     second one could not accept an order, invoice, record a return or a credit note.
-- ---------------------------------------------------------------------------
alter table public.client_invoices add column if not exists supplier_org_id uuid references public.organizations(id) on delete cascade;
alter table public.credit_notes add column if not exists supplier_org_id uuid references public.organizations(id) on delete cascade;
alter table public.returns add column if not exists supplier_org_id uuid references public.organizations(id) on delete cascade;
create or replace function public.fill_document_supplier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.supplier_org_id is null then
    new.supplier_org_id := (select c.supplier_org_id from public.clients c where c.id = new.client_id);
  end if;
  return new;
end;
$$;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY array['client_invoices', 'credit_notes', 'returns'] LOOP
    EXECUTE format('update public.%I d set supplier_org_id = c.supplier_org_id from public.clients c where c.id = d.client_id and d.supplier_org_id is null', t);
    EXECUTE format('drop trigger if exists a_fill_document_supplier on public.%I', t);
    EXECUTE format('create trigger a_fill_document_supplier before insert on public.%I for each row execute function public.fill_document_supplier()', t);
  END LOOP;
  IF exists (select 1 from pg_constraint where conname = 'client_invoices_invoice_number_key') THEN
    alter table public.client_invoices drop constraint client_invoices_invoice_number_key;
  END IF;
  IF exists (select 1 from pg_constraint where conname = 'credit_notes_credit_number_key') THEN
    alter table public.credit_notes drop constraint credit_notes_credit_number_key;
  END IF;
  IF exists (select 1 from pg_constraint where conname = 'returns_return_number_key') THEN
    alter table public.returns drop constraint returns_return_number_key;
  END IF;
  drop index if exists public.orders_delivery_note_number_idx;
END;
$$;
create unique index if not exists client_invoices_supplier_number_idx on public.client_invoices(supplier_org_id, invoice_number);
create unique index if not exists credit_notes_supplier_number_idx on public.credit_notes(supplier_org_id, credit_number);
create unique index if not exists returns_supplier_number_idx on public.returns(supplier_org_id, return_number);
create unique index if not exists orders_supplier_delivery_note_idx on public.orders(supplier_org_id, delivery_note_number);

-- ---------------------------------------------------------------------------
-- 2. A buyer's returns, credit notes, claims and recurring orders with all of its suppliers
--    (lists across its relations; each action runs within the relation of the order concerned).
-- ---------------------------------------------------------------------------
-- Works within one of my relations for the time of an action (the per-Pro guard follows it); returns the previous one.
create or replace function public.buyer_use_client(p_client_id uuid, p_permission text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous uuid;
begin
  if p_client_id is null or not exists (select 1 from public.buyer_relations(p_permission) c where c.id = p_client_id) then
    raise exception using errcode = '42501', message = 'Ce fournisseur ne vous permet pas cette action.';
  end if;
  select pr.client_id into v_previous from public.profiles pr where pr.id = auth.uid();
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set client_id = p_client_id where id = auth.uid();
  perform set_config('appro.link_write', 'off', true);
  return v_previous;
end;
$$;
REVOKE ALL ON FUNCTION public.buyer_use_client(uuid, text) FROM PUBLIC, anon, authenticated;

create or replace function public.buyer_restore_client(p_previous uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set client_id = p_previous where id = auth.uid();
  perform set_config('appro.link_write', 'off', true);
end;
$$;
REVOKE ALL ON FUNCTION public.buyer_restore_client(uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.buyer_request_return(p_order_id uuid, p_items jsonb, p_reason text, p_description text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous uuid := public.buyer_use_client((select o.client_id from public.orders o where o.id = p_order_id), 'client.returns');
  v_result jsonb;
begin
  v_result := public.client_request_return(p_order_id, p_items, p_reason, p_description);
  perform public.buyer_restore_client(v_previous);
  return v_result;
end;
$$;
REVOKE ALL ON FUNCTION public.buyer_request_return(uuid, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_request_return(uuid, jsonb, text, text) TO authenticated;

create or replace function public.buyer_create_claim(p_order_id uuid, p_reason text, p_description text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous uuid := public.buyer_use_client((select o.client_id from public.orders o where o.id = p_order_id), 'client.claims');
  v_result jsonb;
begin
  v_result := public.client_create_claim(p_order_id, p_reason, p_description);
  perform public.buyer_restore_client(v_previous);
  return v_result;
end;
$$;
REVOKE ALL ON FUNCTION public.buyer_create_claim(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_create_claim(uuid, text, text) TO authenticated;

create or replace function public.buyer_respond_order(p_order_id uuid, p_accept boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous uuid := public.buyer_use_client((select o.client_id from public.orders o where o.id = p_order_id), 'client.orders');
  v_result jsonb;
begin
  v_result := public.client_respond_order(p_order_id, p_accept, p_note);
  perform public.buyer_restore_client(v_previous);
  return v_result;
end;
$$;
REVOKE ALL ON FUNCTION public.buyer_respond_order(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_respond_order(uuid, boolean, text) TO authenticated;

create or replace function public.buyer_save_recurring(
  p_client_id uuid, p_id uuid, p_items jsonb, p_delivery_point_id uuid, p_weekdays int[], p_lead_days int default 1,
  p_note text default null, p_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid := coalesce((select r.client_id from public.recurring_orders r where r.id = p_id), p_client_id);
  v_previous uuid := public.buyer_use_client(v_client, 'client.recurring');
  v_id uuid;
begin
  v_id := public.save_recurring_order(p_id, v_client, p_items, p_delivery_point_id, p_weekdays, p_lead_days, p_note, p_active);
  perform public.buyer_restore_client(v_previous);
  return v_id;
end;
$$;
REVOKE ALL ON FUNCTION public.buyer_save_recurring(uuid, uuid, jsonb, uuid, int[], int, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_save_recurring(uuid, uuid, jsonb, uuid, int[], int, text, boolean) TO authenticated;

create or replace function public.buyer_delete_recurring(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous uuid := public.buyer_use_client((select r.client_id from public.recurring_orders r where r.id = p_id), 'client.recurring');
begin
  perform public.delete_recurring_order(p_id);
  perform public.buyer_restore_client(v_previous);
end;
$$;
REVOKE ALL ON FUNCTION public.buyer_delete_recurring(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_delete_recurring(uuid) TO authenticated;

create or replace function public.buyer_recurring()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('clients', jsonb_build_object('business_name', c.business_name), 'supplier_name', s.name)
    order by r.next_delivery), '[]'::jsonb)
  from public.buyer_relations('client.recurring') c
  join public.organizations s on s.id = c.supplier_org_id
  join public.recurring_orders r on r.client_id = c.id;
$$;
REVOKE ALL ON FUNCTION public.buyer_recurring() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_recurring() TO authenticated;

create or replace function public.buyer_returns()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'return_number', r.return_number, 'client_id', r.client_id, 'order_id', r.order_id, 'status', r.status, 'reason', r.reason,
      'description', r.description, 'staff_note', r.staff_note, 'restocked', r.restocked, 'created_at', r.created_at, 'received_at', r.received_at,
      'supplier_name', s.name,
      'return_items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'product_id', i.product_id, 'product_name', i.product_name, 'unit', i.unit,
          'quantity', i.quantity, 'unit_price', i.unit_price, 'vat_rate', i.vat_rate)) from public.return_items i where i.return_id = r.id), '[]'::jsonb),
      'clients', jsonb_build_object('business_name', c.business_name),
      'orders', (select jsonb_build_object('order_number', o.order_number, 'delivery_note_number', o.delivery_note_number) from public.orders o where o.id = r.order_id),
      'credit_notes', coalesce((select jsonb_agg(jsonb_build_object('id', cn.id, 'credit_number', cn.credit_number, 'status', cn.status))
          from public.credit_notes cn where cn.return_id = r.id and cn.status <> 'draft'), '[]'::jsonb))
    order by r.created_at desc), '[]'::jsonb)
  from public.buyer_relations('client.returns') c
  join public.organizations s on s.id = c.supplier_org_id
  join public.returns r on r.client_id = c.id;
$$;
REVOKE ALL ON FUNCTION public.buyer_returns() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_returns() TO authenticated;

create or replace function public.buyer_credit_notes()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', cn.id, 'credit_number', cn.credit_number, 'client_id', cn.client_id, 'return_id', cn.return_id, 'invoice_id', cn.invoice_id,
      'status', cn.status, 'reason', cn.reason, 'client_snapshot', cn.client_snapshot, 'total_ht', cn.total_ht, 'total_vat', cn.total_vat,
      'total_ttc', cn.total_ttc, 'created_at', cn.created_at, 'issued_at', cn.issued_at, 'settled_at', cn.settled_at, 'supplier_name', s.name,
      'credit_note_items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'label', i.label, 'quantity', i.quantity, 'unit', i.unit,
          'unit_price', i.unit_price, 'vat_rate', i.vat_rate)) from public.credit_note_items i where i.credit_note_id = cn.id), '[]'::jsonb),
      'clients', jsonb_build_object('business_name', c.business_name, 'client_number', c.client_number),
      'client_invoices', (select jsonb_build_object('invoice_number', i.invoice_number) from public.client_invoices i where i.id = cn.invoice_id))
    order by cn.created_at desc), '[]'::jsonb)
  from (select distinct x.* from (select * from public.buyer_relations('client.invoices') union all select * from public.buyer_relations('client.returns')) x) c
  join public.organizations s on s.id = c.supplier_org_id
  join public.credit_notes cn on cn.client_id = c.id and cn.status <> 'draft';
$$;
REVOKE ALL ON FUNCTION public.buyer_credit_notes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_credit_notes() TO authenticated;

create or replace function public.buyer_claims()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', cl.id, 'claim_number', cl.claim_number, 'order_id', cl.order_id, 'client_id', cl.client_id, 'reason', cl.reason,
      'description', cl.description, 'status', cl.status, 'staff_response', cl.staff_response, 'created_at', cl.created_at, 'resolved_at', cl.resolved_at,
      'supplier_name', s.name,
      'orders', (select jsonb_build_object('order_number', o.order_number) from public.orders o where o.id = cl.order_id),
      'clients', jsonb_build_object('business_name', c.business_name))
    order by cl.created_at desc), '[]'::jsonb)
  from public.buyer_relations('client.claims') c
  join public.organizations s on s.id = c.supplier_org_id
  join public.claims cl on cl.client_id = c.id;
$$;
REVOKE ALL ON FUNCTION public.buyer_claims() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_claims() TO authenticated;

notify pgrst, 'reload schema';
