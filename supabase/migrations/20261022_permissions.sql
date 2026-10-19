-- Per-role feature permissions, set by admins in the app (Compte → Gérer l'équipe → Droits).
-- Run in Supabase SQL Editor AFTER 20261021_2_planning_stock.sql. Safe to rerun.
-- Admins always have every feature; other roles follow role_permissions.

create table if not exists public.role_permissions (
  role public.app_role not null,
  feature text not null,
  allowed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (role, feature)
);
alter table public.role_permissions enable row level security;
GRANT SELECT ON public.role_permissions TO authenticated;
drop policy if exists "role_permissions_read" on public.role_permissions;
create policy "role_permissions_read" on public.role_permissions
  for select to authenticated using (true);

-- Defaults reproduce the behaviour before this migration; existing choices are kept.
insert into public.role_permissions (role, feature, allowed)
select r.role::public.app_role, f.feature,
  case
    when r.role = 'supervisor' then f.feature not in ('clients.create', 'client.invoices', 'client.messages', 'client.claims')
    when r.role = 'production' then f.feature in ('production.view', 'production.update')
    when r.role = 'driver' then f.feature = 'deliveries'
    when r.role = 'customer' then f.feature in ('client.invoices', 'client.messages', 'client.claims')
  end
from (values ('supervisor'), ('production'), ('driver'), ('customer')) as r(role)
cross join (values
  ('orders.decide'), ('orders.plan'), ('orders.ship'), ('production.view'), ('production.update'),
  ('clients.view'), ('clients.edit'), ('clients.create'), ('invoices.manage'), ('products.manage'),
  ('messages.manage'), ('claims.manage'), ('deliveries'),
  ('client.invoices'), ('client.messages'), ('client.claims')
) as f(feature)
on conflict (role, feature) do nothing;

create or replace function public.has_feature(p_feature text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when pr.role = 'admin' then true
      else coalesce((
        select rp.allowed from public.role_permissions rp
        where rp.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role
          and rp.feature = p_feature
      ), false)
    end
    from public.profiles pr where pr.id = (select auth.uid())
  ), false);
$$;
REVOKE ALL ON FUNCTION public.has_feature(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_feature(text) TO authenticated;

create or replace function public.my_features()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(f.feature order by f.feature), '[]'::jsonb)
  from (select distinct rp.feature from public.role_permissions rp) f
  where public.has_feature(f.feature);
$$;
REVOKE ALL ON FUNCTION public.my_features() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_features() TO authenticated;

create or replace function public.admin_set_permission(p_role public.app_role, p_feature text, p_allowed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if p_role in ('admin', 'staff') then
    raise exception using errcode = '22023', message = 'Les droits administrateur ne se modifient pas.';
  end if;
  if not exists (select 1 from public.role_permissions rp where rp.feature = p_feature) then
    raise exception using errcode = '22023', message = 'Fonctionnalité inconnue.';
  end if;
  insert into public.role_permissions (role, feature, allowed, updated_at)
  values (p_role, p_feature, p_allowed, now())
  on conflict (role, feature) do update set allowed = excluded.allowed, updated_at = now();
end;
$$;
REVOKE ALL ON FUNCTION public.admin_set_permission(public.app_role, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_permission(public.app_role, text, boolean) TO authenticated;

-- Role guards used by policies now follow the permissions.
create or replace function public.is_production()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_feature('production.view') or public.has_feature('production.update');
$$;

create or replace function public.is_driver()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_feature('deliveries');
$$;

-- Client records: creation and edits follow their permissions.
drop policy if exists "clients_staff_update" on public.clients;
create policy "clients_staff_update" on public.clients
  for update to authenticated using ((select public.has_feature('clients.edit'))) with check ((select public.has_feature('clients.edit')));
drop policy if exists "clients_admin_insert" on public.clients;
create policy "clients_admin_insert" on public.clients
  for insert to authenticated with check ((select public.has_feature('clients.create')));

drop policy if exists "delivery_points_staff_all" on public.client_delivery_points;
drop policy if exists "delivery_points_staff_select" on public.client_delivery_points;
create policy "delivery_points_staff_select" on public.client_delivery_points
  for select to authenticated using ((select public.is_staff()));
drop policy if exists "delivery_points_staff_insert" on public.client_delivery_points;
create policy "delivery_points_staff_insert" on public.client_delivery_points
  for insert to authenticated with check ((select public.has_feature('clients.edit')));
drop policy if exists "delivery_points_staff_update" on public.client_delivery_points;
create policy "delivery_points_staff_update" on public.client_delivery_points
  for update to authenticated using ((select public.has_feature('clients.edit'))) with check ((select public.has_feature('clients.edit')));

-- Catalogue: staff read everything, only "products.manage" writes.
drop policy if exists "products_staff_all" on public.products;
drop policy if exists "products_staff_select" on public.products;
create policy "products_staff_select" on public.products
  for select to authenticated using ((select public.is_staff()));
drop policy if exists "products_manage_insert" on public.products;
create policy "products_manage_insert" on public.products
  for insert to authenticated with check ((select public.has_feature('products.manage')));
drop policy if exists "products_manage_update" on public.products;
create policy "products_manage_update" on public.products
  for update to authenticated using ((select public.has_feature('products.manage'))) with check ((select public.has_feature('products.manage')));

-- Clients see their invoices only when the feature is enabled for customers.
drop policy if exists "client_invoices_read_own" on public.client_invoices;
create policy "client_invoices_read_own" on public.client_invoices
  for select to authenticated using (
    client_id = (select public.current_client_id()) and status <> 'draft' and (select public.has_feature('client.invoices'))
  );

-- ---------------------------------------------------------------------------
-- Actions now check the matching feature (bodies otherwise unchanged).
-- ---------------------------------------------------------------------------

create or replace function public.staff_create_invoice(p_client_id uuid, p_order_ids uuid[], p_draft boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice_id uuid;
begin
  if not public.has_feature('invoices.manage') then
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
  if not public.has_feature('invoices.manage') then
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
  if not public.has_feature('invoices.manage') then
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
  if not public.has_feature('invoices.manage') then
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
  if not public.has_feature('invoices.manage') then
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
  if not public.has_feature('claims.manage') then
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
  if not public.has_feature('client.claims') then
    raise exception using errcode = '42501', message = 'Les réclamations ne sont pas activées pour votre compte.';
  end if;
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


create or replace function public.staff_schedule_order(p_order_id uuid, p_before_order_id uuid default null)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.order_status;
  v_before_rank numeric;
  v_previous_rank numeric;
  v_rank numeric;
begin
  if not public.has_feature('orders.plan') then
    raise exception using errcode = '42501', message = 'Accès réservé à l’administration.';
  end if;

  -- Serialize queue changes.
  perform pg_advisory_xact_lock(hashtext('agrifresh_production_queue'));

  select o.status into v_status from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  if v_status not in ('confirmed', 'preparing', 'ready') then
    raise exception using errcode = '22023', message = 'Seules les commandes acceptées se planifient.';
  end if;

  if p_before_order_id is null or p_before_order_id = p_order_id then
    select coalesce(max(o.production_rank), 0) + 1 into v_rank
    from public.orders o
    where o.status in ('confirmed', 'preparing', 'ready') and o.id <> p_order_id;
  else
    select o.production_rank into v_before_rank
    from public.orders o
    where o.id = p_before_order_id and o.status in ('confirmed', 'preparing', 'ready');
    if v_before_rank is null then
      raise exception using errcode = '22023', message = 'La commande de référence n’est plus dans la file de production.';
    end if;
    select max(o.production_rank) into v_previous_rank
    from public.orders o
    where o.status in ('confirmed', 'preparing', 'ready') and o.id <> p_order_id and o.production_rank < v_before_rank;
    v_rank := case when v_previous_rank is null then v_before_rank - 1 else (v_previous_rank + v_before_rank) / 2 end;
  end if;

  update public.orders set production_rank = v_rank, updated_at = now() where id = p_order_id;
  return v_rank;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_schedule_order(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_schedule_order(uuid, uuid) TO authenticated;


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
  v_actor_id uuid := auth.uid();
  v_order public.orders%rowtype;
  v_allowed public.order_status[];
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_invoice_status text;
  v_other_orders int;
begin
  if not public.has_feature(case
      when p_status in ('preparing', 'ready') then 'production.update'
      when p_status = 'out_for_delivery' then 'orders.ship'
      else 'orders.decide' end) then
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
      -- Accepted orders join the end of the queue; staff may then move them.
      production_rank = case
        when p_status = 'confirmed' then coalesce(production_rank, (
          select coalesce(max(q.production_rank), 0) + 1 from public.orders q
          where q.status in ('confirmed', 'preparing', 'ready') and q.id <> p_order_id))
        when p_status in ('preparing', 'ready') then production_rank
        else null end,
      updated_at = now()
  where id = p_order_id;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (p_order_id, p_status, v_note, v_actor_id);

  if p_status = 'confirmed' and v_order.client_invoice_id is null
     and exists (select 1 from public.clients c where c.id = v_order.client_id and c.invoice_mode = 'auto') then
    perform public.create_client_invoice(v_order.client_id, array[p_order_id], v_actor_id, false);
  end if;

  if p_status in ('declined', 'cancelled') then
    if v_order.stock_reserved then
      update public.products p
      set stock_quantity = p.stock_quantity + oi.quantity, updated_at = now()
      from public.order_items oi
      where oi.order_id = p_order_id and oi.product_id = p.id;
      update public.orders set stock_reserved = false where id = p_order_id;
    end if;

    update public.payments set status = 'cancelled'
    where order_id = p_order_id and status = 'pending';
  end if;

  return jsonb_build_object('id', p_order_id, 'previous_status', v_order.status, 'status', p_status);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_update_order_status(uuid, public.order_status, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_update_order_status(uuid, public.order_status, text) TO authenticated;


create or replace function public.staff_inbox()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_feature('messages.manage') then
    raise exception using errcode = '42501', message = 'Accès réservé au personnel AgriFresh.';
  end if;
  return coalesce((
    select jsonb_agg(entry order by entry ->> 'last_at' desc nulls last, entry ->> 'business_name')
    from (
      select jsonb_build_object(
        'client_id', c.id,
        'business_name', c.business_name,
        'client_number', c.client_number,
        'last_body', last_message.body,
        'last_at', last_message.created_at,
        'last_from_staff', last_message.from_staff,
        'unread', (select count(*) from public.messages m
                   where m.client_id = c.id and not m.from_staff and m.read_at is null)
      ) as entry
      from public.clients c
      left join lateral (
        select m.body, m.created_at, m.from_staff from public.messages m
        where m.client_id = c.id order by m.created_at desc limit 1
      ) last_message on true
      where c.active or last_message.created_at is not null
    ) entries
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_inbox() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_inbox() TO authenticated;


create or replace function public.send_message(p_client_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_staff boolean := public.is_staff();
  v_client_id uuid;
  v_message public.messages%rowtype;
begin
  if v_is_staff then
    if not public.has_feature('messages.manage') then
      raise exception using errcode = '42501', message = 'La messagerie n’est pas activée pour votre profil.';
    end if;
    v_client_id := p_client_id;
  else
    if not public.has_feature('client.messages') then
      raise exception using errcode = '42501', message = 'La messagerie n’est pas activée pour votre compte.';
    end if;
    v_client_id := public.current_client_id();
    if v_client_id is null then
      raise exception using errcode = '42501', message = 'Votre compte n’est rattaché à aucune fiche client.';
    end if;
    if p_client_id is not null and p_client_id <> v_client_id then
      raise exception using errcode = '42501', message = 'Vous ne pouvez écrire que dans votre propre conversation.';
    end if;
  end if;

  if not exists (select 1 from public.clients c where c.id = v_client_id) then
    raise exception using errcode = 'P0002', message = 'Client introuvable.';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Le message doit contenir entre 1 et 2000 caractères.';
  end if;

  insert into public.messages (client_id, sender_id, from_staff, body)
  values (v_client_id, auth.uid(), v_is_staff, btrim(p_body))
  returning * into v_message;

  return jsonb_build_object(
    'id', v_message.id, 'client_id', v_message.client_id, 'from_staff', v_message.from_staff,
    'body', v_message.body, 'created_at', v_message.created_at, 'read_at', v_message.read_at
  );
end;
$$;
REVOKE ALL ON FUNCTION public.send_message(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_message(uuid, text) TO authenticated;


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
    'features', public.my_features(),
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

