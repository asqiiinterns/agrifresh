-- Document numbering (format and starting number), returns and credit notes, alert notes.
-- Run in Supabase SQL Editor AFTER 20261029_team_messages.sql. Safe to rerun.

-- ---------------------------------------------------------------------------
-- 1. Alerts: back to unread, personal note
-- ---------------------------------------------------------------------------

alter table public.notifications add column if not exists note text;

create or replace function public.mark_notifications_unread(p_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.notifications set read_at = null
  where user_id = (select public.active_uid()) and id = any(p_ids);
$$;
REVOKE ALL ON FUNCTION public.mark_notifications_unread(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_notifications_unread(uuid[]) TO authenticated;

create or replace function public.set_notification_note(p_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if char_length(coalesce(p_note, '')) > 1000 then
    raise exception using errcode = '22023', message = 'La note est limitée à 1000 caractères.';
  end if;
  update public.notifications set note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_id and user_id = (select public.active_uid());
  if not found then
    raise exception using errcode = 'P0002', message = 'Alerte introuvable.';
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.set_notification_note(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_notification_note(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Numbering of delivery notes, invoices, credit notes and returns
-- ---------------------------------------------------------------------------

create table if not exists public.document_numbering (
  doc_type text primary key check (doc_type in ('delivery_note', 'invoice', 'credit_note', 'return')),
  prefix text not null default '',
  with_year boolean not null default true,
  digits int not null default 5 check (digits between 1 and 10),
  next_number bigint not null default 1 check (next_number >= 1),
  yearly_reset boolean not null default true,
  current_year int,
  updated_at timestamptz not null default now()
);
alter table public.document_numbering enable row level security;
GRANT SELECT ON public.document_numbering TO authenticated;
drop policy if exists "document_numbering_read" on public.document_numbering;
create policy "document_numbering_read" on public.document_numbering for select to authenticated using ((select public.is_staff()));

-- Existing numbers continue where they are: BL from the order numbers, invoices from their sequence.
insert into public.document_numbering (doc_type, prefix, with_year, digits, next_number, yearly_reset, current_year)
select 'delivery_note', 'BL-', false, 6, coalesce((select max(o.order_number) from public.orders o), 0) + 1, false, extract(year from now())::int
union all
select 'invoice', 'FA-', true, 5,
  (select case when s.is_called then s.last_value + 1 else s.last_value end from public.client_invoice_number_seq s), true, extract(year from now())::int
union all
select 'credit_note', 'AV-', true, 5, 1, true, extract(year from now())::int
union all
select 'return', 'RT-', true, 5, 1, true, extract(year from now())::int
on conflict (doc_type) do nothing;

create or replace function public.format_document_number(p_prefix text, p_with_year boolean, p_digits int, p_number bigint, p_year int)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_prefix || case when p_with_year then p_year::text || '-' else '' end || lpad(p_number::text, p_digits, '0');
$$;

-- Takes the next number of a document type (locked, so two documents never share a number).
create or replace function public.next_document_number(p_type text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.document_numbering%rowtype;
  v_year int := extract(year from (now() at time zone 'Africa/Tunis'))::int;
  v_number bigint;
begin
  select n.* into v_row from public.document_numbering n where n.doc_type = p_type for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Numérotation inconnue.';
  end if;
  v_number := case when v_row.yearly_reset and v_row.current_year is distinct from v_year then 1 else v_row.next_number end;
  update public.document_numbering set next_number = v_number + 1, current_year = v_year where doc_type = p_type;
  return public.format_document_number(v_row.prefix, v_row.with_year, v_row.digits, v_number, v_year);
end;
$$;
REVOKE ALL ON FUNCTION public.next_document_number(text) FROM PUBLIC, anon, authenticated;

create or replace function public.admin_set_numbering(
  p_type text, p_prefix text, p_with_year boolean, p_digits int, p_next_number bigint, p_yearly_reset boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if char_length(coalesce(p_prefix, '')) > 12 or coalesce(p_prefix, '') ~ '[^A-Za-z0-9/_.-]' then
    raise exception using errcode = '22023', message = 'Préfixe : 12 caractères au plus (lettres, chiffres, - / _ .).';
  end if;
  if p_digits not between 1 and 10 or p_next_number < 1 then
    raise exception using errcode = '22023', message = 'Nombre de chiffres (1 à 10) ou numéro de départ invalide.';
  end if;
  update public.document_numbering
  set prefix = coalesce(p_prefix, ''), with_year = p_with_year, digits = p_digits, next_number = p_next_number,
      yearly_reset = p_yearly_reset, current_year = extract(year from (now() at time zone 'Africa/Tunis'))::int, updated_at = now()
  where doc_type = p_type;
  if not found then
    raise exception using errcode = 'P0002', message = 'Numérotation inconnue.';
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.admin_set_numbering(text, text, boolean, int, bigint, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_numbering(text, text, boolean, int, bigint, boolean) TO authenticated;

-- Delivery notes get their own number when the order is accepted.
alter table public.orders add column if not exists delivery_note_number text;
create unique index if not exists orders_delivery_note_number_idx on public.orders(delivery_note_number);
update public.orders set delivery_note_number = 'BL-' || lpad(order_number::text, 6, '0')
where delivery_note_number is null and status not in ('pending', 'on_hold', 'declined', 'awaiting_client', 'cancelled');

create or replace function public.assign_delivery_note_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.delivery_note_number is null and new.status in ('confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered') then
    new.delivery_note_number := public.next_document_number('delivery_note');
  end if;
  return new;
end;
$$;
drop trigger if exists orders_delivery_note_number on public.orders;
create trigger orders_delivery_note_number before insert or update of status on public.orders
  for each row execute function public.assign_delivery_note_number();

-- Invoices use the configurable numbering.
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
      invoice_number = public.next_document_number('invoice'),
      issued_at = now(),
      client_snapshot = public.client_invoice_snapshot(v_client_id),
      updated_at = now()
  where id = p_invoice_id;
end;
$$;
REVOKE ALL ON FUNCTION public.issue_invoice(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Returns and credit notes
-- ---------------------------------------------------------------------------

insert into public.role_permissions (role, feature, allowed) values
  ('supervisor', 'returns.manage', true), ('production', 'returns.manage', false), ('driver', 'returns.manage', false),
  ('customer', 'returns.manage', false),
  ('supervisor', 'client.returns', false), ('production', 'client.returns', false), ('driver', 'client.returns', false),
  ('customer', 'client.returns', true)
on conflict (role, feature) do nothing;

insert into public.notification_settings (event, label, audience, push_enabled, email_enabled, sort_order) values
  ('return.new', 'Demande de retour', 'Équipe', true, false, 10),
  ('return.update', 'Suivi d’un retour', 'Client', true, false, 11),
  ('credit.issued', 'Avoir émis', 'Client', true, true, 12)
on conflict (event) do nothing;

-- requested (by the client) → approved / refused → received (goods back) → credited (credit note made).
create table if not exists public.returns (
  id uuid primary key default gen_random_uuid(),
  return_number text unique,
  client_id uuid not null references public.clients(id),
  order_id uuid references public.orders(id) on delete set null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'refused', 'received', 'credited')),
  reason text not null check (reason in ('quality', 'damaged', 'wrong', 'excess', 'other')),
  description text,
  staff_note text,
  restocked boolean not null default false,
  requested_by uuid references public.profiles(id) on delete set null,
  handled_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  received_at timestamptz
);
create table if not exists public.return_items (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.returns(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  unit text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_price numeric(12,3) not null default 0,
  vat_rate numeric(5,2) not null default 0
);
create index if not exists returns_client_idx on public.returns(client_id, created_at desc);

-- draft → issued → refunded (paid back) or deducted (from a next invoice); cancelled.
create table if not exists public.credit_notes (
  id uuid primary key default gen_random_uuid(),
  credit_number text unique,
  client_id uuid not null references public.clients(id),
  return_id uuid references public.returns(id) on delete set null,
  invoice_id uuid references public.client_invoices(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'issued', 'refunded', 'deducted', 'cancelled')),
  reason text,
  client_snapshot jsonb,
  total_ht numeric(12,3) not null default 0,
  total_vat numeric(12,3) not null default 0,
  total_ttc numeric(12,3) not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  issued_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz not null default now()
);
create table if not exists public.credit_note_items (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references public.credit_notes(id) on delete cascade,
  label text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit text not null default '',
  unit_price numeric(12,3) not null check (unit_price >= 0),
  vat_rate numeric(5,2) not null default 0 check (vat_rate between 0 and 100)
);
create index if not exists credit_notes_client_idx on public.credit_notes(client_id, created_at desc);

alter table public.returns enable row level security;
alter table public.return_items enable row level security;
alter table public.credit_notes enable row level security;
alter table public.credit_note_items enable row level security;
GRANT SELECT ON public.returns, public.return_items, public.credit_notes, public.credit_note_items TO authenticated;
drop policy if exists "returns_read" on public.returns;
create policy "returns_read" on public.returns for select to authenticated using (
  (select public.has_feature('returns.manage')) or client_id = (select public.current_client_id())
);
drop policy if exists "return_items_read" on public.return_items;
create policy "return_items_read" on public.return_items for select to authenticated using (
  exists (select 1 from public.returns r where r.id = return_items.return_id
    and ((select public.has_feature('returns.manage')) or r.client_id = (select public.current_client_id())))
);
drop policy if exists "credit_notes_read" on public.credit_notes;
create policy "credit_notes_read" on public.credit_notes for select to authenticated using (
  (select public.has_feature('returns.manage')) or (select public.has_feature('invoices.manage'))
  or (client_id = (select public.current_client_id()) and status <> 'draft')
);
drop policy if exists "credit_note_items_read" on public.credit_note_items;
create policy "credit_note_items_read" on public.credit_note_items for select to authenticated using (
  exists (select 1 from public.credit_notes c where c.id = credit_note_items.credit_note_id
    and ((select public.has_feature('returns.manage')) or (select public.has_feature('invoices.manage'))
         or (c.client_id = (select public.current_client_id()) and c.status <> 'draft')))
);

create or replace function public.client_users(p_client_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(pr.id), '{}'::uuid[]) from public.profiles pr where pr.client_id = p_client_id and pr.account_status = 'active';
$$;
REVOKE ALL ON FUNCTION public.client_users(uuid) FROM PUBLIC, anon, authenticated;

-- Lines of a return, taken from a delivered order (quantities capped to what was delivered).
create or replace function public.create_return(
  p_order_id uuid, p_items jsonb, p_reason text, p_description text, p_actor uuid, p_status text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_return_id uuid;
  v_item record;
  v_line record;
  v_count int := 0;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  if v_order.status <> 'delivered' then
    raise exception using errcode = '22023', message = 'Un retour ne concerne qu’une commande livrée.';
  end if;
  if p_reason not in ('quality', 'damaged', 'wrong', 'excess', 'other') then
    raise exception using errcode = '22023', message = 'Motif de retour invalide.';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'Indiquez au moins un produit à retourner.';
  end if;

  insert into public.returns (return_number, client_id, order_id, status, reason, description, requested_by, handled_by)
  values (public.next_document_number('return'), v_order.client_id, p_order_id, p_status, p_reason,
          nullif(btrim(coalesce(p_description, '')), ''), p_actor, case when p_status <> 'requested' then p_actor end)
  returning id into v_return_id;

  for v_item in
    select (e ->> 'product_id')::uuid as product_id, (e ->> 'quantity')::numeric as quantity from jsonb_array_elements(p_items) e
  loop
    select oi.product_id, min(oi.product_name_snapshot) as name, min(oi.unit_snapshot) as unit, sum(oi.quantity) as quantity,
           max(oi.unit_price) as unit_price, max(oi.vat_rate) as vat_rate
    into v_line
    from public.order_items oi where oi.order_id = p_order_id and oi.product_id = v_item.product_id
    group by oi.product_id;
    if v_line.product_id is null then
      raise exception using errcode = '22023', message = 'Un produit ne figure pas sur cette commande.';
    end if;
    if v_item.quantity is null or v_item.quantity <= 0 or v_item.quantity > v_line.quantity then
      raise exception using errcode = '22023', message = format('Quantité à retourner invalide pour %s (livré : %s).', v_line.name, v_line.quantity);
    end if;
    insert into public.return_items (return_id, product_id, product_name, unit, quantity, unit_price, vat_rate)
    values (v_return_id, v_line.product_id, v_line.name, v_line.unit, v_item.quantity, v_line.unit_price, coalesce(v_line.vat_rate, 0));
    v_count := v_count + 1;
  end loop;
  return v_return_id;
end;
$$;
REVOKE ALL ON FUNCTION public.create_return(uuid, jsonb, text, text, uuid, text) FROM PUBLIC, anon, authenticated;

create or replace function public.client_request_return(p_order_id uuid, p_items jsonb, p_reason text, p_description text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_number text;
begin
  if not public.has_feature('client.returns') then
    raise exception using errcode = '42501', message = 'Les demandes de retour ne sont pas activées pour votre compte.';
  end if;
  if not exists (select 1 from public.orders o where o.id = p_order_id and o.client_id = public.current_client_id()) then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  v_id := public.create_return(p_order_id, p_items, p_reason, p_description, auth.uid(), 'requested');
  select r.return_number into v_number from public.returns r where r.id = v_id;
  perform public.notify(array(select public.team_with_feature('returns.manage')), 'return.new',
    format('Demande de retour %s', v_number), 'Un client demande un retour de marchandise.', p_order_id);
  return jsonb_build_object('id', v_id, 'return_number', v_number);
end;
$$;
REVOKE ALL ON FUNCTION public.client_request_return(uuid, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_request_return(uuid, jsonb, text, text) TO authenticated;

create or replace function public.staff_create_return(p_order_id uuid, p_items jsonb, p_reason text, p_description text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.has_feature('returns.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de gérer les retours.';
  end if;
  v_id := public.create_return(p_order_id, p_items, p_reason, p_description, auth.uid(), 'approved');
  return (select jsonb_build_object('id', r.id, 'return_number', r.return_number) from public.returns r where r.id = v_id);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_create_return(uuid, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_create_return(uuid, jsonb, text, text) TO authenticated;

-- approve / refuse / receive (with or without restocking).
create or replace function public.staff_update_return(p_return_id uuid, p_action text, p_note text default null, p_restock boolean default true)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_return public.returns%rowtype;
  v_next text;
begin
  if not public.has_feature('returns.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de gérer les retours.';
  end if;
  select r.* into v_return from public.returns r where r.id = p_return_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Retour introuvable.';
  end if;
  v_next := case
    when p_action = 'approve' and v_return.status = 'requested' then 'approved'
    when p_action = 'refuse' and v_return.status in ('requested', 'approved') then 'refused'
    when p_action = 'receive' and v_return.status = 'approved' then 'received'
  end;
  if v_next is null then
    raise exception using errcode = '22023', message = 'Action impossible à cette étape du retour.';
  end if;
  update public.returns
  set status = v_next, staff_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), staff_note),
      handled_by = auth.uid(), updated_at = now(),
      received_at = case when v_next = 'received' then now() else received_at end,
      restocked = case when v_next = 'received' then coalesce(p_restock, false) else restocked end
  where id = p_return_id;
  if v_next = 'received' and coalesce(p_restock, false) then
    update public.products p set stock_quantity = p.stock_quantity + ri.quantity, updated_at = now()
    from public.return_items ri where ri.return_id = p_return_id and ri.product_id = p.id;
  end if;
  perform public.notify(public.client_users(v_return.client_id), 'return.update',
    format('Retour %s : %s', v_return.return_number,
      case v_next when 'approved' then 'accepté' when 'refused' then 'refusé' else 'marchandise reçue' end),
    coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Suivez votre retour dans Mes factures → Retours.'), v_return.order_id);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_update_return(uuid, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_update_return(uuid, text, text, boolean) TO authenticated;

create or replace function public.refresh_credit_totals(p_credit_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.credit_notes c set
    total_ht = t.ht, total_vat = t.vat, total_ttc = t.ht + t.vat, updated_at = now()
  from (
    select coalesce(sum(round(i.quantity * i.unit_price, 3)), 0) as ht,
           coalesce(sum(round(i.quantity * i.unit_price * i.vat_rate / 100, 3)), 0) as vat
    from public.credit_note_items i where i.credit_note_id = p_credit_id
  ) t
  where c.id = p_credit_id;
$$;
REVOKE ALL ON FUNCTION public.refresh_credit_totals(uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.issue_credit_note_internal(p_credit_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credit public.credit_notes%rowtype;
begin
  select c.* into v_credit from public.credit_notes c where c.id = p_credit_id for update;
  if v_credit.status <> 'draft' then
    raise exception using errcode = '22023', message = 'Seul un avoir en brouillon peut être émis.';
  end if;
  if not exists (select 1 from public.credit_note_items i where i.credit_note_id = p_credit_id) then
    raise exception using errcode = '22023', message = 'L’avoir ne contient aucune ligne.';
  end if;
  perform public.refresh_credit_totals(p_credit_id);
  update public.credit_notes
  set status = 'issued', credit_number = public.next_document_number('credit_note'), issued_at = now(),
      client_snapshot = public.client_invoice_snapshot(v_credit.client_id), updated_at = now()
  where id = p_credit_id
  returning * into v_credit;
  perform public.notify(public.client_users(v_credit.client_id), 'credit.issued',
    format('Avoir %s émis', v_credit.credit_number),
    format('Montant : %s TND TTC. Retrouvez-le dans Mes factures → Avoirs.', to_char(v_credit.total_ttc, 'FM999G999G990D000')), null);
end;
$$;
REVOKE ALL ON FUNCTION public.issue_credit_note_internal(uuid) FROM PUBLIC, anon, authenticated;

-- Credit note from a received return: one line per returned product.
create or replace function public.staff_credit_return(p_return_id uuid, p_issue boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_return public.returns%rowtype;
  v_credit_id uuid;
  v_invoice uuid;
begin
  if not public.has_feature('returns.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de gérer les retours.';
  end if;
  select r.* into v_return from public.returns r where r.id = p_return_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Retour introuvable.';
  end if;
  if v_return.status not in ('approved', 'received') then
    raise exception using errcode = '22023', message = 'L’avoir se crée sur un retour accepté ou reçu.';
  end if;
  select o.client_invoice_id into v_invoice from public.orders o where o.id = v_return.order_id;
  insert into public.credit_notes (client_id, return_id, invoice_id, reason, created_by)
  values (v_return.client_id, p_return_id, v_invoice, format('Retour %s', v_return.return_number), auth.uid())
  returning id into v_credit_id;
  insert into public.credit_note_items (credit_note_id, label, quantity, unit, unit_price, vat_rate)
  select v_credit_id, ri.product_name, ri.quantity, ri.unit, ri.unit_price, ri.vat_rate from public.return_items ri where ri.return_id = p_return_id;
  perform public.refresh_credit_totals(v_credit_id);
  update public.returns set status = 'credited', handled_by = auth.uid(), updated_at = now() where id = p_return_id;
  if p_issue then
    perform public.issue_credit_note_internal(v_credit_id);
  end if;
  return (select jsonb_build_object('id', c.id, 'credit_number', c.credit_number, 'status', c.status, 'total_ttc', c.total_ttc)
          from public.credit_notes c where c.id = v_credit_id);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_credit_return(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_credit_return(uuid, boolean) TO authenticated;

-- Free credit note (commercial gesture, price correction): lines entered by hand.
create or replace function public.staff_create_credit_note(p_client_id uuid, p_invoice_id uuid, p_reason text, p_lines jsonb, p_issue boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credit_id uuid;
  v_line record;
begin
  if not (public.has_feature('returns.manage') or public.has_feature('invoices.manage')) then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de créer des avoirs.';
  end if;
  if not exists (select 1 from public.clients c where c.id = p_client_id) then
    raise exception using errcode = 'P0002', message = 'Client introuvable.';
  end if;
  if p_invoice_id is not null and not exists (select 1 from public.client_invoices i where i.id = p_invoice_id and i.client_id = p_client_id) then
    raise exception using errcode = '22023', message = 'Cette facture n’appartient pas au client.';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception using errcode = '22023', message = 'Ajoutez au moins une ligne.';
  end if;
  insert into public.credit_notes (client_id, invoice_id, reason, created_by)
  values (p_client_id, p_invoice_id, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid()) returning id into v_credit_id;
  for v_line in
    select btrim(e ->> 'label') as label, (e ->> 'quantity')::numeric as quantity, coalesce(e ->> 'unit', '') as unit,
           (e ->> 'unit_price')::numeric as unit_price, coalesce((e ->> 'vat_rate')::numeric, 0) as vat_rate
    from jsonb_array_elements(p_lines) e
  loop
    if coalesce(v_line.label, '') = '' or v_line.quantity is null or v_line.quantity <= 0 or v_line.unit_price is null or v_line.unit_price < 0 then
      raise exception using errcode = '22023', message = 'Chaque ligne demande un libellé, une quantité et un prix.';
    end if;
    insert into public.credit_note_items (credit_note_id, label, quantity, unit, unit_price, vat_rate)
    values (v_credit_id, v_line.label, v_line.quantity, v_line.unit, v_line.unit_price, v_line.vat_rate);
  end loop;
  perform public.refresh_credit_totals(v_credit_id);
  if p_issue then
    perform public.issue_credit_note_internal(v_credit_id);
  end if;
  return (select jsonb_build_object('id', c.id, 'credit_number', c.credit_number, 'status', c.status, 'total_ttc', c.total_ttc)
          from public.credit_notes c where c.id = v_credit_id);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_create_credit_note(uuid, uuid, text, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_create_credit_note(uuid, uuid, text, jsonb, boolean) TO authenticated;

-- issue / refunded / deducted / cancelled / delete (draft only).
create or replace function public.staff_update_credit_note(p_credit_id uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if not (public.has_feature('returns.manage') or public.has_feature('invoices.manage')) then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de gérer les avoirs.';
  end if;
  select c.status into v_status from public.credit_notes c where c.id = p_credit_id for update;
  if v_status is null then
    raise exception using errcode = 'P0002', message = 'Avoir introuvable.';
  end if;
  if p_action = 'issue' then
    perform public.issue_credit_note_internal(p_credit_id);
  elsif p_action = 'delete' and v_status = 'draft' then
    update public.returns set status = 'received', updated_at = now()
    where id = (select c.return_id from public.credit_notes c where c.id = p_credit_id) and status = 'credited';
    delete from public.credit_notes where id = p_credit_id;
  elsif p_action in ('refunded', 'deducted') and v_status = 'issued' then
    update public.credit_notes set status = p_action, settled_at = now(), updated_at = now() where id = p_credit_id;
  elsif p_action = 'cancelled' and v_status in ('issued', 'refunded', 'deducted') then
    update public.credit_notes set status = 'cancelled', updated_at = now() where id = p_credit_id;
  else
    raise exception using errcode = '22023', message = 'Action impossible pour cet avoir.';
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_update_credit_note(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_update_credit_note(uuid, text) TO authenticated;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY array['returns', 'credit_notes', 'document_numbering'] LOOP
    EXECUTE format('drop trigger if exists audit_%1$s on public.%1$I', t);
    EXECUTE format('create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute function public.audit_row()', t);
  END LOOP;
END;
$$;
