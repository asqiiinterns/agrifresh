-- Production steps configurable per Pro (Paramétrage → Étapes de production):
--   * with or without the « En préparation » step (without it, an accepted order is marked prepared directly);
--   * the ticks of « À préparer » are shared by the whole team (on the server, per order line) instead of each phone;
--   * option: when every product of an order is ticked, the order is marked prepared automatically;
--   * the Pro's own steps inside the preparation (e.g. Découpe, Emballage, Contrôle), ticked per order and traced;
--   * whether the client sees those steps in the history of its order.
-- Functions redefined whole. Run AFTER 20261129_review.sql. Safe to rerun.

alter table public.organizations add column if not exists workflow jsonb not null default '{}'::jsonb;
alter table public.orders add column if not exists prep_done text[] not null default '{}';

create or replace function public.workflow_of(p_org_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('preparing', true, 'auto_ready', false, 'steps', '[]'::jsonb, 'client_sees_steps', true)
    || coalesce((select o.workflow from public.organizations o where o.id = p_org_id), '{}'::jsonb);
$$;
REVOKE ALL ON FUNCTION public.workflow_of(uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.my_workflow_settings()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('auto_deliver_hours', o.auto_deliver_hours) || public.workflow_of(o.id)
  from public.organizations o where o.id = public.acting_supplier_org_id();
$$;
REVOKE ALL ON FUNCTION public.my_workflow_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_workflow_settings() TO authenticated;

create or replace function public.set_workflow(p_workflow jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
  v_steps jsonb := '[]'::jsonb;
  v_step text;
begin
  if v_org is null or not (public.is_admin() or public.is_org_owner(v_org)) then
    raise exception using errcode = '42501', message = 'Seul l’administrateur règle les étapes de production.';
  end if;
  if p_workflow ? 'steps' then
    if jsonb_typeof(p_workflow -> 'steps') <> 'array' or jsonb_array_length(p_workflow -> 'steps') > 10 then
      raise exception using errcode = '22023', message = 'Dix étapes au plus.';
    end if;
    for v_step in select btrim(x) from jsonb_array_elements_text(p_workflow -> 'steps') x loop
      if char_length(v_step) not between 1 and 40 then
        raise exception using errcode = '22023', message = 'Chaque étape a un nom de 1 à 40 caractères.';
      end if;
      if not v_steps ? v_step then
        v_steps := v_steps || to_jsonb(v_step);
      end if;
    end loop;
  end if;
  update public.organizations set workflow = public.workflow_of(v_org)
    || jsonb_strip_nulls(jsonb_build_object(
      'preparing', case when p_workflow ? 'preparing' then (p_workflow ->> 'preparing')::boolean end,
      'auto_ready', case when p_workflow ? 'auto_ready' then (p_workflow ->> 'auto_ready')::boolean end,
      'client_sees_steps', case when p_workflow ? 'client_sees_steps' then (p_workflow ->> 'client_sees_steps')::boolean end))
    || case when p_workflow ? 'steps' then jsonb_build_object('steps', v_steps) else '{}'::jsonb end,
    updated_at = now()
  where id = v_org;
  return public.workflow_of(v_org);
end;
$$;
REVOKE ALL ON FUNCTION public.set_workflow(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_workflow(jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- Shared ticks of « À préparer » (one per order line)
-- ---------------------------------------------------------------------------
create table if not exists public.order_item_ticks (
  order_item_id uuid primary key references public.order_items(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  done_by uuid references public.profiles(id) on delete set null,
  done_at timestamptz not null default now()
);
create index if not exists order_item_ticks_order_idx on public.order_item_ticks(order_id);
alter table public.order_item_ticks enable row level security;
drop policy if exists "order_item_ticks_read" on public.order_item_ticks;
create policy "order_item_ticks_read" on public.order_item_ticks for select to authenticated using (public.org_visible(org_id));

create or replace function public.prep_ticks()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(t.order_item_id), '[]'::jsonb)
  from public.order_item_ticks t join public.orders o on o.id = t.order_id
  where t.org_id = public.acting_supplier_org_id() and o.status in ('confirmed', 'preparing', 'ready');
$$;
REVOKE ALL ON FUNCTION public.prep_ticks() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prep_ticks() TO authenticated;

-- Ticks or unticks order lines. A ticked line starts the preparation of its order (when that step is used);
-- with the option, an order whose lines are all ticked is marked prepared.
create or replace function public.prep_tick(p_item_ids uuid[], p_done boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.acting_supplier_org_id();
  v_flow jsonb := public.workflow_of(public.acting_supplier_org_id());
  v_order record;
  v_status text;
  v_started uuid[] := '{}';
  v_ready uuid[] := '{}';
begin
  if v_org is null or not public.has_feature('production.update') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de cocher la préparation.';
  end if;
  if exists (select 1 from public.order_items i join public.orders o on o.id = i.order_id
             where i.id = any(p_item_ids) and (o.supplier_org_id is distinct from v_org or o.status not in ('confirmed', 'preparing', 'ready'))) then
    raise exception using errcode = '22023', message = 'Une commande n’est plus à préparer : actualisez la liste.';
  end if;
  if not coalesce(p_done, false) then
    delete from public.order_item_ticks where order_item_id = any(p_item_ids);
    return jsonb_build_object('started', '[]'::jsonb, 'ready', '[]'::jsonb);
  end if;
  insert into public.order_item_ticks (order_item_id, order_id, org_id, done_by)
  select i.id, i.order_id, v_org, auth.uid() from public.order_items i where i.id = any(p_item_ids)
  on conflict (order_item_id) do nothing;
  for v_order in
    select o.id, o.status::text as status,
      not exists (select 1 from public.order_items i where i.order_id = o.id
                  and not exists (select 1 from public.order_item_ticks t where t.order_item_id = i.id)) as complete
    from public.orders o where o.id in (select i.order_id from public.order_items i where i.id = any(p_item_ids))
  loop
    v_status := v_order.status;
    if v_status = 'confirmed' and (v_flow ->> 'preparing')::boolean then
      perform public.staff_update_order_status(v_order.id, 'preparing', 'Préparation commencée (produits cochés).');
      v_started := v_started || v_order.id;
      v_status := 'preparing';
    end if;
    if v_order.complete and (v_flow ->> 'auto_ready')::boolean and v_status in ('confirmed', 'preparing') then
      perform public.staff_update_order_status(v_order.id, 'ready', 'Préparée : tous les produits sont cochés.');
      v_ready := v_ready || v_order.id;
    end if;
  end loop;
  return jsonb_build_object('started', to_jsonb(v_started), 'ready', to_jsonb(v_ready));
end;
$$;
REVOKE ALL ON FUNCTION public.prep_tick(uuid[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prep_tick(uuid[], boolean) TO authenticated;

-- One of the Pro's own steps done (or undone) for an order; traced in its history.
create or replace function public.prep_step(p_order_id uuid, p_step text, p_done boolean)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_flow jsonb;
  v_done text[];
begin
  if not public.has_feature('production.update') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de faire avancer la préparation.';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null or v_order.supplier_org_id is distinct from public.acting_supplier_org_id() then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  v_flow := public.workflow_of(v_order.supplier_org_id);
  if not ((v_flow -> 'steps') ? p_step) then
    raise exception using errcode = '22023', message = 'Étape inconnue : actualisez la liste.';
  end if;
  if v_order.status not in ('confirmed', 'preparing') then
    raise exception using errcode = '22023', message = 'Cette commande n’est plus en préparation.';
  end if;
  if v_order.status = 'confirmed' and coalesce(p_done, false) and (v_flow ->> 'preparing')::boolean then
    perform public.staff_update_order_status(p_order_id, 'preparing', null);
  end if;
  v_done := case when coalesce(p_done, false) then array(select distinct x from unnest(v_order.prep_done || p_step) x)
                 else array_remove(v_order.prep_done, p_step) end;
  update public.orders set prep_done = v_done, updated_at = now() where id = p_order_id;
  insert into public.order_status_history (order_id, status, note, changed_by)
  values (p_order_id, (select o.status from public.orders o where o.id = p_order_id),
          format('Étape « %s » %s', p_step, case when coalesce(p_done, false) then 'terminée' else 'annulée' end), auth.uid());
  return v_done;
end;
$$;
REVOKE ALL ON FUNCTION public.prep_step(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prep_step(uuid, text, boolean) TO authenticated;

-- Without the « En préparation » step: accepted → prepared.
create or replace function public.staff_update_order_status(p_order_id uuid, p_status public.order_status, p_note text default null)
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
    raise exception using errcode = '42501', message = 'Accès réservé à l’équipe du fournisseur.';
  end if;

  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if not found or v_order.supplier_org_id is distinct from public.acting_supplier_org_id() then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;

  if p_status = 'awaiting_client' and v_order.status = 'declined'
     and exists (select 1 from public.clients c where c.id = v_order.client_id and not (c.reconfirm_declined and public.module_enabled_for(c.supplier_org_id, 'reconfirm'))) then
    return public.reopen_order_accepted(p_order_id, v_note, v_actor_id);
  end if;

  -- Shipping: one shipment, with the planned or the default vehicle (never blocked for a vehicle).
  if p_status = 'out_for_delivery' and v_order.status = 'ready' then
    return public.driver_ship_orders(array[p_order_id], null) || jsonb_build_object('id', p_order_id, 'previous_status', v_order.status, 'status', p_status);
  end if;

  v_allowed := case v_order.status
    when 'pending' then array['confirmed', 'declined', 'on_hold']::public.order_status[]
    when 'on_hold' then array['confirmed', 'declined']::public.order_status[]
    when 'declined' then array['awaiting_client']::public.order_status[]
    when 'awaiting_client' then array['cancelled']::public.order_status[]
    -- Without the « En préparation » step (Pro setting), an accepted order is marked prepared directly.
    when 'confirmed' then case when public.workflow_of(v_order.supplier_org_id) ->> 'preparing' = 'false'
      then array['ready', 'cancelled']::public.order_status[] else array['preparing', 'cancelled']::public.order_status[] end
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
      production_rank = case
        when p_status = 'confirmed' then coalesce(production_rank, (
          select coalesce(max(q.production_rank), 0) + 1 from public.orders q
          where q.supplier_org_id = v_order.supplier_org_id and q.status in ('confirmed', 'preparing', 'ready') and q.id <> p_order_id))
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

-- The client sees the Pro's own steps in its order history only if the Pro allows it.
CREATE OR REPLACE FUNCTION public.buyer_orders()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(x.o order by x.created_at desc), '[]'::jsonb) from (
    select o.created_at,
      (to_jsonb(o) - 'subtotal' - 'total' - 'delivery_fee')
      || jsonb_build_object(
        'total', case when c.show_prices then o.total end,
        'supplier_name', s.name, 'seller', public.seller_card(s.id), 'show_prices', c.show_prices, 'show_origin', (c.show_origin and public.module_enabled_for(c.supplier_org_id, 'origin')), 'history_enabled', c.history_enabled, 'delivery_note', c.delivery_note_client,
        'order_items', coalesce((select jsonb_agg(jsonb_build_object(
            'product_id', i.product_id, 'product_name_snapshot', i.product_name_snapshot, 'quantity', i.quantity,
            'unit_snapshot', i.unit_snapshot, 'vat_rate', i.vat_rate,
            'unit_price', case when c.show_prices then i.unit_price end, 'line_total', case when c.show_prices then i.line_total end,
            'origin_snapshot', case when (c.show_origin and public.module_enabled_for(c.supplier_org_id, 'origin')) then i.origin_snapshot end) order by i.product_name_snapshot)
          from public.order_items i where i.order_id = o.id), '[]'::jsonb),
        'order_status_history', coalesce((select jsonb_agg(jsonb_build_object(
            'status', h.status, 'note', h.note, 'changed_by', h.changed_by, 'changed_by_name', h.changed_by_name, 'created_at', h.created_at) order by h.created_at)
          from public.order_status_history h where h.order_id = o.id
            and (h.note is null or h.note not like 'Étape « %' or public.workflow_of(o.supplier_org_id) ->> 'client_sees_steps' <> 'false')), '[]'::jsonb)) as o
    from public.buyer_relations('client.orders') c
    join public.organizations s on s.id = c.supplier_org_id
    join public.orders o on o.client_id = c.id
    where c.history_enabled or o.status not in ('delivered', 'cancelled')
    order by o.created_at desc
    limit 300
  ) x;
$function$
;
REVOKE ALL ON FUNCTION public.buyer_orders() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_orders() TO authenticated;

notify pgrst, 'reload schema';
