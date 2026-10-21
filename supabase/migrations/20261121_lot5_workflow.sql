-- Lot 5 (1): order workflow.
--   * going back one step (préparation → acceptée…) for the roles allowed to ("Revenir sur une étape");
--   * client options: orders accepted automatically, delivered automatically N hours after shipping (N set by
--     the supplier), delivery note visible to the client;
--   * a right for the team to print delivery notes;
--   * the vehicle planned when the order is accepted; the driver may use another one: the change is traced
--     in the order history and the team is told ("condition forcée").
-- Run in Supabase SQL Editor AFTER 20261120_lot4.sql. Safe to rerun.

-- ---------------------------------------------------------------------------
-- 1. New rights
-- ---------------------------------------------------------------------------
insert into public.permissions (key, side, label) values
  ('orders.revert', 'supplier', 'Revenir sur une étape d’une commande'),
  ('orders.delivery_note', 'supplier', 'Imprimer les bons de livraison')
on conflict (key) do nothing;
-- Former roles: the delivery note stays with whoever saw the orders; going back is for supervisors.
insert into public.role_permissions (role, feature, allowed)
select rp.role, 'orders.delivery_note', rp.allowed from public.role_permissions rp where rp.feature = 'orders.view'
on conflict (role, feature) do nothing;
insert into public.role_permissions (role, feature, allowed)
select r::public.app_role, 'orders.revert', r = 'supervisor' from unnest(array['supervisor', 'production', 'driver', 'customer']) as r
on conflict (role, feature) do nothing;
-- Role templates: Responsable and Superviseur get both; every template that sees orders keeps the delivery note.
insert into public.role_template_permissions (template_id, permission)
select t.id, 'orders.revert' from public.role_templates t where t.key in ('supplier_owner', 'supplier_supervisor')
on conflict do nothing;
insert into public.role_template_permissions (template_id, permission)
select t.id, 'orders.delivery_note' from public.role_templates t
where t.key = 'supplier_owner' or exists (select 1 from public.role_template_permissions tp where tp.template_id = t.id and tp.permission = 'orders.view')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Client options (default per supplier, exception per client record) and the supplier's delay
-- ---------------------------------------------------------------------------
alter table public.clients add column if not exists auto_accept boolean not null default false;
alter table public.clients add column if not exists auto_deliver boolean not null default false;
alter table public.clients add column if not exists delivery_note_client boolean not null default true;
alter table public.organizations add column if not exists auto_deliver_hours int not null default 24 check (auto_deliver_hours between 1 and 720);
insert into public.client_setting_defaults (org_id, key, value)
select o.id, x.key, x.value from public.organizations o
cross join (values ('auto_accept', 'false'::jsonb), ('auto_deliver', 'false'::jsonb), ('delivery_note_client', 'true'::jsonb)) as x(key, value)
on conflict (org_id, key) do nothing;

DO $$
DECLARE
  v_def text := pg_get_functiondef('public.apply_client_defaults()'::regprocedure);
BEGIN
  IF v_def not like '%auto_accept%' THEN
    v_def := replace(v_def, E'''delivery_signature'', ''driver_prices'')', E'''delivery_signature'', ''driver_prices'', ''auto_accept'', ''auto_deliver'', ''delivery_note_client'')');
    v_def := replace(v_def, E'  new.feature_overrides := coalesce((',
      E'  if not (''auto_accept'' = any(k)) and d ? ''auto_accept'' then new.auto_accept := (d ->> ''auto_accept'')::boolean; end if;\n'
      || E'  if not (''auto_deliver'' = any(k)) and d ? ''auto_deliver'' then new.auto_deliver := (d ->> ''auto_deliver'')::boolean; end if;\n'
      || E'  if not (''delivery_note_client'' = any(k)) and d ? ''delivery_note_client'' then new.delivery_note_client := (d ->> ''delivery_note_client'')::boolean; end if;\n'
      || E'  new.feature_overrides := coalesce((');
    IF v_def not like '%new.auto_accept :=%' or v_def not like '%''delivery_note_client'')%' THEN
      RAISE EXCEPTION 'apply_client_defaults: text not found (run 20261120 first)';
    END IF;
    EXECUTE v_def;
  END IF;
  v_def := pg_get_functiondef('public.admin_set_client_default(text, jsonb)'::regprocedure);
  IF v_def not like '%auto_accept%' THEN
    v_def := replace(v_def, E'''delivery_signature'', ''driver_prices'') then', E'''delivery_signature'', ''driver_prices'', ''auto_accept'', ''auto_deliver'', ''delivery_note_client'') then');
    IF v_def not like '%auto_accept%' THEN
      RAISE EXCEPTION 'admin_set_client_default: text not found (run 20261120 first)';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$$;

-- What the buyer sees of each order (and of its account): may it print the delivery note?
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.buyer_orders()'::regprocedure);
BEGIN
  IF v_def not like '%delivery_note_client%' THEN
    v_def := replace(v_def, '''history_enabled'', c.history_enabled,', '''history_enabled'', c.history_enabled, ''delivery_note'', c.delivery_note_client,');
    IF v_def not like '%delivery_note_client%' THEN
      RAISE EXCEPTION 'buyer_orders: text not found';
    END IF;
    EXECUTE v_def;
  END IF;
  v_def := pg_get_functiondef('public.my_account()'::regprocedure);
  IF v_def not like '%delivery_note_client%' THEN
    v_def := replace(v_def, '''history_enabled'', c.history_enabled,', '''history_enabled'', c.history_enabled, ''delivery_note'', c.delivery_note_client,');
    IF v_def not like '%delivery_note_client%' THEN
      RAISE EXCEPTION 'my_account: text not found';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$$;

-- The supplier's delay before an order shipped is marked delivered (for clients with the option).
create or replace function public.set_auto_deliver_hours(p_hours int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() or public.current_org_id() is null then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if p_hours is null or p_hours not between 1 and 720 then
    raise exception using errcode = '22023', message = 'Délai invalide (1 à 720 heures).';
  end if;
  update public.organizations set auto_deliver_hours = p_hours, updated_at = now() where id = public.current_org_id();
end;
$$;
REVOKE ALL ON FUNCTION public.set_auto_deliver_hours(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_auto_deliver_hours(int) TO authenticated;

create or replace function public.my_workflow_settings()
returns jsonb language sql stable security definer set search_path = ''
as $$ select jsonb_build_object('auto_deliver_hours', o.auto_deliver_hours) from public.organizations o where o.id = public.current_org_id(); $$;
REVOKE ALL ON FUNCTION public.my_workflow_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_workflow_settings() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Accepted automatically (client option), right after the order is placed
-- ---------------------------------------------------------------------------
create or replace function public.auto_accept_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_client public.clients%rowtype;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  select c.* into v_client from public.clients c where c.id = v_order.client_id;
  if v_order.id is null or v_order.status <> 'pending' or not coalesce(v_client.auto_accept, false) then
    return false;
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.orders set status = 'confirmed', updated_at = now(),
    production_rank = coalesce(production_rank, (select coalesce(max(q.production_rank), 0) + 1 from public.orders q
      where q.supplier_org_id = v_order.supplier_org_id and q.status in ('confirmed', 'preparing', 'ready') and q.id <> p_order_id))
  where id = p_order_id;
  insert into public.order_status_history (order_id, status, note, changed_by, changed_by_name)
  values (p_order_id, 'confirmed', 'Acceptée automatiquement (option du client).', null, 'Acceptation automatique');
  if v_order.client_invoice_id is null and v_client.invoice_mode = 'auto' then
    perform public.create_client_invoice(v_order.client_id, array[p_order_id], null, false);
  end if;
  perform set_config('appro.link_write', 'off', true);
  return true;
end;
$$;
REVOKE ALL ON FUNCTION public.auto_accept_order(uuid) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_def text := pg_get_functiondef('public.create_client_order(uuid, uuid, uuid, jsonb, uuid, date, text, text)'::regprocedure);
BEGIN
  IF v_def not like '%auto_accept_order%' THEN
    v_def := replace(v_def, 'perform public.apply_order_pricing(v_order_id);',
      E'perform public.apply_order_pricing(v_order_id);\n  perform public.auto_accept_order(v_order_id);');
    v_def := replace(v_def, '''total'', (select o.total from public.orders o where o.id = v_order_id), ''status'', ''pending'');',
      '''total'', (select o.total from public.orders o where o.id = v_order_id), ''status'', (select o.status from public.orders o where o.id = v_order_id));');
    IF v_def not like '%auto_accept_order%' THEN
      RAISE EXCEPTION 'create_client_order: text not found (run 20261118 first)';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Delivered automatically N hours after shipping (client option, delay of the supplier).
--    Called when the app opens and every hour by pg_cron when it is installed.
-- ---------------------------------------------------------------------------
create or replace function public.auto_deliver_orders()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  perform set_config('appro.link_write', 'on', true);
  with due as (
    select o.id, s.auto_deliver_hours as hours
    from public.orders o
    join public.clients c on c.id = o.client_id and c.auto_deliver
    join public.organizations s on s.id = o.supplier_org_id
    where o.status = 'out_for_delivery'
      and coalesce((select max(h.created_at) from public.order_status_history h where h.order_id = o.id and h.status = 'out_for_delivery'), o.updated_at)
          < now() - make_interval(hours => s.auto_deliver_hours)
    for update of o skip locked),
  done as (
    update public.orders o set status = 'delivered', delivered_at = now(), updated_at = now()
    from due where o.id = due.id
    returning o.id, due.hours)
  insert into public.order_status_history (order_id, status, note, changed_by, changed_by_name)
  select d.id, 'delivered', format('Livrée automatiquement %s h après l’expédition (sans confirmation du livreur).', d.hours), null, 'Clôture automatique'
  from done d;
  get diagnostics v_count = row_count;
  perform set_config('appro.link_write', 'off', true);
  return v_count;
end;
$$;
REVOKE ALL ON FUNCTION public.auto_deliver_orders() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_deliver_orders() TO authenticated;
DO $$
BEGIN
  IF exists (select 1 from pg_extension where extname = 'pg_cron') THEN
    EXECUTE $cron$select cron.schedule('appro-auto-deliver', '17 * * * *', 'select public.auto_deliver_orders()')$cron$;
  END IF;
EXCEPTION WHEN others THEN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Going back one step, for the roles allowed to (traced in the order history)
-- ---------------------------------------------------------------------------
create or replace function public.staff_revert_order(p_order_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_previous public.order_status;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_invoice_status text;
  v_words text;
begin
  if not public.has_feature('orders.revert') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de revenir sur une étape.';
  end if;
  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if v_order.id is null or v_order.supplier_org_id is distinct from public.current_org_id() then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  v_previous := case v_order.status when 'confirmed' then 'pending' when 'preparing' then 'confirmed'
    when 'ready' then 'preparing' when 'out_for_delivery' then 'ready' end;
  if v_previous is null then
    raise exception using errcode = '22023', message = 'Cette commande ne peut pas revenir en arrière à son étape actuelle.';
  end if;
  -- Back to "à décider": the invoice made at acceptance goes away (a draft) or must be cancelled first.
  if v_previous = 'pending' and v_order.client_invoice_id is not null then
    select i.status into v_invoice_status from public.client_invoices i where i.id = v_order.client_invoice_id for update;
    if v_invoice_status = 'draft' then
      update public.orders set client_invoice_id = null where id = p_order_id;
      perform public.refresh_invoice_totals(v_order.client_invoice_id);
    elsif v_invoice_status in ('issued', 'paid') then
      raise exception using errcode = '22023', message = 'La facture de cette commande est déjà émise : annulez-la d’abord.';
    end if;
  end if;
  update public.orders set status = v_previous,
    shipment_id = case when v_order.status = 'out_for_delivery' then null else shipment_id end,
    production_rank = case when v_previous = 'pending' then null
      else coalesce(production_rank, (select coalesce(max(q.production_rank), 0) + 1 from public.orders q
        where q.supplier_org_id = v_order.supplier_org_id and q.status in ('confirmed', 'preparing', 'ready') and q.id <> p_order_id)) end,
    updated_at = now()
  where id = p_order_id;
  v_words := case v_previous when 'pending' then 'à décider' when 'confirmed' then 'acceptée' when 'preparing' then 'en préparation' else 'préparée' end;
  insert into public.order_status_history (order_id, status, note, changed_by)
  values (p_order_id, v_previous, format('Retour à l’étape « %s »%s', v_words, coalesce(' : ' || v_note, '.')), auth.uid());
  return jsonb_build_object('id', p_order_id, 'previous_status', v_order.status, 'status', v_previous);
end;
$$;
REVOKE ALL ON FUNCTION public.staff_revert_order(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_revert_order(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Vehicle planned at acceptance; the driver may take another one (traced, team told)
-- ---------------------------------------------------------------------------
alter table public.orders add column if not exists planned_vehicle_id uuid references public.vehicles(id) on delete set null;

create or replace function public.staff_plan_vehicle(p_order_id uuid, p_vehicle_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  if not (public.has_feature('orders.decide') or public.has_feature('orders.plan')) then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de planifier les livraisons.';
  end if;
  select o.* into v_order from public.orders o where o.id = p_order_id;
  if v_order.id is null or v_order.supplier_org_id is distinct from public.current_org_id() then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  if v_order.status not in ('pending', 'on_hold', 'confirmed', 'preparing', 'ready') then
    raise exception using errcode = '22023', message = 'Cette commande est déjà partie ou clôturée.';
  end if;
  if p_vehicle_id is not null and not exists (select 1 from public.vehicles v where v.id = p_vehicle_id and v.active and v.org_id = v_order.supplier_org_id) then
    raise exception using errcode = 'P0002', message = 'Véhicule introuvable ou retiré de la flotte.';
  end if;
  update public.orders set planned_vehicle_id = p_vehicle_id, updated_at = now() where id = p_order_id;
end;
$$;
REVOKE ALL ON FUNCTION public.staff_plan_vehicle(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_plan_vehicle(uuid, uuid) TO authenticated;

DO $$
DECLARE
  v_def text := pg_get_functiondef('public.driver_ship_orders(uuid[], uuid)'::regprocedure);
BEGIN
  IF v_def not like '%planned_vehicle_id%' THEN
    v_def := replace(v_def, '  return jsonb_build_object(''shipment_id'', v_shipment_id, ''shipment_number'', v_number, ''count'', v_count);',
      E'  -- A vehicle other than the one planned: traced on the order and the deciders are told.\n'
      || E'  update public.order_status_history h set note = h.note || format('' · véhicule prévu : %s, remplacé par le livreur'', pv.label)\n'
      || E'  from public.orders o join public.vehicles pv on pv.id = o.planned_vehicle_id\n'
      || E'  where h.order_id = o.id and o.id = any(p_order_ids) and h.status = ''out_for_delivery'' and h.created_at > now() - interval ''1 minute''\n'
      || E'    and o.planned_vehicle_id is distinct from p_vehicle_id;\n'
      || E'  perform public.notify(array(select public.team_with_feature(''orders.decide'', o.supplier_org_id)), ''order.forced'',\n'
      || E'    format(''Condition forcée · commande #%s'', o.order_number),\n'
      || E'    format(''Véhicule prévu : %s ; utilisé : %s.'', pv.label, coalesce(v_vehicle.label, ''aucun'')), o.id)\n'
      || E'  from public.orders o join public.vehicles pv on pv.id = o.planned_vehicle_id\n'
      || E'  where o.id = any(p_order_ids) and o.planned_vehicle_id is distinct from p_vehicle_id;\n'
      || E'  return jsonb_build_object(''shipment_id'', v_shipment_id, ''shipment_number'', v_number, ''count'', v_count);');
    IF v_def not like '%planned_vehicle_id%' THEN
      RAISE EXCEPTION 'driver_ship_orders: text not found';
    END IF;
    EXECUTE v_def;
  END IF;
  v_def := pg_get_functiondef('public.driver_pickups()'::regprocedure);
  IF v_def not like '%planned_vehicle_id%' THEN
    v_def := replace(v_def, '''order_number'', o.order_number,', '''order_number'', o.order_number, ''planned_vehicle_id'', o.planned_vehicle_id,');
    IF v_def not like '%planned_vehicle_id%' THEN
      RAISE EXCEPTION 'driver_pickups: text not found';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$$;

notify pgrst, 'reload schema';
