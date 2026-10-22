-- « À facturer » and late invoices (billing_board) failed on every call on a real database: the clients are read
-- through a filtered subquery, and grouping by its id alone is refused (column must appear in the GROUP BY clause).
-- Found by the automated tests on a local Supabase. Function redefined whole. Run AFTER 20261207_add_member.sql. Safe to rerun.

CREATE OR REPLACE FUNCTION public.billing_board()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de gérer la facturation.';
  end if;
  return jsonb_build_object(
    'due', coalesce((
      select jsonb_agg(entry order by entry ->> 'next_date')
      from (
        select jsonb_build_object(
          'client_id', c.id, 'business_name', c.business_name, 'frequency', c.billing_frequency,
          'every_days', c.billing_every_days, 'month_day', c.billing_month_day,
          'next_date', public.next_billing_date(c.id),
          'orders', count(o.id), 'amount', coalesce(sum(o.total), 0)
        ) as entry
        from (select * from (select * from public.clients where public.org_visible(supplier_org_id)) clients where public.org_visible(supplier_org_id)) c
        join (select * from (select * from public.orders where public.org_visible(supplier_org_id)) orders where public.org_visible(supplier_org_id)) o on o.client_id = c.id and o.client_invoice_id is null
          and o.status in ('confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered')
        where c.billing_frequency <> 'manual' and public.next_billing_date(c.id) <= current_date
        -- 20261208: every client column used above (c is a filtered subquery: grouping by its id alone is refused).
        group by c.id, c.business_name, c.billing_frequency, c.billing_every_days, c.billing_month_day
      ) rows
    ), '[]'::jsonb),
    'overdue', coalesce((
      select jsonb_agg(jsonb_build_object(
        'invoice_id', i.id, 'invoice_number', i.invoice_number, 'client_id', c.id, 'business_name', c.business_name,
        'balance', i.total_ttc - i.amount_paid, 'due_date', i.due_date, 'days_late', current_date - i.due_date,
        'reminder_count', i.reminder_count, 'last_reminder_at', i.last_reminder_at,
        'reminders', (c.payment_reminders and public.module_enabled_for(c.supplier_org_id, 'reminders')) and not (c.reminder_opt_out_allowed and c.reminder_opt_out)
      ) order by i.due_date)
      from (select * from (select * from public.client_invoices where public.org_visible(public.client_org(client_id))) client_invoices where public.org_visible(public.client_org(client_id))) i join (select * from (select * from public.clients where public.org_visible(supplier_org_id)) clients where public.org_visible(supplier_org_id)) c on c.id = i.client_id
      where i.status = 'issued' and i.total_ttc - i.amount_paid > 0.0005 and i.due_date < current_date
    ), '[]'::jsonb)
  );
end;
$function$
;

notify pgrst, 'reload schema';
