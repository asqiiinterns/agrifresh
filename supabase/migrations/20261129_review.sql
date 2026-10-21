-- Review of lots 20261121 → 20261128 (2026-10-21): fixes found by a full pass, functions redefined whole.
--   1. location: a request already answered (or expired) is not answered again; "compte introuvable" works
--      when the administrator sets tracking for an account outside its Pro;
--   2. rights per account: the Responsable's rights are set by Appro+ only (a delegate could remove them);
--      the matrix knows which accounts are Responsables;
--   3. messages outside the network: a conversation held because the Pro did not accept messages is
--      delivered as soon as both Pros are in relation;
--   4. shipping: the orders must belong to the acting Pro (clear message instead of the generic guard); the
--      history says "(prévu)" for the planned vehicle and "(par défaut)" only for the default one;
--      changing an order's status also checks it belongs to the acting Pro;
--   5. trials: a space whose e-mail was confirmed after its creation starts its trial at the next check;
--   6. labels of the rights catalogue: "Alertes" became "Notifications";
--   7. a buyer's orders, returns and credit notes carry their supplier's details (PDF of the right supplier).
-- Run AFTER 20261128_plan_presets.sql. Safe to rerun.

-- ---------------------------------------------------------------------------
-- 1. Location
-- ---------------------------------------------------------------------------
create or replace function public.answer_location_request(p_request_id uuid, p_accept boolean,
  p_latitude double precision default null, p_longitude double precision default null, p_accuracy double precision default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.location_requests%rowtype;
begin
  select * into v_request from public.location_requests where id = p_request_id for update;
  if v_request.id is null or v_request.target_id is distinct from auth.uid() then
    raise exception using errcode = 'P0002', message = 'Demande introuvable.';
  end if;
  -- Already answered, shown automatically or expired: nothing more to do.
  if v_request.status <> 'pending' then
    return;
  end if;
  if p_accept and (p_latitude is null or p_longitude is null) then
    raise exception using errcode = '22023', message = 'Position indisponible : autorisez la localisation sur ce téléphone.';
  end if;
  update public.location_requests set
    status = case when p_accept then 'accepted' else 'refused' end, answered_at = now(),
    latitude = case when p_accept then p_latitude end, longitude = case when p_accept then p_longitude end,
    accuracy = case when p_accept then p_accuracy end, located_at = case when p_accept then now() end
  where id = p_request_id;
  if p_accept then
    insert into public.user_locations (user_id, latitude, longitude, accuracy, updated_at)
    values (auth.uid(), p_latitude, p_longitude, p_accuracy, now())
    on conflict (user_id) do update set latitude = excluded.latitude, longitude = excluded.longitude, accuracy = excluded.accuracy, updated_at = now();
  end if;
  perform public.notify(array[v_request.requester_id], 'location.answer',
    case when p_accept then 'Position partagée' else 'Position refusée' end,
    format('%s %s votre demande.', public.location_name(auth.uid()), case when p_accept then 'a accepté' else 'a refusé' end));
end;
$$;
REVOKE ALL ON FUNCTION public.answer_location_request(uuid, boolean, double precision, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.answer_location_request(uuid, boolean, double precision, double precision, double precision) TO authenticated;

create or replace function public.set_location_tracking(p_user_id uuid, p_allowed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
  v_count int;
begin
  if v_org is null or not (public.is_admin() or public.is_org_owner(v_org)) then
    raise exception using errcode = '42501', message = 'Seul l’administrateur règle le repérage.';
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set location_tracking = coalesce(p_allowed, false) where id = p_user_id and org_id = v_org;
  get diagnostics v_count = row_count;
  perform set_config('appro.link_write', 'off', true);
  if v_count = 0 then
    raise exception using errcode = 'P0002', message = 'Compte introuvable.';
  end if;
  perform public.notify(array[p_user_id], 'location.tracking', case when p_allowed then 'Repérage autorisé' else 'Repérage retiré' end,
    case when p_allowed then 'Votre administrateur peut voir votre dernière position si vous ne répondez pas à une demande dans la minute. Vous êtes prévenu à chaque consultation.'
         else 'Votre position ne sera plus montrée sans votre accord.' end);
end;
$$;
REVOKE ALL ON FUNCTION public.set_location_tracking(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_location_tracking(uuid, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Rights per account: the Responsable is set by Appro+ only
-- ---------------------------------------------------------------------------
create or replace function public.member_is_owner(p_user_id uuid, p_org_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.member_roles mr join public.org_roles r on r.id = mr.role_id
    join public.role_templates t on t.id = r.template_id
    where mr.user_id = p_user_id and r.org_id = p_org_id and t.key in ('supplier_owner', 'buyer_owner'));
$$;
REVOKE ALL ON FUNCTION public.member_is_owner(uuid, uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.org_members_rights(p_org_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(p_org_id, public.current_org_id());
begin
  if v_org is null or not public.can_manage_org_roles(v_org, false) then
    raise exception using errcode = '42501', message = 'Réservé aux personnes qui gèrent les rôles de ce Pro et à l’équipe Appro+.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', pr.id, 'name', coalesce(nullif(btrim(pr.full_name), ''), u.email), 'email', u.email, 'status', pr.account_status,
      'side', case when pr.role = 'customer' then 'buyer' else 'supplier' end,
      'owner', public.member_is_owner(pr.id, v_org), 'is_self', pr.id = auth.uid(),
      'granted', (select coalesce(jsonb_agg(p.key order by p.key), '[]'::jsonb) from public.permissions p where public.user_has_permission(pr.id, p.key)),
      'overrides', (select coalesce(jsonb_object_agg(mo.permission, mo.allowed), '{}'::jsonb) from public.member_overrides mo where mo.user_id = pr.id and mo.org_id = v_org))
    order by pr.full_name, u.email)
    from public.profiles pr left join auth.users u on u.id = pr.id
    where pr.org_id = v_org and pr.role <> 'platform' and pr.deleted_at is null), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.org_members_rights(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_members_rights(uuid) TO authenticated;

create or replace function public.org_set_member_permission(p_user_id uuid, p_permission text, p_allowed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.profiles%rowtype;
  v_side text;
  v_platform boolean := public.platform_can('platform.pros.manage');
begin
  select * into v_member from public.profiles where id = p_user_id;
  if v_member.id is null or v_member.org_id is null or not public.can_manage_org_roles(v_member.org_id, true) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas modifier les droits de cette personne.';
  end if;
  v_side := case when v_member.role = 'customer' then 'buyer' else 'supplier' end;
  if not exists (select 1 from public.permissions p where p.key = p_permission and p.side = v_side) then
    raise exception using errcode = '22023', message = 'Ce droit ne concerne pas cette personne.';
  end if;
  if p_user_id = auth.uid() and not v_platform then
    raise exception using errcode = '22023', message = 'Vos propres droits sont réglés par une autre personne.';
  end if;
  if not v_platform and public.member_is_owner(p_user_id, v_member.org_id) then
    raise exception using errcode = '42501', message = 'Les droits du Responsable sont réglés par Appro+.';
  end if;
  if not v_platform and coalesce(p_allowed, false) then
    if not public.org_owner_ceiling(v_member.org_id, v_side, p_permission) then
      raise exception using errcode = '42501', message = 'Ce droit dépasse ce qu’Appro+ a ouvert à votre Pro.';
    end if;
    if not (public.is_admin() or public.is_org_owner(v_member.org_id)) and not public.has_feature(p_permission) then
      raise exception using errcode = '42501', message = 'Vous ne pouvez pas donner un droit que vous n’avez pas.';
    end if;
  end if;
  delete from public.member_overrides where user_id = p_user_id and org_id = v_member.org_id and permission = p_permission;
  if p_allowed is not null then
    insert into public.member_overrides (user_id, org_id, permission, allowed) values (p_user_id, v_member.org_id, p_permission, p_allowed);
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.org_set_member_permission(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_set_member_permission(uuid, text, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Held conversations are delivered once both Pros are in relation
-- ---------------------------------------------------------------------------
create or replace function public.org_inbox()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null then
    raise exception using errcode = '42501', message = 'Réservé aux espaces actifs.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'conversation_id', x.id, 'org_id', x.other_id, 'name', x.name, 'kind', x.kind, 'last_at', x.last_at, 'held', x.held_now,
      'last_body', (select m.body from public.org_messages m where m.conversation_id = x.id order by m.created_at desc limit 1),
      'unread', (select count(*) from public.org_messages m where m.conversation_id = x.id and m.sender_org_id <> v_org and m.read_at is null),
      'related', x.related) order by x.last_at desc)
    from (
      select cv.id, cv.last_at, cv.started_by, o.id as other_id, o.name, o.kind, public.org_related(v_org, o.id) as related,
        cv.held and not public.org_related(v_org, o.id) as held_now
      from public.org_conversations cv
      join public.organizations o on o.id = case when cv.org_a = v_org then cv.org_b else cv.org_a end
      where v_org in (cv.org_a, cv.org_b)) x
    where not (x.held_now and x.started_by is distinct from v_org)), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.org_inbox() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_inbox() TO authenticated;

create or replace function public.org_send(p_org_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
  v_other public.organizations%rowtype;
  v_cv public.org_conversations%rowtype;
  v_a uuid;
  v_b uuid;
  v_related boolean;
begin
  if v_org is null then
    raise exception using errcode = '42501', message = 'Votre espace doit être actif pour écrire.';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 4000 then
    raise exception using errcode = '22023', message = 'Écrivez votre message (4000 caractères maximum).';
  end if;
  select * into v_other from public.organizations where id = p_org_id and status = 'active';
  if v_other.id is null or v_other.id = v_org then
    raise exception using errcode = 'P0002', message = 'Ce Pro n’est pas disponible.';
  end if;
  v_related := public.org_related(v_org, v_other.id);
  v_a := least(v_org, v_other.id);
  v_b := greatest(v_org, v_other.id);
  select * into v_cv from public.org_conversations cv where cv.org_a = v_a and cv.org_b = v_b;
  if v_cv.id is null then
    -- Closed to messages from outside its network: the conversation waits until it opens them.
    insert into public.org_conversations (org_a, org_b, started_by, held)
    values (v_a, v_b, v_org, not v_other.open_to_messages and not v_related)
    returning * into v_cv;
  elsif v_cv.held and (v_cv.started_by is distinct from v_org or v_related or v_other.open_to_messages) then
    -- The other Pro answers, the Pros are now in relation, or it opened its messages: delivered.
    update public.org_conversations set held = false where id = v_cv.id returning * into v_cv;
  end if;
  insert into public.org_messages (conversation_id, sender_org_id, sender_id, body) values (v_cv.id, v_org, auth.uid(), btrim(p_body));
  update public.org_conversations set last_at = now() where id = v_cv.id;
  if not v_cv.held then
    perform public.notify(array(select mr.user_id from public.member_roles mr join public.org_roles r on r.id = mr.role_id
        join public.role_templates t on t.id = r.template_id where r.org_id = v_other.id and t.key in ('supplier_owner', 'buyer_owner')),
      'org.message', format('Message de %s', (select o.name from public.organizations o where o.id = v_org)), left(btrim(p_body), 140));
  end if;
  return v_cv.id;
end;
$$;
REVOKE ALL ON FUNCTION public.org_send(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_send(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Shipping and status changes within the acting Pro
-- ---------------------------------------------------------------------------
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
  if exists (select 1 from public.orders o where o.id = any(p_order_ids) and o.supplier_org_id is distinct from v_org) then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  if v_vehicle_id is null then
    -- No choice: the vehicle planned for all these orders, else the default one of the fleet (if any).
    select case when count(distinct o.planned_vehicle_id) = 1 and bool_and(o.planned_vehicle_id is not null) then (array_agg(o.planned_vehicle_id))[1] end
    into v_vehicle_id from public.orders o where o.id = any(p_order_ids);
    if v_vehicle_id is not null and not exists (select 1 from public.vehicles v where v.id = v_vehicle_id and v.active and v.org_id = v_org) then
      v_vehicle_id := null;
    end if;
    if v_vehicle_id is not null then
      v_auto := ' (prévu)';
    else
      v_vehicle_id := public.default_vehicle_for(v_org);
      if v_vehicle_id is not null then
        v_auto := ' (par défaut)';
      end if;
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

-- ---------------------------------------------------------------------------
-- 5. Trials: closed when over, and started for spaces whose e-mail was confirmed after their creation
-- ---------------------------------------------------------------------------
create or replace function public.expire_trials()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_pending record;
begin
  -- Spaces still waiting because the e-mail was not confirmed yet (created in the last 7 days, never in trial).
  for v_pending in
    select o.id, exists (select 1 from public.profiles pr join public.invitation_acceptances a on a.user_id = pr.id where pr.org_id = o.id) as invited
    from public.organizations o
    where o.status = 'pending' and o.trial_until is null and o.created_at > now() - interval '7 days'
      and exists (select 1 from public.profiles pr where pr.org_id = o.id and public.email_confirmed(pr.id))
    limit 50
  loop
    perform public.start_trial(v_pending.id, v_pending.invited);
  end loop;

  with expired as (
    update public.organizations set status = 'suspended', updated_at = now()
    where trial_until is not null and trial_until < now() and status = 'active'
    returning id)
  select array_agg(id) into v_ids from expired;
  if v_ids is null then
    return 0;
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set account_status = 'suspended', trial_suspended = true
  where org_id = any(v_ids) and account_status = 'active' and role <> 'platform';
  perform set_config('appro.link_write', 'off', true);
  return cardinality(v_ids);
end;
$$;
REVOKE ALL ON FUNCTION public.expire_trials() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expire_trials() TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Labels: "Alertes" → "Notifications"
-- ---------------------------------------------------------------------------
update public.permissions set area = 'Accueil et notifications' where area = 'Accueil et alertes';
update public.permissions set label = 'Onglet Notifications' where key = 'alerts.view' and label in ('Onglet Alertes', 'Alertes');
update public.permissions set label = 'Notifications' where key = 'client.alerts' and label in ('Alertes', 'Onglet Alertes');

-- ---------------------------------------------------------------------------
-- 7. A buyer with several suppliers: each order, return and credit note carries its supplier's details, so its
--    PDF shows that supplier (not the one selected in the app).
-- ---------------------------------------------------------------------------
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
          from public.order_status_history h where h.order_id = o.id), '[]'::jsonb)) as o
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

create or replace function public.buyer_returns()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'return_number', r.return_number, 'client_id', r.client_id, 'order_id', r.order_id, 'status', r.status, 'reason', r.reason,
      'description', r.description, 'staff_note', r.staff_note, 'restocked', r.restocked, 'created_at', r.created_at, 'received_at', r.received_at,
      'supplier_name', s.name, 'seller', public.seller_card(s.id),
      'return_items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'product_id', i.product_id, 'product_name', i.product_name, 'unit', i.unit,
          'quantity', i.quantity, 'unit_price', i.unit_price, 'vat_rate', i.vat_rate)) from public.return_items i where i.return_id = r.id), '[]'::jsonb),
      'clients', jsonb_build_object('business_name', c.business_name),
      'orders', (select jsonb_build_object('order_number', o.order_number, 'delivery_note_number', o.delivery_note_number) from public.orders o where o.id = r.order_id),
      'credit_notes', coalesce((select jsonb_agg(jsonb_build_object('id', cn.id, 'credit_number', cn.credit_number, 'status', cn.status))
          from public.credit_notes cn where cn.return_id = r.id and cn.status <> 'draft'), '[]'::jsonb))
    order by r.created_at desc), '[]'::jsonb)
  from public.buyer_relations('client.returns') c
  join public.organizations s on s.id = c.supplier_org_id
  join public.returns r on r.client_id = c.id;
$$;
REVOKE ALL ON FUNCTION public.buyer_returns() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_returns() TO authenticated;

create or replace function public.buyer_credit_notes()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', cn.id, 'credit_number', cn.credit_number, 'client_id', cn.client_id, 'return_id', cn.return_id, 'invoice_id', cn.invoice_id,
      'status', cn.status, 'reason', cn.reason, 'client_snapshot', cn.client_snapshot, 'total_ht', cn.total_ht, 'total_vat', cn.total_vat,
      'total_ttc', cn.total_ttc, 'created_at', cn.created_at, 'issued_at', cn.issued_at, 'settled_at', cn.settled_at, 'supplier_name', s.name, 'seller', public.seller_card(s.id),
      'credit_note_items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'label', i.label, 'quantity', i.quantity, 'unit', i.unit,
          'unit_price', i.unit_price, 'vat_rate', i.vat_rate)) from public.credit_note_items i where i.credit_note_id = cn.id), '[]'::jsonb),
      'clients', jsonb_build_object('business_name', c.business_name, 'client_number', c.client_number),
      'client_invoices', (select jsonb_build_object('invoice_number', i.invoice_number) from public.client_invoices i where i.id = cn.invoice_id))
    order by cn.created_at desc), '[]'::jsonb)
  from (select distinct x.* from (select * from public.buyer_relations('client.invoices') union all select * from public.buyer_relations('client.returns')) x) c
  join public.organizations s on s.id = c.supplier_org_id
  join public.credit_notes cn on cn.client_id = c.id and cn.status <> 'draft';
$$;
REVOKE ALL ON FUNCTION public.buyer_credit_notes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_credit_notes() TO authenticated;

notify pgrst, 'reload schema';
