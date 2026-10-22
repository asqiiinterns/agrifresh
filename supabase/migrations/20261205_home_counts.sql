-- Home figures computed by the database: the home screen used to download up to 1,500 orders, 300 invoices,
-- the returns, credit notes, claims and incidents only to count them. One call now returns the counts.
-- SECURITY INVOKER: the counts run with the person's own rights (row level security), so each person
-- counts exactly the rows it could list, as before.
-- p_today: the person's day (its phone's date); p_offset_minutes: Date.getTimezoneOffset() of its phone,
-- to decide which day an order was placed or delivered.
-- Run AFTER 20261204_reception_qr.sql. Safe to rerun.

create or replace function public.home_counts(p_today date default current_date, p_offset_minutes int default 0)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_shift interval := make_interval(mins => -coalesce(p_offset_minutes, 0));
  v_month_start date := date_trunc('month', p_today)::date;
  v_orders jsonb;
  v_money jsonb;
begin
  select jsonb_build_object(
    'decide', count(*) filter (where o.status in ('pending', 'on_hold', 'awaiting_client')),
    'queue', count(*) filter (where o.status in ('confirmed', 'preparing', 'ready')),
    'prepare', count(*) filter (where o.status in ('confirmed', 'preparing')),
    'ready', count(*) filter (where o.status = 'ready'),
    'shipping', count(*) filter (where o.status = 'out_for_delivery'),
    'placedToday', count(*) filter (where (o.created_at + v_shift)::date = p_today),
    'dueToday', count(*) filter (where o.requested_delivery_date = p_today and o.status not in ('delivered', 'declined', 'cancelled')),
    'deliveredToday', count(*) filter (where o.status = 'delivered' and (coalesce(o.delivered_at,
        (select max(h.created_at) from public.order_status_history h where h.order_id = o.id and h.status in ('delivered', 'declined', 'cancelled')),
        o.created_at) + v_shift)::date = p_today),
    'special', count(*) filter (where o.special_follow),
    'reschedule', count(*) filter (where o.needs_reschedule and o.status in ('confirmed', 'preparing', 'ready')))
  into v_orders
  from public.orders o
  -- The same orders as the lists: everything still open, and the closed ones of the last two months.
  where o.status not in ('delivered', 'declined', 'cancelled') or o.updated_at >= now() - interval '62 days' or o.created_at >= now() - interval '62 days';

  select jsonb_build_object(
    'invoicedMonth', coalesce(round(sum(i.total_ttc) filter (where (i.issued_at + v_shift)::date >= v_month_start)), 0),
    'collectedMonth', coalesce(round((select sum(p.amount) from public.invoice_payments p join public.client_invoices pi on pi.id = p.invoice_id
        where pi.status in ('issued', 'paid') and p.paid_on >= v_month_start and p.paid_on <= p_today)), 0),
    'outstanding', coalesce(round(sum(greatest(0, i.total_ttc - coalesce(i.amount_paid, 0))) filter (where i.status = 'issued')), 0),
    'overdue', count(*) filter (where i.status = 'issued' and i.due_date < p_today and i.total_ttc - coalesce(i.amount_paid, 0) > 0.0005))
  into v_money
  from public.client_invoices i
  where i.status in ('issued', 'paid');

  return v_orders || v_money || jsonb_build_object(
    'claims', (select count(*) from public.claims c where c.status in ('open', 'in_progress')),
    'returns', (select count(*) from public.returns r where r.status in ('requested', 'approved', 'received')),
    'credits', (select count(*) from public.credit_notes n where n.status in ('draft', 'issued')),
    'incidents', (select count(*) from public.incidents x where x.status = 'open'));
end;
$$;
REVOKE ALL ON FUNCTION public.home_counts(date, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.home_counts(date, int) TO authenticated;

notify pgrst, 'reload schema';
