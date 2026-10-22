-- Reception QR: the driver scans the delivery notes, then the QR shown in the client's app.
-- The buyer shows one reception QR to all its suppliers; it is now accepted also by a supplier set on the
-- wall QR of the delivery point (before, that supplier refused it and the hand-over was stuck).
-- Function redefined whole from supabase/reference. Run AFTER 20261203_wording.sql. Safe to rerun.

CREATE OR REPLACE FUNCTION public.driver_deliver(p_order_ids uuid[], p_delivery_tokens uuid[], p_client_qr_kind text DEFAULT NULL::text, p_client_qr_token uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_driver_id uuid := auth.uid();
  v_ids uuid[];
  v_unknown int;
  v_count int;
  v_matching int;
  v_clients int;
  v_points int;
  v_client_id uuid;
  v_point_id uuid;
  v_missing int;
  v_client public.clients%rowtype;
  v_proof text;
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs.';
  end if;
  select count(*) into v_unknown from unnest(coalesce(p_delivery_tokens, '{}'::uuid[])) as t(token)
  where not exists (select 1 from public.orders o where o.delivery_token = t.token);
  if v_unknown > 0 then
    raise exception using errcode = 'P0002', message = 'Bon de livraison inconnu.';
  end if;
  select array_agg(o.id order by o.id) into v_ids from public.orders o
  where o.id = any(coalesce(p_order_ids, '{}'::uuid[])) or o.delivery_token = any(coalesce(p_delivery_tokens, '{}'::uuid[]));
  if v_ids is null then
    raise exception using errcode = '22023', message = 'Sélectionnez ou scannez au moins une commande.';
  end if;

  perform 1 from public.orders o where o.id = any(v_ids) order by o.id for update;
  select count(*), count(*) filter (where o.status = 'out_for_delivery'), count(distinct o.client_id), count(distinct o.delivery_point_id),
         (array_agg(o.client_id))[1], (array_agg(o.delivery_point_id))[1]
  into v_count, v_matching, v_clients, v_points, v_client_id, v_point_id
  from public.orders o where o.id = any(v_ids);
  if v_matching <> v_count then
    raise exception using errcode = '22023', message = 'Une commande n’est pas (ou plus) en cours de livraison.';
  end if;
  if v_clients <> 1 then
    raise exception using errcode = '22023', message = 'Ces commandes concernent plusieurs clients : livrez-les séparément.';
  end if;

  select c.* into v_client from public.clients c where c.id = v_client_id;
  if (v_client.scan_delivery_note and public.module_enabled_for(v_client.supplier_org_id, 'delivery_qr')) then
    select count(*) into v_missing from public.orders o
    where o.id = any(v_ids) and not (o.delivery_token = any(coalesce(p_delivery_tokens, '{}'::uuid[])));
    if v_missing > 0 then
      raise exception using errcode = '22023', message = 'Scannez le bon de livraison de chaque commande (exigé pour ce client).';
    end if;
  end if;
  if (v_client.scan_client_qr and public.module_enabled_for(v_client.supplier_org_id, 'delivery_qr')) then
    if (v_client.reception_qr and public.module_enabled_for(v_client.supplier_org_id, 'delivery_qr')) then
      if p_client_qr_kind is distinct from 'client' or (p_client_qr_token is distinct from v_client.reception_token /* buyer reception QR */
        and p_client_qr_token is distinct from (select b.reception_token from public.organizations b where b.id = v_client.buyer_org_id)) then
        raise exception using errcode = '22023', message = 'QR client invalide : demandez au client d’afficher son QR de réception dans l’application Appro+.';
      end if;
    elsif p_client_qr_kind = 'client' then
      -- 20261204: the client's reception QR is also accepted where the wall QR is asked (stronger proof: the client confirms).
      if p_client_qr_token is distinct from v_client.reception_token
        and p_client_qr_token is distinct from (select b.reception_token from public.organizations b where b.id = v_client.buyer_org_id) then
        raise exception using errcode = '22023', message = 'Ce QR de réception n’est pas celui de ce client.';
      end if;
    else
      if v_points <> 1 then
        raise exception using errcode = '22023', message = 'Ces commandes concernent plusieurs points de livraison : livrez-les séparément.';
      end if;
      if p_client_qr_kind is distinct from 'point' or not exists (
        select 1 from public.client_delivery_points dp where dp.id = v_point_id and dp.qr_token = p_client_qr_token
      ) then
        raise exception using errcode = '22023', message = 'Le QR scanné ne correspond pas au point de livraison de ces commandes.';
      end if;
    end if;
  end if;

  v_proof := concat_ws(' + ',
    case when (v_client.scan_delivery_note and public.module_enabled_for(v_client.supplier_org_id, 'delivery_qr')) then 'bon de livraison scanné' else 'sans scan du bon' end,
    case when not (v_client.scan_client_qr and public.module_enabled_for(v_client.supplier_org_id, 'delivery_qr')) then 'sans QR client'
         when (v_client.reception_qr and public.module_enabled_for(v_client.supplier_org_id, 'delivery_qr')) or p_client_qr_kind = 'client' then 'QR de réception du client'
         else 'QR du point de livraison' end);

  update public.orders
  set status = 'delivered', delivered_at = now(), delivered_by = v_driver_id, updated_at = now()
  where id = any(v_ids);
  insert into public.order_status_history (order_id, status, note, changed_by)
  select o.id, 'delivered', 'Livraison confirmée : ' || v_proof || '.', v_driver_id
  from public.orders o where o.id = any(v_ids);
  update public.payments p set status = 'paid'
  from public.orders o
  where o.id = any(v_ids) and p.order_id = o.id and p.method = 'cash_on_delivery' and p.status = 'pending';
  return v_count;
end;
$function$
;

notify pgrst, 'reload schema';
