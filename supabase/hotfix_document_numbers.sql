-- URGENT FIX, can be run on its own right now (also included in migrations/20261122_cleanup.sql; running
-- both is harmless).
-- Every supplier numbers its own documents (BL, invoices, credit notes, returns), but the numbers were still unique
-- on the whole platform: the second supplier reaching "BL/2026-0001" could not accept the order
-- (duplicate key value violates unique constraint "orders_delivery_note_number_idx").
-- They become unique per supplier.

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
