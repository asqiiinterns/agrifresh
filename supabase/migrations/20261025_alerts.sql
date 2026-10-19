-- Alerts: in-app notifications, push notifications (lock screen) and optional e-mails.
-- Run in Supabase SQL Editor AFTER 20261024_account_status.sql. Safe to rerun.
--
-- Business events create rows in public.notifications for the people concerned. Each new row
-- is delivered, if enabled for its event (Admin → Alertes et e-mails) and for the person
-- (Compte → Notifications), as an Expo push notification and/or an e-mail (Resend), sent from
-- the database with pg_net. The Resend API key lives in Supabase Vault, never in the app.

create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

create table if not exists public.notification_settings (
  event text primary key,
  label text not null,
  audience text not null,
  push_enabled boolean not null default true,
  email_enabled boolean not null default false,
  sort_order int not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.notification_settings (event, label, audience, push_enabled, email_enabled, sort_order) values
  ('order.new', 'Nouvelle commande', 'Équipe', true, false, 1),
  ('order.status', 'Changement de statut d’une commande', 'Client', true, false, 2),
  ('order.reconfirm', 'Commande à reconfirmer', 'Client', true, true, 3),
  ('claim.new', 'Nouvelle réclamation', 'Équipe', true, false, 4),
  ('claim.answered', 'Réponse à une réclamation', 'Client', true, true, 5),
  ('message.new', 'Nouveau message', 'Équipe et client', true, false, 6),
  ('invoice.issued', 'Facture émise', 'Client', true, true, 7),
  ('account.pending', 'Compte à valider', 'Administrateurs', true, true, 8)
on conflict (event) do nothing;

create table if not exists public.app_settings (
  id int primary key default 1 check (id = 1),
  email_enabled boolean not null default false,
  email_from text not null default 'AgriFresh <onboarding@resend.dev>',
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

alter table public.notification_settings enable row level security;
alter table public.app_settings enable row level security;
GRANT SELECT ON public.notification_settings, public.app_settings TO authenticated;
drop policy if exists "notification_settings_read" on public.notification_settings;
create policy "notification_settings_read" on public.notification_settings for select to authenticated using (true);
drop policy if exists "app_settings_read_admin" on public.app_settings;
create policy "app_settings_read_admin" on public.app_settings for select to authenticated using ((select public.is_admin()));

alter table public.profiles add column if not exists notify_push boolean not null default true;
alter table public.profiles add column if not exists notify_email boolean not null default true;

-- ---------------------------------------------------------------------------
-- Notifications and push tokens
-- ---------------------------------------------------------------------------

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  event text not null,
  title text not null,
  body text not null default '',
  order_id uuid references public.orders(id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications(user_id, created_at desc);
alter table public.notifications enable row level security;
GRANT SELECT ON public.notifications TO authenticated;
drop policy if exists "notifications_read_own" on public.notifications;
create policy "notifications_read_own" on public.notifications
  for select to authenticated using (user_id = (select public.active_uid()));

create table if not exists public.push_tokens (
  token text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null default 'android',
  updated_at timestamptz not null default now()
);
alter table public.push_tokens enable row level security;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications';
  END IF;
END;
$$;

create or replace function public.register_push_token(p_token text, p_platform text default 'android')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.active_uid() is null then
    raise exception using errcode = '42501', message = 'Compte inactif.';
  end if;
  if coalesce(p_token, '') !~ '^Expo(nent)?PushToken\[.+\]$' then
    raise exception using errcode = '22023', message = 'Jeton de notification invalide.';
  end if;
  insert into public.push_tokens (token, user_id, platform, updated_at)
  values (p_token, auth.uid(), coalesce(p_platform, 'android'), now())
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, updated_at = now();
end;
$$;
REVOKE ALL ON FUNCTION public.register_push_token(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_push_token(text, text) TO authenticated;

create or replace function public.unregister_push_token(p_token text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.push_tokens where token = p_token and user_id = (select auth.uid());
$$;
REVOKE ALL ON FUNCTION public.unregister_push_token(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unregister_push_token(text) TO authenticated;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.notifications set read_at = now()
  where user_id = (select public.active_uid()) and read_at is null and (p_ids is null or id = any(p_ids));
$$;
REVOKE ALL ON FUNCTION public.mark_notifications_read(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]) TO authenticated;

create or replace function public.set_my_notification_prefs(p_push boolean, p_email boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.profiles set notify_push = p_push, notify_email = p_email where id = (select auth.uid());
$$;
REVOKE ALL ON FUNCTION public.set_my_notification_prefs(boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_notification_prefs(boolean, boolean) TO authenticated;

create or replace function public.my_notification_prefs()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('push', pr.notify_push, 'email', pr.notify_email)
  from public.profiles pr where pr.id = (select auth.uid());
$$;
REVOKE ALL ON FUNCTION public.my_notification_prefs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_notification_prefs() TO authenticated;

-- ---------------------------------------------------------------------------
-- Admin settings
-- ---------------------------------------------------------------------------

create or replace function public.admin_set_notification_setting(p_event text, p_push boolean, p_email boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  update public.notification_settings set push_enabled = p_push, email_enabled = p_email, updated_at = now() where event = p_event;
  if not found then
    raise exception using errcode = 'P0002', message = 'Type d’alerte inconnu.';
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.admin_set_notification_setting(text, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_notification_setting(text, boolean, boolean) TO authenticated;

create or replace function public.admin_set_email_settings(p_enabled boolean, p_from text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if coalesce(btrim(p_from), '') = '' then
    raise exception using errcode = '22023', message = 'Indiquez l’adresse d’expédition.';
  end if;
  update public.app_settings set email_enabled = p_enabled, email_from = btrim(p_from), updated_at = now() where id = 1;
end;
$$;
REVOKE ALL ON FUNCTION public.admin_set_email_settings(boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_email_settings(boolean, text) TO authenticated;

-- The Resend key is written to Vault and can never be read back through the API.
create or replace function public.admin_set_email_api_key(p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if coalesce(btrim(p_key), '') = '' then
    raise exception using errcode = '22023', message = 'Collez la clé API du service d’e-mails.';
  end if;
  select s.id into v_id from vault.secrets s where s.name = 'resend_api_key';
  if v_id is null then
    perform vault.create_secret(btrim(p_key), 'resend_api_key', 'Clé API Resend pour les e-mails AgriFresh');
  else
    perform vault.update_secret(v_id, btrim(p_key));
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.admin_set_email_api_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_email_api_key(text) TO authenticated;

create or replace function public.admin_email_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  return (select jsonb_build_object(
    'enabled', a.email_enabled,
    'from', a.email_from,
    'has_key', exists (select 1 from vault.secrets s where s.name = 'resend_api_key')
  ) from public.app_settings a where a.id = 1);
end;
$$;
REVOKE ALL ON FUNCTION public.admin_email_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_email_status() TO authenticated;

-- ---------------------------------------------------------------------------
-- Delivery: push (Expo) and e-mail (Resend) through pg_net, never blocking the event
-- ---------------------------------------------------------------------------

create or replace function public.send_email(p_to text, p_subject text, p_text text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
      'text', p_text || E'\n\n— AgriFresh\nVous recevez cet e-mail car les alertes par e-mail sont activées sur votre compte (Compte → Notifications).'
    ),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key)
  );
end;
$$;
REVOKE ALL ON FUNCTION public.send_email(text, text, text) FROM PUBLIC, anon, authenticated;

create or replace function public.admin_send_test_email(p_to text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if not exists (select 1 from vault.secrets s where s.name = 'resend_api_key') then
    raise exception using errcode = '22023', message = 'Enregistrez d’abord la clé API.';
  end if;
  if not (select a.email_enabled from public.app_settings a where a.id = 1) then
    raise exception using errcode = '22023', message = 'Activez d’abord l’envoi d’e-mails.';
  end if;
  perform public.send_email(p_to, 'Test AgriFresh', 'Les e-mails AgriFresh sont bien configurés.');
end;
$$;
REVOKE ALL ON FUNCTION public.admin_send_test_email(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_send_test_email(text) TO authenticated;

create or replace function public.deliver_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_setting public.notification_settings%rowtype;
  v_profile public.profiles%rowtype;
  v_messages jsonb;
  v_email text;
begin
  select s.* into v_setting from public.notification_settings s where s.event = new.event;
  select p.* into v_profile from public.profiles p where p.id = new.user_id;
  begin
    if coalesce(v_setting.push_enabled, true) and v_profile.notify_push then
      select jsonb_agg(jsonb_build_object(
        'to', t.token, 'title', new.title, 'body', new.body, 'sound', 'default', 'priority', 'high',
        'channelId', 'alerts', 'data', jsonb_build_object('event', new.event, 'order_id', new.order_id, 'id', new.id)
      )) into v_messages
      from public.push_tokens t where t.user_id = new.user_id;
      if v_messages is not null then
        perform net.http_post(
          url := 'https://exp.host/--/api/v2/push/send',
          body := v_messages,
          headers := jsonb_build_object('Content-Type', 'application/json', 'Accept', 'application/json')
        );
      end if;
    end if;
    if coalesce(v_setting.email_enabled, false) and v_profile.notify_email then
      select u.email into v_email from auth.users u where u.id = new.user_id;
      perform public.send_email(v_email, new.title, new.body);
    end if;
  exception when others then
    -- Delivery problems never block the business event; the alert stays in the app.
    raise warning 'AgriFresh notification delivery failed: %', sqlerrm;
  end;
  return new;
end;
$$;
REVOKE ALL ON FUNCTION public.deliver_notification() FROM PUBLIC, anon, authenticated;

drop trigger if exists notifications_deliver on public.notifications;
create trigger notifications_deliver after insert on public.notifications
  for each row execute procedure public.deliver_notification();

-- ---------------------------------------------------------------------------
-- Who is notified
-- ---------------------------------------------------------------------------

-- Active team members having a feature (admins have all of them).
create or replace function public.team_with_feature(p_feature text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pr.id from public.profiles pr
  where pr.account_status = 'active' and pr.role <> 'customer'
    and (pr.role = 'admin' or exists (
      select 1 from public.role_permissions rp
      where rp.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role
        and rp.feature = p_feature and rp.allowed
    ));
$$;
REVOKE ALL ON FUNCTION public.team_with_feature(text) FROM PUBLIC, anon, authenticated;

create or replace function public.notify(p_users uuid[], p_event text, p_title text, p_body text, p_order_id uuid default null)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (user_id, event, title, body, order_id)
  select distinct u, p_event, p_title, coalesce(p_body, ''), p_order_id
  from unnest(p_users) as u
  where u is not null;
$$;
REVOKE ALL ON FUNCTION public.notify(uuid[], text, text, text, uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.order_status_words(p_status public.order_status)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'pending' then 'reçue' when 'on_hold' then 'mise en attente' when 'confirmed' then 'acceptée'
    when 'declined' then 'déclinée' when 'awaiting_client' then 'à reconfirmer' when 'preparing' then 'en préparation'
    when 'ready' then 'préparée' when 'out_for_delivery' then 'expédiée' when 'delivered' then 'livrée'
    when 'cancelled' then 'annulée' else p_status::text end;
$$;

create or replace function public.alert_on_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client text;
begin
  select c.business_name into v_client from public.clients c where c.id = new.client_id;
  if tg_op = 'INSERT' then
    perform public.notify(array(select public.team_with_feature('orders.decide')), 'order.new',
      format('Nouvelle commande #%s', new.order_number),
      format('%s%s', coalesce(v_client, 'Client'), case when new.requested_delivery_date is not null then ' · livraison souhaitée le ' || to_char(new.requested_delivery_date, 'DD/MM') else '' end),
      new.id);
  elsif new.status is distinct from old.status and new.status <> 'pending' then
    perform public.notify(array[new.customer_id],
      case when new.status = 'awaiting_client' then 'order.reconfirm' else 'order.status' end,
      format('Commande #%s %s', new.order_number, public.order_status_words(new.status)),
      case when new.status = 'awaiting_client' then 'AgriFresh vous propose de la reconfirmer. ' else '' end || coalesce(new.status_note, ''),
      new.id);
  end if;
  return new;
end;
$$;
REVOKE ALL ON FUNCTION public.alert_on_order() FROM PUBLIC, anon, authenticated;
drop trigger if exists orders_alert on public.orders;
create trigger orders_alert after insert or update of status on public.orders
  for each row execute procedure public.alert_on_order();

create or replace function public.alert_on_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number bigint;
  v_client text;
begin
  select o.order_number into v_number from public.orders o where o.id = new.order_id;
  if tg_op = 'INSERT' then
    select c.business_name into v_client from public.clients c where c.id = new.client_id;
    perform public.notify(array(select public.team_with_feature('claims.manage')), 'claim.new',
      format('Réclamation sur la commande #%s', v_number), format('%s : %s', coalesce(v_client, 'Client'), left(new.description, 140)), new.order_id);
  elsif new.status in ('resolved', 'rejected') and old.status is distinct from new.status then
    perform public.notify(array[new.created_by], 'claim.answered',
      format('Réponse à votre réclamation (commande #%s)', v_number), coalesce(new.staff_response, ''), new.order_id);
  end if;
  return new;
end;
$$;
REVOKE ALL ON FUNCTION public.alert_on_claim() FROM PUBLIC, anon, authenticated;
drop trigger if exists claims_alert on public.claims;
create trigger claims_alert after insert or update of status on public.claims
  for each row execute procedure public.alert_on_claim();

create or replace function public.alert_on_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client text;
begin
  select c.business_name into v_client from public.clients c where c.id = new.client_id;
  if new.from_staff then
    perform public.notify(array(select pr.id from public.profiles pr where pr.client_id = new.client_id and pr.account_status = 'active'),
      'message.new', 'Nouveau message d’AgriFresh', left(new.body, 140));
  else
    perform public.notify(array(select public.team_with_feature('messages.manage')), 'message.new',
      format('Message de %s', coalesce(v_client, 'un client')), left(new.body, 140));
  end if;
  return new;
end;
$$;
REVOKE ALL ON FUNCTION public.alert_on_message() FROM PUBLIC, anon, authenticated;
drop trigger if exists messages_alert on public.messages;
create trigger messages_alert after insert on public.messages
  for each row execute procedure public.alert_on_message();

create or replace function public.alert_on_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'issued' and (tg_op = 'INSERT' or old.status = 'draft') then
    perform public.notify(array(select pr.id from public.profiles pr where pr.client_id = new.client_id and pr.account_status = 'active'),
      'invoice.issued', format('Facture %s disponible', new.invoice_number),
      format('Montant TTC : %s TND. Consultez-la dans l’onglet Factures.', to_char(new.total_ttc, 'FM999G999G990D000')));
  end if;
  return new;
end;
$$;
REVOKE ALL ON FUNCTION public.alert_on_invoice() FROM PUBLIC, anon, authenticated;
drop trigger if exists client_invoices_alert on public.client_invoices;
create trigger client_invoices_alert after insert or update of status on public.client_invoices
  for each row execute procedure public.alert_on_invoice();

create or replace function public.alert_on_new_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  if new.account_status = 'pending' then
    select u.email into v_email from auth.users u where u.id = new.id;
    perform public.notify(array(select pr.id from public.profiles pr where pr.role = 'admin' and pr.account_status = 'active'),
      'account.pending', 'Nouveau compte à valider', format('%s attend votre validation (Admin → Comptes).', coalesce(v_email, 'Un utilisateur')));
  end if;
  return new;
end;
$$;
REVOKE ALL ON FUNCTION public.alert_on_new_account() FROM PUBLIC, anon, authenticated;
drop trigger if exists profiles_alert_new on public.profiles;
create trigger profiles_alert_new after insert on public.profiles
  for each row execute procedure public.alert_on_new_account();
