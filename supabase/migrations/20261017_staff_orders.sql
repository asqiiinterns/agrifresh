-- Staff back-office: staff/admin accounts can read every order and move it
-- through the delivery workflow. Run once in Supabase SQL Editor AFTER
-- 20261017_invoice_realtime.sql. Safe to rerun.

-- Customers may edit their name and phone, never their role.
REVOKE UPDATE ON public.profiles FROM anon, authenticated;
GRANT UPDATE (full_name, phone) ON public.profiles TO authenticated;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = (select auth.uid()) and pr.role in ('staff', 'admin')
  );
$$;
REVOKE ALL ON FUNCTION public.is_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated;

GRANT SELECT ON public.payments TO authenticated;

drop policy if exists "orders_read_staff" on public.orders;
create policy "orders_read_staff" on public.orders
  for select to authenticated using ((select public.is_staff()));
drop policy if exists "order_items_read_staff" on public.order_items;
create policy "order_items_read_staff" on public.order_items
  for select to authenticated using ((select public.is_staff()));
drop policy if exists "status_history_read_staff" on public.order_status_history;
create policy "status_history_read_staff" on public.order_status_history
  for select to authenticated using ((select public.is_staff()));
drop policy if exists "invoices_read_staff" on public.invoices;
create policy "invoices_read_staff" on public.invoices
  for select to authenticated using ((select public.is_staff()));
drop policy if exists "payments_read_staff" on public.payments;
create policy "payments_read_staff" on public.payments
  for select to authenticated using ((select public.is_staff()));

-- Only this function changes an order status: it enforces the workflow,
-- records history, restocks cancelled orders and settles cash payments.
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
  v_current public.order_status;
  v_allowed public.order_status[];
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Accès réservé au personnel AgriFresh.';
  end if;

  select o.status into v_current
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;

  v_allowed := case v_current
    when 'pending' then array['confirmed', 'cancelled']::public.order_status[]
    when 'confirmed' then array['preparing', 'cancelled']::public.order_status[]
    when 'preparing' then array['ready', 'cancelled']::public.order_status[]
    when 'ready' then array['out_for_delivery', 'cancelled']::public.order_status[]
    when 'out_for_delivery' then array['delivered', 'cancelled']::public.order_status[]
    else array[]::public.order_status[]
  end;

  if not (p_status = any(v_allowed)) then
    raise exception using errcode = '22023',
      message = format('Transition impossible : %s → %s.', v_current, p_status);
  end if;

  update public.orders
  set status = p_status, updated_at = now()
  where id = p_order_id;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (p_order_id, p_status, nullif(btrim(coalesce(p_note, '')), ''), v_staff_id);

  if p_status = 'cancelled' then
    update public.products p
    set stock_quantity = p.stock_quantity + oi.quantity, updated_at = now()
    from public.order_items oi
    where oi.order_id = p_order_id and oi.product_id = p.id;

    update public.payments set status = 'cancelled'
    where order_id = p_order_id and status = 'pending';
  elsif p_status = 'delivered' then
    update public.payments set status = 'paid'
    where order_id = p_order_id and method = 'cash_on_delivery' and status = 'pending';
  end if;

  return jsonb_build_object('id', p_order_id, 'previous_status', v_current, 'status', p_status);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_update_order_status(uuid, public.order_status, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_update_order_status(uuid, public.order_status, text) TO authenticated;

-- Realtime: staff dashboards also receive new orders.
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

-- Promote a staff account (replace the e-mail, then run this line alone):
-- update public.profiles set role = 'staff'
-- where id = (select id from auth.users where email = 'staff@exemple.com');
