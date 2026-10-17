-- Informational order receipts and realtime order-status updates.
-- Run once in Supabase SQL Editor AFTER 20261017_customer_features.sql.

-- RLS policies filter each authenticated customer's reads; grants allow the
-- mobile Data API to query the corresponding own-row records.
GRANT SELECT ON public.orders, public.order_items, public.invoices, public.order_status_history TO authenticated;

create or replace function public.create_order_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.invoices (
    order_id, invoice_number, issued_at, currency, subtotal, tax_total, delivery_fee, total
  ) values (
    new.id,
    'AF-' || to_char(new.created_at, 'YYYY') || '-' || lpad(new.order_number::text, 8, '0'),
    new.created_at,
    new.currency,
    new.subtotal,
    0,
    new.delivery_fee,
    new.total
  )
  on conflict (order_id) do nothing;
  return new;
end;
$$;
REVOKE ALL ON FUNCTION public.create_order_receipt() FROM PUBLIC, anon, authenticated;

-- Existing orders get an informational receipt too; the unique order_id makes this safe to rerun.
insert into public.invoices (
  order_id, invoice_number, issued_at, currency, subtotal, tax_total, delivery_fee, total
)
select
  o.id,
  'AF-' || to_char(o.created_at, 'YYYY') || '-' || lpad(o.order_number::text, 8, '0'),
  o.created_at,
  o.currency,
  o.subtotal,
  0,
  o.delivery_fee,
  o.total
from public.orders o
on conflict (order_id) do nothing;

DROP TRIGGER IF EXISTS orders_create_receipt ON public.orders;
CREATE TRIGGER orders_create_receipt
  AFTER INSERT ON public.orders
  FOR EACH ROW EXECUTE PROCEDURE public.create_order_receipt();

-- Supabase Realtime reads Postgres changes from this publication.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'orders'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.orders';
  END IF;
END;
$$;

-- Include the previous status in update events so filtered customer subscriptions can evaluate changes.
ALTER TABLE public.orders REPLICA IDENTITY FULL;
