-- Wording: « alerte » becomes « notification » in the server messages too (errors, e-mail footer, journal).
-- Functions redefined whole from supabase/reference. Run AFTER 20261202_products.sql. Safe to rerun.

CREATE OR REPLACE FUNCTION public.admin_set_notification_setting(p_event text, p_push boolean, p_email boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_legacy_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  update public.notification_settings set push_enabled = p_push, email_enabled = p_email, updated_at = now() where event = p_event;
  if not found then
    raise exception using errcode = 'P0002', message = 'Type de notification inconnu.';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.audit_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_row jsonb;
  v_changes jsonb;
  v_actor uuid := auth.uid();
  v_name text;
  v_role text;
  v_label text;
  v_hidden text[] := array['updated_at', 'delivery_token', 'reception_token', 'qr_token', 'body', 'home_layout'];
begin
  v_row := coalesce(v_new, v_old);
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_array(v_old -> n.key, n.value)) into v_changes
    from jsonb_each(v_new) n
    where not (n.key = any(v_hidden)) and (v_old -> n.key) is distinct from n.value;
    if v_changes is null then
      return null;
    end if;
  else
    select jsonb_object_agg(e.key, e.value) into v_changes
    from jsonb_each(v_row) e
    where not (e.key = any(v_hidden)) and e.value <> 'null'::jsonb;
  end if;

  if v_actor is not null then
    select coalesce(nullif(btrim(pr.full_name), ''), u.email), pr.role::text into v_name, v_role
    from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = v_actor;
  end if;

  v_label := case tg_table_name
    when 'orders' then 'Commande #' || (v_row ->> 'order_number')
    when 'clients' then v_row ->> 'business_name'
    when 'client_delivery_points' then 'Point ' || (v_row ->> 'label') || coalesce(' · ' || (select c.business_name from public.clients c where c.id = (v_row ->> 'client_id')::uuid), '')
    when 'products' then v_row ->> 'name'
    when 'role_permissions' then 'Droit ' || (v_row ->> 'feature') || ' · rôle ' || (v_row ->> 'role')
    when 'user_permissions' then 'Droit ' || (v_row ->> 'feature') || ' · ' || coalesce((
      select coalesce(nullif(btrim(pr.full_name), ''), u.email) from public.profiles pr left join auth.users u on u.id = pr.id
      where pr.id = (v_row ->> 'user_id')::uuid), 'compte')
    when 'client_setting_defaults' then 'Option par défaut des clients · ' || (v_row ->> 'key')
    when 'profiles' then coalesce(nullif(btrim(v_row ->> 'full_name'), ''), (select u.email from auth.users u where u.id = (v_row ->> 'id')::uuid), 'Compte')
    when 'client_invoices' then coalesce('Facture ' || (v_row ->> 'invoice_number'), 'Facture (brouillon)')
    when 'claims' then 'Réclamation n° ' || (v_row ->> 'claim_number')
    when 'vehicles' then 'Véhicule ' || (v_row ->> 'label')
    when 'shipments' then 'Expédition #' || (v_row ->> 'shipment_number')
    when 'messages' then 'Message · ' || coalesce((select c.business_name from public.clients c where c.id = (v_row ->> 'client_id')::uuid), 'client')
    when 'notification_settings' then 'Notification · ' || (v_row ->> 'label')
    when 'app_settings' then 'Réglages e-mail'
    when 'home_layouts' then 'Accueil · rôle ' || (v_row ->> 'role')
    else tg_table_name
  end;

  insert into public.audit_log (actor_id, actor_name, actor_role, entity, entity_id, label, action, changes)
  values (
    v_actor,
    coalesce(v_name, case when v_actor is null then 'Système' else 'Compte supprimé' end),
    v_role,
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'key', v_row ->> 'event',
             concat_ws(':', v_row ->> 'role', v_row ->> 'user_id', v_row ->> 'feature')),
    v_label,
    lower(tg_op),
    v_changes
  );
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.send_email(p_to text, p_subject text, p_text text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_settings public.app_settings%rowtype;
  v_key text;
begin
  select a.* into v_settings from public.app_settings a where a.id = 1;
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'resend_api_key';
  if not v_settings.email_enabled or v_key is null or coalesce(p_to, '') = '' then
    return;
  end if;
  perform net.http_post(
    url := 'https://api.resend.com/emails',
    body := jsonb_build_object(
      'from', v_settings.email_from,
      'to', jsonb_build_array(p_to),
      'subject', p_subject,
      'text', p_text || E'\n\n— Appro+\nVous recevez cet e-mail car les notifications par e-mail sont activées sur votre compte (Compte → Notifications).'
    ),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_notification_important(p_id uuid, p_important boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.notifications set important = coalesce(p_important, false)
  where id = p_id and user_id = (select public.active_uid());
  if not found then
    raise exception using errcode = 'P0002', message = 'Notification introuvable.';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_notification_note(p_id uuid, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if char_length(coalesce(p_note, '')) > 1000 then
    raise exception using errcode = '22023', message = 'La note est limitée à 1000 caractères.';
  end if;
  update public.notifications set note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_id and user_id = (select public.active_uid());
  if not found then
    raise exception using errcode = 'P0002', message = 'Notification introuvable.';
  end if;
end;
$function$
;

notify pgrst, 'reload schema';
