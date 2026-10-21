-- Shipping never blocked for a vehicle:
--   * each Pro marks a default vehicle in its fleet;
--   * without a choice: the vehicle planned for the orders (when they share one), else the default vehicle, else the
--     first vehicle of the fleet; a Pro without vehicles ships without one;
--   * the "Expédier" button of an order ships it the same way (it used to ask to go through Livraisons);
--   * fix: "has a fleet" looked at the vehicles of every Pro, not only the acting one.
-- Functions redefined whole. Run AFTER 20261126_fixes.sql. Safe to rerun.

alter table public.vehicles add column if not exists is_default boolean not null default false;
create unique index if not exists vehicles_one_default_idx on public.vehicles(org_id) where is_default;

create or replace function public.default_vehicle_for(p_org_id uuid)
returns uuid language sql stable security definer set search_path = ''
as $$
  select v.id from public.vehicles v where v.org_id = p_org_id and v.active order by v.is_default desc, v.label, v.id limit 1;
$$;
REVOKE ALL ON FUNCTION public.default_vehicle_for(uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.set_default_vehicle(p_vehicle_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not public.has_feature('fleet.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de gérer la flotte.';
  end if;
  if not exists (select 1 from public.vehicles v where v.id = p_vehicle_id and v.org_id = v_org and v.active) then
    raise exception using errcode = 'P0002', message = 'Véhicule introuvable ou retiré de la flotte.';
  end if;
  update public.vehicles set is_default = false where org_id = v_org and is_default and id <> p_vehicle_id;
  update public.vehicles set is_default = true where id = p_vehicle_id;
end;
$$;
REVOKE ALL ON FUNCTION public.set_default_vehicle(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_default_vehicle(uuid) TO authenticated;

create or replace function public.driver_ship_orders(p_order_ids uuid[], p_vehicle_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.active_uid();
  v_org uuid := public.acting_supplier_org_id();
  v_count int;
  v_ready int;
  v_vehicle_id uuid := p_vehicle_id;
  v_vehicle public.vehicles%rowtype;
  v_vehicle_text text := '';
  v_auto text := '';
  v_shipment_id uuid;
  v_number bigint;
begin
  if v_actor is null or not public.has_feature('orders.ship') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas d’expédier les commandes.';
  end if;
  select count(distinct x) into v_count from unnest(coalesce(p_order_ids, '{}'::uuid[])) as t(x);
  if v_count = 0 then
    raise exception using errcode = '22023', message = 'Sélectionnez au moins un bon de livraison.';
  end if;
  if v_vehicle_id is null then
    -- No choice: the vehicle planned for all these orders, else the default one of the fleet (if any).
    select case when count(distinct o.planned_vehicle_id) = 1 and bool_and(o.planned_vehicle_id is not null) then (array_agg(o.planned_vehicle_id))[1] end
    into v_vehicle_id from public.orders o where o.id = any(p_order_ids);
    if v_vehicle_id is not null and not exists (select 1 from public.vehicles v where v.id = v_vehicle_id and v.active and v.org_id = v_org) then
      v_vehicle_id := null;
    end if;
    v_vehicle_id := coalesce(v_vehicle_id, public.default_vehicle_for(v_org));
    if v_vehicle_id is not null then
      v_auto := ' (par défaut)';
    end if;
  end if;
  if v_vehicle_id is not null then
    select v.* into v_vehicle from public.vehicles v where v.id = v_vehicle_id and v.active and v.org_id = v_org;
    if not found then
      raise exception using errcode = 'P0002', message = 'Véhicule introuvable ou retiré de la flotte.';
    end if;
    v_vehicle_text := ' · ' || v_vehicle.label || case when v_vehicle.plate <> '' then ' (' || v_vehicle.plate || ')' else '' end || v_auto;
  end if;

  perform 1 from public.orders o where o.id = any(p_order_ids) order by o.id for update;
  select count(*) into v_ready from public.orders o where o.id = any(p_order_ids) and o.status = 'ready';
  if v_ready <> v_count then
    raise exception using errcode = '22023', message = 'Une commande sélectionnée n’est plus prête à expédier : actualisez la liste.';
  end if;

  insert into public.shipments (vehicle_id, driver_id, order_count) values (v_vehicle_id, v_actor, v_count)
  returning id, shipment_number into v_shipment_id, v_number;
  update public.orders set status = 'out_for_delivery', shipment_id = v_shipment_id, production_rank = null, updated_at = now()
  where id = any(p_order_ids);
  insert into public.order_status_history (order_id, status, note, changed_by)
  select o.id, 'out_for_delivery', format('Expédition #%s%s', v_number, v_vehicle_text), v_actor
  from public.orders o where o.id = any(p_order_ids);
  -- A vehicle other than the one planned: traced on the order and the deciders are told.
  update public.order_status_history h set note = h.note || format(' · véhicule prévu : %s, remplacé', pv.label)
  from public.orders o join public.vehicles pv on pv.id = o.planned_vehicle_id
  where h.order_id = o.id and o.id = any(p_order_ids) and h.status = 'out_for_delivery' and h.created_at > now() - interval '1 minute'
    and o.planned_vehicle_id is distinct from v_vehicle_id;
  perform public.notify(array(select public.team_with_feature('orders.decide', o.supplier_org_id)), 'order.forced',
    format('Condition forcée · commande #%s', o.order_number),
    format('Véhicule prévu : %s ; utilisé : %s.', pv.label, coalesce(v_vehicle.label, 'aucun')), o.id)
  from public.orders o join public.vehicles pv on pv.id = o.planned_vehicle_id
  where o.id = any(p_order_ids) and o.planned_vehicle_id is distinct from v_vehicle_id;
  return jsonb_build_object('shipment_id', v_shipment_id, 'shipment_number', v_number, 'count', v_count, 'vehicle', v_vehicle.label);
end;
$$;
REVOKE ALL ON FUNCTION public.driver_ship_orders(uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_ship_orders(uuid[], uuid) TO authenticated;

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
  if not found then
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

notify pgrst, 'reload schema';
