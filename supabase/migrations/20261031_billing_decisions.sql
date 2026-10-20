-- Payments (partial, several methods), payment reminders, billing frequency per client,
-- special follow-up and "to reschedule" flags on orders, client messages needing a reply.
-- Run in Supabase SQL Editor AFTER 20261030_numbering_returns.sql. Safe to rerun.

-- ---------------------------------------------------------------------------
-- 1. Client billing options
-- ---------------------------------------------------------------------------

alter table public.clients add column if not exists payment_reminders boolean not null default true;
alter table public.clients add column if not exists reminder_opt_out_allowed boolean not null default true;
alter table public.clients add column if not exists reminder_opt_out boolean not null default false;
alter table public.clients add column if not exists payment_terms_days int not null default 30;
alter table public.clients add column if not exists reminder_interval_days int not null default 7;
alter table public.clients add column if not exists billing_frequency text not null default 'manual';
alter table public.clients add column if not exists billing_every_days int not null default 7;
alter table public.clients add column if not exists billing_start date;
alter table public.clients add column if not exists billing_month_day int not null default 1;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'clients_billing_check') THEN
    ALTER TABLE public.clients ADD CONSTRAINT clients_billing_check CHECK (
      billing_frequency IN ('manual', 'every_n_days', 'monthly_day')
      AND billing_every_days BETWEEN 1 AND 365 AND billing_month_day BETWEEN 1 AND 28
      AND payment_terms_days BETWEEN 0 AND 365 AND reminder_interval_days BETWEEN 1 AND 90);
  END IF;
END;
$$;

insert into public.client_setting_defaults (key, value) values ('payment_reminders', 'true'), ('reminder_opt_out_allowed', 'true')
on conflict (key) do nothing;

create or replace function public.apply_client_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d jsonb := coalesce((select jsonb_object_agg(s.key, s.value) from public.client_setting_defaults s), '{}'::jsonb);
  k text[];
begin
  new.custom_settings := array(
    select distinct x from unnest(coalesce(new.custom_settings, '{}'::text[])) as t(x)
    where x in ('show_prices', 'show_origin', 'show_stock', 'stock_managed', 'invoice_mode', 'reception_qr',
                'history_enabled', 'reconfirm_declined', 'scan_delivery_note', 'scan_client_qr',
                'payment_reminders', 'reminder_opt_out_allowed')
    order by x);
  k := new.custom_settings;
  if not ('show_prices' = any(k)) and d ? 'show_prices' then new.show_prices := (d ->> 'show_prices')::boolean; end if;
  if not ('show_origin' = any(k)) and d ? 'show_origin' then new.show_origin := (d ->> 'show_origin')::boolean; end if;
  if not ('show_stock' = any(k)) and d ? 'show_stock' then new.show_stock := (d ->> 'show_stock')::boolean; end if;
  if not ('stock_managed' = any(k)) and d ? 'stock_managed' then new.stock_managed := (d ->> 'stock_managed')::boolean; end if;
  if not ('invoice_mode' = any(k)) and d ? 'invoice_mode' then new.invoice_mode := d ->> 'invoice_mode'; end if;
  if not ('reception_qr' = any(k)) and d ? 'reception_qr' then new.reception_qr := (d ->> 'reception_qr')::boolean; end if;
  if not ('history_enabled' = any(k)) and d ? 'history_enabled' then new.history_enabled := (d ->> 'history_enabled')::boolean; end if;
  if not ('reconfirm_declined' = any(k)) and d ? 'reconfirm_declined' then new.reconfirm_declined := (d ->> 'reconfirm_declined')::boolean; end if;
  if not ('scan_delivery_note' = any(k)) and d ? 'scan_delivery_note' then new.scan_delivery_note := (d ->> 'scan_delivery_note')::boolean; end if;
  if not ('scan_client_qr' = any(k)) and d ? 'scan_client_qr' then new.scan_client_qr := (d ->> 'scan_client_qr')::boolean; end if;
  if not ('payment_reminders' = any(k)) and d ? 'payment_reminders' then new.payment_reminders := (d ->> 'payment_reminders')::boolean; end if;
  if not ('reminder_opt_out_allowed' = any(k)) and d ? 'reminder_opt_out_allowed' then new.reminder_opt_out_allowed := (d ->> 'reminder_opt_out_allowed')::boolean; end if;
  new.feature_overrides := coalesce((
    select jsonb_object_agg(e.key, e.value) from jsonb_each(
      case when jsonb_typeof(new.feature_overrides) = 'object' then new.feature_overrides else '{}'::jsonb end) e
    where e.key like 'client.%' and jsonb_typeof(e.value) = 'boolean'
  ), '{}'::jsonb);
  return new;
end;
$$;

create or replace function public.admin_set_client_default(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if p_key not in ('show_prices', 'show_origin', 'show_stock', 'stock_managed', 'invoice_mode', 'reception_qr',
                   'history_enabled', 'reconfirm_declined', 'scan_delivery_note', 'scan_client_qr',
                   'payment_reminders', 'reminder_opt_out_allowed') then
    raise exception using errcode = '22023', message = 'Option client inconnue.';
  end if;
  if p_key = 'invoice_mode' then
    if jsonb_typeof(p_value) is distinct from 'string' or (p_value #>> '{}') not in ('auto', 'manual') then
      raise exception using errcode = '22023', message = 'Mode de facturation invalide.';
    end if;
  elsif jsonb_typeof(p_value) is distinct from 'boolean' then
    raise exception using errcode = '22023', message = 'Valeur invalide.';
  end if;
  insert into public.client_setting_defaults (key, value, updated_at) values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  update public.clients set custom_settings = custom_settings where not (p_key = any(custom_settings));
end;
$$;

-- The client turns reminders off for itself, when its record allows it.
create or replace function public.set_my_reminder_opt_out(p_opt_out boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid := public.current_client_id();
begin
  if v_client is null then
    raise exception using errcode = '42501', message = 'Réservé aux comptes clients.';
  end if;
  if coalesce(p_opt_out, false) and not exists (select 1 from public.clients c where c.id = v_client and c.reminder_opt_out_allowed) then
    raise exception using errcode = '42501', message = 'AgriFresh a rendu les rappels de paiement obligatoires pour votre compte.';
  end if;
  update public.clients set reminder_opt_out = coalesce(p_opt_out, false), updated_at = now() where id = v_client;
end;
$$;
REVOKE ALL ON FUNCTION public.set_my_reminder_opt_out(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_reminder_opt_out(boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Payments: partial, several methods, credit notes deducted
-- ---------------------------------------------------------------------------

alter table public.client_invoices add column if not exists amount_paid numeric(12,3) not null default 0;
alter table public.client_invoices add column if not exists due_date date;
alter table public.client_invoices add column if not exists last_reminder_at timestamptz;
alter table public.client_invoices add column if not exists reminder_count int not null default 0;
update public.client_invoices set amount_paid = total_ttc where status = 'paid' and amount_paid = 0;
update public.client_invoices i set due_date = (i.issued_at at time zone 'Africa/Tunis')::date + coalesce((select c.payment_terms_days from public.clients c where c.id = i.client_id), 30)
where i.due_date is null and i.status in ('issued', 'paid');

create or replace function public.set_invoice_due_date()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'issued' and new.due_date is null then
    new.due_date := (coalesce(new.issued_at, now()) at time zone 'Africa/Tunis')::date
      + coalesce((select c.payment_terms_days from public.clients c where c.id = new.client_id), 30);
  end if;
  return new;
end;
$$;
drop trigger if exists client_invoices_due_date on public.client_invoices;
create trigger client_invoices_due_date before insert or update of status on public.client_invoices
  for each row execute function public.set_invoice_due_date();

create table if not exists public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.client_invoices(id) on delete cascade,
  amount numeric(12,3) not null check (amount > 0),
  method text not null check (method in ('cash', 'check', 'transfer', 'card', 'credit_note', 'other')),
  paid_on date not null default current_date,
  reference text,
  credit_note_id uuid references public.credit_notes(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists invoice_payments_invoice_idx on public.invoice_payments(invoice_id);
alter table public.invoice_payments enable row level security;
GRANT SELECT ON public.invoice_payments TO authenticated;
drop policy if exists "invoice_payments_read" on public.invoice_payments;
create policy "invoice_payments_read" on public.invoice_payments for select to authenticated using (
  (select public.has_feature('invoices.manage'))
  or exists (select 1 from public.client_invoices i where i.id = invoice_payments.invoice_id and i.client_id = (select public.current_client_id()) and i.status <> 'draft')
);

create or replace function public.refresh_invoice_payment(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paid numeric;
  v_last date;
begin
  select coalesce(sum(p.amount), 0), max(p.paid_on) into v_paid, v_last from public.invoice_payments p where p.invoice_id = p_invoice_id;
  update public.client_invoices i
  set amount_paid = v_paid,
      status = case when i.status in ('issued', 'paid') then case when v_paid >= i.total_ttc - 0.0005 then 'paid' else 'issued' end else i.status end,
      paid_at = case when v_paid >= i.total_ttc - 0.0005 then coalesce(v_last::timestamptz, now()) else null end,
      updated_at = now()
  where i.id = p_invoice_id;
end;
$$;
REVOKE ALL ON FUNCTION public.refresh_invoice_payment(uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.staff_add_payment(
  p_invoice_id uuid, p_amount numeric, p_method text, p_paid_on date default null, p_reference text default null, p_credit_note_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.client_invoices%rowtype;
  v_credit public.credit_notes%rowtype;
  v_balance numeric;
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas d’enregistrer des règlements.';
  end if;
  select i.* into v_invoice from public.client_invoices i where i.id = p_invoice_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Facture introuvable.';
  end if;
  if v_invoice.status not in ('issued', 'paid') then
    raise exception using errcode = '22023', message = 'Seule une facture émise peut recevoir un règlement.';
  end if;
  v_balance := v_invoice.total_ttc - v_invoice.amount_paid;
  if p_amount is null or p_amount <= 0 or p_amount > v_balance + 0.0005 then
    raise exception using errcode = '22023', message = format('Montant invalide : il reste %s TND à régler.', to_char(v_balance, 'FM999G999G990D000'));
  end if;
  if p_method not in ('cash', 'check', 'transfer', 'card', 'credit_note', 'other') then
    raise exception using errcode = '22023', message = 'Mode de règlement inconnu.';
  end if;
  if p_method = 'credit_note' then
    select c.* into v_credit from public.credit_notes c where c.id = p_credit_note_id for update;
    if not found or v_credit.client_id <> v_invoice.client_id or v_credit.status <> 'issued' then
      raise exception using errcode = '22023', message = 'Choisissez un avoir émis de ce client, pas encore utilisé.';
    end if;
    if p_amount > v_credit.total_ttc + 0.0005 then
      raise exception using errcode = '22023', message = 'Le montant dépasse celui de l’avoir.';
    end if;
    update public.credit_notes set status = 'deducted', settled_at = now(), invoice_id = coalesce(invoice_id, p_invoice_id), updated_at = now()
    where id = p_credit_note_id;
  end if;
  insert into public.invoice_payments (invoice_id, amount, method, paid_on, reference, credit_note_id, created_by)
  values (p_invoice_id, round(p_amount, 3), p_method, coalesce(p_paid_on, current_date), nullif(btrim(coalesce(p_reference, '')), ''),
          case when p_method = 'credit_note' then p_credit_note_id end, auth.uid());
  perform public.refresh_invoice_payment(p_invoice_id);
  return (select jsonb_build_object('status', i.status, 'amount_paid', i.amount_paid, 'balance', i.total_ttc - i.amount_paid)
          from public.client_invoices i where i.id = p_invoice_id);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_add_payment(uuid, numeric, text, date, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_add_payment(uuid, numeric, text, date, text, uuid) TO authenticated;

create or replace function public.staff_delete_payment(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.invoice_payments%rowtype;
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de modifier les règlements.';
  end if;
  select p.* into v_payment from public.invoice_payments p where p.id = p_payment_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Règlement introuvable.';
  end if;
  if exists (select 1 from public.client_invoices i where i.id = v_payment.invoice_id and i.status = 'cancelled') then
    raise exception using errcode = '22023', message = 'La facture est annulée.';
  end if;
  delete from public.invoice_payments where id = p_payment_id;
  if v_payment.credit_note_id is not null then
    update public.credit_notes set status = 'issued', settled_at = null, updated_at = now() where id = v_payment.credit_note_id and status = 'deducted';
  end if;
  perform public.refresh_invoice_payment(v_payment.invoice_id);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_delete_payment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_delete_payment(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Payment reminders
-- ---------------------------------------------------------------------------

insert into public.notification_settings (event, label, audience, push_enabled, email_enabled, sort_order)
values ('invoice.reminder', 'Rappel de facture à régler', 'Client', true, true, 13)
on conflict (event) do nothing;

-- Sends a reminder for each overdue invoice whose client accepts them, at most once per interval.
create or replace function public.staff_send_payment_reminders(p_client_id uuid default null, p_force boolean default false)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice record;
  v_count int := 0;
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas d’envoyer des relances.';
  end if;
  for v_invoice in
    select i.id, i.invoice_number, i.client_id, i.total_ttc - i.amount_paid as balance, i.due_date
    from public.client_invoices i join public.clients c on c.id = i.client_id
    where i.status = 'issued' and i.total_ttc - i.amount_paid > 0.0005
      and i.due_date < (now() at time zone 'Africa/Tunis')::date
      and c.payment_reminders and not (c.reminder_opt_out_allowed and c.reminder_opt_out)
      and (p_client_id is null or i.client_id = p_client_id)
      and (p_force or i.last_reminder_at is null or i.last_reminder_at < now() - make_interval(days => c.reminder_interval_days))
    for update of i
  loop
    perform public.notify(public.client_users(v_invoice.client_id), 'invoice.reminder',
      format('Rappel : facture %s à régler', v_invoice.invoice_number),
      format('Reste à payer : %s TND (échéance le %s). Merci de procéder au règlement.',
        to_char(v_invoice.balance, 'FM999G999G990D000'), to_char(v_invoice.due_date, 'DD/MM/YYYY')), null);
    update public.client_invoices set last_reminder_at = now(), reminder_count = reminder_count + 1 where id = v_invoice.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_send_payment_reminders(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_send_payment_reminders(uuid, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Billing board: invoices to make (billing frequency) and overdue invoices
-- ---------------------------------------------------------------------------

create or replace function public.next_billing_date(p_client_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_client public.clients%rowtype;
  v_last date;
  v_ref date;
  v_next date;
begin
  select c.* into v_client from public.clients c where c.id = p_client_id;
  if v_client.billing_frequency = 'manual' then
    return null;
  end if;
  select max((i.issued_at at time zone 'Africa/Tunis')::date) into v_last
  from public.client_invoices i where i.client_id = p_client_id and i.status in ('issued', 'paid');
  if v_client.billing_frequency = 'every_n_days' then
    v_ref := coalesce(v_client.billing_start, v_last, current_date);
    return case when v_last is null then v_ref else greatest(v_ref, v_last + v_client.billing_every_days) end;
  end if;
  v_ref := coalesce(v_last + 1, greatest(coalesce(v_client.billing_start, current_date), date_trunc('month', current_date)::date));
  v_next := make_date(extract(year from v_ref)::int, extract(month from v_ref)::int, v_client.billing_month_day);
  if v_next < v_ref then
    v_next := (v_next + interval '1 month')::date;
  end if;
  return v_next;
end;
$$;
REVOKE ALL ON FUNCTION public.next_billing_date(uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.billing_board()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
        from public.clients c
        join public.orders o on o.client_id = c.id and o.client_invoice_id is null
          and o.status in ('confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered')
        where c.billing_frequency <> 'manual' and public.next_billing_date(c.id) <= current_date
        group by c.id
      ) rows
    ), '[]'::jsonb),
    'overdue', coalesce((
      select jsonb_agg(jsonb_build_object(
        'invoice_id', i.id, 'invoice_number', i.invoice_number, 'client_id', c.id, 'business_name', c.business_name,
        'balance', i.total_ttc - i.amount_paid, 'due_date', i.due_date, 'days_late', current_date - i.due_date,
        'reminder_count', i.reminder_count, 'last_reminder_at', i.last_reminder_at,
        'reminders', c.payment_reminders and not (c.reminder_opt_out_allowed and c.reminder_opt_out)
      ) order by i.due_date)
      from public.client_invoices i join public.clients c on c.id = i.client_id
      where i.status = 'issued' and i.total_ttc - i.amount_paid > 0.0005 and i.due_date < current_date
    ), '[]'::jsonb)
  );
end;
$$;
REVOKE ALL ON FUNCTION public.billing_board() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_board() TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Order flags: special follow-up, to reschedule
-- ---------------------------------------------------------------------------

alter table public.orders add column if not exists special_follow boolean not null default false;
alter table public.orders add column if not exists needs_reschedule boolean not null default false;

create or replace function public.staff_set_order_flags(p_order_id uuid, p_special boolean default null, p_reschedule boolean default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_special is not null and not (public.has_feature('orders.decide') or public.has_feature('orders.plan')) then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de marquer le suivi spécial.';
  end if;
  if p_reschedule is not null and not public.has_feature('orders.plan') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de planifier.';
  end if;
  update public.orders
  set special_follow = coalesce(p_special, special_follow), needs_reschedule = coalesce(p_reschedule, needs_reschedule), updated_at = now()
  where id = p_order_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_set_order_flags(uuid, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_order_flags(uuid, boolean, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Client messages needing a reply (cleared by the next team reply)
-- ---------------------------------------------------------------------------

alter table public.messages add column if not exists needs_reply boolean not null default false;

create or replace function public.staff_flag_message(p_message_id uuid, p_needs_reply boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_feature('messages.manage') then
    raise exception using errcode = '42501', message = 'La messagerie client n’est pas activée pour votre profil.';
  end if;
  update public.messages set needs_reply = coalesce(p_needs_reply, false) where id = p_message_id and not from_staff;
  if not found then
    raise exception using errcode = 'P0002', message = 'Message client introuvable.';
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_flag_message(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_flag_message(uuid, boolean) TO authenticated;

create or replace function public.clear_needs_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.from_staff then
    update public.messages set needs_reply = false where client_id = new.client_id and needs_reply and created_at <= new.created_at;
  end if;
  return new;
end;
$$;
drop trigger if exists messages_clear_needs_reply on public.messages;
create trigger messages_clear_needs_reply after insert on public.messages
  for each row execute function public.clear_needs_reply();

-- Client conversations waiting for an answer, for "À décider".
create or replace function public.messages_needing_reply()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_feature('messages.manage') then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('client_id', c.id, 'business_name', c.business_name, 'count', x.n, 'since', x.since, 'last_body', x.last_body) order by x.since)
    from (
      select m.client_id, count(*) as n, min(m.created_at) as since, (array_agg(m.body order by m.created_at desc))[1] as last_body
      from public.messages m where m.needs_reply group by m.client_id
    ) x join public.clients c on c.id = x.client_id
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.messages_needing_reply() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.messages_needing_reply() TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Account: reminder choice visible to the client
-- ---------------------------------------------------------------------------

create or replace function public.my_account()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', pr.id,
    'role', pr.role,
    'full_name', pr.full_name,
    'features', public.my_features(),
    'disabled', pr.account_status <> 'active',
    'status', pr.account_status,
    'home_layout', coalesce(pr.home_layout, (select hl.layout from public.home_layouts hl
      where hl.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role)),
    'role_home_layout', (select hl.layout from public.home_layouts hl
      where hl.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role),
    'client', case when c.id is null or not c.active then null else jsonb_build_object(
      'id', c.id,
      'client_number', c.client_number,
      'business_name', c.business_name,
      'contact_name', c.contact_name,
      'phone', c.phone,
      'show_prices', c.show_prices,
      'show_origin', c.show_origin,
      'show_stock', c.show_stock,
      'stock_managed', c.stock_managed,
      'reception_qr', c.reception_qr and c.scan_client_qr,
      'reception_token', case when c.reception_qr and c.scan_client_qr then c.reception_token end,
      'history_enabled', c.history_enabled,
      'payment_reminders', c.payment_reminders,
      'reminder_opt_out_allowed', c.reminder_opt_out_allowed,
      'reminder_opt_out', c.reminder_opt_out,
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

DO $$
BEGIN
  EXECUTE 'drop trigger if exists audit_invoice_payments on public.invoice_payments';
  EXECUTE 'create trigger audit_invoice_payments after insert or update or delete on public.invoice_payments for each row execute function public.audit_row()';
END;
$$;
