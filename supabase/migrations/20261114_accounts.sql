-- Accounts between a supplier and each of its clients (also a shopkeeper and its private customers):
--   * deposits (money paid in advance), applied to one or several invoices, the rest staying available;
--   * deposits paid back;
--   * an outstanding limit (credit allowed): a new order is refused once unpaid invoices reach it;
--   * an account statement seen by both sides: invoices, payments, deposits, credit notes, balance.
-- Run in Supabase SQL Editor AFTER 20261113_directory.sql. Safe to rerun.

alter table public.clients add column if not exists credit_limit numeric(12,3) check (credit_limit is null or credit_limit >= 0);

create table if not exists public.account_entries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  kind text not null check (kind in ('deposit', 'refund')),
  amount numeric(12,3) not null check (amount > 0),
  method text not null default 'cash' check (method in ('cash', 'check', 'transfer', 'card', 'other')),
  entry_date date not null default current_date,
  reference text,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists account_entries_client_idx on public.account_entries(client_id);
alter table public.account_entries enable row level security;
GRANT SELECT ON public.account_entries TO authenticated;
drop policy if exists "account_entries_read" on public.account_entries;
create policy "account_entries_read" on public.account_entries for select to authenticated
  using (public.org_visible(public.client_org(client_id))
         and (public.has_feature('invoices.manage') or (client_id = public.current_client_id() and public.has_feature('client.invoices'))));

-- A deposit pays an invoice like any other means of payment.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN select conname from pg_constraint where conrelid = 'public.invoice_payments'::regclass and contype = 'c'
           and pg_get_constraintdef(oid) like '%method%' and pg_get_constraintdef(oid) not like '%deposit%' LOOP
    EXECUTE format('alter table public.invoice_payments drop constraint %I', c.conname);
  END LOOP;
  IF not exists (select 1 from pg_constraint where conrelid = 'public.invoice_payments'::regclass and conname = 'invoice_payments_method_check2') THEN
    alter table public.invoice_payments add constraint invoice_payments_method_check2
      check (method in ('cash', 'check', 'transfer', 'card', 'credit_note', 'deposit', 'other'));
  END IF;
END;
$$;

-- The deposits of 20261111's guard: they belong to the client's supplier.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.row_org(text, jsonb)'::regprocedure);
BEGIN
  IF v_def not like '%account_entries%' THEN
    EXECUTE replace(v_def, 'when ''client_invoices'' then', 'when ''account_entries'' then public.client_org((p_row ->> ''client_id'')::uuid)
    when ''client_invoices'' then');
  END IF;
  EXECUTE 'drop trigger if exists zz_org_guard on public.account_entries';
  EXECUTE 'create trigger zz_org_guard before insert or update or delete on public.account_entries for each row execute function public.org_write_guard()';
  IF to_regprocedure('public.audit_row()') IS NOT NULL THEN
    EXECUTE 'drop trigger if exists audit_account_entries on public.account_entries';
    EXECUTE 'create trigger audit_account_entries after insert or update or delete on public.account_entries for each row execute function public.audit_row()';
  END IF;
END;
$$;

-- Figures of one account.
create or replace function public.account_figures(p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'outstanding', coalesce((select sum(i.total_ttc - i.amount_paid) from public.client_invoices i
                             where i.client_id = p_client_id and i.status = 'issued'), 0),
    'deposits', coalesce((select sum(case when e.kind = 'deposit' then e.amount else -e.amount end) from public.account_entries e where e.client_id = p_client_id), 0)
              - coalesce((select sum(p.amount) from public.invoice_payments p join public.client_invoices i on i.id = p.invoice_id
                          where i.client_id = p_client_id and p.method = 'deposit'), 0),
    'credit_limit', (select c.credit_limit from public.clients c where c.id = p_client_id));
$$;
REVOKE ALL ON FUNCTION public.account_figures(uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.can_see_account(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.org_visible(public.client_org(p_client_id))
     and (public.has_feature('invoices.manage') or (p_client_id = public.current_client_id() and public.has_feature('client.invoices')));
$$;
REVOKE ALL ON FUNCTION public.can_see_account(uuid) FROM PUBLIC, anon, authenticated;

-- The statement of an account (default: my own account with my current supplier).
create or replace function public.account_statement(p_client_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_client uuid := coalesce(p_client_id, public.current_client_id());
begin
  if v_client is null or not public.can_see_account(v_client) then
    raise exception using errcode = '42501', message = 'Compte introuvable.';
  end if;
  return jsonb_build_object(
    'client_id', v_client,
    'business_name', (select c.business_name from public.clients c where c.id = v_client),
    'supplier_name', (select o.name from public.clients c join public.organizations o on o.id = c.supplier_org_id where c.id = v_client),
    'figures', public.account_figures(v_client),
    'lines', coalesce((select jsonb_agg(l order by l ->> 'date', l ->> 'sort') from (
      select jsonb_build_object('date', coalesce(i.issued_at, i.created_at)::date, 'sort', '1' || i.id, 'kind', 'invoice',
        'label', 'Facture ' || coalesce(i.invoice_number, ''), 'ref', i.invoice_number, 'debit', i.total_ttc, 'credit', 0) as l
      from public.client_invoices i where i.client_id = v_client and i.status in ('issued', 'paid')
      union all
      select jsonb_build_object('date', p.paid_on, 'sort', '2' || p.id, 'kind', 'payment',
        'label', 'Règlement ' || coalesce(i.invoice_number, ''), 'ref', i.invoice_number, 'method', p.method, 'debit', 0, 'credit', p.amount)
      from public.invoice_payments p join public.client_invoices i on i.id = p.invoice_id
      where i.client_id = v_client and p.method not in ('deposit', 'credit_note')
      union all
      select jsonb_build_object('date', p.paid_on, 'sort', '2' || p.id, 'kind', 'deposit_use',
        'label', 'Acompte imputé sur ' || coalesce(i.invoice_number, 'facture'), 'ref', i.invoice_number, 'debit', 0, 'credit', 0, 'info', p.amount)
      from public.invoice_payments p join public.client_invoices i on i.id = p.invoice_id
      where i.client_id = v_client and p.method = 'deposit'
      union all
      select jsonb_build_object('date', e.entry_date, 'sort', '3' || e.id, 'kind', e.kind,
        'label', case when e.kind = 'deposit' then 'Acompte reçu' else 'Acompte remboursé' end || coalesce(' · ' || e.reference, ''), 'ref', e.reference, 'method', e.method,
        'debit', case when e.kind = 'refund' then e.amount else 0 end, 'credit', case when e.kind = 'deposit' then e.amount else 0 end)
      from public.account_entries e where e.client_id = v_client
      union all
      select jsonb_build_object('date', coalesce(cn.issued_at, cn.created_at)::date, 'sort', '4' || cn.id, 'kind', 'credit_note',
        'label', 'Avoir ' || coalesce(cn.credit_number, ''), 'ref', cn.credit_number, 'debit', case when cn.status = 'refunded' then cn.total_ttc else 0 end, 'credit', cn.total_ttc)
      from public.credit_notes cn where cn.client_id = v_client and cn.status in ('issued', 'deducted', 'refunded')
    ) s), '[]'::jsonb));
end;
$$;
REVOKE ALL ON FUNCTION public.account_statement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_statement(uuid) TO authenticated;

-- Every account of my Pro (supplier side), with its figures.
create or replace function public.staff_accounts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de gérer les comptes clients.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('client_id', c.id, 'business_name', c.business_name) || public.account_figures(c.id) order by c.business_name)
    from public.clients c where c.supplier_org_id = public.current_org_id() and c.link_status = 'active'), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_accounts() TO authenticated;

create or replace function public.staff_record_deposit(p_client_id uuid, p_kind text, p_amount numeric, p_method text, p_entry_date date default null, p_reference text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_available numeric;
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas d’enregistrer des acomptes.';
  end if;
  if not exists (select 1 from public.clients c where c.id = p_client_id and c.supplier_org_id = public.current_org_id()) then
    raise exception using errcode = 'P0002', message = 'Client introuvable.';
  end if;
  if p_kind not in ('deposit', 'refund') or p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = 'Indiquez un montant positif.';
  end if;
  if p_kind = 'refund' then
    v_available := (public.account_figures(p_client_id) ->> 'deposits')::numeric;
    if p_amount > v_available + 0.0005 then
      raise exception using errcode = '22023', message = format('Il ne reste que %s TND d’acompte à rembourser.', to_char(v_available, 'FM999G999G990D000'));
    end if;
  end if;
  insert into public.account_entries (client_id, kind, amount, method, entry_date, reference, note, created_by)
  values (p_client_id, p_kind, round(p_amount, 3), coalesce(p_method, 'cash'), coalesce(p_entry_date, current_date),
          nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), auth.uid());
  perform public.notify(array(select pr.id from public.profiles pr where pr.client_id = p_client_id and pr.account_status = 'active'),
    'account.deposit', case when p_kind = 'deposit' then 'Acompte enregistré' else 'Acompte remboursé' end,
    format('%s TND', to_char(round(p_amount, 3), 'FM999G999G990D000')));
  return public.account_figures(p_client_id);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_record_deposit(uuid, text, numeric, text, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_record_deposit(uuid, text, numeric, text, date, text, text) TO authenticated;

-- Applies part of the available deposit to an invoice.
create or replace function public.staff_apply_deposit(p_invoice_id uuid, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.client_invoices%rowtype;
  v_available numeric;
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas d’enregistrer des règlements.';
  end if;
  select i.* into v_invoice from public.client_invoices i where i.id = p_invoice_id for update;
  if v_invoice.id is null or public.client_org(v_invoice.client_id) is distinct from public.current_org_id() then
    raise exception using errcode = 'P0002', message = 'Facture introuvable.';
  end if;
  if v_invoice.status <> 'issued' then
    raise exception using errcode = '22023', message = 'Seule une facture émise et non soldée reçoit un acompte.';
  end if;
  v_available := (public.account_figures(v_invoice.client_id) ->> 'deposits')::numeric;
  if p_amount is null or p_amount <= 0 or p_amount > v_available + 0.0005 or p_amount > v_invoice.total_ttc - v_invoice.amount_paid + 0.0005 then
    raise exception using errcode = '22023', message = format('Montant invalide : acompte disponible %s TND, reste à régler %s TND.',
      to_char(v_available, 'FM999G999G990D000'), to_char(v_invoice.total_ttc - v_invoice.amount_paid, 'FM999G999G990D000'));
  end if;
  insert into public.invoice_payments (invoice_id, amount, method, paid_on, reference, created_by)
  values (p_invoice_id, round(p_amount, 3), 'deposit', current_date, 'Acompte', auth.uid());
  perform public.refresh_invoice_payment(p_invoice_id);
  return public.account_figures(v_invoice.client_id);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_apply_deposit(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_apply_deposit(uuid, numeric) TO authenticated;

create or replace function public.staff_set_credit_limit(p_client_id uuid, p_limit numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de régler l’encours.';
  end if;
  if p_limit is not null and p_limit < 0 then
    raise exception using errcode = '22023', message = 'L’encours autorisé ne peut pas être négatif.';
  end if;
  update public.clients set credit_limit = p_limit where id = p_client_id and supplier_org_id = public.current_org_id();
  if not found then
    raise exception using errcode = 'P0002', message = 'Client introuvable.';
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_set_credit_limit(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_credit_limit(uuid, numeric) TO authenticated;

-- A client who reached its outstanding limit cannot place a new order (its supplier still can).
create or replace function public.orders_check_credit_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_figures jsonb;
begin
  if (select auth.uid()) is null or not exists (select 1 from public.profiles pr where pr.id = (select auth.uid()) and pr.role = 'customer') then
    return new;
  end if;
  v_figures := public.account_figures(new.client_id);
  if (v_figures ->> 'credit_limit') is not null
     and (v_figures ->> 'outstanding')::numeric - (v_figures ->> 'deposits')::numeric >= (v_figures ->> 'credit_limit')::numeric then
    raise exception using errcode = '22023', message = format('Encours atteint : %s TND de factures à régler pour un encours autorisé de %s TND. Contactez votre fournisseur.',
      to_char((v_figures ->> 'outstanding')::numeric, 'FM999G999G990D000'), to_char((v_figures ->> 'credit_limit')::numeric, 'FM999G999G990D000'));
  end if;
  return new;
end;
$$;
drop trigger if exists orders_check_credit_limit on public.orders;
create trigger orders_check_credit_limit before insert on public.orders for each row execute function public.orders_check_credit_limit();
