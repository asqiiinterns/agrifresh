-- Reference: the definition of every function of the public schema once ALL migrations up to 20261123 are installed
-- (generated from the test database, 322 functions). Read-only: do not run it. New migrations copy a function from here
-- and redefine it whole (create or replace … with the full body) instead of patching its text with replace().

-- ===== accept_invitation
CREATE OR REPLACE FUNCTION public.accept_invitation(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_inv public.invitations%rowtype;
  v_me public.profiles%rowtype;
  v_linked boolean;
begin
  select * into v_me from public.profiles where id = auth.uid();
  if v_me.id is null then
    raise exception using errcode = '28000', message = 'Connectez-vous pour accepter l’invitation.';
  end if;
  select * into v_inv from public.invitations where code = upper(btrim(coalesce(p_code, '')));
  if v_inv.id is null or v_inv.expires_at < now() then
    raise exception using errcode = 'P0002', message = 'Invitation inconnue ou expirée : demandez un nouveau lien.';
  end if;
  if v_inv.org_id = v_me.org_id then
    raise exception using errcode = '22023', message = 'Cette invitation vient de votre propre espace.';
  end if;
  if v_me.role = 'platform' then
    raise exception using errcode = '22023', message = 'Un compte Appro+ ne peut pas accepter d’invitation.';
  end if;
  if not exists (select 1 from public.invitation_acceptances a where a.invitation_id = v_inv.id and a.user_id = v_me.id) then
    insert into public.invitation_acceptances (invitation_id, user_id) values (v_inv.id, v_me.id);
    update public.invitations set uses = uses + 1 where id = v_inv.id;
  end if;
  v_linked := public.invitation_link(v_inv.id, v_me.id);
  return jsonb_build_object('linked', v_linked, 'org_name', (select o.name from public.organizations o where o.id = v_inv.org_id), 'side', v_inv.side,
    'needs_space', not v_linked and (select pr.org_id from public.profiles pr where pr.id = v_me.id) is null);
end;
$function$
;

-- ===== account_figures
CREATE OR REPLACE FUNCTION public.account_figures(p_client_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'outstanding', coalesce((select sum(i.total_ttc - i.amount_paid) from public.client_invoices i
                             where i.client_id = p_client_id and i.status = 'issued'), 0),
    'deposits', coalesce((select sum(case when e.kind = 'deposit' then e.amount else -e.amount end) from public.account_entries e where e.client_id = p_client_id), 0)
              - coalesce((select sum(p.amount) from public.invoice_payments p join public.client_invoices i on i.id = p.invoice_id
                          where i.client_id = p_client_id and p.method = 'deposit'), 0),
    'credit_limit', (select c.credit_limit from public.clients c where c.id = p_client_id));
$function$
;

-- ===== account_statement
CREATE OR REPLACE FUNCTION public.account_statement(p_client_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== acting_or_legacy_org_id
CREATE OR REPLACE FUNCTION public.acting_or_legacy_org_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(public.acting_supplier_org_id(), public.legacy_org_id()); $function$
;

-- ===== acting_supplier_org_id
CREATE OR REPLACE FUNCTION public.acting_supplier_org_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select o.id
  from public.profiles pr
  join public.organizations o on o.id = case
    when pr.role = 'customer' then (select c.supplier_org_id from public.clients c where c.id = pr.client_id)
    when pr.role = 'platform' then null
    else pr.org_id end
  where pr.id = (select auth.uid()) and pr.account_status = 'active' and o.status = 'active'
    and (pr.role <> 'customer' or exists (select 1 from public.organizations b where b.id = pr.org_id and b.status = 'active'));
$function$
;

-- ===== active_uid
CREATE OR REPLACE FUNCTION public.active_uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pr.id from public.profiles pr where pr.id = (select auth.uid()) and pr.account_status = 'active';
$function$
;

-- ===== admin_confirm_account
CREATE OR REPLACE FUNCTION public.admin_confirm_account(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = p_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Compte introuvable.';
  end if;
end;
$function$
;

-- ===== admin_email_status
CREATE OR REPLACE FUNCTION public.admin_email_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_legacy_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  return (select jsonb_build_object(
    'enabled', a.email_enabled,
    'from', a.email_from,
    'has_key', exists (select 1 from vault.secrets s where s.name = 'resend_api_key')
  ) from public.app_settings a where a.id = 1);
end;
$function$
;

-- ===== admin_list_accounts
CREATE OR REPLACE FUNCTION public.admin_list_accounts()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', u.id,
      'email', u.email,
      'full_name', coalesce(pr.full_name, ''),
      'role', coalesce(pr.role::text, 'customer'),
      'status', coalesce(pr.account_status, 'pending'),
      'created_at', u.created_at,
      'last_sign_in_at', u.last_sign_in_at,
      'client_name', c.business_name,
      'is_self', u.id = auth.uid()
    ) order by (coalesce(pr.account_status, 'pending') = 'pending') desc, u.created_at desc)
    from auth.users u
    left join public.profiles pr on pr.id = u.id
    left join public.clients c on c.id = pr.client_id
    where coalesce(pr.role::text, 'customer') <> 'platform'
      and (public.org_visible(pr.org_id))
  ), '[]'::jsonb);
end;
$function$
;

-- ===== admin_list_team
CREATE OR REPLACE FUNCTION public.admin_list_team()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', pr.id, 'email', u.email, 'full_name', pr.full_name, 'role', pr.role)
                     order by pr.role, u.email)
    from (select * from (select * from public.profiles where (public.org_visible(org_id) or public.org_visible(public.client_org(client_id)))) profiles where (public.org_visible(org_id) or public.org_visible(public.client_org(client_id)))) pr
    join auth.users u on u.id = pr.id
    where pr.role <> 'customer'
  ), '[]'::jsonb);
end;
$function$
;

-- ===== admin_send_test_email
CREATE OR REPLACE FUNCTION public.admin_send_test_email(p_to text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_legacy_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if not exists (select 1 from vault.secrets s where s.name = 'resend_api_key') then
    raise exception using errcode = '22023', message = 'Enregistrez d’abord la clé API.';
  end if;
  if not (select a.email_enabled from public.app_settings a where a.id = 1) then
    raise exception using errcode = '22023', message = 'Activez d’abord l’envoi d’e-mails.';
  end if;
  perform public.send_email(p_to, 'Test Appro+', 'Les e-mails Appro+ sont bien configurés.');
end;
$function$
;

-- ===== admin_set_account_disabled
CREATE OR REPLACE FUNCTION public.admin_set_account_disabled(p_user_id uuid, p_disabled boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if p_user_id = auth.uid() then
    raise exception using errcode = '22023', message = 'Vous ne pouvez pas désactiver votre propre compte.';
  end if;
  update public.profiles set disabled = p_disabled where id = p_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Compte introuvable.';
  end if;
  -- The ban blocks new sign-ins and token refreshes; profiles.disabled cuts rights at once.
  update auth.users set banned_until = case when p_disabled then now() + interval '100 years' else null end
  where id = p_user_id;
end;
$function$
;

-- ===== admin_set_account_status
CREATE OR REPLACE FUNCTION public.admin_set_account_status(p_user_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if p_user_id = auth.uid() then
    raise exception using errcode = '22023', message = 'Vous ne pouvez pas modifier le statut de votre propre compte.';
  end if;
  if p_status not in ('pending', 'active', 'refused', 'suspended') then
    raise exception using errcode = '22023', message = 'Statut de compte invalide.';
  end if;
  update public.profiles set account_status = p_status, disabled = p_status <> 'active' where id = p_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Compte introuvable.';
  end if;
  -- Refused and suspended accounts cannot sign in; a pending one may, to see its waiting screen.
  update auth.users
  set banned_until = case when p_status in ('refused', 'suspended') then now() + interval '100 years' else null end,
      email_confirmed_at = case when p_status = 'active' then coalesce(email_confirmed_at, now()) else email_confirmed_at end
  where id = p_user_id;
end;
$function$
;

-- ===== admin_set_client_default
CREATE OR REPLACE FUNCTION public.admin_set_client_default(p_key text, p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
begin
  if not public.is_admin() or v_org is null then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if p_key not in ('show_prices', 'show_origin', 'show_stock', 'stock_managed', 'invoice_mode', 'reception_qr',
                   'history_enabled', 'reconfirm_declined', 'scan_delivery_note', 'scan_client_qr',
                   'payment_reminders', 'reminder_opt_out_allowed', 'delivery_signature', 'driver_prices', 'auto_accept', 'auto_deliver', 'delivery_note_client') then
    raise exception using errcode = '22023', message = 'Option client inconnue.';
  end if;
  if p_key = 'invoice_mode' then
    if jsonb_typeof(p_value) is distinct from 'string' or (p_value #>> '{}') not in ('auto', 'manual') then
      raise exception using errcode = '22023', message = 'Mode de facturation invalide.';
    end if;
  elsif jsonb_typeof(p_value) is distinct from 'boolean' then
    raise exception using errcode = '22023', message = 'Valeur invalide.';
  end if;
  insert into public.client_setting_defaults (org_id, key, value, updated_at) values (v_org, p_key, p_value, now())
  on conflict (org_id, key) do update set value = excluded.value, updated_at = now();
  update public.clients set custom_settings = custom_settings where supplier_org_id = v_org and not (p_key = any(custom_settings));
end;
$function$
;

-- ===== admin_set_email_api_key
CREATE OR REPLACE FUNCTION public.admin_set_email_api_key(p_key text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  if not public.is_legacy_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if coalesce(btrim(p_key), '') = '' then
    raise exception using errcode = '22023', message = 'Collez la clé API du service d’e-mails.';
  end if;
  select s.id into v_id from vault.secrets s where s.name = 'resend_api_key';
  if v_id is null then
    perform vault.create_secret(btrim(p_key), 'resend_api_key', 'Clé API Resend pour les e-mails Appro+');
  else
    perform vault.update_secret(v_id, btrim(p_key));
  end if;
end;
$function$
;

-- ===== admin_set_email_settings
CREATE OR REPLACE FUNCTION public.admin_set_email_settings(p_enabled boolean, p_from text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_legacy_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if coalesce(btrim(p_from), '') = '' then
    raise exception using errcode = '22023', message = 'Indiquez l’adresse d’expédition.';
  end if;
  update public.app_settings set email_enabled = p_enabled, email_from = btrim(p_from), updated_at = now() where id = 1;
end;
$function$
;

-- ===== admin_set_home_layout
CREATE OR REPLACE FUNCTION public.admin_set_home_layout(p_role app_role, p_layout jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_legacy_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if not public.valid_home_layout(p_layout) then
    raise exception using errcode = '22023', message = 'Disposition de l’accueil invalide.';
  end if;
  if p_layout is null then
    delete from public.home_layouts where role = p_role;
  else
    insert into public.home_layouts (role, layout, updated_at) values (p_role, p_layout, now())
    on conflict (role) do update set layout = excluded.layout, updated_at = now();
  end if;
end;
$function$
;

-- ===== admin_set_leave_approval
CREATE OR REPLACE FUNCTION public.admin_set_leave_approval(p_required boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_legacy_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  update public.app_settings set leave_approval_required = coalesce(p_required, true), updated_at = now() where id = 1;
end;
$function$
;

-- ===== admin_set_module
CREATE OR REPLACE FUNCTION public.admin_set_module(p_key text, p_enabled boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Seule l’équipe Appro+ fixe les modules par défaut. Pour votre Pro : Paramétrage → Modules.';
  end if;
  if not (p_key = any(public.module_keys())) then
    raise exception using errcode = '22023', message = 'Module inconnu.';
  end if;
  insert into public.app_modules (key, enabled, updated_at, updated_by) values (p_key, coalesce(p_enabled, true), now(), auth.uid())
  on conflict (key) do update set enabled = excluded.enabled, updated_at = now(), updated_by = auth.uid();
end;
$function$
;

-- ===== admin_set_notification_setting
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
    raise exception using errcode = 'P0002', message = 'Type d’alerte inconnu.';
  end if;
end;
$function$
;

-- ===== admin_set_numbering
CREATE OR REPLACE FUNCTION public.admin_set_numbering(p_type text, p_prefix text, p_with_year boolean, p_digits integer, p_next_number bigint, p_yearly_reset boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
begin
  if not public.is_admin() or v_org is null then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if char_length(coalesce(p_prefix, '')) > 12 or coalesce(p_prefix, '') ~ '[^A-Za-z0-9/_.-]' then
    raise exception using errcode = '22023', message = 'Préfixe : 12 caractères au plus (lettres, chiffres, - / _ .).';
  end if;
  if p_digits not between 1 and 10 or p_next_number < 1 then
    raise exception using errcode = '22023', message = 'Nombre de chiffres (1 à 10) ou numéro de départ invalide.';
  end if;
  perform public.org_install_numbering(v_org);
  update public.document_numbering
  set prefix = coalesce(p_prefix, ''), with_year = p_with_year, digits = p_digits, next_number = p_next_number,
      yearly_reset = p_yearly_reset, current_year = extract(year from (now() at time zone 'Africa/Tunis'))::int, updated_at = now()
  where org_id = v_org and doc_type = p_type;
  if not found then
    raise exception using errcode = 'P0002', message = 'Numérotation inconnue.';
  end if;
end;
$function$
;

-- ===== admin_set_permission
CREATE OR REPLACE FUNCTION public.admin_set_permission(p_role app_role, p_feature text, p_allowed boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_legacy_admin() then
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
$function$
;

-- ===== admin_set_role
CREATE OR REPLACE FUNCTION public.admin_set_role(p_email text, p_role app_role)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  select u.id into v_user_id from auth.users u where lower(u.email) = lower(btrim(p_email));
  if not found then
    raise exception using errcode = 'P0002', message = 'Aucun compte avec cet e-mail : la personne doit d’abord activer son accès dans l’application.';
  end if;
  if v_user_id = auth.uid() then
    raise exception using errcode = '22023', message = 'Vous ne pouvez pas modifier votre propre rôle.';
  end if;
  if p_role <> 'customer' and exists (select 1 from public.profiles pr where pr.id = v_user_id and pr.client_id is not null) then
    raise exception using errcode = '22023', message = 'Ce compte est rattaché à une fiche client : utilisez une autre adresse pour l’équipe.';
  end if;
  update public.profiles set role = p_role where id = v_user_id;
  return jsonb_build_object('id', v_user_id, 'role', p_role);
end;
$function$
;

-- ===== admin_set_user_permission
CREATE OR REPLACE FUNCTION public.admin_set_user_permission(p_user_id uuid, p_feature text, p_allowed boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role text;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user_id;
  if v_role is null then
    raise exception using errcode = 'P0002', message = 'Compte introuvable.';
  end if;
  if v_role = 'admin' then
    raise exception using errcode = '22023', message = 'Un administrateur a toujours tous les droits.';
  end if;
  if not exists (select 1 from public.role_permissions rp where rp.feature = p_feature) then
    raise exception using errcode = '22023', message = 'Fonctionnalité inconnue.';
  end if;
  if (v_role = 'customer') <> (p_feature like 'client.%') then
    raise exception using errcode = '22023', message = 'Cette fonctionnalité ne concerne pas ce type de compte.';
  end if;
  if p_allowed is null then
    delete from public.user_permissions where user_id = p_user_id and feature = p_feature;
  else
    insert into public.user_permissions (user_id, feature, allowed, updated_at) values (p_user_id, p_feature, p_allowed, now())
    on conflict (user_id, feature) do update set allowed = excluded.allowed, updated_at = now();
  end if;
end;
$function$
;

-- ===== alert_on_claim
CREATE OR REPLACE FUNCTION public.alert_on_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_number bigint;
  v_client text;
begin
  select o.order_number into v_number from public.orders o where o.id = new.order_id;
  if tg_op = 'INSERT' then
    select c.business_name into v_client from public.clients c where c.id = new.client_id;
    perform public.notify(array(select public.team_with_feature('claims.manage', public.client_org(new.client_id))), 'claim.new',
      format('Réclamation sur la commande #%s', v_number), format('%s : %s', coalesce(v_client, 'Client'), left(new.description, 140)), new.order_id);
  elsif new.status in ('resolved', 'rejected') and old.status is distinct from new.status then
    perform public.notify(array[new.created_by], 'claim.answered',
      format('Réponse à votre réclamation (commande #%s)', v_number), coalesce(new.staff_response, ''), new.order_id);
  end if;
  return new;
end;
$function$
;

-- ===== alert_on_invoice
CREATE OR REPLACE FUNCTION public.alert_on_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.status = 'issued' and (tg_op = 'INSERT' or old.status = 'draft') then
    perform public.notify(array(select pr.id from public.profiles pr where pr.client_id = new.client_id and pr.account_status = 'active'),
      'invoice.issued', format('Facture %s disponible', new.invoice_number),
      format('Montant TTC : %s TND. Consultez-la dans l’onglet Factures.', to_char(new.total_ttc, 'FM999G999G990D000')));
  end if;
  return new;
end;
$function$
;

-- ===== alert_on_message
CREATE OR REPLACE FUNCTION public.alert_on_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_client text;
begin
  select c.business_name into v_client from public.clients c where c.id = new.client_id;
  if new.from_staff then
    perform public.notify(array(select pr.id from public.profiles pr where pr.client_id = new.client_id and pr.account_status = 'active'),
      'message.new', 'Nouveau message de votre fournisseur', left(new.body, 140));
  else
    perform public.notify(array(select public.team_with_feature('messages.manage', public.client_org(new.client_id))), 'message.new',
      format('Message de %s', coalesce(v_client, 'un client')), left(new.body, 140));
  end if;
  return new;
end;
$function$
;

-- ===== alert_on_new_account
CREATE OR REPLACE FUNCTION public.alert_on_new_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_email text;
begin
  if new.account_status = 'pending' and new.role <> 'platform' then
    select u.email into v_email from auth.users u where u.id = new.id;
    perform public.notify(array(select pm.user_id from public.platform_members pm
        where pm.active and pm.role in ('superadmin', 'verification', 'account_manager')),
      'account.pending', 'Nouvelle inscription', format('%s attend une validation (Appro+ → Paramétrage → Comptes).', coalesce(v_email, 'Un utilisateur')));
  end if;
  return new;
end;
$function$
;

-- ===== alert_on_order
CREATE OR REPLACE FUNCTION public.alert_on_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_client text;
begin
  select c.business_name into v_client from public.clients c where c.id = new.client_id;
  if tg_op = 'INSERT' then
    perform public.notify(array(select public.team_with_feature('orders.decide', new.supplier_org_id)), 'order.new',
      format('Nouvelle commande #%s', new.order_number),
      format('%s%s', coalesce(v_client, 'Client'), case when new.requested_delivery_date is not null then ' · livraison souhaitée le ' || to_char(new.requested_delivery_date, 'DD/MM') else '' end),
      new.id);
  elsif new.status is distinct from old.status and new.status <> 'pending' then
    perform public.notify(array[new.customer_id],
      case when new.status = 'awaiting_client' then 'order.reconfirm' else 'order.status' end,
      format('Commande #%s %s', new.order_number, public.order_status_words(new.status)),
      case when new.status = 'awaiting_client' then 'Votre fournisseur vous propose de la reconfirmer. ' else '' end || coalesce(new.status_note, ''),
      new.id);
  end if;
  return new;
end;
$function$
;

-- ===== answer_location_request
CREATE OR REPLACE FUNCTION public.answer_location_request(p_request_id uuid, p_accept boolean, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy double precision DEFAULT NULL::double precision)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_request public.location_requests%rowtype;
begin
  select * into v_request from public.location_requests where id = p_request_id for update;
  if v_request.id is null or v_request.target_id is distinct from auth.uid() then
    raise exception using errcode = 'P0002', message = 'Demande introuvable.';
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
$function$
;

-- ===== app_modules_state
CREATE OR REPLACE FUNCTION public.app_modules_state()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_object_agg(k, public.module_enabled(k)) from unnest(public.module_keys()) as k;
$function$
;

-- ===== apply_client_defaults
CREATE OR REPLACE FUNCTION public.apply_client_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d jsonb := coalesce((select jsonb_object_agg(s.key, s.value) from public.client_setting_defaults s where s.org_id = coalesce(new.supplier_org_id, public.acting_or_legacy_org_id())), '{}'::jsonb);
  k text[];
begin
  new.custom_settings := array(
    select distinct x from unnest(coalesce(new.custom_settings, '{}'::text[])) as t(x)
    where x in ('show_prices', 'show_origin', 'show_stock', 'stock_managed', 'invoice_mode', 'reception_qr',
                'history_enabled', 'reconfirm_declined', 'scan_delivery_note', 'scan_client_qr',
                'payment_reminders', 'reminder_opt_out_allowed', 'delivery_signature', 'driver_prices', 'auto_accept', 'auto_deliver', 'delivery_note_client')
    order by x);
  k := new.custom_settings;
  if not ('show_prices' = any(k)) and d ? 'show_prices' then new.show_prices := (d ->> 'show_prices')::boolean; end if;
  if not ('show_origin' = any(k)) and d ? 'show_origin' then new.show_origin := (d ->> 'show_origin')::boolean; end if;
  if not ('show_stock' = any(k)) and d ? 'show_stock' then new.show_stock := (d ->> 'show_stock')::boolean; end if;
  if not ('stock_managed' = any(k)) and d ? 'stock_managed' then new.stock_managed := (d ->> 'stock_managed')::boolean; end if;
  if not ('invoice_mode' = any(k)) and d ? 'invoice_mode' then new.invoice_mode := d ->> 'invoice_mode'; end if;
  if not ('reception_qr' = any(k)) and d ? 'reception_qr' then new.reception_qr := (d ->> 'reception_qr')::boolean; end if;
  if not ('history_enabled' = any(k)) and d ? 'history_enabled' then new.history_enabled := (d ->> 'history_enabled')::boolean; end if;
  if not ('reconfirm_declined' = any(k)) and d ? 'reconfirm_declined' then new.reconfirm_declined := (d ->> 'reconfirm_declined')::boolean; end if;
  if not ('scan_delivery_note' = any(k)) and d ? 'scan_delivery_note' then new.scan_delivery_note := (d ->> 'scan_delivery_note')::boolean; end if;
  if not ('scan_client_qr' = any(k)) and d ? 'scan_client_qr' then new.scan_client_qr := (d ->> 'scan_client_qr')::boolean; end if;
  if not ('payment_reminders' = any(k)) and d ? 'payment_reminders' then new.payment_reminders := (d ->> 'payment_reminders')::boolean; end if;
  if not ('reminder_opt_out_allowed' = any(k)) and d ? 'reminder_opt_out_allowed' then new.reminder_opt_out_allowed := (d ->> 'reminder_opt_out_allowed')::boolean; end if;
  if not ('delivery_signature' = any(k)) and d ? 'delivery_signature' then new.delivery_signature := (d ->> 'delivery_signature')::boolean; end if;
  if not ('driver_prices' = any(k)) and d ? 'driver_prices' then new.driver_prices := (d ->> 'driver_prices')::boolean; end if;
  if not ('auto_accept' = any(k)) and d ? 'auto_accept' then new.auto_accept := (d ->> 'auto_accept')::boolean; end if;
  if not ('auto_deliver' = any(k)) and d ? 'auto_deliver' then new.auto_deliver := (d ->> 'auto_deliver')::boolean; end if;
  if not ('delivery_note_client' = any(k)) and d ? 'delivery_note_client' then new.delivery_note_client := (d ->> 'delivery_note_client')::boolean; end if;
  new.feature_overrides := coalesce((
    select jsonb_object_agg(e.key, e.value) from jsonb_each(
      case when jsonb_typeof(new.feature_overrides) = 'object' then new.feature_overrides else '{}'::jsonb end) e
    where e.key like 'client.%' and jsonb_typeof(e.value) = 'boolean'
  ), '{}'::jsonb);
  return new;
end;
$function$
;

-- ===== apply_module_guards
CREATE OR REPLACE FUNCTION public.apply_module_guards()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  r record;
  v_def text;
  v_new text;
  v_count int := 0;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'has_feature' and p.prosrc like '%has_feature_base%') then
    v_def := pg_get_functiondef('public.has_feature(text)'::regprocedure);
    execute replace(v_def, 'FUNCTION public.has_feature(', 'FUNCTION public.has_feature_base(');
    execute 'REVOKE ALL ON FUNCTION public.has_feature_base(text) FROM PUBLIC, anon, authenticated';
    execute $f$
      create or replace function public.has_feature(p_feature text)
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $body$
        select (public.feature_module(p_feature) is null or public.module_enabled(public.feature_module(p_feature)))
          and public.has_feature_base(p_feature);
      $body$
    $f$;
    v_count := v_count + 1;
  end if;

  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname not in ('apply_module_guards', 'has_feature', 'has_feature_base', 'module_enabled', 'module_enabled_for')
      and p.prosrc ~ '\m(c|v_client)\.(delivery_signature|payment_reminders|scan_delivery_note|scan_client_qr|reception_qr|show_origin|show_stock|stock_managed|reconfirm_declined)\M'
      and p.prosrc not like '%public.module_enabled(''%'
      and p.prosrc not like '%public.module_enabled_for(%'
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := v_def;
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(delivery_signature)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''signature''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(payment_reminders)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''reminders''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(scan_delivery_note|scan_client_qr|reception_qr)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''delivery_qr''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(show_origin)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''origin''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(show_stock|stock_managed)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''stock''))', 'g');
    v_new := regexp_replace(v_new, '\m(c|v_client)\.(reconfirm_declined)\M(?!\s*:=)', '(\1.\2 and public.module_enabled(''reconfirm''))', 'g');
    if v_new <> v_def then
      execute v_new;
      v_count := v_count + 1;
    end if;
  end loop;

  -- Second pass: (c.option and module_enabled('m')) -> the modules of c's supplier.
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname not in ('apply_module_guards', 'has_feature', 'has_feature_base', 'module_enabled', 'module_enabled_for')
      and p.prosrc ~ '\((c|v_client)\.\w+ and public\.module_enabled\(''\w+''\)\)'
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def, '\((c|v_client)\.(\w+) and public\.module_enabled\(''(\w+)''\)\)',
      '(\1.\2 and public.module_enabled_for(\1.supplier_org_id, ''\3''))', 'g');
    if v_new <> v_def then
      execute v_new;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$function$
;

-- ===== apply_order_pricing
CREATE OR REPLACE FUNCTION public.apply_order_pricing(p_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order public.orders%rowtype;
  v_price jsonb;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id;
  if not found or v_order.client_id is null then return; end if;
  v_price := public.price_lines(v_order.client_id,
    (select coalesce(jsonb_agg(jsonb_build_object('product_id', oi.product_id, 'quantity', oi.quantity)), '[]'::jsonb)
     from public.order_items oi where oi.order_id = p_order_id and oi.product_id is not null), p_order_id);
  update public.order_items oi set
    list_price = (v_price -> 'lines' -> oi.product_id::text ->> 'list_price')::numeric,
    unit_price = (v_price -> 'lines' -> oi.product_id::text ->> 'unit_price')::numeric,
    line_total = (v_price -> 'lines' -> oi.product_id::text ->> 'line_total')::numeric,
    discount_label = v_price -> 'lines' -> oi.product_id::text ->> 'label'
  where oi.order_id = p_order_id and oi.product_id is not null and (v_price -> 'lines') ? oi.product_id::text;
  update public.orders o set
    subtotal = s.subtotal, total = s.subtotal + coalesce(o.delivery_fee, 0), discount_total = s.discount, updated_at = now()
  from (select coalesce(sum(oi.line_total), 0) as subtotal,
               coalesce(sum(greatest(round(coalesce(oi.list_price, oi.unit_price) * oi.quantity, 3) - oi.line_total, 0)), 0) as discount
        from public.order_items oi where oi.order_id = p_order_id) s
  where o.id = p_order_id;
  update public.payments p set amount = o.total from public.orders o
  where o.id = p_order_id and p.order_id = p_order_id and p.status = 'pending';
end;
$function$
;

-- ===== appro_rewrite
CREATE OR REPLACE FUNCTION public.appro_rewrite(p_text text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
    p_text,
    'Accès réservé au personnel AgriFresh.', 'Accès réservé à l’équipe du fournisseur.'),
    'Accès réservé aux livreurs AgriFresh.', 'Accès réservé aux livreurs.'),
    'Contactez AgriFresh.', 'Contactez votre fournisseur.'),
    'contactez AgriFresh.', 'contactez votre fournisseur.'),
    'Commande reçue depuis AgriFresh.', 'Commande reçue depuis Appro+.'),
    'AgriFresh vous propose de la reconfirmer. ', 'Votre fournisseur vous propose de la reconfirmer. '),
    'Nouveau message d’AgriFresh', 'Nouveau message de votre fournisseur'),
    'Commande saisie par AgriFresh (%s) pour le client.', 'Commande saisie par le fournisseur (%s) pour le client.'),
    'saisie par AgriFresh', 'saisie par votre fournisseur'),
    'AgriFresh a enregistré cette commande pour vous', 'Votre fournisseur a enregistré cette commande pour vous'),
    'AgriFresh a rendu les rappels de paiement obligatoires', 'Votre fournisseur a rendu les rappels de paiement obligatoires'),
    'Les e-mails AgriFresh sont bien configurés.', 'Les e-mails Appro+ sont bien configurés.'),
    'Test AgriFresh', 'Test Appro+'),
    '— AgriFresh', '— Appro+'),
    'AgriFresh', 'Appro+');
$function$
;

-- ===== assign_delivery_note_number
CREATE OR REPLACE FUNCTION public.assign_delivery_note_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.delivery_note_number is null and new.status in ('confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered') then
    new.delivery_note_number := public.next_document_number('delivery_note');
  end if;
  return new;
end;
$function$
;

-- ===== attach_invoice_orders
CREATE OR REPLACE FUNCTION public.attach_invoice_orders(p_invoice_id uuid, p_client_id uuid, p_order_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_requested int;
  v_matching int;
begin
  select count(distinct id) into v_requested from unnest(coalesce(p_order_ids, array[]::uuid[])) as t(id);
  if v_requested = 0 then
    raise exception using errcode = '22023', message = 'Sélectionnez au moins un bon de livraison.';
  end if;

  perform 1 from public.orders o
  where o.id = any(p_order_ids) or o.client_invoice_id = p_invoice_id
  order by o.id for update;

  select count(*) into v_matching
  from public.orders o
  where o.id = any(p_order_ids)
    and o.client_id = p_client_id
    and (o.client_invoice_id is null or o.client_invoice_id = p_invoice_id)
    and o.status in ('confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered');
  if v_matching <> v_requested then
    raise exception using errcode = '22023', message = 'Un bon sélectionné est déjà facturé, appartient à un autre client ou n’est pas accepté.';
  end if;

  update public.orders set client_invoice_id = null
  where client_invoice_id = p_invoice_id and not (id = any(p_order_ids));
  update public.orders set client_invoice_id = p_invoice_id where id = any(p_order_ids);
  perform public.refresh_invoice_totals(p_invoice_id);
end;
$function$
;

-- ===== attach_org_owner
CREATE OR REPLACE FUNCTION public.attach_org_owner(p_org_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org public.organizations%rowtype;
begin
  select * into v_org from public.organizations where id = p_org_id;
  update public.profiles set org_id = p_org_id, role = case when v_org.is_supplier then 'admin' else 'customer' end::public.app_role, client_id = null,
    account_status = case when v_org.status = 'active' then 'active' else 'pending' end
  where id = p_user_id and org_id is null and client_id is null and role <> 'platform';
  if not found then
    return;
  end if;
  perform public.org_install_roles(p_org_id);
  insert into public.member_roles (user_id, role_id)
  select p_user_id, r.id from public.org_roles r join public.role_templates t on t.id = r.template_id
  where r.org_id = p_org_id and t.key in ('supplier_owner', 'buyer_owner')
  on conflict do nothing;
end;
$function$
;

-- ===== audit_row
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
    when 'notification_settings' then 'Alerte · ' || (v_row ->> 'label')
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

-- ===== auto_accept_order
CREATE OR REPLACE FUNCTION public.auto_accept_order(p_order_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== auto_deliver_orders
CREATE OR REPLACE FUNCTION public.auto_deliver_orders()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== billing_board
CREATE OR REPLACE FUNCTION public.billing_board()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de gérer la facturation.';
  end if;
  return jsonb_build_object(
    'due', coalesce((
      select jsonb_agg(entry order by entry ->> 'next_date')
      from (
        select jsonb_build_object(
          'client_id', c.id, 'business_name', c.business_name, 'frequency', c.billing_frequency,
          'every_days', c.billing_every_days, 'month_day', c.billing_month_day,
          'next_date', public.next_billing_date(c.id),
          'orders', count(o.id), 'amount', coalesce(sum(o.total), 0)
        ) as entry
        from (select * from (select * from public.clients where public.org_visible(supplier_org_id)) clients where public.org_visible(supplier_org_id)) c
        join (select * from (select * from public.orders where public.org_visible(supplier_org_id)) orders where public.org_visible(supplier_org_id)) o on o.client_id = c.id and o.client_invoice_id is null
          and o.status in ('confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered')
        where c.billing_frequency <> 'manual' and public.next_billing_date(c.id) <= current_date
        group by c.id
      ) rows
    ), '[]'::jsonb),
    'overdue', coalesce((
      select jsonb_agg(jsonb_build_object(
        'invoice_id', i.id, 'invoice_number', i.invoice_number, 'client_id', c.id, 'business_name', c.business_name,
        'balance', i.total_ttc - i.amount_paid, 'due_date', i.due_date, 'days_late', current_date - i.due_date,
        'reminder_count', i.reminder_count, 'last_reminder_at', i.last_reminder_at,
        'reminders', (c.payment_reminders and public.module_enabled_for(c.supplier_org_id, 'reminders')) and not (c.reminder_opt_out_allowed and c.reminder_opt_out)
      ) order by i.due_date)
      from (select * from (select * from public.client_invoices where public.org_visible(public.client_org(client_id))) client_invoices where public.org_visible(public.client_org(client_id))) i join (select * from (select * from public.clients where public.org_visible(supplier_org_id)) clients where public.org_visible(supplier_org_id)) c on c.id = i.client_id
      where i.status = 'issued' and i.total_ttc - i.amount_paid > 0.0005 and i.due_date < current_date
    ), '[]'::jsonb)
  );
end;
$function$
;

-- ===== buyer_accounts
CREATE OR REPLACE FUNCTION public.buyer_accounts()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('client_id', c.id, 'supplier_name', s.name, 'current', c.id = public.current_client_id())
    || public.account_figures(c.id) order by s.name), '[]'::jsonb)
  from public.buyer_relations('client.invoices') c join public.organizations s on s.id = c.supplier_org_id;
$function$
;

-- ===== buyer_catalog
CREATE OR REPLACE FUNCTION public.buyer_catalog()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'buyer_org_id', (select pr.org_id from public.profiles pr where pr.id = (select auth.uid())),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object(
        'client_id', c.id, 'org_id', s.id, 'name', s.name, 'business_name', c.business_name,
        'show_prices', c.show_prices, 'show_stock', c.show_stock, 'show_origin', c.show_origin,
        'current', c.id = (select pr.client_id from public.profiles pr where pr.id = (select auth.uid())),
        'delivery_points', coalesce((select jsonb_agg(jsonb_build_object('id', dp.id, 'label', dp.label, 'address_line', dp.address_line, 'city', dp.city) order by dp.label)
          from public.client_delivery_points dp where dp.client_id = c.id and dp.active), '[]'::jsonb)) order by s.name)
      from public.buyer_order_relations() c join public.organizations s on s.id = c.supplier_org_id), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'client_id', c.id, 'name', p.name, 'description', p.description, 'image_url', p.image_url,
        'unit_label', p.unit_label, 'vat_rate', p.vat_rate, 'created_at', p.created_at, 'category', cat.name, 'category_sort', cat.sort_order,
        'category_id', p.category_id, 'category_parent_id', cat.parent_id,
        'price', case when c.show_prices then p.price end,
        'stock_quantity', case when c.show_stock then p.stock_quantity end,
        'origin_producer', case when c.show_origin then p.origin_producer end,
        'origin_region', case when c.show_origin then p.origin_region end,
        'origin_label', case when c.show_origin then p.origin_label end,
        'origin_note', case when c.show_origin then p.origin_note end) order by p.created_at desc)
      from public.buyer_order_relations() c
      join public.products p on p.org_id = c.supplier_org_id and p.active
      left join public.categories cat on cat.id = p.category_id), '[]'::jsonb),
    'offers', coalesce((select jsonb_agg(o) from public.buyer_order_relations() c, jsonb_array_elements(public.relation_offers(c.id)) o), '[]'::jsonb));
$function$
;

-- ===== buyer_claims
CREATE OR REPLACE FUNCTION public.buyer_claims()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', cl.id, 'claim_number', cl.claim_number, 'order_id', cl.order_id, 'client_id', cl.client_id, 'reason', cl.reason,
      'description', cl.description, 'status', cl.status, 'staff_response', cl.staff_response, 'created_at', cl.created_at, 'resolved_at', cl.resolved_at,
      'supplier_name', s.name,
      'orders', (select jsonb_build_object('order_number', o.order_number) from public.orders o where o.id = cl.order_id),
      'clients', jsonb_build_object('business_name', c.business_name))
    order by cl.created_at desc), '[]'::jsonb)
  from public.buyer_relations('client.claims') c
  join public.organizations s on s.id = c.supplier_org_id
  join public.claims cl on cl.client_id = c.id;
$function$
;

-- ===== buyer_create_claim
CREATE OR REPLACE FUNCTION public.buyer_create_claim(p_order_id uuid, p_reason text, p_description text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_previous uuid := public.buyer_use_client((select o.client_id from public.orders o where o.id = p_order_id), 'client.claims');
  v_result jsonb;
begin
  v_result := public.client_create_claim(p_order_id, p_reason, p_description);
  perform public.buyer_restore_client(v_previous);
  return v_result;
end;
$function$
;

-- ===== buyer_credit_notes
CREATE OR REPLACE FUNCTION public.buyer_credit_notes()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', cn.id, 'credit_number', cn.credit_number, 'client_id', cn.client_id, 'return_id', cn.return_id, 'invoice_id', cn.invoice_id,
      'status', cn.status, 'reason', cn.reason, 'client_snapshot', cn.client_snapshot, 'total_ht', cn.total_ht, 'total_vat', cn.total_vat,
      'total_ttc', cn.total_ttc, 'created_at', cn.created_at, 'issued_at', cn.issued_at, 'settled_at', cn.settled_at, 'supplier_name', s.name,
      'credit_note_items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'label', i.label, 'quantity', i.quantity, 'unit', i.unit,
          'unit_price', i.unit_price, 'vat_rate', i.vat_rate)) from public.credit_note_items i where i.credit_note_id = cn.id), '[]'::jsonb),
      'clients', jsonb_build_object('business_name', c.business_name, 'client_number', c.client_number),
      'client_invoices', (select jsonb_build_object('invoice_number', i.invoice_number) from public.client_invoices i where i.id = cn.invoice_id))
    order by cn.created_at desc), '[]'::jsonb)
  from (select distinct x.* from (select * from public.buyer_relations('client.invoices') union all select * from public.buyer_relations('client.returns')) x) c
  join public.organizations s on s.id = c.supplier_org_id
  join public.credit_notes cn on cn.client_id = c.id and cn.status <> 'draft';
$function$
;

-- ===== buyer_delete_recurring
CREATE OR REPLACE FUNCTION public.buyer_delete_recurring(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_previous uuid := public.buyer_use_client((select r.client_id from public.recurring_orders r where r.id = p_id), 'client.recurring');
begin
  perform public.delete_recurring_order(p_id);
  perform public.buyer_restore_client(v_previous);
end;
$function$
;

-- ===== buyer_inbox
CREATE OR REPLACE FUNCTION public.buyer_inbox()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('client_id', c.id, 'supplier_name', s.name,
      'last_body', m.body, 'last_at', m.created_at, 'last_from_staff', m.from_staff,
      'unread', (select count(*) from public.messages u where u.client_id = c.id and u.from_staff and u.read_at is null))
    order by m.created_at desc nulls last, s.name), '[]'::jsonb)
  from public.buyer_relations('client.messages') c
  join public.organizations s on s.id = c.supplier_org_id
  left join lateral (select x.body, x.created_at, x.from_staff from public.messages x where x.client_id = c.id order by x.created_at desc limit 1) m on true;
$function$
;

-- ===== buyer_invoices
CREATE OR REPLACE FUNCTION public.buyer_invoices()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(to_jsonb(i) || jsonb_build_object(
      'supplier_name', s.name, 'seller', public.seller_card(s.id),
      'invoice_payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.paid_on) from public.invoice_payments p where p.invoice_id = i.id), '[]'::jsonb),
      'orders', coalesce((select jsonb_agg(to_jsonb(o) || jsonb_build_object(
          'order_items', coalesce((select jsonb_agg(to_jsonb(oi) order by oi.product_name_snapshot) from public.order_items oi where oi.order_id = o.id), '[]'::jsonb),
          'order_status_history', '[]'::jsonb)) from public.orders o where o.client_invoice_id = i.id), '[]'::jsonb))
    order by coalesce(i.issued_at, i.created_at) desc), '[]'::jsonb)
  from public.buyer_relations('client.invoices') c
  join public.organizations s on s.id = c.supplier_org_id
  join public.client_invoices i on i.client_id = c.id and i.status <> 'draft';
$function$
;

-- ===== buyer_order_relations
CREATE OR REPLACE FUNCTION public.buyer_order_relations()
 RETURNS SETOF clients
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select c.* from public.profiles pr
  join public.clients c on c.buyer_org_id = pr.org_id and c.link_status = 'active' and c.active
  join public.organizations s on s.id = c.supplier_org_id and s.status = 'active'
  where pr.id = (select auth.uid()) and pr.role = 'customer' and pr.account_status = 'active'
    and public.buyer_relation_can(c.id, 'client.order');
$function$
;

-- ===== buyer_orders
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
        'supplier_name', s.name, 'show_prices', c.show_prices, 'show_origin', (c.show_origin and public.module_enabled_for(c.supplier_org_id, 'origin')), 'history_enabled', c.history_enabled, 'delivery_note', c.delivery_note_client,
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

-- ===== buyer_pending_order
CREATE OR REPLACE FUNCTION public.buyer_pending_order(p_order_id uuid)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order public.orders%rowtype;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if v_order.id is null or not exists (select 1 from public.buyer_relations('client.order') c where c.id = v_order.client_id) then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  if v_order.status <> 'pending' then
    raise exception using errcode = '22023', message = 'Votre fournisseur a déjà traité cette commande : contactez-le pour la changer.';
  end if;
  perform set_config('appro.link_write', 'on', true);
  return v_order;
end;
$function$
;

-- ===== buyer_price_cart
CREATE OR REPLACE FUNCTION public.buyer_price_cart(p_orders jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order jsonb;
  v_client public.clients%rowtype;
  v_price jsonb;
  v_result jsonb := '[]'::jsonb;
begin
  if public.active_uid() is null then
    raise exception using errcode = '28000', message = 'Connectez-vous.';
  end if;
  for v_order in select value from jsonb_array_elements(case when jsonb_typeof(p_orders) = 'array' then p_orders else '[]'::jsonb end) loop
    select c.* into v_client from public.buyer_order_relations() c where c.id = nullif(v_order ->> 'client_id', '')::uuid;
    continue when v_client.id is null;
    v_price := public.price_lines(v_client.id, v_order -> 'items');
    if not v_client.show_prices then
      v_price := jsonb_build_object('lines', '{}'::jsonb, 'applied', v_price -> 'applied', 'next', '[]'::jsonb, 'hidden', true);
    end if;
    v_result := v_result || jsonb_build_array(v_price || jsonb_build_object('client_id', v_client.id));
    v_client := null;
  end loop;
  return v_result;
end;
$function$
;

-- ===== buyer_recurring
CREATE OR REPLACE FUNCTION public.buyer_recurring()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('clients', jsonb_build_object('business_name', c.business_name), 'supplier_name', s.name)
    order by r.next_delivery), '[]'::jsonb)
  from public.buyer_relations('client.recurring') c
  join public.organizations s on s.id = c.supplier_org_id
  join public.recurring_orders r on r.client_id = c.id;
$function$
;

-- ===== buyer_relation_can
CREATE OR REPLACE FUNCTION public.buyer_relation_can(p_client_id uuid, p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((
    select case when pr.account_status <> 'active' or pr.role <> 'customer' then false
      when public.feature_module(p_permission) is not null and not public.module_enabled_for((select c2.supplier_org_id from public.clients c2 where c2.id = p_client_id), public.feature_module(p_permission)) then false
      else coalesce(
        (select mo.allowed from public.member_overrides mo where mo.user_id = pr.id and mo.org_id = pr.org_id and mo.permission = p_permission),
        (select (c.feature_overrides ->> p_permission)::boolean from public.clients c where c.id = p_client_id and p_permission like 'client.%'),
        (select bool_or(public.role_grants(r.id, p_permission)) from public.member_roles mr join public.org_roles r on r.id = mr.role_id
          where mr.user_id = pr.id and r.org_id = pr.org_id and (mr.valid_until is null or mr.valid_until > now()) and r.side = 'buyer'),
        false) end
    from public.profiles pr
    join public.clients c on c.id = p_client_id and c.buyer_org_id = pr.org_id and c.link_status = 'active' and c.active
    join public.organizations s on s.id = c.supplier_org_id and s.status = 'active'
    where pr.id = (select auth.uid())), false);
$function$
;

-- ===== buyer_relations
CREATE OR REPLACE FUNCTION public.buyer_relations(p_permission text)
 RETURNS SETOF clients
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select c.* from public.profiles pr
  join public.clients c on c.buyer_org_id = pr.org_id and c.link_status = 'active' and c.active
  join public.organizations s on s.id = c.supplier_org_id and s.status = 'active'
  where pr.id = (select auth.uid()) and pr.role = 'customer' and pr.account_status = 'active'
    and public.buyer_relation_can(c.id, p_permission);
$function$
;

-- ===== buyer_request_return
CREATE OR REPLACE FUNCTION public.buyer_request_return(p_order_id uuid, p_items jsonb, p_reason text, p_description text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_previous uuid := public.buyer_use_client((select o.client_id from public.orders o where o.id = p_order_id), 'client.returns');
  v_result jsonb;
begin
  v_result := public.client_request_return(p_order_id, p_items, p_reason, p_description);
  perform public.buyer_restore_client(v_previous);
  return v_result;
end;
$function$
;

-- ===== buyer_respond_order
CREATE OR REPLACE FUNCTION public.buyer_respond_order(p_order_id uuid, p_accept boolean, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_previous uuid := public.buyer_use_client((select o.client_id from public.orders o where o.id = p_order_id), 'client.orders');
  v_result jsonb;
begin
  v_result := public.client_respond_order(p_order_id, p_accept, p_note);
  perform public.buyer_restore_client(v_previous);
  return v_result;
end;
$function$
;

-- ===== buyer_restore_client
CREATE OR REPLACE FUNCTION public.buyer_restore_client(p_previous uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set client_id = p_previous where id = auth.uid();
  perform set_config('appro.link_write', 'off', true);
end;
$function$
;

-- ===== buyer_returns
CREATE OR REPLACE FUNCTION public.buyer_returns()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'return_number', r.return_number, 'client_id', r.client_id, 'order_id', r.order_id, 'status', r.status, 'reason', r.reason,
      'description', r.description, 'staff_note', r.staff_note, 'restocked', r.restocked, 'created_at', r.created_at, 'received_at', r.received_at,
      'supplier_name', s.name,
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
$function$
;

-- ===== buyer_save_recurring
CREATE OR REPLACE FUNCTION public.buyer_save_recurring(p_client_id uuid, p_id uuid, p_items jsonb, p_delivery_point_id uuid, p_weekdays integer[], p_lead_days integer DEFAULT 1, p_note text DEFAULT NULL::text, p_active boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_client uuid := coalesce((select r.client_id from public.recurring_orders r where r.id = p_id), p_client_id);
  v_previous uuid := public.buyer_use_client(v_client, 'client.recurring');
  v_id uuid;
begin
  v_id := public.save_recurring_order(p_id, v_client, p_items, p_delivery_point_id, p_weekdays, p_lead_days, p_note, p_active);
  perform public.buyer_restore_client(v_previous);
  return v_id;
end;
$function$
;

-- ===== buyer_send_message
CREATE OR REPLACE FUNCTION public.buyer_send_message(p_client_ids uuid[], p_body text, p_attachment jsonb DEFAULT NULL::jsonb, p_needs_reply boolean DEFAULT false, p_reply_to uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := public.active_uid();
  v_current uuid;
  v_id uuid;
  v_results jsonb := '[]'::jsonb;
begin
  if v_uid is null or coalesce(array_length(p_client_ids, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'Choisissez au moins un destinataire.';
  end if;
  if array_length(p_client_ids, 1) > 1 and (p_attachment is not null or p_reply_to is not null) then
    raise exception using errcode = '22023', message = 'Une pièce jointe ou une réponse ne part qu’à un seul fournisseur.';
  end if;
  select pr.client_id into v_current from public.profiles pr where pr.id = v_uid;
  foreach v_id in array p_client_ids loop
    if not exists (select 1 from public.buyer_relations('client.messages') c where c.id = v_id) then
      raise exception using errcode = '42501', message = 'Un des destinataires ne fait pas partie de vos fournisseurs.';
    end if;
    perform set_config('appro.link_write', 'on', true);
    update public.profiles set client_id = v_id where id = v_uid;
    perform set_config('appro.link_write', 'off', true);
    v_results := v_results || jsonb_build_array(public.send_message_v3(v_id, p_body, p_attachment, p_needs_reply, p_reply_to));
  end loop;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set client_id = v_current where id = v_uid;
  perform set_config('appro.link_write', 'off', true);
  return v_results;
end;
$function$
;

-- ===== buyer_thread
CREATE OR REPLACE FUNCTION public.buyer_thread(p_client_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (select 1 from public.buyer_relations('client.messages') c where c.id = p_client_id) then
    raise exception using errcode = '42501', message = 'Conversation introuvable.';
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.messages set read_at = now() where client_id = p_client_id and from_staff and read_at is null;
  perform set_config('appro.link_write', 'off', true);
  return coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at desc)
    from (select * from public.messages x where x.client_id = p_client_id order by x.created_at desc limit 200) m), '[]'::jsonb);
end;
$function$
;

-- ===== buyer_use_client
CREATE OR REPLACE FUNCTION public.buyer_use_client(p_client_id uuid, p_permission text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_previous uuid;
begin
  if p_client_id is null or not exists (select 1 from public.buyer_relations(p_permission) c where c.id = p_client_id) then
    raise exception using errcode = '42501', message = 'Ce fournisseur ne vous permet pas cette action.';
  end if;
  select pr.client_id into v_previous from public.profiles pr where pr.id = auth.uid();
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set client_id = p_client_id where id = auth.uid();
  perform set_config('appro.link_write', 'off', true);
  return v_previous;
end;
$function$
;

-- ===== can_access_attachment
CREATE OR REPLACE FUNCTION public.can_access_attachment(p_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_parts text[] := string_to_array(coalesce(p_name, ''), '/');
  v_id uuid;
begin
  if array_length(v_parts, 1) < 3 then
    return false;
  end if;
  begin
    v_id := v_parts[2]::uuid;
  exception when others then
    return false;
  end;
  if v_parts[1] = 'client' then
    return public.has_feature('messages.manage') or (v_id = public.current_client_id() and public.has_feature('client.messages'));
  elsif v_parts[1] = 'team' then
    return public.is_team_conversation_member(v_id);
  end if;
  return false;
end;
$function$
;

-- ===== can_manage_org_roles
CREATE OR REPLACE FUNCTION public.can_manage_org_roles(p_org_id uuid, p_edit boolean)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.platform_can('platform.pros.manage')
      or (not p_edit and public.platform_can('platform.roles.assign'))
      or ((public.is_admin() or public.is_org_owner(p_org_id)) and public.current_org_id() = p_org_id);
$function$
;

-- ===== can_moderate_messages
CREATE OR REPLACE FUNCTION public.can_moderate_messages()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.profiles pr
    where pr.id = (select auth.uid()) and pr.role in ('admin', 'supervisor', 'staff') and pr.account_status = 'active'
  );
$function$
;

-- ===== can_see_account
CREATE OR REPLACE FUNCTION public.can_see_account(p_client_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (public.org_visible(public.client_org(p_client_id))
          and (public.has_feature('invoices.manage') or (p_client_id = public.current_client_id() and public.has_feature('client.invoices'))))
      or public.buyer_relation_can(p_client_id, 'client.invoices');
$function$
;

-- ===== clean_attachment
CREATE OR REPLACE FUNCTION public.clean_attachment(p_attachment jsonb, p_folder text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
begin
  if p_attachment is null or p_attachment = 'null'::jsonb then
    return null;
  end if;
  if jsonb_typeof(p_attachment) <> 'object' or coalesce(p_attachment ->> 'path', '') not like p_folder || '/%'
     or coalesce(p_attachment ->> 'kind', '') not in ('image', 'video', 'audio', 'file') then
    raise exception using errcode = '22023', message = 'Pièce jointe invalide.';
  end if;
  return jsonb_build_object(
    'path', p_attachment ->> 'path',
    'kind', p_attachment ->> 'kind',
    'name', left(coalesce(nullif(p_attachment ->> 'name', ''), 'fichier'), 120),
    'size', coalesce((p_attachment ->> 'size')::bigint, 0),
    'mime', left(coalesce(p_attachment ->> 'mime', ''), 100)
  );
end;
$function$
;

-- ===== clear_needs_reply
CREATE OR REPLACE FUNCTION public.clear_needs_reply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.messages set needs_reply = false
  where client_id = new.client_id and needs_reply and from_staff <> new.from_staff and created_at <= new.created_at;
  return new;
end;
$function$
;

-- ===== clear_team_needs_reply
CREATE OR REPLACE FUNCTION public.clear_team_needs_reply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.team_messages set needs_reply = false
  where conversation_id = new.conversation_id and needs_reply and sender_id is distinct from new.sender_id and created_at <= new.created_at;
  return new;
end;
$function$
;

-- ===== client_cancel_order
CREATE OR REPLACE FUNCTION public.client_cancel_order(p_order_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order public.orders%rowtype := public.buyer_pending_order(p_order_id);
  v_note text := coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Annulée par le client avant acceptation.');
begin
  perform public.release_order_stock(v_order.id);
  update public.orders set status = 'cancelled', status_note = v_note, stock_reserved = false, updated_at = now() where id = v_order.id;
  insert into public.order_status_history (order_id, status, note, changed_by) values (v_order.id, 'cancelled', v_note, auth.uid());
  update public.payments set status = 'cancelled' where order_id = v_order.id and status = 'pending';
  perform public.notify(array(select public.team_with_feature('orders.decide', v_order.supplier_org_id)), 'order.status',
    format('Commande #%s annulée par le client', v_order.order_number), v_note, v_order.id);
  return jsonb_build_object('id', v_order.id, 'status', 'cancelled');
end;
$function$
;

-- ===== client_create_claim
CREATE OR REPLACE FUNCTION public.client_create_claim(p_order_id uuid, p_reason text, p_description text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== client_invoice_snapshot
CREATE OR REPLACE FUNCTION public.client_invoice_snapshot(p_client_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'business_name', c.business_name,
    'contact_name', c.contact_name,
    'client_number', c.client_number,
    'email', c.email,
    'phone', c.phone,
    'tax_id', c.tax_id,
    'address', (select dp.address_line || ', ' || dp.city from public.client_delivery_points dp
                where dp.client_id = c.id and dp.active order by dp.created_at limit 1)
  )
  from public.clients c where c.id = p_client_id;
$function$
;

-- ===== client_modify_order
CREATE OR REPLACE FUNCTION public.client_modify_order(p_order_id uuid, p_items jsonb, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order public.orders%rowtype := public.buyer_pending_order(p_order_id);
  v_stock boolean;
  v_item record;
  v_product public.products%rowtype;
  v_subtotal numeric(12,3) := 0;
  v_line numeric(12,3);
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'La commande est vide : annulez-la plutôt.';
  end if;
  v_stock := v_order.stock_reserved;
  perform public.release_order_stock(v_order.id);
  delete from public.order_items where order_id = v_order.id;
  for v_item in
    select (line.value ->> 'product_id')::uuid as product_id, sum((line.value ->> 'quantity')::numeric)::numeric(12,3) as quantity
    from jsonb_array_elements(p_items) as line(value) group by 1 order by 1
  loop
    if v_item.product_id is null or v_item.quantity is null or v_item.quantity <= 0 or v_item.quantity > 100000 then
      raise exception using errcode = '22023', message = 'Une quantité de la commande est invalide.';
    end if;
    select p.* into v_product from public.products p where p.id = v_item.product_id for update;
    if not found or not v_product.active or v_product.org_id is distinct from v_order.supplier_org_id then
      raise exception using errcode = 'P0002', message = 'Un produit de la commande n’est plus disponible chez ce fournisseur.';
    end if;
    if v_stock and v_product.stock_quantity < v_item.quantity then
      raise exception using errcode = '22023', message = format('Stock insuffisant pour %s (disponible : %s).', v_product.name, v_product.stock_quantity);
    end if;
    v_line := round(v_product.price * v_item.quantity, 3);
    v_subtotal := v_subtotal + v_line;
    insert into public.order_items (order_id, product_id, product_name_snapshot, unit_snapshot, unit_price, quantity, line_total, vat_rate, origin_snapshot)
    values (v_order.id, v_product.id, v_product.name, v_product.unit_label, v_product.price, v_item.quantity, v_line, v_product.vat_rate,
      nullif(jsonb_strip_nulls(jsonb_build_object('producer', nullif(btrim(v_product.origin_producer), ''), 'region', nullif(btrim(v_product.origin_region), ''),
        'label', nullif(btrim(v_product.origin_label), ''), 'note', nullif(btrim(v_product.origin_note), ''))), '{}'::jsonb));
    if v_stock then
      update public.products set stock_quantity = stock_quantity - v_item.quantity, updated_at = now() where id = v_product.id;
    end if;
  end loop;
  update public.orders set subtotal = v_subtotal, total = v_subtotal + coalesce(delivery_fee, 0),
    customer_note = case when p_note is null then customer_note else nullif(btrim(p_note), '') end, updated_at = now()
  where id = v_order.id;
  update public.payments set amount = v_subtotal + coalesce(v_order.delivery_fee, 0) where order_id = v_order.id and status = 'pending';
  perform public.apply_order_pricing(v_order.id);
  v_subtotal := (select o.total from public.orders o where o.id = v_order.id);
  insert into public.order_status_history (order_id, status, note, changed_by) values (v_order.id, 'pending', 'Commande modifiée par le client.', auth.uid());
  perform public.notify(array(select public.team_with_feature('orders.decide', v_order.supplier_org_id)), 'order.new',
    format('Commande #%s modifiée par le client', v_order.order_number), 'Vérifiez les nouvelles quantités avant de l’accepter.', v_order.id);
  return jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number, 'total', v_subtotal);
end;
$function$
;

-- ===== client_org
CREATE OR REPLACE FUNCTION public.client_org(p_client_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select c.supplier_org_id from public.clients c where c.id = p_client_id; $function$
;

-- ===== client_request_return
CREATE OR REPLACE FUNCTION public.client_request_return(p_order_id uuid, p_items jsonb, p_reason text, p_description text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== client_respond_order
CREATE OR REPLACE FUNCTION public.client_respond_order(p_order_id uuid, p_accept boolean, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_customer_id uuid := auth.uid();
  v_client_id uuid := public.current_client_id();
  v_client public.clients%rowtype;
  v_order public.orders%rowtype;
  v_line record;
  v_product public.products%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_client_id is null then
    raise exception using errcode = '42501', message = 'Votre compte n’est rattaché à aucune fiche client.';
  end if;
  select c.* into v_client from public.clients c where c.id = v_client_id;

  select o.* into v_order from public.orders o where o.id = p_order_id and o.client_id = v_client_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
  if v_order.status <> 'awaiting_client' then
    raise exception using errcode = '22023', message = 'Cette commande n’attend pas votre confirmation.';
  end if;

  if p_accept then
    if (v_client.stock_managed and public.module_enabled_for(v_client.supplier_org_id, 'stock')) then
      for v_line in
        select oi.product_id, sum(oi.quantity) as quantity, min(oi.product_name_snapshot) as name
        from public.order_items oi where oi.order_id = p_order_id
        group by oi.product_id order by oi.product_id
      loop
        if v_line.product_id is null then
          raise exception using errcode = 'P0002', message = format('%s n’est plus disponible : contactez votre fournisseur.', v_line.name);
        end if;
        select p.* into v_product from public.products p where p.id = v_line.product_id for update;
        if not found or not v_product.active or v_product.stock_quantity < v_line.quantity then
          raise exception using errcode = '22023', message = format('Stock insuffisant pour %s : contactez votre fournisseur.', v_line.name);
        end if;
        update public.products set stock_quantity = stock_quantity - v_line.quantity, updated_at = now()
        where id = v_line.product_id;
      end loop;
    end if;

    update public.orders
    set status = 'confirmed', status_note = null, stock_reserved = (v_client.stock_managed and public.module_enabled_for(v_client.supplier_org_id, 'stock')),
        production_rank = (select coalesce(max(q.production_rank), 0) + 1 from public.orders q
                           where q.status in ('confirmed', 'preparing', 'ready') and q.id <> p_order_id),
        updated_at = now()
    where id = p_order_id;
    insert into public.order_status_history (order_id, status, note, changed_by)
    values (p_order_id, 'confirmed', coalesce(v_note, 'Commande reconfirmée par le client.'), v_customer_id);
    update public.payments set status = 'pending' where order_id = p_order_id and status = 'cancelled';

    if v_order.client_invoice_id is null and v_client.invoice_mode = 'auto' then
      perform public.create_client_invoice(v_client_id, array[p_order_id], v_customer_id, false);
    end if;
  else
    update public.orders set status = 'cancelled', status_note = v_note, updated_at = now() where id = p_order_id;
    insert into public.order_status_history (order_id, status, note, changed_by)
    values (p_order_id, 'cancelled', coalesce(v_note, 'Refusée par le client.'), v_customer_id);
  end if;

  return jsonb_build_object('id', p_order_id, 'status', case when p_accept then 'confirmed' else 'cancelled' end);
end;
$function$
;

-- ===== client_users
CREATE OR REPLACE FUNCTION public.client_users(p_client_id uuid)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(array_agg(pr.id), '{}'::uuid[]) from public.profiles pr where pr.client_id = p_client_id and pr.account_status = 'active';
$function$
;

-- ===== clients_fill_orgs
CREATE OR REPLACE FUNCTION public.clients_fill_orgs()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.supplier_org_id is null then
    new.supplier_org_id := coalesce(public.current_org_id(), public.legacy_org_id());
  end if;
  if new.buyer_org_id is null then
    insert into public.organizations (name, is_supplier, is_buyer, status, phone, email, created_by)
    values (new.business_name, false, true,
            case when (select auth.uid()) is null or public.platform_role() is not null then (case when new.active then 'active' else 'suspended' end) else 'pending' end,
            coalesce(new.phone, ''), coalesce(new.email, ''), (select auth.uid()))
    returning id into new.buyer_org_id;
  end if;
  return new;
end;
$function$
;

-- ===== clients_only_by_link
CREATE OR REPLACE FUNCTION public.clients_only_by_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (select auth.uid()) is null or public.org_write_guard_bypassed() or public.platform_role() is not null then
    return new;
  end if;
  raise exception using errcode = '42501', message = 'Les clients se choisissent dans l’annuaire des Pros validés (Réseau).';
end;
$function$
;

-- ===== create_client_invoice
CREATE OR REPLACE FUNCTION public.create_client_invoice(p_client_id uuid, p_order_ids uuid[], p_created_by uuid, p_draft boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_invoice_id uuid;
begin
  if not exists (select 1 from public.clients c where c.id = p_client_id) then
    raise exception using errcode = 'P0002', message = 'Client introuvable.';
  end if;

  insert into public.client_invoices (
    invoice_number, client_id, status, client_snapshot, total_ht, total_vat, stamp_duty, total_ttc, created_by
  ) values (
    null, p_client_id, 'draft', public.client_invoice_snapshot(p_client_id), 0, 0, 1, 1, p_created_by
  ) returning id into v_invoice_id;

  perform public.attach_invoice_orders(v_invoice_id, p_client_id, p_order_ids);
  if not p_draft then
    perform public.issue_invoice(v_invoice_id);
  end if;
  return v_invoice_id;
end;
$function$
;

-- ===== create_client_order
CREATE OR REPLACE FUNCTION public.create_client_order(p_client_id uuid, p_customer_id uuid, p_actor_id uuid, p_items jsonb, p_delivery_point_id uuid, p_requested_date date, p_note text, p_history_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_customer_id uuid := p_customer_id;
  v_client public.clients%rowtype;
  v_point public.client_delivery_points%rowtype;
  v_point_count int;
  v_item record;
  v_product public.products%rowtype;
  v_line_total numeric(12,3);
  v_subtotal numeric(12,3) := 0;
  v_lines jsonb := '[]'::jsonb;
  v_order_id uuid;
  v_order_number bigint;
begin
  select c.* into v_client from public.clients c where c.id = p_client_id and c.active;
  if not found then
    raise exception using errcode = 'P0002', message = 'Fiche client introuvable ou inactive.';
  end if;

  select count(*) into v_point_count
  from public.client_delivery_points dp
  where dp.client_id = v_client.id and dp.active;

  if p_delivery_point_id is null and v_point_count = 1 then
    select dp.* into v_point from public.client_delivery_points dp
    where dp.client_id = v_client.id and dp.active;
  elsif p_delivery_point_id is not null then
    select dp.* into v_point from public.client_delivery_points dp
    where dp.id = p_delivery_point_id and dp.client_id = v_client.id and dp.active;
  end if;
  if v_point.id is null then
    raise exception using errcode = '22023', message = case when v_point_count = 0
      then 'Aucun point de livraison n’est configuré sur votre fiche. Contactez votre fournisseur.'
      else 'Choisissez un point de livraison.' end;
  end if;

  if p_requested_date is not null and p_requested_date < (now() at time zone 'Africa/Tunis')::date then
    raise exception using errcode = '22023', message = 'La date de livraison souhaitée est déjà passée.';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'La commande est vide.';
  end if;

  for v_item in
    select
      (line.value ->> 'product_id')::uuid as product_id,
      sum((line.value ->> 'quantity')::numeric)::numeric(12,3) as quantity
    from jsonb_array_elements(p_items) as line(value)
    group by 1
    order by 1
  loop
    if v_item.product_id is null or v_item.quantity is null or v_item.quantity <= 0 or v_item.quantity > 100000 then
      raise exception using errcode = '22023', message = 'Une quantité de la commande est invalide.';
    end if;

    select p.* into v_product from public.products p where p.id = v_item.product_id for update;
    if not found or not v_product.active then
      raise exception using errcode = 'P0002', message = 'Un produit de la commande n’est plus disponible.';
    end if;
    if (v_client.stock_managed and public.module_enabled_for(v_client.supplier_org_id, 'stock')) and v_product.stock_quantity < v_item.quantity then
      raise exception using errcode = '22023', message = format('Stock insuffisant pour %s (disponible : %s).', v_product.name, v_product.stock_quantity);
    end if;

    v_line_total := round(v_product.price * v_item.quantity, 3);
    v_subtotal := v_subtotal + v_line_total;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id, 'name', v_product.name, 'unit', v_product.unit_label,
      'unit_price', v_product.price, 'quantity', v_item.quantity, 'line_total', v_line_total,
      'vat_rate', v_product.vat_rate,
      'origin', nullif(jsonb_strip_nulls(jsonb_build_object(
        'producer', nullif(btrim(v_product.origin_producer), ''),
        'region', nullif(btrim(v_product.origin_region), ''),
        'label', nullif(btrim(v_product.origin_label), ''),
        'note', nullif(btrim(v_product.origin_note), '')
      )), '{}'::jsonb)
    ));
  end loop;

  insert into public.orders (
    customer_id, client_id, delivery_point_id, requested_delivery_date, status,
    address_snapshot, subtotal, delivery_fee, total, currency, customer_note, stock_reserved
  ) values (
    v_customer_id, v_client.id, v_point.id, p_requested_date, 'pending',
    jsonb_build_object(
      'business_name', v_client.business_name,
      'recipient_name', coalesce(nullif(v_client.contact_name, ''), v_client.business_name),
      'phone', coalesce(nullif(v_point.phone, ''), v_client.phone),
      'point_label', v_point.label,
      'address_line', v_point.address_line,
      'city', v_point.city,
      'notes', v_point.instructions
    ),
    v_subtotal, 0, v_subtotal, 'TND', nullif(btrim(coalesce(p_note, '')), ''), (v_client.stock_managed and public.module_enabled_for(v_client.supplier_org_id, 'stock'))
  ) returning id, order_number into v_order_id, v_order_number;

  for v_item in select line.value from jsonb_array_elements(v_lines) as line(value)
  loop
    insert into public.order_items (
      order_id, product_id, product_name_snapshot, unit_snapshot, unit_price, quantity, line_total, vat_rate, origin_snapshot
    ) values (
      v_order_id,
      (v_item.value ->> 'product_id')::uuid,
      v_item.value ->> 'name',
      v_item.value ->> 'unit',
      (v_item.value ->> 'unit_price')::numeric,
      (v_item.value ->> 'quantity')::numeric,
      (v_item.value ->> 'line_total')::numeric,
      (v_item.value ->> 'vat_rate')::numeric,
      case when jsonb_typeof(v_item.value -> 'origin') = 'object' then v_item.value -> 'origin' end
    );
    if (v_client.stock_managed and public.module_enabled_for(v_client.supplier_org_id, 'stock')) then
      update public.products
      set stock_quantity = stock_quantity - (v_item.value ->> 'quantity')::numeric, updated_at = now()
      where id = (v_item.value ->> 'product_id')::uuid;
    end if;
  end loop;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (v_order_id, 'pending', p_history_note, p_actor_id);

  insert into public.payments (order_id, method, status, amount, currency)
  values (v_order_id, 'cash_on_delivery', 'pending', v_subtotal, 'TND');

  perform public.apply_order_pricing(v_order_id);
  perform public.auto_accept_order(v_order_id);
  return jsonb_build_object('id', v_order_id, 'order_number', v_order_number, 'total', (select o.total from public.orders o where o.id = v_order_id), 'status', (select o.status from public.orders o where o.id = v_order_id));
end;
$function$
;

-- ===== create_invitation
CREATE OR REPLACE FUNCTION public.create_invitation(p_side text, p_client_id uuid DEFAULT NULL::uuid, p_name text DEFAULT NULL::text, p_contact text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org public.organizations%rowtype;
  v_code text;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  select * into v_org from public.organizations where id = public.current_org_id();
  if v_org.id is null then
    raise exception using errcode = '42501', message = 'Votre espace doit être actif pour inviter.';
  end if;
  if p_side = 'client' and not v_org.is_supplier then
    raise exception using errcode = '22023', message = 'Seul un fournisseur invite des clients.';
  elsif p_side = 'supplier' and not v_org.is_buyer then
    raise exception using errcode = '22023', message = 'Seul un acheteur invite des fournisseurs.';
  elsif p_side not in ('client', 'supplier') then
    raise exception using errcode = '22023', message = 'Précisez qui vous invitez.';
  end if;
  if p_client_id is not null then
    if p_side <> 'client' or not exists (select 1 from public.clients c where c.id = p_client_id and c.supplier_org_id = v_org.id) then
      raise exception using errcode = 'P0002', message = 'Client introuvable.';
    end if;
    v_name := coalesce(v_name, (select c.business_name from public.clients c where c.id = p_client_id));
  end if;
  -- The same invitation is reused while it is valid (one per client record, one per person invited).
  select i.code into v_code from public.invitations i
  where i.org_id = v_org.id and i.side = p_side and i.client_id is not distinct from p_client_id and i.expires_at > now() + interval '7 days'
    and (p_client_id is not null or (i.invited_by = auth.uid() and i.name is not distinct from v_name))
  order by i.created_at desc limit 1;
  if v_code is null then
    loop
      v_code := upper(substr(md5(random()::text || clock_timestamp()::text || coalesce(auth.uid()::text, '')), 1, 8));
      exit when not exists (select 1 from public.invitations i where i.code = v_code);
    end loop;
    insert into public.invitations (code, org_id, invited_by, side, client_id, name, contact)
    values (v_code, v_org.id, auth.uid(), p_side, p_client_id, v_name, nullif(btrim(coalesce(p_contact, '')), ''));
  end if;
  return jsonb_build_object('code', v_code, 'org_name', v_org.name, 'side', p_side, 'name', v_name,
    'app_url', coalesce(public.platform_setting('app_url') #>> '{}', ''));
end;
$function$
;

-- ===== create_order_receipt
CREATE OR REPLACE FUNCTION public.create_order_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.invoices (
    order_id, invoice_number, issued_at, currency, subtotal, tax_total, delivery_fee, total
  ) values (
    new.id,
    'AF-' || to_char(new.created_at, 'YYYY') || '-' || lpad(new.order_number::text, 8, '0'),
    new.created_at,
    new.currency,
    new.subtotal,
    0,
    new.delivery_fee,
    new.total
  )
  on conflict (order_id) do nothing;
  return new;
end;
$function$
;

-- ===== create_return
CREATE OR REPLACE FUNCTION public.create_return(p_order_id uuid, p_items jsonb, p_reason text, p_description text, p_actor uuid, p_status text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== current_client_id
CREATE OR REPLACE FUNCTION public.current_client_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pr.client_id from public.profiles pr where pr.id = (select auth.uid()) and pr.account_status = 'active';
$function$
;

-- ===== current_org_id
CREATE OR REPLACE FUNCTION public.current_org_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pr.org_id from public.profiles pr join public.organizations o on o.id = pr.org_id
  where pr.id = (select auth.uid()) and pr.account_status = 'active' and o.status = 'active';
$function$
;

-- ===== decide_leave
CREATE OR REPLACE FUNCTION public.decide_leave(p_id uuid, p_action text, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_leave public.leave_requests%rowtype;
begin
  select l.* into v_leave from public.leave_requests l where l.id = p_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Demande introuvable.';
  end if;
  if p_action = 'cancel' then
    if v_leave.user_id <> auth.uid() and not public.has_feature('leave.manage') then
      raise exception using errcode = '42501', message = 'Vous ne pouvez annuler que vos demandes.';
    end if;
    update public.leave_requests set status = 'cancelled', decided_at = now() where id = p_id;
    return;
  end if;
  if not public.has_feature('leave.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de valider les congés.';
  end if;
  if v_leave.user_id = auth.uid() and not public.is_admin() then
    raise exception using errcode = '42501', message = 'Votre propre demande doit être validée par une autre personne.';
  end if;
  if v_leave.status <> 'pending' or p_action not in ('approve', 'refuse') then
    raise exception using errcode = '22023', message = 'Cette demande a déjà été traitée.';
  end if;
  update public.leave_requests
  set status = case when p_action = 'approve' then 'approved' else 'refused' end,
      decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_id;
  perform public.notify(array[v_leave.user_id], 'leave.decision',
    format('Congé du %s : %s', to_char(v_leave.start_date, 'DD/MM'), case when p_action = 'approve' then 'accepté' else 'refusé' end),
    coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Consultez vos demandes dans Plus → Congés.'), null);
end;
$function$
;

-- ===== default_org_id
CREATE OR REPLACE FUNCTION public.default_org_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(public.current_org_id(), public.legacy_org_id());
$function$
;

-- ===== delete_recurring_order
CREATE OR REPLACE FUNCTION public.delete_recurring_order(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  delete from public.recurring_orders r
  where r.id = p_id and (r.client_id = public.current_client_id() or public.has_feature('orders.create'));
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande récurrente introuvable.';
  end if;
end;
$function$
;

-- ===== deliver_notification
CREATE OR REPLACE FUNCTION public.deliver_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    raise warning 'Appro+ notification delivery failed: %', sqlerrm;
  end;
  return new;
end;
$function$
;

-- ===== driver_confirm_delivery
CREATE OR REPLACE FUNCTION public.driver_confirm_delivery(p_qr_token uuid, p_order_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_driver_id uuid := auth.uid();
  v_point_id uuid;
  v_requested int;
  v_matching int;
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs.';
  end if;

  select dp.id into v_point_id from public.client_delivery_points dp where dp.qr_token = p_qr_token;
  if not found then
    raise exception using errcode = 'P0002', message = 'QR code inconnu.';
  end if;

  select count(distinct id) into v_requested from unnest(p_order_ids) as t(id);
  if v_requested = 0 then
    raise exception using errcode = '22023', message = 'Sélectionnez au moins une commande.';
  end if;

  -- Lock the selected orders, then check they are all shipped to this point.
  perform 1 from public.orders o where o.id = any(p_order_ids) order by o.id for update;
  select count(*) into v_matching
  from public.orders o
  where o.id = any(p_order_ids) and o.delivery_point_id = v_point_id and o.status = 'out_for_delivery';
  if v_matching <> v_requested then
    raise exception using errcode = '22023', message = 'Une commande sélectionnée n’est pas expédiée vers ce point de livraison.';
  end if;

  update public.orders
  set status = 'delivered', delivered_at = now(), delivered_by = v_driver_id, updated_at = now()
  where id = any(p_order_ids);

  insert into public.order_status_history (order_id, status, note, changed_by)
  select o.id, 'delivered', 'Livraison confirmée par scan du QR code.', v_driver_id
  from public.orders o where o.id = any(p_order_ids);

  update public.payments set status = 'paid'
  where order_id = any(p_order_ids) and method = 'cash_on_delivery' and status = 'pending';

  return v_matching;
end;
$function$
;

-- ===== driver_confirm_handover
CREATE OR REPLACE FUNCTION public.driver_confirm_handover(p_delivery_tokens uuid[], p_client_qr_kind text, p_client_qr_token uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_driver_id uuid := auth.uid();
  v_requested int;
  v_matching int;
  v_clients int;
  v_points int;
  v_client_id uuid;
  v_point_id uuid;
  v_client public.clients%rowtype;
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs.';
  end if;

  select count(distinct token) into v_requested from unnest(p_delivery_tokens) as t(token);
  if v_requested = 0 then
    raise exception using errcode = '22023', message = 'Scannez au moins un bon de livraison.';
  end if;

  perform 1 from public.orders o where o.delivery_token = any(p_delivery_tokens) order by o.id for update;
  select count(*), count(distinct o.client_id), count(distinct o.delivery_point_id),
         (array_agg(o.client_id))[1], (array_agg(o.delivery_point_id))[1]
  into v_matching, v_clients, v_points, v_client_id, v_point_id
  from public.orders o
  where o.delivery_token = any(p_delivery_tokens) and o.status = 'out_for_delivery';

  if v_matching <> v_requested then
    raise exception using errcode = '22023', message = 'Un bon de livraison scanné n’est pas (ou plus) en cours de livraison.';
  end if;
  if v_clients <> 1 then
    raise exception using errcode = '22023', message = 'Les bons scannés concernent plusieurs clients : livrez-les séparément.';
  end if;

  select c.* into v_client from public.clients c where c.id = v_client_id;
  if (v_client.reception_qr and public.module_enabled_for(v_client.supplier_org_id, 'delivery_qr')) then
    if p_client_qr_kind is distinct from 'client' or p_client_qr_token is distinct from v_client.reception_token then
      raise exception using errcode = '22023', message = 'QR client invalide : demandez au client d’afficher son QR de réception dans l’application Appro+.';
    end if;
  else
    if v_points <> 1 then
      raise exception using errcode = '22023', message = 'Les bons scannés concernent plusieurs points de livraison : livrez-les séparément.';
    end if;
    if p_client_qr_kind is distinct from 'point' or not exists (
      select 1 from public.client_delivery_points dp where dp.id = v_point_id and dp.qr_token = p_client_qr_token
    ) then
      raise exception using errcode = '22023', message = 'Le QR scanné ne correspond pas au point de livraison de ces commandes.';
    end if;
  end if;

  update public.orders
  set status = 'delivered', delivered_at = now(), delivered_by = v_driver_id, updated_at = now()
  where delivery_token = any(p_delivery_tokens);

  insert into public.order_status_history (order_id, status, note, changed_by)
  select o.id, 'delivered',
         case when (v_client.reception_qr and public.module_enabled_for(v_client.supplier_org_id, 'delivery_qr')) then 'Livraison confirmée : bon de livraison + QR de réception du client.'
              else 'Livraison confirmée : bon de livraison + QR du point de livraison.' end,
         v_driver_id
  from public.orders o where o.delivery_token = any(p_delivery_tokens);

  update public.payments p set status = 'paid'
  from public.orders o
  where o.delivery_token = any(p_delivery_tokens) and p.order_id = o.id
    and p.method = 'cash_on_delivery' and p.status = 'pending';

  return v_matching;
end;
$function$
;

-- ===== driver_deliver
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
         when (v_client.reception_qr and public.module_enabled_for(v_client.supplier_org_id, 'delivery_qr')) then 'QR de réception du client'
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

-- ===== driver_deliver_v2
CREATE OR REPLACE FUNCTION public.driver_deliver_v2(p_order_ids uuid[], p_delivery_tokens uuid[], p_client_qr_kind text DEFAULT NULL::text, p_client_qr_token uuid DEFAULT NULL::uuid, p_signature jsonb DEFAULT NULL::jsonb, p_signer text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ids uuid[];
  v_needs boolean;
  v_count int;
begin
  select array_agg(o.id) into v_ids from public.orders o
  where o.id = any(coalesce(p_order_ids, '{}'::uuid[])) or o.delivery_token = any(coalesce(p_delivery_tokens, '{}'::uuid[]));
  select bool_or((c.delivery_signature and public.module_enabled_for(c.supplier_org_id, 'signature'))) into v_needs from public.orders o join public.clients c on c.id = o.client_id where o.id = any(coalesce(v_ids, '{}'::uuid[]));
  if p_signature is not null and (jsonb_typeof(p_signature) <> 'object' or char_length(coalesce(p_signature ->> 'path', '')) not between 10 and 60000) then
    raise exception using errcode = '22023', message = 'Signature invalide.';
  end if;
  if coalesce(v_needs, false) and p_signature is null then
    raise exception using errcode = '22023', message = 'Ce client signe à la livraison : faites signer sur l’écran.';
  end if;
  v_count := public.driver_deliver(p_order_ids, p_delivery_tokens, p_client_qr_kind, p_client_qr_token);
  if p_signature is not null then
    update public.orders
    set delivery_signature = jsonb_build_object('path', p_signature ->> 'path', 'width', coalesce((p_signature ->> 'width')::numeric, 300),
          'height', coalesce((p_signature ->> 'height')::numeric, 150), 'signer', left(nullif(btrim(coalesce(p_signer, '')), ''), 80), 'signed_at', now())
    where id = any(v_ids);
    update public.order_status_history h set note = h.note || ' Signé par ' || coalesce(nullif(btrim(coalesce(p_signer, '')), ''), 'le client') || '.'
    where h.order_id = any(v_ids) and h.status = 'delivered' and h.created_at > now() - interval '1 minute';
  end if;
  return v_count;
end;
$function$
;

-- ===== driver_deliver_v3
CREATE OR REPLACE FUNCTION public.driver_deliver_v3(p_order_ids uuid[], p_delivery_tokens uuid[], p_client_qr_kind text DEFAULT NULL::text, p_client_qr_token uuid DEFAULT NULL::uuid, p_signature jsonb DEFAULT NULL::jsonb, p_signer text DEFAULT NULL::text, p_deposit numeric DEFAULT NULL::numeric, p_deposit_method text DEFAULT 'cash'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ids uuid[];
  v_count int;
  v_client uuid;
  v_org uuid;
  v_refs text;
  v_amount numeric := round(coalesce(p_deposit, 0), 3);
  v_left numeric;
  v_invoice record;
  v_part numeric;
  v_method text := coalesce(nullif(p_deposit_method, ''), 'cash');
  v_words text;
begin
  if v_amount < 0 or v_amount > 10000000 then
    raise exception using errcode = '22023', message = 'Montant d’acompte invalide.';
  end if;
  if v_method not in ('cash', 'check', 'transfer', 'card', 'other') then
    raise exception using errcode = '22023', message = 'Mode de paiement inconnu.';
  end if;
  select array_agg(o.id order by o.order_number) into v_ids from public.orders o
  where o.id = any(coalesce(p_order_ids, '{}'::uuid[])) or o.delivery_token = any(coalesce(p_delivery_tokens, '{}'::uuid[]));
  v_count := public.driver_deliver_v2(p_order_ids, p_delivery_tokens, p_client_qr_kind, p_client_qr_token, p_signature, p_signer);
  v_left := v_amount;
  if v_amount > 0 then
    select (array_agg(o.client_id))[1], (array_agg(o.supplier_org_id))[1],
           string_agg(coalesce(o.delivery_note_number, '#' || o.order_number), ', ' order by o.order_number)
    into v_client, v_org, v_refs
    from public.orders o where o.id = any(v_ids);
    v_words := case v_method when 'cash' then 'espèces' when 'check' then 'chèque' when 'transfer' then 'virement' when 'card' then 'carte' else 'autre' end;
    insert into public.account_entries (client_id, kind, amount, method, entry_date, reference, note, created_by, order_id)
    values (v_client, 'deposit', v_amount, v_method, current_date, left(coalesce(v_refs, ''), 120),
            'Reçu par le livreur ' || coalesce((select nullif(btrim(pr.full_name), '') from public.profiles pr where pr.id = auth.uid()), '') || ' à la livraison.',
            auth.uid(), v_ids[1]);
    -- Applied at once to the invoices of these orders already issued; the rest stays on the account.
    for v_invoice in
      select distinct i.id, i.total_ttc - i.amount_paid as rest, i.issued_at
      from public.client_invoices i join public.orders o on o.client_invoice_id = i.id
      where o.id = any(v_ids) and i.status = 'issued'
      order by i.issued_at, i.id
    loop
      exit when v_left <= 0;
      v_part := least(v_left, round(v_invoice.rest, 3));
      if v_part > 0 then
        insert into public.invoice_payments (invoice_id, amount, method, paid_on, reference, created_by)
        values (v_invoice.id, v_part, 'deposit', current_date, 'Acompte reçu à la livraison', auth.uid());
        perform public.refresh_invoice_payment(v_invoice.id);
        v_left := v_left - v_part;
      end if;
    end loop;
    update public.order_status_history h
    set note = coalesce(h.note, '') || format(' Acompte reçu : %s TND (%s).', to_char(v_amount, 'FM999G999G990D000'), v_words)
    where h.order_id = any(v_ids) and h.status = 'delivered' and h.created_at > now() - interval '1 minute';
    perform public.notify(array(select public.team_with_feature('invoices.manage', v_org)), 'account.deposit',
      format('Acompte reçu à la livraison · %s TND', to_char(v_amount, 'FM999G999G990D000')),
      format('%s · %s · %s', (select c.business_name from public.clients c where c.id = v_client), coalesce(v_refs, ''), v_words), v_ids[1]);
  end if;
  return jsonb_build_object('count', v_count, 'deposit', v_amount, 'applied', v_amount - v_left);
end;
$function$
;

-- ===== driver_history
CREATE OR REPLACE FUNCTION public.driver_history(p_since date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
declare
  v_is_staff boolean := public.is_staff();
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs.';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'delivered_at', o.delivered_at,
      'client_id', c.id,
      'business_name', c.business_name,
      'point_label', dp.label,
      'address_line', dp.address_line,
      'city', dp.city,
      'total', o.total,
      'driver_name', pr.full_name,
      'shipment_number', s.shipment_number,
      'vehicle_label', v.label,
      'item_count', (select count(*) from public.order_items oi where oi.order_id = o.id)
    ) order by o.delivered_at desc)
    from (select * from (select * from public.orders where public.org_visible(supplier_org_id)) orders where public.org_visible(supplier_org_id)) o
    join (select * from (select * from public.clients where public.org_visible(supplier_org_id)) clients where public.org_visible(supplier_org_id)) c on c.id = o.client_id
    join public.client_delivery_points dp on dp.id = o.delivery_point_id
    left join public.profiles pr on pr.id = o.delivered_by
    left join public.shipments s on s.id = o.shipment_id
    left join public.vehicles v on v.id = s.vehicle_id
    where o.status = 'delivered'
      and o.delivered_at >= p_since
      and (v_is_staff or o.delivered_by = auth.uid())
  ), '[]'::jsonb);
end;
$function$
;

-- ===== driver_lookup_delivery
CREATE OR REPLACE FUNCTION public.driver_lookup_delivery(p_delivery_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
declare
  v_result jsonb;
  v_status public.order_status;
  v_number bigint;
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs.';
  end if;

  select o.status, o.order_number into v_status, v_number from (select * from (select * from public.orders where public.org_visible(supplier_org_id)) orders where public.org_visible(supplier_org_id)) o where o.delivery_token = p_delivery_token;
  if not found then
    raise exception using errcode = 'P0002', message = 'Bon de livraison inconnu.';
  end if;
  if v_status <> 'out_for_delivery' then
    raise exception using errcode = '22023', message = format('La commande #%s n’est pas en cours de livraison.', v_number);
  end if;

  select jsonb_build_object(
    'id', o.id,
    'order_number', o.order_number,
    'delivery_token', o.delivery_token,
    'client_id', c.id,
    'business_name', c.business_name,
    'reception_qr', (c.reception_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')),
    'scan_delivery_note', (c.scan_delivery_note and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')),
    'scan_client_qr', (c.scan_client_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')),
    'point_id', dp.id,
    'point_label', dp.label,
    'address_line', dp.address_line,
    'city', dp.city,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', oi.product_name_snapshot, 'quantity', oi.quantity, 'unit', oi.unit_snapshot
      )), '[]'::jsonb) from public.order_items oi where oi.order_id = o.id)
  ) into v_result
  from (select * from (select * from public.orders where public.org_visible(supplier_org_id)) orders where public.org_visible(supplier_org_id)) o
  join (select * from (select * from public.clients where public.org_visible(supplier_org_id)) clients where public.org_visible(supplier_org_id)) c on c.id = o.client_id
  join public.client_delivery_points dp on dp.id = o.delivery_point_id
  where o.delivery_token = p_delivery_token;

  return v_result;
end;
$function$
;

-- ===== driver_lookup_point
CREATE OR REPLACE FUNCTION public.driver_lookup_point(p_qr_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
declare
  v_point public.client_delivery_points%rowtype;
  v_client public.clients%rowtype;
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs.';
  end if;

  select dp.* into v_point from (select * from (select * from public.client_delivery_points where public.org_visible(public.client_org(client_id))) client_delivery_points where public.org_visible(public.client_org(client_id))) dp where dp.qr_token = p_qr_token;
  if not found then
    raise exception using errcode = 'P0002', message = 'QR code inconnu.';
  end if;
  select c.* into v_client from (select * from (select * from public.clients where public.org_visible(supplier_org_id)) clients where public.org_visible(supplier_org_id)) c where c.id = v_point.client_id;

  return jsonb_build_object(
    'point', jsonb_build_object(
      'id', v_point.id, 'label', v_point.label, 'address_line', v_point.address_line, 'city', v_point.city,
      'business_name', v_client.business_name, 'client_number', v_client.client_number
    ),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id,
        'order_number', o.order_number,
        'requested_delivery_date', o.requested_delivery_date,
        'total', o.total,
        'items', (select coalesce(jsonb_agg(jsonb_build_object(
            'name', oi.product_name_snapshot, 'quantity', oi.quantity, 'unit', oi.unit_snapshot
          )), '[]'::jsonb) from public.order_items oi where oi.order_id = o.id)
      ) order by o.order_number)
      from (select * from (select * from public.orders where public.org_visible(supplier_org_id)) orders where public.org_visible(supplier_org_id)) o
      where o.delivery_point_id = v_point.id and o.status = 'out_for_delivery'
    ), '[]'::jsonb)
  );
end;
$function$
;

-- ===== driver_pickups
CREATE OR REPLACE FUNCTION public.driver_pickups()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
begin
  if not public.has_feature('orders.ship') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas d’expédier les commandes.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number, 'planned_vehicle_id', o.planned_vehicle_id,
      'client_id', c.id,
      'requested_delivery_date', o.requested_delivery_date,
      'business_name', c.business_name,
      'point_label', dp.label,
      'address_line', dp.address_line,
      'city', dp.city,
      'phone', coalesce(nullif(dp.phone, ''), c.phone),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('name', oi.product_name_snapshot, 'quantity', oi.quantity, 'unit', oi.unit_snapshot)), '[]'::jsonb)
                from public.order_items oi where oi.order_id = o.id)
    ) order by o.requested_delivery_date nulls last, o.production_rank nulls last, o.order_number)
    from (select * from (select * from public.orders where public.org_visible(supplier_org_id)) orders where public.org_visible(supplier_org_id)) o
    join (select * from (select * from public.clients where public.org_visible(supplier_org_id)) clients where public.org_visible(supplier_org_id)) c on c.id = o.client_id
    join public.client_delivery_points dp on dp.id = o.delivery_point_id
    where o.status = 'ready'
  ), '[]'::jsonb);
end;
$function$
;

-- ===== driver_ship_orders
CREATE OR REPLACE FUNCTION public.driver_ship_orders(p_order_ids uuid[], p_vehicle_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := public.active_uid();
  v_count int;
  v_ready int;
  v_vehicle public.vehicles%rowtype;
  v_vehicle_text text := '';
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
  if p_vehicle_id is not null then
    select v.* into v_vehicle from public.vehicles v where v.id = p_vehicle_id and v.active;
    if not found then
      raise exception using errcode = 'P0002', message = 'Véhicule introuvable ou retiré de la flotte.';
    end if;
    v_vehicle_text := ' · ' || v_vehicle.label || case when v_vehicle.plate <> '' then ' (' || v_vehicle.plate || ')' else '' end;
  elsif exists (select 1 from public.vehicles v where v.active) then
    raise exception using errcode = '22023', message = 'Choisissez le véhicule utilisé pour cette expédition.';
  end if;

  perform 1 from public.orders o where o.id = any(p_order_ids) order by o.id for update;
  select count(*) into v_ready from public.orders o where o.id = any(p_order_ids) and o.status = 'ready';
  if v_ready <> v_count then
    raise exception using errcode = '22023', message = 'Une commande sélectionnée n’est plus prête à expédier : actualisez la liste.';
  end if;

  insert into public.shipments (vehicle_id, driver_id, order_count) values (p_vehicle_id, v_actor, v_count)
  returning id, shipment_number into v_shipment_id, v_number;
  update public.orders set status = 'out_for_delivery', shipment_id = v_shipment_id, production_rank = null, updated_at = now()
  where id = any(p_order_ids);
  insert into public.order_status_history (order_id, status, note, changed_by)
  select o.id, 'out_for_delivery', format('Expédition #%s%s', v_number, v_vehicle_text), v_actor
  from public.orders o where o.id = any(p_order_ids);
  -- A vehicle other than the one planned: traced on the order and the deciders are told.
  update public.order_status_history h set note = h.note || format(' · véhicule prévu : %s, remplacé par le livreur', pv.label)
  from public.orders o join public.vehicles pv on pv.id = o.planned_vehicle_id
  where h.order_id = o.id and o.id = any(p_order_ids) and h.status = 'out_for_delivery' and h.created_at > now() - interval '1 minute'
    and o.planned_vehicle_id is distinct from p_vehicle_id;
  perform public.notify(array(select public.team_with_feature('orders.decide', o.supplier_org_id)), 'order.forced',
    format('Condition forcée · commande #%s', o.order_number),
    format('Véhicule prévu : %s ; utilisé : %s.', pv.label, coalesce(v_vehicle.label, 'aucun')), o.id)
  from public.orders o join public.vehicles pv on pv.id = o.planned_vehicle_id
  where o.id = any(p_order_ids) and o.planned_vehicle_id is distinct from p_vehicle_id;
  return jsonb_build_object('shipment_id', v_shipment_id, 'shipment_number', v_number, 'count', v_count);
end;
$function$
;

-- ===== driver_shipments
CREATE OR REPLACE FUNCTION public.driver_shipments()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
begin
  if not public.is_driver() then
    raise exception using errcode = '42501', message = 'Accès réservé aux livreurs.';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'requested_delivery_date', o.requested_delivery_date,
      'total', case when c.driver_prices then o.total end,
      'business_name', c.business_name,
      'point_label', dp.label,
      'address_line', dp.address_line,
      'city', dp.city,
      'phone', coalesce(nullif(dp.phone, ''), c.phone),
      'item_count', (select count(*) from public.order_items oi where oi.order_id = o.id),
      'client_id', c.id,
      'point_id', dp.id,
      'delivery_token', o.delivery_token,
      'delivery_signature', (c.delivery_signature and public.module_enabled_for(c.supplier_org_id, 'signature')),
      'reception_qr', (c.reception_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')),
      'scan_delivery_note', (c.scan_delivery_note and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')),
      'scan_client_qr', (c.scan_client_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')),
      'shipment_number', s.shipment_number,
      'vehicle_label', v.label,
      'driver_name', dr.full_name,
      'show_prices', c.driver_prices,
      'total_ttc', case when c.driver_prices then (select coalesce(sum(oi.line_total * (1 + coalesce(oi.vat_rate, 0) / 100)), 0) from public.order_items oi where oi.order_id = o.id) + coalesce(o.delivery_fee, 0) end
    ) order by o.requested_delivery_date nulls last, c.business_name, o.order_number)
    from (select * from (select * from public.orders where public.org_visible(supplier_org_id)) orders where public.org_visible(supplier_org_id)) o
    join (select * from (select * from public.clients where public.org_visible(supplier_org_id)) clients where public.org_visible(supplier_org_id)) c on c.id = o.client_id
    join public.client_delivery_points dp on dp.id = o.delivery_point_id
    left join public.shipments s on s.id = o.shipment_id
    left join public.vehicles v on v.id = s.vehicle_id
    left join public.profiles dr on dr.id = s.driver_id
    where o.status = 'out_for_delivery'
  ), '[]'::jsonb);
end;
$function$
;

-- ===== ensure_relation
CREATE OR REPLACE FUNCTION public.ensure_relation(p_supplier uuid, p_buyer uuid, p_via text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
  v_buyer public.organizations%rowtype;
begin
  select * into v_buyer from public.organizations where id = p_buyer;
  perform set_config('appro.link_write', 'on', true);
  select c.id into v_id from public.clients c where c.supplier_org_id = p_supplier and c.buyer_org_id = p_buyer order by c.created_at limit 1;
  if v_id is null then
    insert into public.clients (business_name, contact_name, phone, email, supplier_org_id, buyer_org_id, active, link_status, link_requested_at, joined_via)
    values (v_buyer.name, '', coalesce(v_buyer.phone, ''), nullif(v_buyer.email, ''), p_supplier, p_buyer, true, 'active', now(), p_via)
    returning id into v_id;
  else
    update public.clients set link_status = 'active', active = true, joined_via = coalesce(joined_via, p_via) where id = v_id and (link_status <> 'active' or not active);
  end if;
  if not exists (select 1 from public.client_delivery_points dp where dp.client_id = v_id and dp.active) then
    insert into public.client_delivery_points (client_id, label, address_line, city, phone)
    values (v_id, 'Principal', coalesce(nullif(btrim(v_buyer.address), ''), 'Adresse à préciser'), 'À préciser', coalesce(v_buyer.phone, ''));
  end if;
  -- The buyer's people with no supplier yet start with this one.
  update public.profiles set client_id = v_id where org_id = p_buyer and role = 'customer' and client_id is null;
  perform set_config('appro.link_write', 'off', true);
  return v_id;
end;
$function$
;

-- ===== expire_trials
CREATE OR REPLACE FUNCTION public.expire_trials()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ids uuid[];
begin
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
$function$
;

-- ===== feature_module
CREATE OR REPLACE FUNCTION public.feature_module(p_feature text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_feature
    when 'production.view' then 'production' when 'production.update' then 'production'
    when 'orders.plan' then 'planning'
    when 'deliveries' then 'delivery' when 'orders.ship' then 'delivery'
    when 'fleet.manage' then 'fleet'
    when 'invoices.manage' then 'invoicing' when 'client.invoices' then 'invoicing'
    when 'returns.manage' then 'returns' when 'client.returns' then 'returns'
    when 'claims.manage' then 'claims' when 'client.claims' then 'claims'
    when 'messages.manage' then 'client_messages' when 'client.messages' then 'client_messages'
    when 'team.messages' then 'team_messages'
    when 'orders.create' then 'staff_orders'
    when 'client.recurring' then 'recurring'
    when 'calendar.view' then 'calendar'
    when 'leave.request' then 'leaves' when 'leave.manage' then 'leaves'
    when 'incidents.report' then 'incidents' when 'incidents.manage' then 'incidents'
    when 'location.share' then 'location' when 'location.view' then 'location'
    when 'stats.view' then 'stats'
    when 'audit.view' then 'audit'
  end;
$function$
;

-- ===== fill_document_supplier
CREATE OR REPLACE FUNCTION public.fill_document_supplier()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.supplier_org_id is null then
    new.supplier_org_id := (select c.supplier_org_id from public.clients c where c.id = new.client_id);
  end if;
  return new;
end;
$function$
;

-- ===== fill_org_id
CREATE OR REPLACE FUNCTION public.fill_org_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.org_id is null then
    new.org_id := public.acting_or_legacy_org_id();
  end if;
  return new;
end;
$function$
;

-- ===== format_document_number
CREATE OR REPLACE FUNCTION public.format_document_number(p_prefix text, p_with_year boolean, p_digits integer, p_number bigint, p_year integer)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select p_prefix || case when p_with_year then p_year::text || '-' else '' end || lpad(p_number::text, p_digits, '0');
$function$
;

-- ===== handle_new_user
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.profiles (id, full_name, phone, client_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    (select c.id from public.clients c
     where c.email = lower(new.email)
       and not exists (select 1 from public.profiles p where p.client_id = c.id))
  )
  on conflict (id) do nothing;
  return new;
end;
$function$
;

-- ===== has_feature
CREATE OR REPLACE FUNCTION public.has_feature(p_feature text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
        select (public.feature_module(p_feature) is null or public.module_enabled(public.feature_module(p_feature)))
          and public.has_feature_base(p_feature);
      $function$
;

-- ===== has_feature_base
CREATE OR REPLACE FUNCTION public.has_feature_base(p_feature text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.has_permission(p_feature);
$function$
;

-- ===== has_permission
CREATE OR REPLACE FUNCTION public.has_permission(p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from public.profiles pr join public.organizations o on o.id = pr.org_id
                 where pr.id = (select auth.uid()) and o.status = 'active')
     and public.user_has_permission((select auth.uid()), p_permission);
$function$
;

-- ===== invitation_info
CREATE OR REPLACE FUNCTION public.invitation_info(p_code text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('org_name', o.name, 'side', i.side, 'client_name', c.business_name, 'valid', i.expires_at > now())
  from public.invitations i join public.organizations o on o.id = i.org_id
  left join public.clients c on c.id = i.client_id
  where i.code = upper(btrim(coalesce(p_code, '')));
$function$
;

-- ===== invitation_link
CREATE OR REPLACE FUNCTION public.invitation_link(p_invitation_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_inv public.invitations%rowtype;
  v_me public.profiles%rowtype;
  v_org public.organizations%rowtype;
  v_record public.clients%rowtype;
begin
  select * into v_inv from public.invitations where id = p_invitation_id;
  select * into v_me from public.profiles where id = p_user_id;
  select * into v_org from public.organizations where id = v_me.org_id;
  if v_inv.id is null or v_me.id is null then
    return false;
  end if;
  if v_inv.client_id is not null then
    select * into v_record from public.clients where id = v_inv.client_id;
  end if;
  -- No space yet, invited from a client record whose space has nobody: the person becomes its Responsable.
  if v_org.id is null then
    if v_record.id is null or v_record.buyer_org_id is null
       or exists (select 1 from public.profiles pr where pr.org_id = v_record.buyer_org_id and pr.id <> p_user_id) then
      return false;
    end if;
    perform set_config('appro.link_write', 'on', true);
    perform public.attach_org_owner(v_record.buyer_org_id, p_user_id);
    update public.profiles set client_id = v_record.id where id = p_user_id;
    perform set_config('appro.link_write', 'off', true);
    perform public.start_trial(v_record.buyer_org_id);
  elsif v_inv.side = 'client' then
    if not v_org.is_buyer then
      return false;
    end if;
    -- The client record waiting for its buyer is given to this buyer's space.
    if v_record.id is not null and v_record.buyer_org_id is distinct from v_org.id
       and not exists (select 1 from public.profiles pr where pr.org_id = v_record.buyer_org_id)
       and not exists (select 1 from public.clients c where c.supplier_org_id = v_inv.org_id and c.buyer_org_id = v_org.id) then
      perform set_config('appro.link_write', 'on', true);
      update public.clients set buyer_org_id = v_org.id, link_status = 'active', active = true, joined_via = coalesce(joined_via, 'invitation') where id = v_record.id;
      perform set_config('appro.link_write', 'off', true);
    end if;
    perform public.ensure_relation(v_inv.org_id, v_org.id, 'invitation');
  else
    if not v_org.is_supplier then
      return false;
    end if;
    perform public.ensure_relation(v_org.id, v_inv.org_id, 'invitation');
  end if;
  update public.invitation_acceptances set linked_at = now() where invitation_id = p_invitation_id and user_id = p_user_id;
  perform public.notify(array(select mr.user_id from public.member_roles mr join public.org_roles r on r.id = mr.role_id
      join public.role_templates t on t.id = r.template_id where r.org_id = v_inv.org_id and t.key in ('supplier_owner', 'buyer_owner')
      union select v_inv.invited_by),
    'invitation.accepted', 'Invitation acceptée',
    format('%s a rejoint Appro+ : vous êtes maintenant en relation.', coalesce((select o.name from public.organizations o where o.id = (select pr.org_id from public.profiles pr where pr.id = p_user_id)), v_me.full_name, 'Votre invité')));
  return true;
end;
$function$
;

-- ===== is_admin
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from public.profiles pr where pr.id = (select auth.uid()) and pr.role = 'admin' and pr.account_status = 'active');
$function$
;

-- ===== is_driver
CREATE OR REPLACE FUNCTION public.is_driver()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.has_feature('deliveries');
$function$
;

-- ===== is_legacy_admin
CREATE OR REPLACE FUNCTION public.is_legacy_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select public.platform_role() = 'superadmin' or (public.is_admin() and public.current_org_id() = public.legacy_org_id()); $function$
;

-- ===== is_org_owner
CREATE OR REPLACE FUNCTION public.is_org_owner(p_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from public.member_roles mr join public.org_roles r on r.id = mr.role_id
    join public.role_templates t on t.id = r.template_id
    where mr.user_id = (select auth.uid()) and r.org_id = p_org_id and t.key in ('supplier_owner', 'buyer_owner'))
    and public.current_org_id() = p_org_id;
$function$
;

-- ===== is_production
CREATE OR REPLACE FUNCTION public.is_production()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.has_feature('production.view') or public.has_feature('production.update');
$function$
;

-- ===== is_staff
CREATE OR REPLACE FUNCTION public.is_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.profiles pr
    where pr.id = (select auth.uid()) and pr.role in ('staff', 'admin', 'supervisor') and pr.account_status = 'active'
  );
$function$
;

-- ===== is_superadmin
CREATE OR REPLACE FUNCTION public.is_superadmin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from public.profiles pr where pr.id = (select auth.uid()) and pr.is_superadmin and pr.account_status = 'active');
$function$
;

-- ===== is_team_conversation_member
CREATE OR REPLACE FUNCTION public.is_team_conversation_member(p_conversation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.has_feature('team.messages')
     and exists (select 1 from public.team_member_ids(p_conversation_id) m where m = (select auth.uid()));
$function$
;

-- ===== issue_credit_note_internal
CREATE OR REPLACE FUNCTION public.issue_credit_note_internal(p_credit_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== issue_invoice
CREATE OR REPLACE FUNCTION public.issue_invoice(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== leave_list
CREATE OR REPLACE FUNCTION public.leave_list(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'user_id', l.user_id, 'name', coalesce(nullif(btrim(pr.full_name), ''), u.email), 'kind', l.kind,
    'start_date', l.start_date, 'end_date', l.end_date, 'half_day', l.half_day, 'note', l.note, 'status', l.status,
    'decision_note', l.decision_note, 'created_at', l.created_at, 'mine', l.user_id = auth.uid()
  ) order by l.start_date), '[]'::jsonb)
  from (select * from (select * from public.leave_requests where public.org_visible(public.user_org(user_id))) leave_requests where public.org_visible(public.user_org(user_id))) l
  join (select * from (select * from public.profiles where (public.org_visible(org_id) or public.org_visible(public.client_org(client_id)))) profiles where (public.org_visible(org_id) or public.org_visible(public.client_org(client_id)))) pr on pr.id = l.user_id
  left join auth.users u on u.id = pr.id
  where l.end_date >= p_from and l.start_date <= p_to
    and (l.user_id = auth.uid() or public.has_feature('leave.manage')
         or (l.status = 'approved' and (public.is_staff() or public.has_feature('calendar.view'))));
$function$
;

-- ===== legacy_org_id
CREATE OR REPLACE FUNCTION public.legacy_org_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select o.id from public.organizations o where o.legacy;
$function$
;

-- ===== legacy_role_template
CREATE OR REPLACE FUNCTION public.legacy_role_template(p_role text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_role when 'admin' then 'supplier_owner' when 'supervisor' then 'supplier_supervisor' when 'staff' then 'supplier_supervisor'
    when 'production' then 'supplier_production' when 'driver' then 'supplier_driver' when 'customer' then 'buyer_purchaser' end;
$function$
;

-- ===== link_client_account
CREATE OR REPLACE FUNCTION public.link_client_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.email is not null
     and not exists (select 1 from public.profiles p where p.client_id = new.id) then
    update public.profiles p
    set client_id = new.id
    from auth.users u
    where u.id = p.id
      and lower(u.email) = new.email
      and p.client_id is null
      and p.role = 'customer';
  end if;
  return new;
end;
$function$
;

-- ===== location_name
CREATE OR REPLACE FUNCTION public.location_name(p_user uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(nullif(btrim(pr.full_name), ''), u.email, 'Un collègue') from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = p_user; $function$
;

-- ===== location_request_status
CREATE OR REPLACE FUNCTION public.location_request_status(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_request public.location_requests%rowtype;
  v_target public.profiles%rowtype;
  v_last public.user_locations%rowtype;
begin
  select * into v_request from public.location_requests where id = p_request_id for update;
  if v_request.id is null or v_request.requester_id is distinct from auth.uid() then
    raise exception using errcode = 'P0002', message = 'Demande introuvable.';
  end if;
  if v_request.status = 'pending' and v_request.created_at < now() - interval '1 minute' then
    select * into v_target from public.profiles where id = v_request.target_id;
    select * into v_last from public.user_locations where user_id = v_request.target_id;
    if v_target.location_tracking or public.is_admin() or public.is_org_owner(v_request.org_id) then
      update public.location_requests set status = 'automatic', answered_at = now(),
        latitude = v_last.latitude, longitude = v_last.longitude, accuracy = v_last.accuracy, located_at = v_last.updated_at
      where id = p_request_id
      returning * into v_request;
      perform public.notify(array[v_request.target_id], 'location.viewed', 'Votre position a été consultée',
        format('%s a vu votre dernière position connue, sans réponse de votre part dans la minute%s.', public.location_name(auth.uid()),
          case when v_target.location_tracking then ' (repérage autorisé par votre administrateur)' else ' (administrateur de votre Pro)' end));
    else
      update public.location_requests set status = 'expired', answered_at = now() where id = p_request_id returning * into v_request;
    end if;
  end if;
  return jsonb_build_object('id', v_request.id, 'status', v_request.status, 'latitude', v_request.latitude, 'longitude', v_request.longitude,
    'accuracy', v_request.accuracy, 'located_at', v_request.located_at, 'target', public.location_name(v_request.target_id),
    'seconds_left', greatest(0, 60 - extract(epoch from now() - v_request.created_at)::int));
end;
$function$
;

-- ===== mark_messages_read
CREATE OR REPLACE FUNCTION public.mark_messages_read(p_client_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if public.is_staff() then
    update public.messages set read_at = now()
    where client_id = p_client_id and not from_staff and read_at is null;
  elsif p_client_id = public.current_client_id() then
    update public.messages set read_at = now()
    where client_id = p_client_id and from_staff and read_at is null;
  end if;
end;
$function$
;

-- ===== mark_notifications_read
CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.notifications set read_at = now()
  where user_id = (select public.active_uid()) and read_at is null and (p_ids is null or id = any(p_ids));
$function$
;

-- ===== mark_notifications_unread
CREATE OR REPLACE FUNCTION public.mark_notifications_unread(p_ids uuid[])
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.notifications set read_at = null
  where user_id = (select public.active_uid()) and id = any(p_ids);
$function$
;

-- ===== messages_needing_reply
CREATE OR REPLACE FUNCTION public.messages_needing_reply()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
declare
  v_me uuid := auth.uid();
  v_client uuid := public.current_client_id();
begin
  return jsonb_build_object(
    'clients', case when public.has_feature('messages.manage') then coalesce((
      select jsonb_agg(jsonb_build_object('client_id', c.id, 'business_name', c.business_name, 'count', x.n, 'since', x.since, 'last_body', x.last_body) order by x.since)
      from (
        select m.client_id, count(*) as n, min(m.created_at) as since, (array_agg(m.body order by m.created_at desc))[1] as last_body
        from (select * from (select * from public.messages where public.org_visible(public.client_org(client_id))) messages where public.org_visible(public.client_org(client_id))) m where m.needs_reply and not m.from_staff group by m.client_id
      ) x join (select * from (select * from public.clients where public.org_visible(supplier_org_id)) clients where public.org_visible(supplier_org_id)) c on c.id = x.client_id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'team', case when public.has_feature('team.messages') then coalesce((
      select jsonb_agg(jsonb_build_object('conversation_id', x.conversation_id, 'title', public.team_conversation_title(x.conversation_id, v_me),
        'count', x.n, 'since', x.since, 'last_body', x.last_body) order by x.since)
      from (
        select tm.conversation_id, count(*) as n, min(tm.created_at) as since, (array_agg(tm.body order by tm.created_at desc))[1] as last_body
        from public.team_messages tm
        where tm.needs_reply and tm.sender_id is distinct from v_me
          and exists (select 1 from public.team_member_ids(tm.conversation_id) m where m = v_me)
        group by tm.conversation_id
      ) x
    ), '[]'::jsonb) else '[]'::jsonb end,
    'own', case when v_client is not null and not public.is_staff() then
      (select count(*)::int from (select * from (select * from public.messages where public.org_visible(public.client_org(client_id))) messages where public.org_visible(public.client_org(client_id))) m where m.client_id = v_client and m.needs_reply and m.from_staff)
      else 0 end
  );
end;
$function$
;

-- ===== module_default
CREATE OR REPLACE FUNCTION public.module_default(p_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select m.enabled from public.app_modules m where m.key = p_key), true);
$function$
;

-- ===== module_enabled
CREATE OR REPLACE FUNCTION public.module_enabled(p_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.module_enabled_for(public.user_module_org((select auth.uid()), p_key), p_key);
$function$
;

-- ===== module_enabled_for
CREATE OR REPLACE FUNCTION public.module_enabled_for(p_org uuid, p_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when p_org is null then public.module_default(p_key)
    else coalesce(om.granted, public.module_default(p_key)) and coalesce(om.enabled, true) end
  from (select 1) one
  left join public.org_modules om on om.org_id = p_org and om.key = p_key;
$function$
;

-- ===== module_keys
CREATE OR REPLACE FUNCTION public.module_keys()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select array['decide', 'production', 'planning', 'delivery', 'delivery_qr', 'signature', 'fleet', 'invoicing', 'reminders',
    'exports', 'returns', 'claims', 'client_messages', 'team_messages', 'attachments', 'needs_reply', 'staff_orders',
    'recurring', 'order_tags', 'stock', 'origin', 'reconfirm', 'calendar', 'leaves', 'incidents', 'location', 'stats',
    'audit', 'languages', 'home_custom', 'pricing'];
$function$
;

-- ===== module_own_scope
CREATE OR REPLACE FUNCTION public.module_own_scope(p_key text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select p_key = any(array['team_messages', 'calendar', 'leaves', 'location', 'audit', 'stats', 'languages', 'home_custom']);
$function$
;

-- ===== my_account
CREATE OR REPLACE FUNCTION public.my_account()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'id', pr.id,
    'role', pr.role,
    'full_name', pr.full_name,
    'features', public.my_features(),
    'disabled', pr.account_status <> 'active',
    'status', pr.account_status,
    'home_layout', coalesce(pr.home_layout, (select hl.layout from public.home_layouts hl
      where hl.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role)),
    'role_home_layout', (select hl.layout from public.home_layouts hl
      where hl.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role),
    'client', case when c.id is null or not c.active then null else jsonb_build_object(
      'id', c.id,
      'client_number', c.client_number,
      'business_name', c.business_name,
      'contact_name', c.contact_name,
      'phone', c.phone,
      'show_prices', c.show_prices,
      'show_origin', (c.show_origin and public.module_enabled_for(c.supplier_org_id, 'origin')),
      'show_stock', (c.show_stock and public.module_enabled_for(c.supplier_org_id, 'stock')),
      'stock_managed', (c.stock_managed and public.module_enabled_for(c.supplier_org_id, 'stock')),
      'reception_qr', (c.reception_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')) and (c.scan_client_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')),
      'reception_token', case when (c.reception_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')) and (c.scan_client_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')) then c.reception_token end,
      'history_enabled', c.history_enabled, 'delivery_note', c.delivery_note_client,
      'payment_reminders', (c.payment_reminders and public.module_enabled_for(c.supplier_org_id, 'reminders')),
      'reminder_opt_out_allowed', c.reminder_opt_out_allowed,
      'reminder_opt_out', c.reminder_opt_out,
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
$function$
;

-- ===== my_client_history
CREATE OR REPLACE FUNCTION public.my_client_history()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((
    select c.history_enabled from public.profiles pr join public.clients c on c.id = pr.client_id
    where pr.id = (select auth.uid())
  ), true);
$function$
;

-- ===== my_company_profile
CREATE OR REPLACE FUNCTION public.my_company_profile()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('name', o.name, 'tagline', o.tagline, 'address', o.address, 'phone', o.phone, 'email', o.email,
    'tax_id', o.tax_id, 'rib', o.rib, 'brand_color', o.brand_color)
  from public.organizations o where o.id = public.acting_supplier_org_id();
$function$
;

-- ===== my_features
CREATE OR REPLACE FUNCTION public.my_features()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(f.feature order by f.feature), '[]'::jsonb)
  from (select distinct rp.feature from public.role_permissions rp) f
  where public.has_feature(f.feature)
     or (f.feature in ('client.home', 'client.order', 'client.orders', 'client.messages', 'client.invoices', 'client.alerts')
         and exists (select 1 from public.buyer_relations(f.feature)));
$function$
;

-- ===== my_links
CREATE OR REPLACE FUNCTION public.my_links()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'org', (select jsonb_build_object('id', o.id, 'name', o.name, 'is_supplier', o.is_supplier, 'is_buyer', o.is_buyer, 'open_to_new', o.open_to_new, 'listed_in_directory', o.listed_in_directory, 'open_to_messages', o.open_to_messages, 'catalog_visibility', o.catalog_visibility, 'kind', o.kind)
            from public.organizations o where o.id = public.current_org_id()),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('client_id', c.id, 'org_id', s.id, 'name', s.name, 'status', c.link_status,
                  'to_answer', c.link_status = 'requested_by_supplier') order by s.name)
                from public.clients c join public.organizations s on s.id = c.supplier_org_id
                where c.buyer_org_id = public.current_org_id() and c.link_status <> 'refused'), '[]'::jsonb),
    'clients', coalesce((select jsonb_agg(jsonb_build_object('client_id', c.id, 'org_id', b.id, 'name', b.name, 'status', c.link_status,
                  'to_answer', c.link_status = 'requested_by_buyer') order by b.name)
                from public.clients c join public.organizations b on b.id = c.buyer_org_id
                where c.supplier_org_id = public.current_org_id() and c.link_status <> 'refused'), '[]'::jsonb));
$function$
;

-- ===== my_location_requests
CREATE OR REPLACE FUNCTION public.my_location_requests()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'requester', public.location_name(r.requester_id), 'created_at', r.created_at,
      'tracking', (select pr.location_tracking from public.profiles pr where pr.id = r.target_id)) order by r.created_at), '[]'::jsonb)
  from public.location_requests r
  where r.target_id = (select auth.uid()) and r.status = 'pending' and r.created_at > now() - interval '10 minutes';
$function$
;

-- ===== my_location_views
CREATE OR REPLACE FUNCTION public.my_location_views()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('requester', public.location_name(r.requester_id), 'status', r.status, 'created_at', r.created_at)
    order by r.created_at desc), '[]'::jsonb)
  from (select * from public.location_requests x where x.target_id = (select auth.uid()) order by x.created_at desc limit 50) r;
$function$
;

-- ===== my_notification_prefs
CREATE OR REPLACE FUNCTION public.my_notification_prefs()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('push', pr.notify_push, 'email', pr.notify_email)
  from public.profiles pr where pr.id = (select auth.uid());
$function$
;

-- ===== my_pro
CREATE OR REPLACE FUNCTION public.my_pro()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when o.id is null then null else jsonb_build_object(
    'id', o.id, 'name', o.name, 'kind', o.kind, 'status', o.status, 'is_supplier', o.is_supplier, 'is_buyer', o.is_buyer,
    'roles_delegated', o.roles_delegated, 'trial_until', o.trial_until, 'catalog_visibility', o.catalog_visibility,
    'listed_in_directory', o.listed_in_directory, 'open_to_messages', o.open_to_messages, 'open_to_new', o.open_to_new) end
  from public.profiles pr left join public.organizations o on o.id = pr.org_id
  where pr.id = (select auth.uid());
$function$
;

-- ===== my_reception_qr
CREATE OR REPLACE FUNCTION public.my_reception_qr()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('token', b.reception_token, 'name', b.name,
    'required', exists (select 1 from public.clients c where c.buyer_org_id = b.id and c.link_status = 'active' and c.active and (c.reception_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr')) and (c.scan_client_qr and public.module_enabled_for(c.supplier_org_id, 'delivery_qr'))))
  from public.profiles pr join public.organizations b on b.id = pr.org_id
  where pr.id = (select auth.uid()) and pr.role = 'customer' and pr.account_status = 'active';
$function$
;

-- ===== my_spaces
CREATE OR REPLACE FUNCTION public.my_spaces()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('org_id', m.org_id, 'org_name', o.name, 'mode', m.mode, 'status', o.status,
      'current', m.org_id = pr.org_id and m.mode = case when pr.role = 'customer' then 'buyer' else 'supplier' end)
    order by o.name, m.mode desc), '[]'::jsonb)
  from public.pro_memberships m join public.organizations o on o.id = m.org_id
  join public.profiles pr on pr.id = m.user_id
  where m.user_id = (select auth.uid());
$function$
;

-- ===== my_suppliers
CREATE OR REPLACE FUNCTION public.my_suppliers()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('client_id', c.id, 'name', s.name, 'current', c.id = pr.client_id) order by s.name), '[]'::jsonb)
  from public.profiles pr
  join public.clients c on c.buyer_org_id = pr.org_id and c.link_status = 'active' and c.active
  join public.organizations s on s.id = c.supplier_org_id and s.status = 'active'
  where pr.id = (select auth.uid()) and pr.role = 'customer';
$function$
;

-- ===== my_workflow_settings
CREATE OR REPLACE FUNCTION public.my_workflow_settings()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select jsonb_build_object('auto_deliver_hours', o.auto_deliver_hours) from public.organizations o where o.id = public.current_org_id(); $function$
;

-- ===== next_billing_date
CREATE OR REPLACE FUNCTION public.next_billing_date(p_client_id uuid)
 RETURNS date
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_client public.clients%rowtype;
  v_last date;
  v_ref date;
  v_next date;
begin
  select c.* into v_client from public.clients c where c.id = p_client_id;
  if v_client.billing_frequency = 'manual' then
    return null;
  end if;
  select max((i.issued_at at time zone 'Africa/Tunis')::date) into v_last
  from public.client_invoices i where i.client_id = p_client_id and i.status in ('issued', 'paid');
  if v_client.billing_frequency = 'every_n_days' then
    v_ref := coalesce(v_client.billing_start, v_last, current_date);
    return case when v_last is null then v_ref else greatest(v_ref, v_last + v_client.billing_every_days) end;
  end if;
  v_ref := coalesce(v_last + 1, greatest(coalesce(v_client.billing_start, current_date), date_trunc('month', current_date)::date));
  v_next := make_date(extract(year from v_ref)::int, extract(month from v_ref)::int, v_client.billing_month_day);
  if v_next < v_ref then
    v_next := (v_next + interval '1 month')::date;
  end if;
  return v_next;
end;
$function$
;

-- ===== next_document_number
CREATE OR REPLACE FUNCTION public.next_document_number(p_type text, p_org_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := coalesce(p_org_id, public.acting_supplier_org_id(), public.legacy_org_id());
  v_row public.document_numbering%rowtype;
  v_year int := extract(year from (now() at time zone 'Africa/Tunis'))::int;
  v_number bigint;
begin
  perform public.org_install_numbering(v_org);
  select n.* into v_row from public.document_numbering n where n.org_id = v_org and n.doc_type = p_type for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Numérotation inconnue.';
  end if;
  v_number := case when v_row.yearly_reset and v_row.current_year is distinct from v_year then 1 else v_row.next_number end;
  update public.document_numbering set next_number = v_number + 1, current_year = v_year where org_id = v_org and doc_type = p_type;
  return public.format_document_number(v_row.prefix, v_row.with_year, v_row.digits, v_number, v_year);
end;
$function$
;

-- ===== next_org_counter
CREATE OR REPLACE FUNCTION public.next_org_counter(p_org_id uuid, p_kind text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_next bigint;
begin
  insert into public.org_counters (org_id, kind, last_value) values (p_org_id, p_kind, 1)
  on conflict (org_id, kind) do update set last_value = public.org_counters.last_value + 1
  returning last_value into v_next;
  return v_next;
end;
$function$
;

-- ===== next_weekday_date
CREATE OR REPLACE FUNCTION public.next_weekday_date(p_from date, p_days integer[])
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select min(d)::date from generate_series(p_from, p_from + 6, interval '1 day') as g(d)
  where extract(isodow from d)::int = any(p_days);
$function$
;

-- ===== notifications_name_supplier
CREATE OR REPLACE FUNCTION public.notifications_name_supplier()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_name text;
begin
  if not exists (select 1 from public.profiles pr where pr.id = new.user_id and pr.role = 'customer') then
    return new;
  end if;
  if (select count(*) from public.profiles pr join public.clients c on c.buyer_org_id = pr.org_id and c.link_status = 'active' and c.active
      where pr.id = new.user_id) < 2 then
    return new;
  end if;
  select s.name into v_name from public.organizations s
  where s.id = coalesce((select o.supplier_org_id from public.orders o where o.id = new.order_id), public.acting_supplier_org_id());
  if v_name is not null and position(v_name in coalesce(new.title, '')) = 0 then
    new.title := v_name || ' · ' || coalesce(new.title, '');
  end if;
  return new;
end;
$function$
;

-- ===== notify
CREATE OR REPLACE FUNCTION public.notify(p_users uuid[], p_event text, p_title text, p_body text, p_order_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into public.notifications (user_id, event, title, body, order_id)
  select distinct u, p_event, p_title, coalesce(p_body, ''), p_order_id
  from unnest(p_users) as u
  where u is not null;
$function$
;

-- ===== order_from_public
CREATE OR REPLACE FUNCTION public.order_from_public(p_supplier_org_id uuid, p_items jsonb, p_requested_date date DEFAULT NULL::date, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me public.profiles%rowtype;
  v_buyer public.organizations%rowtype;
  v_supplier public.organizations%rowtype;
  v_link public.clients%rowtype;
  v_client uuid;
  v_new boolean := false;
  v_result jsonb;
begin
  perform public.expire_trials();
  select * into v_me from public.profiles where id = auth.uid();
  if v_me.id is null then
    raise exception using errcode = '28000', message = 'Connectez-vous pour commander.';
  end if;
  select * into v_buyer from public.organizations where id = v_me.org_id;
  if v_me.account_status <> 'active' or v_buyer.status is distinct from 'active' then
    raise exception using errcode = '42501', message = case when v_buyer.id is null then 'Créez d’abord votre espace (entreprise ou particulier) pour commander.'
      when v_buyer.status = 'suspended' then 'Votre espace est suspendu en attendant sa validation par l’équipe Appro+ : vous pourrez commander dès qu’il sera validé.'
      else 'Votre compte attend sa validation par l’équipe Appro+ : vous pourrez commander dès qu’il sera validé.' end;
  end if;
  if not v_buyer.is_buyer or v_me.role <> 'customer' then
    raise exception using errcode = '22023', message = 'Passez dans votre espace Acheteur pour commander.';
  end if;
  select * into v_supplier from public.organizations where id = p_supplier_org_id and status = 'active' and is_supplier and catalog_visibility = 'public';
  if v_supplier.id is null or v_supplier.id = v_buyer.id then
    raise exception using errcode = 'P0002', message = 'Ce fournisseur n’est pas disponible.';
  end if;
  select * into v_link from public.clients where supplier_org_id = v_supplier.id and buyer_org_id = v_buyer.id order by created_at limit 1;
  if v_link.id is not null and v_link.link_status = 'refused' and v_link.link_requested_at > now() - interval '30 days' then
    raise exception using errcode = '22023', message = 'Ce fournisseur n’a pas donné suite à votre mise en relation : contactez-le directement.';
  end if;
  v_new := v_link.id is null or v_link.link_status <> 'active' or not v_link.active;
  v_client := public.ensure_relation(v_supplier.id, v_buyer.id, 'public_catalog');
  v_result := public.place_multi_order(jsonb_build_array(jsonb_build_object('client_id', v_client, 'items', p_items)), p_requested_date, p_note) -> 0;
  if v_new then
    perform public.notify(array(select public.team_with_feature('orders.decide', v_supplier.id)), 'link.new_client',
      format('Nouveau client · %s', v_buyer.name),
      'Première commande depuis votre catalogue public : acceptez-la ou déclinez-la comme d’habitude.', nullif(v_result ->> 'id', '')::uuid);
  end if;
  return v_result || jsonb_build_object('new_relation', v_new, 'client_id', v_client, 'supplier_name', v_supplier.name);
end;
$function$
;

-- ===== order_org
CREATE OR REPLACE FUNCTION public.order_org(p_order_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select o.supplier_org_id from public.orders o where o.id = p_order_id; $function$
;

-- ===== order_status_words
CREATE OR REPLACE FUNCTION public.order_status_words(p_status order_status)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_status
    when 'pending' then 'reçue' when 'on_hold' then 'mise en attente' when 'confirmed' then 'acceptée'
    when 'declined' then 'déclinée' when 'awaiting_client' then 'à reconfirmer' when 'preparing' then 'en préparation'
    when 'ready' then 'préparée' when 'out_for_delivery' then 'expédiée' when 'delivered' then 'livrée'
    when 'cancelled' then 'annulée' else p_status::text end;
$function$
;

-- ===== orders_check_credit_limit
CREATE OR REPLACE FUNCTION public.orders_check_credit_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== orders_fill_supplier
CREATE OR REPLACE FUNCTION public.orders_fill_supplier()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.supplier_org_id is null then
    new.supplier_org_id := coalesce((select c.supplier_org_id from public.clients c where c.id = new.client_id), public.legacy_org_id());
  end if;
  return new;
end;
$function$
;

-- ===== orders_number_per_supplier
CREATE OR REPLACE FUNCTION public.orders_number_per_supplier()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.order_number is null then
    new.supplier_org_id := coalesce(new.supplier_org_id, (select c.supplier_org_id from public.clients c where c.id = new.client_id), public.legacy_org_id());
    new.order_number := public.next_org_counter(new.supplier_org_id, 'order');
  end if;
  return new;
end;
$function$
;

-- ===== org_add_member
CREATE OR REPLACE FUNCTION public.org_add_member(p_email text, p_role_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role public.org_roles%rowtype;
  v_user uuid;
  v_profile public.profiles%rowtype;
  v_template text;
begin
  select * into v_role from public.org_roles where id = p_role_id;
  if v_role.id is null or not public.can_manage_org_roles(v_role.org_id, false) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas ajouter de collaborateur à ce Pro.';
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(p_email));
  if v_user is null then
    raise exception using errcode = 'P0002', message = 'Aucun compte avec cet e-mail : la personne doit d’abord créer son compte.';
  end if;
  select * into v_profile from public.profiles where id = v_user;
  if v_profile.role = 'platform' then
    raise exception using errcode = '22023', message = 'Ce compte appartient à l’équipe Appro+.';
  end if;
  -- one more space: the account already works elsewhere; its current space is not changed.
  if v_profile.org_id is not null and v_profile.org_id <> v_role.org_id then
    insert into public.pro_memberships (user_id, org_id, mode, role)
    values (v_user, v_role.org_id, v_role.side, (case when v_role.side = 'buyer' then 'customer' else 'supervisor' end)::public.app_role)
    on conflict do nothing;
    insert into public.member_roles (user_id, role_id) values (v_user, p_role_id) on conflict do nothing;
    return v_user;
  end if;
  select t.key into v_template from public.role_templates t where t.id = v_role.template_id;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set org_id = v_role.org_id,
    role = (case when v_role.side = 'buyer' then 'customer'
                 when v_template = 'supplier_owner' then 'admin' when v_template = 'supplier_production' then 'production'
                 when v_template = 'supplier_driver' then 'driver' else 'supervisor' end)::public.app_role
  where id = v_user;
  -- Only the chosen role (the automatic one of the profile is removed).
  delete from public.member_roles where user_id = v_user and role_id <> p_role_id
    and role_id in (select r.id from public.org_roles r where r.org_id = v_role.org_id);
  insert into public.member_roles (user_id, role_id) values (v_user, p_role_id) on conflict do nothing;
  -- A buyer collaborator works with the Pro's first active supplier.
  if v_role.side = 'buyer' then
    update public.profiles set client_id = (select c.id from public.clients c where c.buyer_org_id = v_role.org_id and c.link_status = 'active' and c.active order by c.created_at limit 1)
    where id = v_user and client_id is null;
  end if;
  perform set_config('appro.link_write', 'off', true);
  return v_user;
end;
$function$
;

-- ===== org_condition
CREATE OR REPLACE FUNCTION public.org_condition(p_table text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_table
    when 'orders' then 'public.org_visible(supplier_org_id)'
    when 'clients' then 'public.org_visible(supplier_org_id)'
    when 'products' then 'public.org_visible(org_id)'
    when 'vehicles' then 'public.org_visible(org_id)'
    when 'team_conversations' then 'public.org_visible(org_id)'
    when 'document_numbering' then 'public.org_visible(org_id)'
    when 'client_setting_defaults' then 'public.org_visible(org_id)'
    when 'order_items' then 'public.org_visible(public.order_org(order_id))'
    when 'order_status_history' then 'public.org_visible(public.order_org(order_id))'
    when 'invoices' then 'public.org_visible(public.order_org(order_id))'
    when 'payments' then 'public.org_visible(public.order_org(order_id))'
    when 'client_delivery_points' then 'public.org_visible(public.client_org(client_id))'
    when 'client_invoices' then 'public.org_visible(public.client_org(client_id))'
    when 'claims' then 'public.org_visible(public.client_org(client_id))'
    when 'messages' then 'public.org_visible(public.client_org(client_id))'
    when 'returns' then 'public.org_visible(public.client_org(client_id))'
    when 'credit_notes' then 'public.org_visible(public.client_org(client_id))'
    when 'recurring_orders' then 'public.org_visible(public.client_org(client_id))'
    when 'invoice_payments' then 'public.org_visible(public.client_org((select i.client_id from public.client_invoices i where i.id = invoice_id)))'
    when 'credit_note_items' then 'public.org_visible(public.client_org((select cn.client_id from public.credit_notes cn where cn.id = credit_note_id)))'
    when 'return_items' then 'public.org_visible(public.client_org((select r.client_id from public.returns r where r.id = return_id)))'
    when 'shipments' then 'public.org_visible(public.user_org(driver_id))'
    when 'leave_requests' then 'public.org_visible(public.user_org(user_id))'
    when 'user_locations' then 'public.org_visible(public.user_org(user_id))'
    when 'incidents' then 'public.org_visible(public.user_org(reported_by))'
    when 'audit_log' then 'public.org_visible(public.user_org(actor_id))'
    when 'profiles' then '(public.org_visible(org_id) or public.org_visible(public.client_org(client_id)))'
  end;
$function$
;

-- ===== org_create_role
CREATE OR REPLACE FUNCTION public.org_create_role(p_org_id uuid, p_name text, p_side text, p_from_role uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := coalesce(p_org_id, public.current_org_id());
  v_id uuid;
begin
  if v_org is null or not public.can_manage_org_roles(v_org, true) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas créer de rôle pour ce Pro.';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) < 2 or p_side not in ('supplier', 'buyer') then
    raise exception using errcode = '22023', message = 'Indiquez un nom et le côté (fournisseur ou acheteur).';
  end if;
  insert into public.org_roles (org_id, name, side) values (v_org, left(btrim(p_name), 60), p_side) returning id into v_id;
  if p_from_role is not null then
    insert into public.org_role_overrides (role_id, permission, allowed)
    select v_id, p.key, true from public.permissions p
    where p.side = p_side and public.role_grants(p_from_role, p.key)
      and exists (select 1 from public.org_roles src where src.id = p_from_role and src.org_id = v_org);
  end if;
  return v_id;
end;
$function$
;

-- ===== org_inbox
CREATE OR REPLACE FUNCTION public.org_inbox()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null then
    raise exception using errcode = '42501', message = 'Réservé aux espaces actifs.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'conversation_id', cv.id, 'org_id', o.id, 'name', o.name, 'kind', o.kind, 'last_at', cv.last_at,
      'last_body', (select m.body from public.org_messages m where m.conversation_id = cv.id order by m.created_at desc limit 1),
      'unread', (select count(*) from public.org_messages m where m.conversation_id = cv.id and m.sender_org_id <> v_org and m.read_at is null),
      'related', public.org_related(v_org, o.id)) order by cv.last_at desc)
    from public.org_conversations cv
    join public.organizations o on o.id = case when cv.org_a = v_org then cv.org_b else cv.org_a end
    where v_org in (cv.org_a, cv.org_b)), '[]'::jsonb);
end;
$function$
;

-- ===== org_install_numbering
CREATE OR REPLACE FUNCTION public.org_install_numbering(p_org_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into public.document_numbering (org_id, doc_type, prefix, with_year, digits, next_number, yearly_reset)
  select p_org_id, n.doc_type, n.prefix, n.with_year, n.digits, 1, n.yearly_reset
  from public.document_numbering n where n.org_id = public.legacy_org_id()
  on conflict (org_id, doc_type) do nothing;
$function$
;

-- ===== org_install_roles
CREATE OR REPLACE FUNCTION public.org_install_roles(p_org_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.org_roles (org_id, name, side, template_id)
  select o.id, t.name, t.side, t.id
  from public.organizations o join public.role_templates t
    on (t.side = 'supplier' and o.is_supplier) or (t.side = 'buyer' and o.is_buyer)
  where o.id = p_org_id
  on conflict (org_id, template_id) do nothing;
end;
$function$
;

-- ===== org_member_permissions
CREATE OR REPLACE FUNCTION public.org_member_permissions(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := (select pr.org_id from public.profiles pr where pr.id = p_user_id);
begin
  if v_org is null or not public.can_manage_org_roles(v_org, false) then
    raise exception using errcode = '42501', message = 'Réservé au Responsable du Pro et à l’équipe Appro+.';
  end if;
  return (select coalesce(jsonb_agg(p.key order by p.key), '[]'::jsonb) from public.permissions p
          where public.user_has_permission(p_user_id, p.key));
end;
$function$
;

-- ===== org_modules_state
CREATE OR REPLACE FUNCTION public.org_modules_state(p_org_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := coalesce(p_org_id, public.current_org_id());
begin
  if v_org is null or not (public.platform_can('platform.pros.view') or v_org = public.current_org_id()) then
    raise exception using errcode = '42501', message = 'Accès refusé.';
  end if;
  return (select jsonb_object_agg(k, jsonb_build_object(
      'default', public.module_default(k),
      'granted', om.granted,
      'included', coalesce(om.granted, public.module_default(k)),
      'enabled', coalesce(om.enabled, true),
      'effective', public.module_enabled_for(v_org, k)))
    from unnest(public.module_keys()) as k
    left join public.org_modules om on om.org_id = v_org and om.key = k);
end;
$function$
;

-- ===== org_owner_ceiling
CREATE OR REPLACE FUNCTION public.org_owner_ceiling(p_org_id uuid, p_side text, p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from public.org_roles r join public.role_templates t on t.id = r.template_id
    where r.org_id = p_org_id and r.side = p_side and t.key in ('supplier_owner', 'buyer_owner') and public.role_grants(r.id, p_permission));
$function$
;

-- ===== org_owner_template
CREATE OR REPLACE FUNCTION public.org_owner_template(p_supplier boolean)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$ select case when p_supplier then 'supplier_owner' else 'buyer_owner' end; $function$
;

-- ===== org_related
CREATE OR REPLACE FUNCTION public.org_related(p_a uuid, p_b uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from public.clients c where c.link_status = 'active'
    and ((c.supplier_org_id = p_a and c.buyer_org_id = p_b) or (c.supplier_org_id = p_b and c.buyer_org_id = p_a)));
$function$
;

-- ===== org_remove_member
CREATE OR REPLACE FUNCTION public.org_remove_member(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := (select pr.org_id from public.profiles pr where pr.id = p_user_id);
begin
  if v_org is null or not public.can_manage_org_roles(v_org, false) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas retirer ce compte.';
  end if;
  if p_user_id = auth.uid() then
    raise exception using errcode = '22023', message = 'Vous ne pouvez pas vous retirer vous-même.';
  end if;
  if exists (select 1 from public.member_roles mr join public.org_roles r on r.id = mr.role_id join public.role_templates t on t.id = r.template_id
             where mr.user_id = p_user_id and t.key in ('supplier_owner', 'buyer_owner'))
     and not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Un Responsable ne peut être retiré que par Appro+.';
  end if;
  perform set_config('appro.link_write', 'on', true);
  delete from public.member_roles where user_id = p_user_id and role_id in (select r.id from public.org_roles r where r.org_id = v_org);
  update public.profiles set org_id = null, client_id = null, role = 'customer' where id = p_user_id;
  delete from public.pro_memberships where user_id = p_user_id and org_id = v_org;
  perform set_config('appro.link_write', 'off', true);
end;
$function$
;

-- ===== org_roles_matrix
CREATE OR REPLACE FUNCTION public.org_roles_matrix(p_org_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := coalesce(p_org_id, public.current_org_id());
begin
  if v_org is null or not public.can_manage_org_roles(v_org, false) then
    raise exception using errcode = '42501', message = 'Réservé au Responsable du Pro et à l’équipe Appro+.';
  end if;
  return jsonb_build_object(
    'org', (select jsonb_build_object('id', o.id, 'name', o.name, 'is_supplier', o.is_supplier, 'is_buyer', o.is_buyer, 'roles_delegated', o.roles_delegated)
            from public.organizations o where o.id = v_org),
    'can_edit', public.can_manage_org_roles(v_org, true),
    'permissions', (select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'side', p.side, 'module', public.feature_module(p.key)) order by p.side, p.key), '[]'::jsonb)
                    from public.permissions p),
    'roles', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name, 'side', r.side, 'template', t.name, 'template_key', t.key,
        'granted', (select coalesce(jsonb_agg(p.key order by p.key), '[]'::jsonb) from public.permissions p
                    where p.side = r.side and public.role_grants(r.id, p.key)),
        'overrides', (select coalesce(jsonb_object_agg(o.permission, o.allowed), '{}'::jsonb) from public.org_role_overrides o where o.role_id = r.id),
        'members', (select count(*) from public.member_roles mr where mr.role_id = r.id)
      ) order by r.side, coalesce(t.sort_order, 99), r.name), '[]'::jsonb)
      from public.org_roles r left join public.role_templates t on t.id = r.template_id where r.org_id = v_org),
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', pr.id, 'email', u.email, 'full_name', pr.full_name, 'status', pr.account_status,
        'roles', (select coalesce(jsonb_agg(mr.role_id), '[]'::jsonb) from public.member_roles mr join public.org_roles r on r.id = mr.role_id
                  where mr.user_id = pr.id and r.org_id = v_org)
      ) order by pr.full_name, u.email), '[]'::jsonb)
      from public.profiles pr left join auth.users u on u.id = pr.id
      where pr.org_id = v_org and pr.role <> 'platform')
  );
end;
$function$
;

-- ===== org_send
CREATE OR REPLACE FUNCTION public.org_send(p_org_id uuid, p_body text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
  v_other public.organizations%rowtype;
  v_cv uuid;
  v_a uuid;
  v_b uuid;
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
  v_a := least(v_org, v_other.id);
  v_b := greatest(v_org, v_other.id);
  select cv.id into v_cv from public.org_conversations cv where cv.org_a = v_a and cv.org_b = v_b;
  if v_cv is null then
    if not v_other.open_to_messages and not public.org_related(v_org, v_other.id) then
      raise exception using errcode = '42501', message = 'Ce Pro ne reçoit pas de messages hors de son réseau.';
    end if;
    insert into public.org_conversations (org_a, org_b, started_by) values (v_a, v_b, v_org) returning id into v_cv;
  end if;
  insert into public.org_messages (conversation_id, sender_org_id, sender_id, body) values (v_cv, v_org, auth.uid(), btrim(p_body));
  update public.org_conversations set last_at = now() where id = v_cv;
  perform public.notify(array(select mr.user_id from public.member_roles mr join public.org_roles r on r.id = mr.role_id
      join public.role_templates t on t.id = r.template_id where r.org_id = v_other.id and t.key in ('supplier_owner', 'buyer_owner')),
    'org.message', format('Message de %s', (select o.name from public.organizations o where o.id = v_org)), left(btrim(p_body), 140));
  return v_cv;
end;
$function$
;

-- ===== org_set_member_role
CREATE OR REPLACE FUNCTION public.org_set_member_role(p_user_id uuid, p_role_id uuid, p_enabled boolean, p_valid_until timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role public.org_roles%rowtype;
  v_owner boolean;
begin
  select * into v_role from public.org_roles where id = p_role_id;
  if v_role.id is null or not public.can_manage_org_roles(v_role.org_id, false) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas attribuer ce rôle.';
  end if;
  if not exists (select 1 from public.profiles pr where pr.id = p_user_id and pr.org_id = v_role.org_id) then
    raise exception using errcode = 'P0002', message = 'Cette personne n’appartient pas à ce Pro.';
  end if;
  v_owner := exists (select 1 from public.role_templates t where t.id = v_role.template_id and t.key in ('supplier_owner', 'buyer_owner'));
  if p_enabled then
    insert into public.member_roles (user_id, role_id, valid_until) values (p_user_id, p_role_id, p_valid_until)
    on conflict (user_id, role_id) do update set valid_until = excluded.valid_until;
  else
    if v_owner and p_user_id = auth.uid() then
      raise exception using errcode = '22023', message = 'Vous ne pouvez pas retirer votre propre rôle de Responsable.';
    end if;
    if v_owner and not exists (select 1 from public.member_roles mr join public.profiles pr on pr.id = mr.user_id
                               where mr.role_id = p_role_id and mr.user_id <> p_user_id and pr.account_status = 'active') then
      raise exception using errcode = '22023', message = 'Le Pro doit garder au moins un Responsable actif.';
    end if;
    delete from public.member_roles where user_id = p_user_id and role_id = p_role_id;
  end if;
end;
$function$
;

-- ===== org_set_module
CREATE OR REPLACE FUNCTION public.org_set_module(p_key text, p_enabled boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not (public.is_admin() or public.is_org_owner(v_org)) then
    raise exception using errcode = '42501', message = 'Seul le Responsable du Pro active ou désactive ses modules.';
  end if;
  if not (p_key = any(public.module_keys())) then
    raise exception using errcode = '22023', message = 'Module inconnu.';
  end if;
  if coalesce(p_enabled, true) and not coalesce((select om.granted from public.org_modules om where om.org_id = v_org and om.key = p_key), public.module_default(p_key)) then
    raise exception using errcode = '42501', message = 'Ce module n’est pas inclus dans votre formule. Contactez l’équipe Appro+.';
  end if;
  insert into public.org_modules (org_id, key, enabled, updated_at, updated_by)
  values (v_org, p_key, case when coalesce(p_enabled, true) then null else false end, now(), auth.uid())
  on conflict (org_id, key) do update set enabled = excluded.enabled, updated_at = now(), updated_by = auth.uid();
end;
$function$
;

-- ===== org_set_role_permission
CREATE OR REPLACE FUNCTION public.org_set_role_permission(p_role_id uuid, p_permission text, p_allowed boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role public.org_roles%rowtype;
  v_template boolean;
  v_platform boolean := public.platform_can('platform.pros.manage');
begin
  select * into v_role from public.org_roles where id = p_role_id;
  if v_role.id is null or not public.can_manage_org_roles(v_role.org_id, true) then
    raise exception using errcode = '42501', message = 'Vous ne pouvez pas modifier ce rôle.';
  end if;
  if not exists (select 1 from public.permissions p where p.key = p_permission and p.side = v_role.side) then
    raise exception using errcode = '22023', message = 'Ce droit ne concerne pas ce rôle.';
  end if;
  if not v_platform then
    if exists (select 1 from public.role_templates t where t.id = v_role.template_id and t.key in ('supplier_owner', 'buyer_owner')) then
      raise exception using errcode = '42501', message = 'Le rôle de Responsable est réglé par Appro+.';
    end if;
    if coalesce(p_allowed, false) and not public.org_owner_ceiling(v_role.org_id, v_role.side, p_permission) then
      raise exception using errcode = '42501', message = 'Ce droit dépasse ce qu’Appro+ a ouvert à votre Pro.';
    end if;
  end if;
  v_template := exists (select 1 from public.role_template_permissions tp where tp.template_id = v_role.template_id and tp.permission = p_permission);
  if p_allowed is null or (v_role.template_id is not null and p_allowed = v_template) then
    delete from public.org_role_overrides where role_id = p_role_id and permission = p_permission;
  else
    insert into public.org_role_overrides (role_id, permission, allowed) values (p_role_id, p_permission, p_allowed)
    on conflict (role_id, permission) do update set allowed = excluded.allowed;
  end if;
end;
$function$
;

-- ===== org_thread
CREATE OR REPLACE FUNCTION public.org_thread(p_conversation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
  v_cv public.org_conversations%rowtype;
begin
  select * into v_cv from public.org_conversations where id = p_conversation_id;
  if v_org is null or v_cv.id is null or v_org not in (v_cv.org_a, v_cv.org_b) then
    raise exception using errcode = '42501', message = 'Conversation introuvable.';
  end if;
  update public.org_messages set read_at = now() where conversation_id = v_cv.id and sender_org_id <> v_org and read_at is null;
  return jsonb_build_object(
    'conversation_id', v_cv.id,
    'org', (select jsonb_build_object('id', o.id, 'name', o.name, 'kind', o.kind) from public.organizations o
            where o.id = case when v_cv.org_a = v_org then v_cv.org_b else v_cv.org_a end),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'mine', m.sender_org_id = v_org,
        'sender_name', pr.full_name, 'created_at', m.created_at, 'read_at', m.read_at) order by m.created_at desc)
      from (select * from public.org_messages x where x.conversation_id = v_cv.id order by x.created_at desc limit 300) m
      left join public.profiles pr on pr.id = m.sender_id), '[]'::jsonb));
end;
$function$
;

-- ===== org_visible
CREATE OR REPLACE FUNCTION public.org_visible(p_org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select ((select auth.uid()) is null and current_user not in ('anon', 'authenticated'))
      or p_org = public.acting_supplier_org_id();
$function$
;

-- ===== org_write_guard
CREATE OR REPLACE FUNCTION public.org_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_acting uuid;
  v_new uuid;
  v_old uuid;
begin
  if (select auth.uid()) is null or public.org_write_guard_bypassed() then
    return coalesce(new, old);
  end if;
  if exists (select 1 from public.profiles pr where pr.id = (select auth.uid()) and pr.role = 'platform') then
    raise exception using errcode = '42501', message = 'L’équipe Appro+ ne modifie pas les données des Pros.';
  end if;
  v_acting := public.acting_supplier_org_id();
  if tg_op <> 'DELETE' then
    v_new := public.row_org(tg_table_name, to_jsonb(new));
    if v_new is distinct from v_acting and not (v_new is null and tg_table_name in ('shipments', 'team_messages')) then
      raise exception using errcode = '42501', message = case when v_acting is null then 'Votre espace Pro n’est pas actif (en attente de validation par Appro+ ou suspendu) : vous ne pouvez pas encore modifier ses données.' else 'Cette donnée appartient à un autre Pro.' end;
    end if;
    if tg_table_name = 'order_items' then
      if (to_jsonb(new) ->> 'product_id') is not null
         and (select p.org_id from public.products p where p.id = (to_jsonb(new) ->> 'product_id')::uuid) is distinct from v_new then
        raise exception using errcode = '42501', message = 'Ce produit n’est pas proposé par ce fournisseur.';
      end if;
    end if;
  end if;
  if tg_op <> 'INSERT' then
    v_old := public.row_org(tg_table_name, to_jsonb(old));
    if v_old is distinct from v_acting and not (v_old is null and tg_table_name in ('shipments', 'team_messages')) then
      raise exception using errcode = '42501', message = case when v_acting is null then 'Votre espace Pro n’est pas actif (en attente de validation par Appro+ ou suspendu) : vous ne pouvez pas encore modifier ses données.' else 'Cette donnée appartient à un autre Pro.' end;
    end if;
  end if;
  return coalesce(new, old);
end;
$function$
;

-- ===== org_write_guard_bypassed
CREATE OR REPLACE FUNCTION public.org_write_guard_bypassed()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$ select coalesce(current_setting('appro.link_write', true), '') = 'on'; $function$
;

-- ===== place_client_order
CREATE OR REPLACE FUNCTION public.place_client_order(p_items jsonb, p_delivery_point_id uuid DEFAULT NULL::uuid, p_requested_date date DEFAULT NULL::date, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_customer_id uuid := public.active_uid();
  v_client_id uuid;
begin
  if v_customer_id is null then
    raise exception using errcode = '28000', message = 'Connectez-vous avant de passer commande (compte actif requis).';
  end if;
  select c.id into v_client_id
  from public.profiles pr join public.clients c on c.id = pr.client_id
  where pr.id = v_customer_id and c.active;
  if v_client_id is null then
    raise exception using errcode = '42501', message = 'Votre compte n’est rattaché à aucune fiche client active. Contactez votre fournisseur.';
  end if;
  return public.create_client_order(v_client_id, v_customer_id, v_customer_id, p_items, p_delivery_point_id, p_requested_date, p_note, 'Commande transmise par le client.');
end;
$function$
;

-- ===== place_customer_order
CREATE OR REPLACE FUNCTION public.place_customer_order(p_items jsonb, p_address jsonb, p_customer_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_customer_id uuid := auth.uid();
  v_item record;
  v_product public.products%rowtype;
  v_product_id uuid;
  v_quantity numeric(12,3);
  v_line_total numeric(12,3);
  v_subtotal numeric(12,3) := 0;
  v_delivery_fee numeric(12,3) := 0;
  v_total numeric(12,3);
  v_lines jsonb := '[]'::jsonb;
  v_address jsonb;
  v_recipient_name text;
  v_phone text;
  v_address_line text;
  v_city text;
  v_notes text;
  v_order_id uuid;
  v_order_number bigint;
begin
  if v_customer_id is null then
    raise exception using errcode = '28000', message = 'Connectez-vous avant de passer commande.';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Le panier est vide.';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'Le panier est vide.';
  end if;

  if jsonb_typeof(p_address) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Les informations de livraison sont invalides.';
  end if;

  v_recipient_name := btrim(coalesce(p_address ->> 'recipient_name', ''));
  v_phone := btrim(coalesce(p_address ->> 'phone', ''));
  v_address_line := btrim(coalesce(p_address ->> 'address_line', ''));
  v_city := btrim(coalesce(p_address ->> 'city', ''));
  v_notes := nullif(btrim(coalesce(p_address ->> 'notes', '')), '');

  if v_recipient_name = '' or v_phone = '' or v_address_line = '' or v_city = '' then
    raise exception using errcode = '22023', message = 'Nom, téléphone, adresse et ville sont obligatoires.';
  end if;

  if not exists (select 1 from public.profiles pr where pr.id = v_customer_id) then
    raise exception using errcode = '23503', message = 'Le profil client est introuvable. Reconnectez-vous ou recréez votre compte.';
  end if;

  v_address := jsonb_build_object(
    'recipient_name', v_recipient_name,
    'phone', v_phone,
    'address_line', v_address_line,
    'city', v_city,
    'notes', v_notes
  );

  -- Aggregate duplicate product lines and lock products in a stable order to
  -- validate stock and prices atomically, preventing client-supplied totals.
  for v_item in
    select
      (line.value ->> 'product_id')::uuid as product_id,
      sum((line.value ->> 'quantity')::numeric)::numeric(12,3) as quantity
    from jsonb_array_elements(p_items) as line(value)
    group by (line.value ->> 'product_id')::uuid
    order by (line.value ->> 'product_id')::uuid
  loop
    v_product_id := v_item.product_id;
    v_quantity := v_item.quantity;

    if v_quantity <= 0 or v_quantity > 1000 then
      raise exception using errcode = '22023', message = 'La quantité demandée est invalide.';
    end if;

    select p.* into v_product
    from public.products p
    where p.id = v_product_id
    for update;

    if not found or not v_product.active then
      raise exception using errcode = 'P0002', message = 'Un produit du panier n’est plus disponible.';
    end if;

    if v_product.stock_quantity < v_quantity then
      raise exception using errcode = '22023', message = format('Stock insuffisant pour %s.', v_product.name);
    end if;

    v_line_total := round(v_product.price * v_quantity, 3);
    v_subtotal := v_subtotal + v_line_total;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id,
      'name', v_product.name,
      'unit', v_product.unit_label,
      'unit_price', v_product.price,
      'quantity', v_quantity,
      'line_total', v_line_total
    ));
  end loop;

  if jsonb_array_length(v_lines) = 0 then
    raise exception using errcode = '22023', message = 'Le panier ne contient aucun produit valide.';
  end if;

  v_total := v_subtotal + v_delivery_fee;

  insert into public.orders (
    customer_id, status, address_snapshot, subtotal, delivery_fee, total, currency, customer_note
  ) values (
    v_customer_id, 'pending', v_address, v_subtotal, v_delivery_fee, v_total, 'TND', nullif(btrim(coalesce(p_customer_note, '')), '')
  ) returning id, order_number into v_order_id, v_order_number;

  insert into public.customer_addresses (
    customer_id, label, recipient_name, phone, address_line, city, notes, is_default
  ) values (
    v_customer_id, 'Livraison', v_recipient_name, v_phone, v_address_line, v_city, v_notes, false
  );

  for v_item in select line.value from jsonb_array_elements(v_lines) as line(value)
  loop
    insert into public.order_items (
      order_id, product_id, product_name_snapshot, unit_snapshot, unit_price, quantity, line_total
    ) values (
      v_order_id,
      (v_item.value ->> 'product_id')::uuid,
      v_item.value ->> 'name',
      v_item.value ->> 'unit',
      (v_item.value ->> 'unit_price')::numeric,
      (v_item.value ->> 'quantity')::numeric,
      (v_item.value ->> 'line_total')::numeric
    );

    update public.products
    set stock_quantity = stock_quantity - (v_item.value ->> 'quantity')::numeric,
        updated_at = now()
    where id = (v_item.value ->> 'product_id')::uuid;
  end loop;

  insert into public.order_status_history (order_id, status, note, changed_by)
  values (v_order_id, 'pending', 'Commande reçue depuis Appro+.', v_customer_id);

  insert into public.payments (order_id, method, status, amount, currency)
  values (v_order_id, 'cash_on_delivery', 'pending', v_total, 'TND');

  return jsonb_build_object(
    'id', v_order_id,
    'order_number', v_order_number,
    'subtotal', v_subtotal,
    'delivery_fee', v_delivery_fee,
    'total', v_total,
    'currency', 'TND',
    'status', 'pending',
    'payment_method', 'cash_on_delivery'
  );
end;
$function$
;

-- ===== place_multi_order
CREATE OR REPLACE FUNCTION public.place_multi_order(p_orders jsonb, p_requested_date date DEFAULT NULL::date, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := public.active_uid();
  v_current uuid;
  v_order jsonb;
  v_client uuid;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'Connectez-vous avant de passer commande (compte actif requis).';
  end if;
  if jsonb_typeof(p_orders) is distinct from 'array' or jsonb_array_length(p_orders) = 0 then
    raise exception using errcode = '22023', message = 'La commande est vide.';
  end if;
  select pr.client_id into v_current from public.profiles pr where pr.id = v_uid;
  for v_order in select value from jsonb_array_elements(p_orders) loop
    v_client := nullif(v_order ->> 'client_id', '')::uuid;
    if v_client is null or not exists (select 1 from public.buyer_order_relations() c where c.id = v_client) then
      raise exception using errcode = '42501', message = 'Un des fournisseurs du panier ne vous permet pas de commander.';
    end if;
    -- Every product must belong to this supplier.
    if exists (select 1 from jsonb_array_elements(coalesce(v_order -> 'items', '[]'::jsonb)) line
               where not exists (select 1 from public.products p join public.clients c on c.id = v_client
                                 where p.id = nullif(line ->> 'product_id', '')::uuid and p.org_id = c.supplier_org_id)) then
      raise exception using errcode = '22023', message = 'Un produit du panier n’appartient pas à ce fournisseur.';
    end if;
    perform set_config('appro.link_write', 'on', true);
    update public.profiles set client_id = v_client where id = v_uid;
    perform set_config('appro.link_write', 'off', true);
    v_result := public.place_client_order(v_order -> 'items', nullif(v_order ->> 'delivery_point_id', '')::uuid, p_requested_date, p_note);
    v_results := v_results || jsonb_build_array(v_result || jsonb_build_object('client_id', v_client,
      'supplier_name', (select s.name from public.clients c join public.organizations s on s.id = c.supplier_org_id where c.id = v_client)));
  end loop;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set client_id = v_current where id = v_uid;
  perform set_config('appro.link_write', 'off', true);
  return v_results;
end;
$function$
;

-- ===== platform_accounts
CREATE OR REPLACE FUNCTION public.platform_accounts(p_search text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.platform_can('platform.pros.view') then
    raise exception using errcode = '42501', message = 'Réservé à l’équipe Appro+.';
  end if;
  return coalesce((
    select jsonb_agg(x order by (x ->> 'status') = 'pending' desc, x ->> 'email') from (
      select jsonb_build_object('id', u.id, 'email', u.email, 'full_name', coalesce(pr.full_name, ''), 'role', pr.role,
        'status', pr.account_status, 'org_id', o.id, 'org_name', coalesce(o.name, c.business_name), 'org_kind', o.kind,
        'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at) as x
      from auth.users u left join public.profiles pr on pr.id = u.id
      left join public.organizations o on o.id = pr.org_id left join public.clients c on c.id = pr.client_id
      where p_search is null or btrim(p_search) = ''
         or lower(u.email || ' ' || coalesce(pr.full_name, '') || ' ' || coalesce(o.name, '') || ' ' || coalesce(c.business_name, '')) like '%' || lower(btrim(p_search)) || '%'
      order by u.created_at desc limit 300) s
  ), '[]'::jsonb);
end;
$function$
;

-- ===== platform_can
CREATE OR REPLACE FUNCTION public.platform_can(p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case public.platform_role()
    when 'superadmin' then true
    when 'support' then p_permission in ('platform.pros.view', 'platform.support.access', 'platform.audit')
    when 'account_manager' then p_permission in ('platform.pros.view', 'platform.pros.manage', 'platform.roles.assign', 'platform.support.access', 'platform.catalog')
    when 'verification' then p_permission in ('platform.pros.view', 'platform.pros.validate')
    when 'finance' then p_permission in ('platform.pros.view', 'platform.billing')
    when 'viewer' then p_permission in ('platform.pros.view', 'platform.audit')
    else false
  end;
$function$
;

-- ===== platform_categories
CREATE OR REPLACE FUNCTION public.platform_categories()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'parent_id', c.parent_id, 'sort_order', c.sort_order, 'active', c.active,
    'products', (select count(*) from public.products p where p.category_id = c.id)) order by c.sort_order, c.name), '[]'::jsonb)
  from public.categories c where public.platform_can('platform.catalog');
$function$
;

-- ===== platform_modules_defaults
CREATE OR REPLACE FUNCTION public.platform_modules_defaults()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_object_agg(k, public.module_default(k)) from unnest(public.module_keys()) as k;
$function$
;

-- ===== platform_pro
CREATE OR REPLACE FUNCTION public.platform_pro(p_org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.platform_can('platform.pros.view') then
    raise exception using errcode = '42501', message = 'Réservé à l’équipe Appro+.';
  end if;
  return (select to_jsonb(o) || jsonb_build_object(
      'members', (select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'email', u.email, 'full_name', pr.full_name,
                    'status', pr.account_status, 'role', pr.role) order by pr.role = 'admin' desc, u.email), '[]'::jsonb)
                  from public.profiles pr left join auth.users u on u.id = pr.id where pr.org_id = o.id),
      'clients', (select count(*) from public.clients c where c.supplier_org_id = o.id),
      'suppliers', (select count(*) from public.clients c where c.buyer_org_id = o.id),
      'products', (select count(*) from public.products p where p.org_id = o.id))
    from public.organizations o where o.id = p_org_id);
end;
$function$
;

-- ===== platform_pros
CREATE OR REPLACE FUNCTION public.platform_pros()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.platform_can('platform.pros.view') then
    raise exception using errcode = '42501', message = 'Réservé à l’équipe Appro+.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'name', o.name, 'is_supplier', o.is_supplier, 'is_buyer', o.is_buyer, 'status', o.status, 'trial_until', o.trial_until, 'kind', o.kind,
      'email', o.email, 'phone', o.phone, 'created_at', o.created_at,
      'members', (select count(*) from public.profiles pr where pr.org_id = o.id),
      'clients', (select count(*) from public.clients c where c.supplier_org_id = o.id),
      'suppliers', (select count(*) from public.clients c where c.buyer_org_id = o.id)
    ) order by (o.status = 'pending' or o.trial_until is not null) desc, o.is_supplier desc, o.name)
    from public.organizations o
  ), '[]'::jsonb);
end;
$function$
;

-- ===== platform_role
CREATE OR REPLACE FUNCTION public.platform_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pm.role from public.platform_members pm join public.profiles pr on pr.id = pm.user_id
  where pm.user_id = (select auth.uid()) and pm.active and pr.account_status = 'active';
$function$
;

-- ===== platform_save_category
CREATE OR REPLACE FUNCTION public.platform_save_category(p_id uuid, p_name text, p_parent_id uuid DEFAULT NULL::uuid, p_sort_order integer DEFAULT NULL::integer, p_active boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid := p_id;
  v_name text := btrim(coalesce(p_name, ''));
  v_slug text;
begin
  if not public.platform_can('platform.catalog') then
    raise exception using errcode = '42501', message = 'Seule l’équipe Appro+ gère les catégories.';
  end if;
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Indiquez le nom de la catégorie.';
  end if;
  if p_parent_id is not null and (p_parent_id = p_id or exists (select 1 from public.categories c where c.id = p_parent_id and c.parent_id is not null)) then
    raise exception using errcode = '22023', message = 'Une sous-catégorie se range sous une catégorie principale.';
  end if;
  if exists (select 1 from public.categories c where lower(c.name) = lower(v_name) and c.id is distinct from p_id) then
    raise exception using errcode = '23505', message = 'Cette catégorie existe déjà.';
  end if;
  v_slug := trim(both '-' from regexp_replace(lower(translate(v_name, 'àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ', 'aaaceeeeiioouuuyoaAAACEEEEIIOOUUUY')), '[^a-z0-9]+', '-', 'g'));
  while exists (select 1 from public.categories c where c.slug = v_slug and c.id is distinct from p_id) loop
    v_slug := v_slug || '-' || substr(md5(random()::text), 1, 4);
  end loop;
  if v_id is null then
    insert into public.categories (name, slug, sort_order, active, parent_id)
    values (v_name, v_slug, coalesce(p_sort_order, (select coalesce(max(sort_order), 0) + 10 from public.categories)), coalesce(p_active, true), p_parent_id)
    returning id into v_id;
  else
    update public.categories set name = v_name, slug = v_slug, sort_order = coalesce(p_sort_order, sort_order),
      active = coalesce(p_active, active), parent_id = p_parent_id, updated_at = now()
    where id = v_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'Catégorie introuvable.';
    end if;
  end if;
  return v_id;
end;
$function$
;

-- ===== platform_save_pro
CREATE OR REPLACE FUNCTION public.platform_save_pro(p_org_id uuid, p_profile jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := p_org_id;
  v_owner text := nullif(lower(btrim(coalesce(p_profile ->> 'owner_email', ''))), '');
  v_user uuid;
  v_supplier boolean := coalesce((p_profile ->> 'is_supplier')::boolean, false);
  v_buyer boolean := coalesce((p_profile ->> 'is_buyer')::boolean, true);
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas de créer ou modifier un Pro.';
  end if;
  if char_length(btrim(coalesce(p_profile ->> 'name', ''))) < 2 then
    raise exception using errcode = '22023', message = 'Indiquez le nom du Pro.';
  end if;
  if not (v_supplier or v_buyer) then
    raise exception using errcode = '22023', message = 'Un Pro est au moins fournisseur ou acheteur.';
  end if;
  if coalesce(p_profile ->> 'kind', 'business') = 'person' and v_supplier then
    raise exception using errcode = '22023', message = 'Un particulier est acheteur, pas fournisseur.';
  end if;
  if v_owner is not null then
    select u.id into v_user from auth.users u where lower(u.email) = v_owner;
    if v_user is not null and exists (select 1 from public.profiles pr where pr.id = v_user
         and (pr.role = 'platform' or (pr.org_id is not null and pr.org_id is distinct from v_org) or pr.client_id is not null)) then
      raise exception using errcode = '22023', message = 'Cet e-mail appartient déjà à un autre Pro ou à l’équipe Appro+.';
    end if;
  end if;
  if v_org is null then
    insert into public.organizations (name, kind, is_supplier, is_buyer, status, created_by)
    values (left(btrim(p_profile ->> 'name'), 120), coalesce(p_profile ->> 'kind', 'business'), v_supplier, v_buyer,
            coalesce(p_profile ->> 'status', 'active'), auth.uid())
    returning id into v_org;
  end if;
  update public.organizations set
    name = left(btrim(p_profile ->> 'name'), 120),
    kind = coalesce(p_profile ->> 'kind', kind),
    is_supplier = v_supplier, is_buyer = v_buyer,
    roles_delegated = coalesce((p_profile ->> 'roles_delegated')::boolean, roles_delegated),
    tagline = left(btrim(coalesce(p_profile ->> 'tagline', tagline)), 160),
    address = left(btrim(coalesce(p_profile ->> 'address', address)), 300),
    phone = left(btrim(coalesce(p_profile ->> 'phone', phone)), 60),
    email = left(btrim(coalesce(p_profile ->> 'email', email)), 160),
    tax_id = left(btrim(coalesce(p_profile ->> 'tax_id', tax_id)), 60),
    rib = left(btrim(coalesce(p_profile ->> 'rib', rib)), 80),
    owner_email = coalesce(v_owner, owner_email),
    updated_at = now()
  where id = v_org;
  if not found then
    raise exception using errcode = 'P0002', message = 'Pro introuvable.';
  end if;
  perform public.org_install_roles(v_org);
  if v_supplier and exists (select 1 from public.organizations where id = v_org and status = 'active') then
    perform public.org_install_numbering(v_org);
  end if;
  if v_user is not null then
    perform public.attach_org_owner(v_org, v_user);
  end if;
  return v_org;
end;
$function$
;

-- ===== platform_set_account_status
CREATE OR REPLACE FUNCTION public.platform_set_account_status(p_user_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas de modifier un compte.';
  end if;
  if p_user_id = auth.uid() then
    raise exception using errcode = '22023', message = 'Vous ne pouvez pas modifier votre propre compte ici.';
  end if;
  if p_status not in ('active', 'suspended', 'pending', 'refused') then
    raise exception using errcode = '22023', message = 'Statut inconnu.';
  end if;
  update public.profiles set account_status = p_status where id = p_user_id and role <> 'platform';
  if not found then
    raise exception using errcode = 'P0002', message = 'Compte introuvable (les comptes Appro+ se gèrent dans Équipe Appro+).';
  end if;
end;
$function$
;

-- ===== platform_set_member
CREATE OR REPLACE FUNCTION public.platform_set_member(p_email text, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid;
  v_profile public.profiles%rowtype;
begin
  if public.platform_role() is distinct from 'superadmin' then
    raise exception using errcode = '42501', message = 'Seul le super-admin gère l’équipe Appro+.';
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(p_email));
  if v_user is null then
    raise exception using errcode = 'P0002', message = 'Aucun compte avec cet e-mail : la personne doit d’abord créer son compte.';
  end if;
  if v_user = auth.uid() then
    raise exception using errcode = '22023', message = 'Vous ne pouvez pas modifier votre propre rôle.';
  end if;
  select * into v_profile from public.profiles where id = v_user;
  if p_role is null then
    delete from public.platform_members where user_id = v_user;
    update public.profiles set role = 'customer', is_superadmin = false, account_status = 'suspended' where id = v_user and role = 'platform';
    return;
  end if;
  if p_role not in ('superadmin', 'support', 'account_manager', 'verification', 'finance', 'viewer') then
    raise exception using errcode = '22023', message = 'Rôle Appro+ inconnu.';
  end if;
  if v_profile.org_id is not null or v_profile.client_id is not null then
    raise exception using errcode = '22023', message = 'Ce compte appartient à un Pro : utilisez une autre adresse pour l’équipe Appro+.';
  end if;
  insert into public.platform_members (user_id, role, invited_by) values (v_user, p_role, auth.uid())
  on conflict (user_id) do update set role = excluded.role, active = true;
  update public.profiles set role = 'platform', is_superadmin = (p_role = 'superadmin'), account_status = 'active' where id = v_user;
end;
$function$
;

-- ===== platform_set_org_module
CREATE OR REPLACE FUNCTION public.platform_set_org_module(p_org_id uuid, p_key text, p_granted boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Seule l’équipe Appro+ gère la formule d’un Pro.';
  end if;
  if not (p_key = any(public.module_keys())) then
    raise exception using errcode = '22023', message = 'Module inconnu.';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org_id) then
    raise exception using errcode = 'P0002', message = 'Pro introuvable.';
  end if;
  insert into public.org_modules (org_id, key, granted, updated_at, updated_by) values (p_org_id, p_key, p_granted, now(), auth.uid())
  on conflict (org_id, key) do update set granted = excluded.granted, updated_at = now(), updated_by = auth.uid();
end;
$function$
;

-- ===== platform_set_pro_profile
CREATE OR REPLACE FUNCTION public.platform_set_pro_profile(p_org_id uuid, p_is_supplier boolean, p_is_buyer boolean, p_roles_delegated boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas de modifier un Pro.';
  end if;
  if not (coalesce(p_is_supplier, false) or coalesce(p_is_buyer, false)) then
    raise exception using errcode = '22023', message = 'Un Pro est au moins fournisseur ou acheteur.';
  end if;
  update public.organizations set is_supplier = p_is_supplier, is_buyer = p_is_buyer,
    roles_delegated = coalesce(p_roles_delegated, roles_delegated), updated_at = now()
  where id = p_org_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Pro introuvable.';
  end if;
  perform public.org_install_roles(p_org_id);
  if p_is_supplier then
    perform public.org_install_numbering(p_org_id);
  end if;
  -- Its Responsable(s) get the Responsable role of the new activity too.
  insert into public.member_roles (user_id, role_id)
  select pr.id, r.id from public.profiles pr
  join public.org_roles r on r.org_id = p_org_id
  join public.role_templates t on t.id = r.template_id and t.key in ('supplier_owner', 'buyer_owner')
  where pr.org_id = p_org_id and pr.role = 'admin'
  on conflict do nothing;
end;
$function$
;

-- ===== platform_set_pro_status
CREATE OR REPLACE FUNCTION public.platform_set_pro_status(p_org_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not (public.platform_can('platform.pros.validate') or public.platform_can('platform.pros.manage')) then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas de valider ou suspendre un Pro.';
  end if;
  if p_status not in ('active', 'suspended', 'refused', 'pending') then
    raise exception using errcode = '22023', message = 'Statut inconnu.';
  end if;
  if exists (select 1 from public.organizations where id = p_org_id and legacy) and p_status <> 'active' then
    raise exception using errcode = '22023', message = 'Le premier fournisseur de la plateforme ne peut pas être suspendu ici.';
  end if;
  update public.organizations set status = p_status, trial_until = case when p_status = 'active' then null else trial_until end, updated_at = now() where id = p_org_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Pro introuvable.';
  end if;
  if p_status = 'active' then
    perform public.org_install_roles(p_org_id);
    if exists (select 1 from public.organizations where id = p_org_id and is_supplier) then
      perform public.org_install_numbering(p_org_id);
    end if;
    update public.profiles set account_status = 'active', trial_suspended = false
    where org_id = p_org_id and role in ('admin', 'customer') and (account_status = 'pending' or (account_status = 'suspended' and trial_suspended));
  end if;
end;
$function$
;

-- ===== platform_set_setting
CREATE OR REPLACE FUNCTION public.platform_set_setting(p_key text, p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas de modifier ce réglage.';
  end if;
  if p_key = 'new_accounts_trial_hours' then
    if jsonb_typeof(p_value) is distinct from 'number' or (p_value #>> '{}')::numeric not between 0 and 720 then
      raise exception using errcode = '22023', message = 'Durée invalide (0 à 720 heures).';
    end if;
    p_value := to_jsonb(round((p_value #>> '{}')::numeric)::int);
  elsif p_key = 'app_url' then
    if jsonb_typeof(p_value) is distinct from 'string' or ((p_value #>> '{}') <> '' and (p_value #>> '{}') !~ '^https?://[^ ]+$') then
      raise exception using errcode = '22023', message = 'Adresse invalide : elle commence par https://';
    end if;
    p_value := to_jsonb(regexp_replace(p_value #>> '{}', '/+$', ''));
  else
    raise exception using errcode = '22023', message = 'Réglage inconnu.';
  end if;
  insert into public.platform_settings (key, value, updated_at, updated_by) values (p_key, p_value, now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end;
$function$
;

-- ===== platform_set_template_permission
CREATE OR REPLACE FUNCTION public.platform_set_template_permission(p_template_key text, p_permission text, p_allowed boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_template public.role_templates%rowtype;
begin
  if public.platform_role() is distinct from 'superadmin' then
    raise exception using errcode = '42501', message = 'Seul le super-admin modifie les modèles de rôles.';
  end if;
  select * into v_template from public.role_templates where key = p_template_key;
  if v_template.id is null then
    raise exception using errcode = 'P0002', message = 'Modèle introuvable.';
  end if;
  if not exists (select 1 from public.permissions p where p.key = p_permission and p.side = v_template.side) then
    raise exception using errcode = '22023', message = 'Ce droit ne concerne pas ce modèle.';
  end if;
  if p_allowed then
    insert into public.role_template_permissions (template_id, permission) values (v_template.id, p_permission) on conflict do nothing;
  else
    delete from public.role_template_permissions where template_id = v_template.id and permission = p_permission;
  end if;
end;
$function$
;

-- ===== platform_setting
CREATE OR REPLACE FUNCTION public.platform_setting(p_key text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select s.value from public.platform_settings s where s.key = p_key; $function$
;

-- ===== platform_team
CREATE OR REPLACE FUNCTION public.platform_team()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if public.platform_role() is null then
    raise exception using errcode = '42501', message = 'Réservé à l’équipe Appro+.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', pm.user_id, 'email', u.email, 'full_name', pr.full_name, 'role', pm.role, 'active', pm.active)
      order by pm.role = 'superadmin' desc, u.email)
    from public.platform_members pm join public.profiles pr on pr.id = pm.user_id left join auth.users u on u.id = pm.user_id
  ), '[]'::jsonb);
end;
$function$
;

-- ===== platform_templates
CREATE OR REPLACE FUNCTION public.platform_templates()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when public.platform_role() is null then null else jsonb_build_object(
    'permissions', (select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'side', p.side, 'module', public.feature_module(p.key)) order by p.side, p.key), '[]'::jsonb) from public.permissions p),
    'templates', (select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'name', t.name, 'side', t.side, 'description', t.description,
        'granted', (select coalesce(jsonb_agg(tp.permission order by tp.permission), '[]'::jsonb) from public.role_template_permissions tp where tp.template_id = t.id),
        'roles', (select count(*) from public.org_roles r where r.template_id = t.id)
      ) order by t.sort_order), '[]'::jsonb) from public.role_templates t)) end;
$function$
;

-- ===== price_lines
CREATE OR REPLACE FUNCTION public.price_lines(p_client_id uuid, p_items jsonb, p_order_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_client public.clients%rowtype;
  v_today date := (now() at time zone 'Africa/Tunis')::date;
  v_dow int := extract(isodow from (now() at time zone 'Africa/Tunis'))::int;
  v_past int;
  v_on boolean;
  v_subtotal_list numeric := 0;
  v_cart jsonb;
  v_rules public.pricing_rules[];
  v_rule public.pricing_rules;
  v_line record;
  v_base numeric;
  v_net numeric;
  v_factor numeric;
  v_best numeric;
  v_best_label text;
  v_stack numeric;
  v_labels text[];
  v_total numeric;
  v_lines jsonb := '{}'::jsonb;
  v_subtotal numeric := 0;
  v_applied text[] := '{}';
  v_next jsonb := '[]'::jsonb;
begin
  select c.* into v_client from public.clients c where c.id = p_client_id;
  if not found then
    return jsonb_build_object('lines', '{}'::jsonb, 'subtotal_list', 0, 'subtotal', 0, 'discount', 0, 'applied', '[]'::jsonb, 'next', '[]'::jsonb);
  end if;
  v_on := public.module_enabled_for(v_client.supplier_org_id, 'pricing');

  select coalesce(jsonb_agg(jsonb_build_object('product_id', q.product_id, 'quantity', q.quantity)), '[]'::jsonb) into v_cart
  from (select (line.value ->> 'product_id')::uuid as product_id, sum((line.value ->> 'quantity')::numeric) as quantity
        from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) as line(value)
        where nullif(line.value ->> 'product_id', '') is not null and (line.value ->> 'quantity')::numeric > 0
        group by 1) q;

  select coalesce(sum(round(p.price * (q.value ->> 'quantity')::numeric, 3)), 0) into v_subtotal_list
  from jsonb_array_elements(v_cart) q join public.products p on p.id = (q.value ->> 'product_id')::uuid and p.org_id = v_client.supplier_org_id;

  select count(*) into v_past from public.orders o
  where o.client_id = v_client.id and o.status not in ('cancelled', 'declined') and o.id is distinct from p_order_id;

  if v_on then
    select coalesce(array_agg(r order by r.created_at), '{}') into v_rules
    from public.pricing_rules r
    where r.org_id = v_client.supplier_org_id and r.active
      and (r.target = 'all' or (r.target = 'group' and r.price_group_id = v_client.price_group_id) or (r.target = 'client' and r.client_id = v_client.id))
      and (r.starts_on is null or r.starts_on <= v_today) and (r.ends_on is null or r.ends_on >= v_today)
      and (cardinality(r.weekdays) = 0 or v_dow = any(r.weekdays))
      and (not r.first_order_only or v_past = 0)
      and (r.min_past_orders is null or v_past >= r.min_past_orders)
      and (r.min_order_amount is null or v_subtotal_list >= r.min_order_amount);

    -- What the buyer could still get by adding to the cart.
    select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'missing', round(r.min_order_amount - v_subtotal_list, 3)) order by r.min_order_amount), '[]'::jsonb)
    into v_next
    from public.pricing_rules r
    where r.org_id = v_client.supplier_org_id and r.active and r.min_order_amount is not null and v_subtotal_list < r.min_order_amount
      and (r.target = 'all' or (r.target = 'group' and r.price_group_id = v_client.price_group_id) or (r.target = 'client' and r.client_id = v_client.id))
      and (r.starts_on is null or r.starts_on <= v_today) and (r.ends_on is null or r.ends_on >= v_today)
      and (cardinality(r.weekdays) = 0 or v_dow = any(r.weekdays))
      and (not r.first_order_only or v_past = 0)
      and (r.min_past_orders is null or v_past >= r.min_past_orders);
  else
    v_rules := '{}';
  end if;

  for v_line in
    select p as product, (q.value ->> 'quantity')::numeric as quantity from jsonb_array_elements(v_cart) q
    join public.products p on p.id = (q.value ->> 'product_id')::uuid and p.org_id = v_client.supplier_org_id
  loop
    v_base := (v_line.product).price;
    v_labels := '{}';
    -- Negotiated net price: the lowest one that applies, if lower than the catalogue price.
    v_net := null;
    foreach v_rule in array v_rules loop
      if v_rule.kind = 'net_price' and v_rule.value is not null and public.pricing_rule_covers(v_rule, v_line.product)
         and (v_rule.min_line_qty is null or v_line.quantity >= v_rule.min_line_qty)
         and v_rule.value < coalesce(v_net, v_base) then
        v_net := v_rule.value;
        v_best_label := v_rule.name;
      end if;
    end loop;
    if v_net is not null then
      v_base := v_net;
      v_labels := array_append(v_labels, v_best_label);
      v_applied := array_append(v_applied, v_best_label);
    end if;

    -- Discounts: the best one, then the stackable ones on top.
    v_best := 1;
    v_best_label := null;
    v_stack := 1;
    foreach v_rule in array v_rules loop
      continue when v_rule.kind = 'net_price' or not public.pricing_rule_covers(v_rule, v_line.product)
        or (v_rule.min_line_qty is not null and v_line.quantity < v_rule.min_line_qty);
      v_factor := case v_rule.kind
        when 'percent' then 1 - least(greatest(coalesce(v_rule.value, 0), 0), 100) / 100
        when 'tiers' then 1 - coalesce((select least(greatest((t ->> 'percent')::numeric, 0), 100) from jsonb_array_elements(v_rule.tiers) t
            where (t ->> 'min_qty')::numeric <= v_line.quantity order by (t ->> 'min_qty')::numeric desc limit 1), 0) / 100
        when 'free_units' then case when coalesce(v_rule.buy_qty, 0) > 0 and coalesce(v_rule.free_qty, 0) > 0
            then (v_line.quantity - floor(v_line.quantity / (v_rule.buy_qty + v_rule.free_qty)) * v_rule.free_qty) / v_line.quantity
            else 1 end
        else 1 end;
      continue when v_factor >= 1;
      if v_rule.stackable then
        v_stack := v_stack * v_factor;
        v_labels := array_append(v_labels, v_rule.name);
        v_applied := array_append(v_applied, v_rule.name);
      elsif v_factor < v_best then
        v_best := v_factor;
        v_best_label := v_rule.name;
      end if;
    end loop;
    if v_best_label is not null then
      v_labels := array_append(v_labels, v_best_label);
      v_applied := array_append(v_applied, v_best_label);
    end if;

    v_total := round(v_base * v_line.quantity * v_best * v_stack, 3);
    v_subtotal := v_subtotal + v_total;
    v_lines := v_lines || jsonb_build_object((v_line.product).id::text, jsonb_build_object(
      'list_price', (v_line.product).price,
      'unit_price', round(v_total / v_line.quantity, 3),
      'quantity', v_line.quantity,
      'line_total', v_total,
      'discount', round((v_line.product).price * v_line.quantity, 3) - v_total,
      'label', nullif(array_to_string(v_labels, ' + '), '')));
  end loop;

  return jsonb_build_object('lines', v_lines, 'subtotal_list', v_subtotal_list, 'subtotal', v_subtotal,
    'discount', v_subtotal_list - v_subtotal,
    'applied', (select coalesce(jsonb_agg(distinct a), '[]'::jsonb) from unnest(v_applied) a),
    'next', v_next);
end;
$function$
;

-- ===== pricing_delete_group
CREATE OR REPLACE FUNCTION public.pricing_delete_group(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.pricing_manager_org();
begin
  perform set_config('appro.link_write', 'on', true);
  update public.clients set price_group_id = null where price_group_id = p_id and supplier_org_id = v_org;
  perform set_config('appro.link_write', 'off', true);
  delete from public.price_groups where id = p_id and org_id = v_org;
end;
$function$
;

-- ===== pricing_delete_rule
CREATE OR REPLACE FUNCTION public.pricing_delete_rule(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.pricing_manager_org();
begin
  delete from public.pricing_rules where id = p_id and org_id = v_org;
end;
$function$
;

-- ===== pricing_manager_org
CREATE OR REPLACE FUNCTION public.pricing_manager_org()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not public.has_feature('products.manage') then
    raise exception using errcode = '42501', message = 'Vous n’avez pas le droit de gérer les tarifs.';
  end if;
  if not public.module_enabled_for(v_org, 'pricing') then
    raise exception using errcode = '42501', message = 'Le module « Remises et tarifs clients » n’est pas actif pour votre Pro.';
  end if;
  return v_org;
end;
$function$
;

-- ===== pricing_overview
CREATE OR REPLACE FUNCTION public.pricing_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.pricing_manager_org();
begin
  return jsonb_build_object(
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name,
        'clients', (select count(*) from public.clients c where c.price_group_id = g.id)) order by lower(g.name))
      from public.price_groups g where g.org_id = v_org), '[]'::jsonb),
    'clients', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'business_name', c.business_name, 'price_group_id', c.price_group_id) order by lower(c.business_name))
      from public.clients c where c.supplier_org_id = v_org and c.active and c.link_status = 'active'), '[]'::jsonb),
    'rules', coalesce((select jsonb_agg(to_jsonb(r) order by r.active desc, r.created_at desc) from public.pricing_rules r where r.org_id = v_org), '[]'::jsonb));
end;
$function$
;

-- ===== pricing_rule_covers
CREATE OR REPLACE FUNCTION public.pricing_rule_covers(p_rule pricing_rules, p_product products)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case p_rule.product_scope
    when 'all' then true
    when 'products' then p_product.id = any(p_rule.product_ids)
    else p_product.category_id = any(p_rule.category_ids)
      or exists (select 1 from public.categories cat where cat.id = p_product.category_id and cat.parent_id = any(p_rule.category_ids))
  end;
$function$
;

-- ===== pricing_save_group
CREATE OR REPLACE FUNCTION public.pricing_save_group(p_id uuid, p_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.pricing_manager_org();
  v_id uuid;
begin
  if btrim(coalesce(p_name, '')) = '' then
    raise exception using errcode = '22023', message = 'Donnez un nom au groupe.';
  end if;
  if exists (select 1 from public.price_groups g where g.org_id = v_org and lower(g.name) = lower(btrim(p_name)) and g.id is distinct from p_id) then
    raise exception using errcode = '23505', message = 'Un groupe porte déjà ce nom.';
  end if;
  if p_id is null then
    insert into public.price_groups (org_id, name) values (v_org, btrim(p_name)) returning id into v_id;
  else
    update public.price_groups set name = btrim(p_name) where id = p_id and org_id = v_org returning id into v_id;
    if v_id is null then
      raise exception using errcode = 'P0002', message = 'Groupe introuvable.';
    end if;
  end if;
  return v_id;
end;
$function$
;

-- ===== pricing_save_rule
CREATE OR REPLACE FUNCTION public.pricing_save_rule(p_rule jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.pricing_manager_org();
  v_id uuid := nullif(p_rule ->> 'id', '')::uuid;
  v_kind text := p_rule ->> 'kind';
  v_value numeric := nullif(p_rule ->> 'value', '')::numeric;
  v_buy numeric := nullif(p_rule ->> 'buy_qty', '')::numeric;
  v_free numeric := nullif(p_rule ->> 'free_qty', '')::numeric;
  v_tiers jsonb := coalesce(p_rule -> 'tiers', '[]'::jsonb);
  v_target text := coalesce(nullif(p_rule ->> 'target', ''), 'all');
  v_group uuid := nullif(p_rule ->> 'price_group_id', '')::uuid;
  v_client uuid := nullif(p_rule ->> 'client_id', '')::uuid;
  v_scope text := coalesce(nullif(p_rule ->> 'product_scope', ''), 'all');
  v_categories uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_rule -> 'category_ids', '[]'::jsonb)) x), '{}');
  v_products uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_rule -> 'product_ids', '[]'::jsonb)) x), '{}');
  v_weekdays int[] := coalesce((select array_agg(distinct x::int) from jsonb_array_elements_text(coalesce(p_rule -> 'weekdays', '[]'::jsonb)) x), '{}');
  v_starts date := nullif(p_rule ->> 'starts_on', '')::date;
  v_ends date := nullif(p_rule ->> 'ends_on', '')::date;
  v_min_amount numeric := nullif(p_rule ->> 'min_order_amount', '')::numeric;
  v_min_qty numeric := nullif(p_rule ->> 'min_line_qty', '')::numeric;
  v_min_past int := nullif(p_rule ->> 'min_past_orders', '')::int;
begin
  if btrim(coalesce(p_rule ->> 'name', '')) = '' then
    raise exception using errcode = '22023', message = 'Donnez un nom à la remise (il est affiché au client).';
  end if;
  if v_kind is null or v_kind not in ('percent', 'net_price', 'free_units', 'tiers') then
    raise exception using errcode = '22023', message = 'Choisissez le type de remise.';
  end if;
  if v_kind = 'percent' and (v_value is null or v_value <= 0 or v_value > 100) then
    raise exception using errcode = '22023', message = 'Le pourcentage doit être compris entre 0 et 100.';
  end if;
  if v_kind = 'net_price' then
    if v_value is null or v_value < 0 then
      raise exception using errcode = '22023', message = 'Indiquez le prix net HT négocié.';
    end if;
    if v_scope <> 'products' or cardinality(v_products) = 0 then
      raise exception using errcode = '22023', message = 'Un prix net s’applique à des produits choisis.';
    end if;
  end if;
  if v_kind = 'free_units' and (v_buy is null or v_buy <= 0 or v_free is null or v_free <= 0) then
    raise exception using errcode = '22023', message = 'Indiquez combien sont achetés et combien sont offerts.';
  end if;
  if v_kind = 'tiers' then
    if jsonb_typeof(v_tiers) <> 'array' or jsonb_array_length(v_tiers) = 0 then
      raise exception using errcode = '22023', message = 'Ajoutez au moins un palier.';
    end if;
    if exists (select 1 from jsonb_array_elements(v_tiers) t
               where coalesce(nullif(t ->> 'min_qty', '')::numeric, 0) <= 0 or coalesce(nullif(t ->> 'percent', '')::numeric, 0) <= 0 or (t ->> 'percent')::numeric > 100) then
      raise exception using errcode = '22023', message = 'Chaque palier a une quantité minimale et un pourcentage entre 0 et 100.';
    end if;
  end if;
  if v_target not in ('all', 'group', 'client') or v_scope not in ('all', 'category', 'products') then
    raise exception using errcode = '22023', message = 'Ciblage invalide.';
  end if;
  if v_target = 'group' and not exists (select 1 from public.price_groups g where g.id = v_group and g.org_id = v_org) then
    raise exception using errcode = '22023', message = 'Choisissez le groupe de clients.';
  end if;
  if v_target = 'client' and not exists (select 1 from public.clients c where c.id = v_client and c.supplier_org_id = v_org) then
    raise exception using errcode = '22023', message = 'Choisissez le client.';
  end if;
  if v_scope = 'category' and (cardinality(v_categories) = 0 or exists (select 1 from unnest(v_categories) x where not exists (select 1 from public.categories cat where cat.id = x))) then
    raise exception using errcode = '22023', message = 'Choisissez au moins une catégorie.';
  end if;
  if v_scope = 'products' and (cardinality(v_products) = 0 or exists (select 1 from unnest(v_products) x where not exists (select 1 from public.products p where p.id = x and p.org_id = v_org))) then
    raise exception using errcode = '22023', message = 'Choisissez au moins un de vos produits.';
  end if;
  if exists (select 1 from unnest(v_weekdays) d where d < 1 or d > 7) then
    raise exception using errcode = '22023', message = 'Jour de la semaine invalide.';
  end if;
  if v_starts is not null and v_ends is not null and v_ends < v_starts then
    raise exception using errcode = '22023', message = 'La date de fin est avant la date de début.';
  end if;
  if (v_min_amount is not null and v_min_amount < 0) or (v_min_qty is not null and v_min_qty < 0) or (v_min_past is not null and v_min_past < 0) then
    raise exception using errcode = '22023', message = 'Les conditions ne peuvent pas être négatives.';
  end if;

  if v_id is null then
    insert into public.pricing_rules (org_id, created_by, name, kind) values (v_org, auth.uid(), btrim(p_rule ->> 'name'), v_kind) returning id into v_id;
  elsif not exists (select 1 from public.pricing_rules r where r.id = v_id and r.org_id = v_org) then
    raise exception using errcode = 'P0002', message = 'Remise introuvable.';
  end if;
  update public.pricing_rules set
    name = btrim(p_rule ->> 'name'), kind = v_kind,
    value = case when v_kind in ('percent', 'net_price') then v_value end,
    buy_qty = case when v_kind = 'free_units' then v_buy end,
    free_qty = case when v_kind = 'free_units' then v_free end,
    tiers = case when v_kind = 'tiers' then (select jsonb_agg(jsonb_build_object('min_qty', (t ->> 'min_qty')::numeric, 'percent', (t ->> 'percent')::numeric) order by (t ->> 'min_qty')::numeric) from jsonb_array_elements(v_tiers) t) else '[]'::jsonb end,
    target = v_target,
    price_group_id = case when v_target = 'group' then v_group end,
    client_id = case when v_target = 'client' then v_client end,
    product_scope = v_scope,
    category_ids = case when v_scope = 'category' then v_categories else '{}' end,
    product_ids = case when v_scope = 'products' then v_products else '{}' end,
    min_order_amount = v_min_amount, min_line_qty = v_min_qty, starts_on = v_starts, ends_on = v_ends, weekdays = v_weekdays,
    first_order_only = coalesce((p_rule ->> 'first_order_only')::boolean, false),
    min_past_orders = v_min_past,
    stackable = coalesce((p_rule ->> 'stackable')::boolean, false),
    active = coalesce((p_rule ->> 'active')::boolean, true),
    updated_at = now()
  where id = v_id;
  return v_id;
end;
$function$
;

-- ===== pricing_set_client_group
CREATE OR REPLACE FUNCTION public.pricing_set_client_group(p_client_id uuid, p_group_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.pricing_manager_org();
begin
  if p_group_id is not null and not exists (select 1 from public.price_groups g where g.id = p_group_id and g.org_id = v_org) then
    raise exception using errcode = 'P0002', message = 'Groupe introuvable.';
  end if;
  if not exists (select 1 from public.clients c where c.id = p_client_id and c.supplier_org_id = v_org) then
    raise exception using errcode = 'P0002', message = 'Client introuvable.';
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.clients set price_group_id = p_group_id where id = p_client_id and supplier_org_id = v_org;
  perform set_config('appro.link_write', 'off', true);
end;
$function$
;

-- ===== pricing_set_rule_active
CREATE OR REPLACE FUNCTION public.pricing_set_rule_active(p_id uuid, p_active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.pricing_manager_org();
begin
  update public.pricing_rules set active = coalesce(p_active, false), updated_at = now() where id = p_id and org_id = v_org;
end;
$function$
;

-- ===== pro_directory
CREATE OR REPLACE FUNCTION public.pro_directory(p_looking_for text, p_search text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me public.organizations%rowtype;
begin
  select * into v_me from public.organizations where id = public.current_org_id();
  if v_me.id is null then
    raise exception using errcode = '42501', message = 'Réservé aux Pros actifs.';
  end if;
  if (p_looking_for = 'clients' and not v_me.is_supplier) or (p_looking_for = 'suppliers' and not v_me.is_buyer) then
    raise exception using errcode = '22023', message = 'Votre Pro n’a pas cette activité.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'name', o.name, 'kind', o.kind, 'is_supplier', o.is_supplier, 'is_buyer', o.is_buyer,
      'address', o.address, 'tagline', o.tagline, 'open_to_new', o.open_to_new, 'open_to_messages', o.open_to_messages, 'catalog_visibility', o.catalog_visibility,
      'link', (select jsonb_build_object('id', c.id, 'status', c.link_status)
               from public.clients c
               where (p_looking_for = 'clients' and c.supplier_org_id = v_me.id and c.buyer_org_id = o.id)
                  or (p_looking_for = 'suppliers' and c.supplier_org_id = o.id and c.buyer_org_id = v_me.id)
               limit 1)
    ) order by o.name)
    from public.organizations o
    where o.status = 'active' and o.id <> v_me.id and o.listed_in_directory
      and ((p_looking_for = 'clients' and o.is_buyer) or (p_looking_for = 'suppliers' and o.is_supplier and o.kind = 'business'))
      and (p_search is null or btrim(p_search) = '' or lower(o.name || ' ' || o.address || ' ' || o.tagline) like '%' || lower(btrim(p_search)) || '%')
    limit 200
  ), '[]'::jsonb);
end;
$function$
;

-- ===== pro_link_request
CREATE OR REPLACE FUNCTION public.pro_link_request(p_other_org_id uuid, p_as text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me public.organizations%rowtype;
  v_other public.organizations%rowtype;
  v_supplier uuid;
  v_buyer uuid;
  v_id uuid;
begin
  if not (public.is_admin() or public.is_org_owner(public.current_org_id())) then
    raise exception using errcode = '42501', message = 'Seul le Responsable du Pro peut demander une mise en relation.';
  end if;
  select * into v_me from public.organizations where id = public.current_org_id();
  select * into v_other from public.organizations where id = p_other_org_id and status = 'active';
  if v_other.id is null or v_other.id = v_me.id then
    raise exception using errcode = 'P0002', message = 'Ce Pro n’est pas disponible dans l’annuaire.';
  end if;
  if p_as = 'supplier' then
    if not v_me.is_supplier or not v_other.is_buyer then
      raise exception using errcode = '22023', message = 'Ce Pro ne peut pas devenir votre client.';
    end if;
    if not v_other.open_to_new then
      raise exception using errcode = '22023', message = 'Ce Pro ne souhaite pas de nouveau fournisseur pour l’instant.';
    end if;
    v_supplier := v_me.id; v_buyer := v_other.id;
  elsif p_as = 'buyer' then
    if not v_me.is_buyer or not v_other.is_supplier then
      raise exception using errcode = '22023', message = 'Ce Pro ne peut pas devenir votre fournisseur.';
    end if;
    v_supplier := v_other.id; v_buyer := v_me.id;
  else
    raise exception using errcode = '22023', message = 'Précisez si vous êtes fournisseur ou acheteur.';
  end if;
  select c.id into v_id from public.clients c where c.supplier_org_id = v_supplier and c.buyer_org_id = v_buyer;
  if v_id is not null then
    update public.clients set link_status = case when link_status = 'refused' then
        (case when p_as = 'supplier' then 'requested_by_supplier' else 'requested_by_buyer' end) else link_status end,
      link_requested_at = now()
    where id = v_id and link_status = 'refused';
    return v_id;
  end if;
  perform set_config('appro.link_write', 'on', true);
  insert into public.clients (business_name, contact_name, phone, supplier_org_id, buyer_org_id, active, link_status, link_requested_at)
  values ((select o.name from public.organizations o where o.id = v_buyer), '', (select o.phone from public.organizations o where o.id = v_buyer),
          v_supplier, v_buyer, false, case when p_as = 'supplier' then 'requested_by_supplier' else 'requested_by_buyer' end, now())
  returning id into v_id;
  perform set_config('appro.link_write', 'off', true);
  -- The other side's Responsable(s) are told.
  perform public.notify(array(select mr.user_id from public.member_roles mr join public.org_roles r on r.id = mr.role_id
      join public.role_templates t on t.id = r.template_id
      where r.org_id = v_other.id and t.key in ('supplier_owner', 'buyer_owner')),
    'link.request', 'Demande de mise en relation',
    format('%s souhaite %s.', v_me.name, case when p_as = 'supplier' then 'devenir votre fournisseur' else 'devenir votre client' end));
  return v_id;
end;
$function$
;

-- ===== pro_link_respond
CREATE OR REPLACE FUNCTION public.pro_link_respond(p_client_id uuid, p_accept boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_link public.clients%rowtype;
  v_org uuid := public.current_org_id();
  v_buyer public.organizations%rowtype;
begin
  if not (public.is_admin() or public.is_org_owner(v_org)) then
    raise exception using errcode = '42501', message = 'Seul le Responsable du Pro peut répondre.';
  end if;
  select * into v_link from public.clients where id = p_client_id;
  if v_link.id is null
     or not ((v_link.link_status = 'requested_by_supplier' and v_link.buyer_org_id = v_org)
          or (v_link.link_status = 'requested_by_buyer' and v_link.supplier_org_id = v_org)) then
    raise exception using errcode = 'P0002', message = 'Aucune demande en attente de votre réponse.';
  end if;
  perform set_config('appro.link_write', 'on', true);
  if p_accept then
    update public.clients set link_status = 'active', active = true where id = p_client_id;
    select * into v_buyer from public.organizations where id = v_link.buyer_org_id;
    if not exists (select 1 from public.client_delivery_points dp where dp.client_id = p_client_id and dp.active) then
      insert into public.client_delivery_points (client_id, label, address_line, city, phone)
      values (p_client_id, 'Principal', coalesce(nullif(btrim(v_buyer.address), ''), 'Adresse à préciser'), 'À préciser', v_buyer.phone);
    end if;
    -- The buyer's people who work with no supplier yet start with this one.
    update public.profiles set client_id = p_client_id
    where org_id = v_link.buyer_org_id and role = 'customer' and client_id is null;
  else
    update public.clients set link_status = 'refused', active = false where id = p_client_id;
  end if;
  perform set_config('appro.link_write', 'off', true);
end;
$function$
;

-- ===== profiles_attach_named_owner
CREATE OR REPLACE FUNCTION public.profiles_attach_named_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid;
begin
  if new.org_id is null and new.client_id is null and new.role <> 'platform' then
    select o.id into v_org from public.organizations o join auth.users u on lower(u.email) = o.owner_email
    where u.id = new.id order by o.created_at limit 1;
    if v_org is not null then
      perform public.attach_org_owner(v_org, new.id);
    end if;
  end if;
  return null;
end;
$function$
;

-- ===== profiles_fill_org
CREATE OR REPLACE FUNCTION public.profiles_fill_org()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.is_superadmin or new.role = 'platform' then
    return new;
  end if;
  if new.role = 'customer' and new.client_id is not null
     and (tg_op = 'INSERT' or new.client_id is distinct from old.client_id or new.org_id is null) then
    new.org_id := coalesce((select c.buyer_org_id from public.clients c where c.id = new.client_id), new.org_id);
  elsif new.org_id is null and new.role in ('staff', 'supervisor', 'production', 'driver', 'admin') then
    new.org_id := public.acting_or_legacy_org_id();
  end if;
  return new;
end;
$function$
;

-- ===== profiles_org_guard
CREATE OR REPLACE FUNCTION public.profiles_org_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_acting uuid;
begin
  if (select auth.uid()) is null or public.org_write_guard_bypassed() or new.id = (select auth.uid()) or public.platform_role() is not null then
    return new;
  end if;
  v_acting := public.current_org_id();
  -- Only its own team: a member of its Pro, or a free account it adds to its own team.
  if v_acting is null then
    raise exception using errcode = '42501', message = 'Ce compte n’appartient pas à votre équipe : il est géré par Appro+.';
  end if;
  if not (coalesce(old.org_id = v_acting, false) or (old.org_id is null and old.client_id is null and old.role <> 'platform')) then
    raise exception using errcode = '42501', message = 'Ce compte n’appartient pas à votre équipe : il est géré par Appro+.';
  end if;
  if not coalesce(new.org_id = v_acting, false) or new.client_id is not null then
    raise exception using errcode = '42501', message = 'Ce compte n’appartient pas à votre équipe : il est géré par Appro+.';
  end if;
  return new;
end;
$function$
;

-- ===== profiles_sync_roles
CREATE OR REPLACE FUNCTION public.profiles_sync_roles()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'UPDATE' and (old.role is distinct from new.role or old.org_id is distinct from new.org_id) then
    delete from public.member_roles mr
    using public.org_roles r join public.role_templates t on t.id = r.template_id
    where mr.role_id = r.id and mr.user_id = new.id and not mr.transitional
      and (r.org_id is distinct from new.org_id or t.key = public.legacy_role_template(old.role::text));
  end if;
  if new.is_superadmin or new.org_id is null then
    return new;
  end if;
  perform public.org_install_roles(new.org_id);
  insert into public.member_roles (user_id, role_id)
  select new.id, r.id from public.org_roles r join public.role_templates t on t.id = r.template_id
  where r.org_id = new.org_id and t.key = public.legacy_role_template(new.role::text)
  on conflict (user_id, role_id) do nothing;
  return new;
end;
$function$
;

-- ===== profiles_track_space
CREATE OR REPLACE FUNCTION public.profiles_track_space()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.org_id is not null and new.role <> 'platform' then
    insert into public.pro_memberships (user_id, org_id, mode, role, client_id)
    values (new.id, new.org_id, case when new.role = 'customer' then 'buyer' else 'supplier' end, new.role, new.client_id)
    on conflict (user_id, org_id, mode) do update set role = excluded.role, client_id = coalesce(excluded.client_id, public.pro_memberships.client_id);
  end if;
  return null;
end;
$function$
;

-- ===== public_catalog
CREATE OR REPLACE FUNCTION public.public_catalog(p_search text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with me as (select pr.org_id from public.profiles pr where pr.id = (select auth.uid())),
  sup as (
    select o.id, o.name, o.address, o.tagline,
      coalesce((select (d.value #>> '{}')::boolean from public.client_setting_defaults d where d.org_id = o.id and d.key = 'show_prices'), true) as show_prices
    from public.organizations o
    where (select auth.uid()) is not null and o.status = 'active' and o.is_supplier and o.catalog_visibility = 'public'
      and o.id is distinct from (select me.org_id from me)
      and not exists (select 1 from public.clients c where c.supplier_org_id = o.id and c.buyer_org_id = (select me.org_id from me)
                      and c.link_status = 'active' and c.active)),
  prod as (
    select p.*, s.show_prices, s.name as supplier_name, cat.name as category
    from sup s join public.products p on p.org_id = s.id and p.active
    left join public.categories cat on cat.id = p.category_id
    where p_search is null or btrim(p_search) = ''
       or lower(p.name || ' ' || coalesce(p.description, '') || ' ' || s.name || ' ' || coalesce(cat.name, '')) like '%' || lower(btrim(p_search)) || '%'
    order by p.name
    limit 600)
  select jsonb_build_object(
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('org_id', s.id, 'name', s.name, 'address', s.address, 'tagline', s.tagline, 'show_prices', s.show_prices) order by s.name)
      from sup s where exists (select 1 from prod p where p.org_id = s.id)), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'org_id', p.org_id, 'supplier_name', p.supplier_name, 'name', p.name,
        'description', p.description, 'image_url', p.image_url, 'unit_label', p.unit_label, 'category', p.category,
        'price', case when p.show_prices then p.price end, 'vat_rate', p.vat_rate) order by p.supplier_name, p.name) from prod p), '[]'::jsonb));
$function$
;

-- ===== public_settings
CREATE OR REPLACE FUNCTION public.public_settings()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'app_url', coalesce(public.platform_setting('app_url') #>> '{}', ''),
    'trial_hours', coalesce((public.platform_setting('new_accounts_trial_hours') #>> '{}')::int, 0));
$function$
;

-- ===== refresh_credit_totals
CREATE OR REPLACE FUNCTION public.refresh_credit_totals(p_credit_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.credit_notes c set
    total_ht = t.ht, total_vat = t.vat, total_ttc = t.ht + t.vat, updated_at = now()
  from (
    select coalesce(sum(round(i.quantity * i.unit_price, 3)), 0) as ht,
           coalesce(sum(round(i.quantity * i.unit_price * i.vat_rate / 100, 3)), 0) as vat
    from public.credit_note_items i where i.credit_note_id = p_credit_id
  ) t
  where c.id = p_credit_id;
$function$
;

-- ===== refresh_invoice_payment
CREATE OR REPLACE FUNCTION public.refresh_invoice_payment(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_paid numeric;
  v_last date;
begin
  select coalesce(sum(p.amount), 0), max(p.paid_on) into v_paid, v_last from public.invoice_payments p where p.invoice_id = p_invoice_id;
  update public.client_invoices i
  set amount_paid = v_paid,
      status = case when i.status in ('issued', 'paid') then case when v_paid >= i.total_ttc - 0.0005 then 'paid' else 'issued' end else i.status end,
      paid_at = case when v_paid >= i.total_ttc - 0.0005 then coalesce(v_last::timestamptz, now()) else null end,
      updated_at = now()
  where i.id = p_invoice_id;
end;
$function$
;

-- ===== refresh_invoice_totals
CREATE OR REPLACE FUNCTION public.refresh_invoice_totals(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ht numeric(12,3);
  v_vat numeric(12,3);
  v_breakdown jsonb;
  v_stamp numeric(12,3) := 1;
begin
  select
    coalesce(sum(r.base), 0),
    coalesce(sum(r.vat), 0),
    coalesce(jsonb_agg(jsonb_build_object('rate', r.rate, 'base', r.base, 'vat', r.vat) order by r.rate), '[]'::jsonb)
  into v_ht, v_vat, v_breakdown
  from (
    select oi.vat_rate as rate, sum(oi.line_total) as base, round(sum(oi.line_total) * oi.vat_rate / 100, 3) as vat
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.client_invoice_id = p_invoice_id
    group by oi.vat_rate
  ) r;

  update public.client_invoices
  set total_ht = v_ht, total_vat = v_vat, vat_breakdown = v_breakdown,
      stamp_duty = v_stamp, total_ttc = v_ht + v_vat + v_stamp, updated_at = now()
  where id = p_invoice_id;
end;
$function$
;

-- ===== register_pro
CREATE OR REPLACE FUNCTION public.register_pro(p_profile jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me public.profiles%rowtype;
  v_org uuid;
  v_kind text := case when p_profile ->> 'kind' = 'person' then 'person' else 'business' end;
  v_supplier boolean := coalesce((p_profile ->> 'is_supplier')::boolean, false) and v_kind = 'business';
  v_buyer boolean := coalesce((p_profile ->> 'is_buyer')::boolean, true) or v_kind = 'person';
  v_acceptance record;
begin
  select * into v_me from public.profiles where id = auth.uid();
  if v_me.id is null then
    raise exception using errcode = '42501', message = 'Connectez-vous d’abord.';
  end if;
  if v_me.role = 'platform' or v_me.org_id is not null or v_me.client_id is not null then
    raise exception using errcode = '22023', message = 'Ce compte appartient déjà à un Pro ou à l’équipe Appro+.';
  end if;
  if char_length(btrim(coalesce(p_profile ->> 'name', ''))) < 2 then
    raise exception using errcode = '22023', message = case when v_kind = 'person' then 'Indiquez votre nom.' else 'Indiquez le nom de votre entreprise.' end;
  end if;
  if not (v_supplier or v_buyer) then
    raise exception using errcode = '22023', message = 'Choisissez au moins une activité : fournisseur ou acheteur.';
  end if;
  insert into public.organizations (name, kind, is_supplier, is_buyer, status, phone, address, tax_id, email, created_by)
  values (left(btrim(p_profile ->> 'name'), 120), v_kind, v_supplier, v_buyer, 'pending',
          left(btrim(coalesce(p_profile ->> 'phone', '')), 60), left(btrim(coalesce(p_profile ->> 'address', '')), 300),
          left(btrim(coalesce(p_profile ->> 'tax_id', '')), 60),
          coalesce((select u.email from auth.users u where u.id = auth.uid()), ''), auth.uid())
  returning id into v_org;
  perform public.org_install_roles(v_org);
  update public.profiles set org_id = v_org, role = (case when v_supplier then 'admin' else 'customer' end)::public.app_role, account_status = 'pending'
  where id = auth.uid();
  insert into public.member_roles (user_id, role_id)
  select auth.uid(), r.id from public.org_roles r join public.role_templates t on t.id = r.template_id
  where r.org_id = v_org and t.key in ('supplier_owner', 'buyer_owner')
  on conflict do nothing;
  perform public.start_trial(v_org);
  for v_acceptance in select a.invitation_id from public.invitation_acceptances a where a.user_id = auth.uid() and a.linked_at is null loop
    perform public.invitation_link(v_acceptance.invitation_id, auth.uid());
  end loop;
  return v_org;
end;
$function$
;

-- ===== register_push_token
CREATE OR REPLACE FUNCTION public.register_push_token(p_token text, p_platform text DEFAULT 'android'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== relation_offers
CREATE OR REPLACE FUNCTION public.relation_offers(p_client_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'client_id', c.id, 'name', r.name, 'kind', r.kind, 'value', r.value, 'buy_qty', r.buy_qty, 'free_qty', r.free_qty,
      'tiers', r.tiers, 'product_scope', r.product_scope, 'category_ids', r.category_ids, 'product_ids', r.product_ids,
      'min_order_amount', r.min_order_amount, 'min_line_qty', r.min_line_qty, 'ends_on', r.ends_on, 'weekdays', r.weekdays,
      'first_order_only', r.first_order_only, 'min_past_orders', r.min_past_orders, 'stackable', r.stackable) order by r.created_at), '[]'::jsonb)
  from public.clients c
  join public.pricing_rules r on r.org_id = c.supplier_org_id and r.active
  where c.id = p_client_id and c.show_prices and public.module_enabled_for(c.supplier_org_id, 'pricing')
    and (r.target = 'all' or (r.target = 'group' and r.price_group_id = c.price_group_id) or (r.target = 'client' and r.client_id = c.id))
    and (r.starts_on is null or r.starts_on <= (now() at time zone 'Africa/Tunis')::date)
    and (r.ends_on is null or r.ends_on >= (now() at time zone 'Africa/Tunis')::date);
$function$
;

-- ===== release_order_stock
CREATE OR REPLACE FUNCTION public.release_order_stock(p_order_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.products p set stock_quantity = p.stock_quantity + oi.quantity, updated_at = now()
  from public.order_items oi join public.orders o on o.id = oi.order_id
  where oi.order_id = p_order_id and oi.product_id = p.id and o.stock_reserved;
$function$
;

-- ===== reopen_order_accepted
CREATE OR REPLACE FUNCTION public.reopen_order_accepted(p_order_id uuid, p_note text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order public.orders%rowtype;
  v_client public.clients%rowtype;
  v_line record;
  v_product public.products%rowtype;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  select c.* into v_client from public.clients c where c.id = v_order.client_id;
  if (v_client.stock_managed and public.module_enabled_for(v_client.supplier_org_id, 'stock')) then
    for v_line in
      select oi.product_id, sum(oi.quantity) as quantity, min(oi.product_name_snapshot) as name
      from public.order_items oi where oi.order_id = p_order_id
      group by oi.product_id order by oi.product_id
    loop
      if v_line.product_id is null then
        raise exception using errcode = 'P0002', message = format('%s n’est plus au catalogue.', v_line.name);
      end if;
      select p.* into v_product from public.products p where p.id = v_line.product_id for update;
      if not found or not v_product.active or v_product.stock_quantity < v_line.quantity then
        raise exception using errcode = '22023', message = format('Stock insuffisant pour %s.', v_line.name);
      end if;
      update public.products set stock_quantity = stock_quantity - v_line.quantity, updated_at = now()
      where id = v_line.product_id;
    end loop;
  end if;

  update public.orders
  set status = 'confirmed', status_note = null, stock_reserved = (v_client.stock_managed and public.module_enabled_for(v_client.supplier_org_id, 'stock')),
      production_rank = (select coalesce(max(q.production_rank), 0) + 1 from public.orders q
                         where q.status in ('confirmed', 'preparing', 'ready') and q.id <> p_order_id),
      updated_at = now()
  where id = p_order_id;
  insert into public.order_status_history (order_id, status, note, changed_by)
  values (p_order_id, 'confirmed',
          concat_ws(' — ', 'Rouverte et acceptée directement (reconfirmation du client désactivée)', nullif(btrim(coalesce(p_note, '')), '')),
          p_actor_id);
  update public.payments set status = 'pending' where order_id = p_order_id and status = 'cancelled';
  if v_order.client_invoice_id is null and v_client.invoice_mode = 'auto' then
    perform public.create_client_invoice(v_client.id, array[p_order_id], p_actor_id, false);
  end if;
  return jsonb_build_object('id', p_order_id, 'previous_status', v_order.status, 'status', 'confirmed');
end;
$function$
;

-- ===== report_incident
CREATE OR REPLACE FUNCTION public.report_incident(p_kind text, p_category text, p_description text, p_order_id uuid DEFAULT NULL::uuid, p_vehicle_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
  v_name text;
begin
  if public.active_uid() is null or not public.has_feature('incidents.report') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de signaler des incidents.';
  end if;
  if p_kind not in ('delivery', 'vehicle') or char_length(btrim(coalesce(p_description, ''))) = 0 then
    raise exception using errcode = '22023', message = 'Décrivez l’incident.';
  end if;
  insert into public.incidents (kind, category, description, order_id, vehicle_id, reported_by)
  values (p_kind, left(coalesce(nullif(btrim(p_category), ''), 'Autre'), 60), btrim(p_description), p_order_id, p_vehicle_id, auth.uid())
  returning id into v_id;
  select coalesce(nullif(btrim(pr.full_name), ''), u.email) into v_name from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = auth.uid();
  perform public.notify(array(select public.team_with_feature('incidents.manage')), 'incident.new',
    format('Incident %s : %s', case when p_kind = 'vehicle' then 'véhicule' else 'livraison' end, p_category),
    format('%s — %s', v_name, left(btrim(p_description), 120)), p_order_id);
  return v_id;
end;
$function$
;

-- ===== request_leave
CREATE OR REPLACE FUNCTION public.request_leave(p_kind text, p_start date, p_end date, p_half_day boolean DEFAULT false, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_auto boolean := not coalesce((select s.leave_approval_required from public.app_settings s where s.id = 1), true);
  v_id uuid;
  v_name text;
begin
  if public.active_uid() is null or not public.has_feature('leave.request') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de demander des congés.';
  end if;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception using errcode = '22023', message = 'Dates de congé invalides.';
  end if;
  if exists (select 1 from public.leave_requests l where l.user_id = auth.uid() and l.status in ('pending', 'approved')
             and daterange(l.start_date, l.end_date, '[]') && daterange(p_start, p_end, '[]')) then
    raise exception using errcode = '22023', message = 'Vous avez déjà une demande sur ces dates.';
  end if;
  insert into public.leave_requests (user_id, kind, start_date, end_date, half_day, note, status, decided_at)
  values (auth.uid(), p_kind, p_start, p_end, coalesce(p_half_day, false), nullif(btrim(coalesce(p_note, '')), ''),
          case when v_auto then 'approved' else 'pending' end, case when v_auto then now() end)
  returning id into v_id;
  if not v_auto then
    select coalesce(nullif(btrim(pr.full_name), ''), u.email) into v_name from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = auth.uid();
    perform public.notify(array(select public.team_with_feature('leave.manage')), 'leave.new',
      format('Demande de congé : %s', v_name), format('Du %s au %s.', to_char(p_start, 'DD/MM/YYYY'), to_char(p_end, 'DD/MM/YYYY')), null);
  end if;
  return jsonb_build_object('id', v_id, 'status', case when v_auto then 'approved' else 'pending' end);
end;
$function$
;

-- ===== request_location
CREATE OR REPLACE FUNCTION public.request_location(p_target_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
  v_id uuid;
begin
  if v_org is null or not public.has_feature('location.view') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de voir les positions.';
  end if;
  if p_target_id = auth.uid() or not exists (select 1 from public.profiles pr where pr.id = p_target_id and pr.org_id = v_org and pr.account_status = 'active') then
    raise exception using errcode = 'P0002', message = 'Compte introuvable dans votre équipe.';
  end if;
  insert into public.location_requests (org_id, requester_id, target_id) values (v_org, auth.uid(), p_target_id) returning id into v_id;
  perform public.notify(array[p_target_id], 'location.request', 'Demande de position',
    format('%s demande à voir votre position : ouvrez l’application pour accepter ou refuser.', public.location_name(auth.uid())));
  return v_id;
end;
$function$
;

-- ===== resolve_incident
CREATE OR REPLACE FUNCTION public.resolve_incident(p_id uuid, p_resolution text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.has_feature('incidents.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de traiter les incidents.';
  end if;
  update public.incidents set status = 'resolved', resolution = nullif(btrim(coalesce(p_resolution, '')), ''), resolved_by = auth.uid(), resolved_at = now()
  where id = p_id and status = 'open';
  if not found then
    raise exception using errcode = 'P0002', message = 'Incident introuvable ou déjà traité.';
  end if;
end;
$function$
;

-- ===== role_grants
CREATE OR REPLACE FUNCTION public.role_grants(p_role_id uuid, p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    (select o.allowed from public.org_role_overrides o where o.role_id = p_role_id and o.permission = p_permission),
    exists (select 1 from public.org_roles r join public.role_template_permissions tp on tp.template_id = r.template_id
            where r.id = p_role_id and tp.permission = p_permission))
    and (exists (select 1 from public.org_roles r join public.role_templates t on t.id = r.template_id
                 where r.id = p_role_id and t.key in ('supplier_owner', 'buyer_owner'))
         or not exists (select 1 from public.org_roles r join public.org_roles o on o.org_id = r.org_id and o.side = r.side
                        join public.role_templates ot on ot.id = o.template_id and ot.key in ('supplier_owner', 'buyer_owner')
                        where r.id = p_role_id)
         or exists (select 1 from public.org_roles r join public.org_roles o on o.org_id = r.org_id and o.side = r.side
                    join public.role_templates ot on ot.id = o.template_id and ot.key in ('supplier_owner', 'buyer_owner')
                    left join public.org_role_overrides oo on oo.role_id = o.id and oo.permission = p_permission
                    where r.id = p_role_id
                      and coalesce(oo.allowed, exists (select 1 from public.role_template_permissions tp where tp.template_id = o.template_id and tp.permission = p_permission))));
$function$
;

-- ===== role_permissions_mirror
CREATE OR REPLACE FUNCTION public.role_permissions_mirror()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.permissions (key, side)
  values (coalesce(new.feature, old.feature), case when coalesce(new.feature, old.feature) like 'client.%' then 'buyer' else 'supplier' end)
  on conflict (key) do nothing;
  perform public.sync_legacy_role(coalesce(new.role, old.role)::text);
  if new.role = 'staff' or old.role = 'staff' then perform public.sync_legacy_role('supervisor'); end if;
  return null;
end;
$function$
;

-- ===== row_org
CREATE OR REPLACE FUNCTION public.row_org(p_table text, p_row jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return case p_table
    when 'orders' then (p_row ->> 'supplier_org_id')::uuid
    when 'clients' then (p_row ->> 'supplier_org_id')::uuid
    when 'products' then (p_row ->> 'org_id')::uuid
    when 'vehicles' then (p_row ->> 'org_id')::uuid
    when 'team_conversations' then (p_row ->> 'org_id')::uuid
    when 'document_numbering' then (p_row ->> 'org_id')::uuid
    when 'client_setting_defaults' then (p_row ->> 'org_id')::uuid
    when 'order_items' then public.order_org((p_row ->> 'order_id')::uuid)
    when 'order_status_history' then public.order_org((p_row ->> 'order_id')::uuid)
    when 'client_delivery_points' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'account_entries' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'client_invoices' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'claims' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'messages' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'returns' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'credit_notes' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'recurring_orders' then public.client_org((p_row ->> 'client_id')::uuid)
    when 'invoice_payments' then public.client_org((select i.client_id from public.client_invoices i where i.id = (p_row ->> 'invoice_id')::uuid))
    when 'credit_note_items' then public.client_org((select cn.client_id from public.credit_notes cn where cn.id = (p_row ->> 'credit_note_id')::uuid))
    when 'return_items' then public.client_org((select r.client_id from public.returns r where r.id = (p_row ->> 'return_id')::uuid))
    when 'shipments' then public.user_org((p_row ->> 'driver_id')::uuid)
    when 'team_messages' then (select c.org_id from public.team_conversations c where c.id = (p_row ->> 'conversation_id')::uuid)
  end;
end;
$function$
;

-- ===== run_recurring_orders
CREATE OR REPLACE FUNCTION public.run_recurring_orders()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
declare
  v_row public.recurring_orders%rowtype;
  v_result jsonb;
  v_count int := 0;
begin
  if auth.uid() is not null and public.active_uid() is null then
    return 0;
  end if;
  for v_row in
    select r.* from (select * from (select * from public.recurring_orders where public.org_visible(public.client_org(client_id))) recurring_orders where public.org_visible(public.client_org(client_id))) r
    where r.active and r.next_delivery - r.lead_days <= current_date
    for update skip locked
  loop
    begin
      if v_row.next_delivery >= current_date then
        v_result := public.create_client_order(v_row.client_id, v_row.customer_id, null, v_row.items, v_row.delivery_point_id,
          v_row.next_delivery, v_row.note, 'Commande récurrente créée automatiquement.');
        update public.recurring_orders set last_order_id = (v_result ->> 'id')::uuid, last_error = null where id = v_row.id;
        perform public.notify(public.client_users(v_row.client_id), 'order.status',
          format('Commande récurrente #%s créée', v_result ->> 'order_number'),
          format('Livraison prévue le %s.', to_char(v_row.next_delivery, 'DD/MM/YYYY')), (v_result ->> 'id')::uuid);
        v_count := v_count + 1;
      end if;
    exception when others then
      update public.recurring_orders set last_error = left(sqlerrm, 300) where id = v_row.id;
    end;
    update public.recurring_orders
    set next_delivery = public.next_weekday_date(greatest(v_row.next_delivery + 1, current_date + lead_days), weekdays), updated_at = now()
    where id = v_row.id;
  end loop;
  return v_count;
end;
$function$
;

-- ===== save_recurring_order
CREATE OR REPLACE FUNCTION public.save_recurring_order(p_id uuid, p_client_id uuid, p_items jsonb, p_delivery_point_id uuid, p_weekdays integer[], p_lead_days integer DEFAULT 1, p_note text DEFAULT NULL::text, p_active boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_client uuid;
  v_customer uuid;
  v_id uuid := p_id;
  v_days int[];
begin
  if public.active_uid() is null then
    raise exception using errcode = '28000', message = 'Compte actif requis.';
  end if;
  if public.current_client_id() is not null and not public.is_staff() then
    if not public.has_feature('client.recurring') then
      raise exception using errcode = '42501', message = 'Les commandes récurrentes ne sont pas activées pour votre compte.';
    end if;
    v_client := public.current_client_id();
    v_customer := auth.uid();
  else
    if not public.has_feature('orders.create') then
      raise exception using errcode = '42501', message = 'Votre profil ne permet pas de programmer des commandes.';
    end if;
    v_client := p_client_id;
    select pr.id into v_customer from public.profiles pr where pr.client_id = v_client and pr.account_status = 'active' order by pr.created_at limit 1;
  end if;
  if not exists (select 1 from public.clients c where c.id = v_client and c.active) then
    raise exception using errcode = 'P0002', message = 'Fiche client introuvable ou inactive.';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'La commande récurrente est vide.';
  end if;
  v_days := array(select distinct d from unnest(coalesce(p_weekdays, '{}'::int[])) d where d between 1 and 7 order by d);
  if cardinality(v_days) = 0 then
    raise exception using errcode = '22023', message = 'Choisissez au moins un jour de livraison.';
  end if;
  if v_id is not null and not exists (select 1 from public.recurring_orders r where r.id = v_id and r.client_id = v_client) then
    raise exception using errcode = 'P0002', message = 'Commande récurrente introuvable.';
  end if;
  if v_id is null then
    insert into public.recurring_orders (client_id, customer_id, created_by, items, delivery_point_id, weekdays, lead_days, next_delivery, note, active)
    values (v_client, coalesce(v_customer, auth.uid()), auth.uid(), p_items, p_delivery_point_id, v_days, coalesce(p_lead_days, 1),
            public.next_weekday_date(current_date + coalesce(p_lead_days, 1), v_days), nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_active, true))
    returning id into v_id;
  else
    update public.recurring_orders
    set items = p_items, delivery_point_id = p_delivery_point_id, weekdays = v_days, lead_days = coalesce(p_lead_days, 1),
        next_delivery = public.next_weekday_date(current_date + coalesce(p_lead_days, 1), v_days),
        note = nullif(btrim(coalesce(p_note, '')), ''), active = coalesce(p_active, true), last_error = null, updated_at = now()
    where id = v_id;
  end if;
  return v_id;
end;
$function$
;

-- ===== scope_function
CREATE OR REPLACE FUNCTION public.scope_function(p_name text, p_tables text[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $functionx$
declare
  r record;
  v_def text;
  t text;
  v_cond text;
  v_kw text := '(?:where|on|join|left|right|inner|full|cross|group|order|limit|using|set|returning|union|for|natural|lateral|as|and|or|having|window|offset|except|intersect)';
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = p_name loop
    v_def := pg_get_functiondef(r.oid);
    continue when v_def like '%/* org-scoped */%';
    foreach t in array p_tables loop
      v_cond := public.org_condition(t);
      -- "from public.t x" / "join public.t x"
      v_def := regexp_replace(v_def,
        '(?<!delete\s)\m(from|join)(\s+)public\.' || t || '(\s+)(?!' || v_kw || '\M)([a-z_][a-z0-9_]*)\M',
        '\1\2(select * from public.' || t || ' where ' || v_cond || ')\3\4', 'gi');
      -- "from public.t where…" (no alias): the table's own name becomes the alias
      v_def := regexp_replace(v_def,
        '(?<!delete\s)\m(from|join)(\s+)public\.' || t || '\M(?=\s*(?:where|on|join|left|group|order|limit|\)|;|,)|\s*$)',
        '\1\2(select * from public.' || t || ' where ' || v_cond || ') ' || t, 'gi');
    end loop;
    v_def := regexp_replace(v_def, 'AS \$function\$', 'AS $function$ /* org-scoped */');
    execute v_def;
  end loop;
end;
$functionx$
;

-- ===== seller_card
CREATE OR REPLACE FUNCTION public.seller_card(p_org_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('name', o.name, 'tagline', o.tagline, 'address', o.address, 'phone', o.phone, 'email', o.email,
    'tax_id', o.tax_id, 'rib', o.rib, 'brand_color', o.brand_color)
  from public.organizations o where o.id = p_org_id;
$function$
;

-- ===== send_email
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
      'text', p_text || E'\n\n— Appro+\nVous recevez cet e-mail car les alertes par e-mail sont activées sur votre compte (Compte → Notifications).'
    ),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key)
  );
end;
$function$
;

-- ===== send_message
CREATE OR REPLACE FUNCTION public.send_message(p_client_id uuid, p_body text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.send_message_v2(p_client_id, p_body, null, false);
$function$
;

-- ===== send_message_v2
CREATE OR REPLACE FUNCTION public.send_message_v2(p_client_id uuid, p_body text, p_attachment jsonb DEFAULT NULL::jsonb, p_needs_reply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.send_message_v3(p_client_id, p_body, p_attachment, p_needs_reply, null::uuid);
$function$
;

-- ===== send_message_v3
CREATE OR REPLACE FUNCTION public.send_message_v3(p_client_id uuid, p_body text, p_attachment jsonb DEFAULT NULL::jsonb, p_needs_reply boolean DEFAULT false, p_reply_to uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_is_staff boolean := public.is_staff();
  v_client_id uuid;
  v_message public.messages%rowtype;
  v_attachment jsonb;
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
  if p_reply_to is not null and not exists (select 1 from public.messages r where r.id = p_reply_to and r.client_id = v_client_id) then
    raise exception using errcode = '22023', message = 'Le message auquel vous répondez n’est pas dans cette conversation.';
  end if;
  v_attachment := public.clean_attachment(p_attachment, 'client/' || v_client_id::text);
  if char_length(coalesce(p_body, '')) > 2000 or (char_length(btrim(coalesce(p_body, ''))) = 0 and v_attachment is null) then
    raise exception using errcode = '22023', message = 'Écrivez un message (2000 caractères au plus) ou joignez un fichier.';
  end if;

  insert into public.messages (client_id, sender_id, from_staff, body, attachment, needs_reply, reply_to)
  values (v_client_id, auth.uid(), v_is_staff, btrim(coalesce(p_body, '')), v_attachment, coalesce(p_needs_reply, false), p_reply_to)
  returning * into v_message;

  return jsonb_build_object(
    'id', v_message.id, 'client_id', v_message.client_id, 'sender_id', v_message.sender_id, 'from_staff', v_message.from_staff, 'body', v_message.body,
    'attachment', v_message.attachment, 'needs_reply', v_message.needs_reply, 'reply_to', v_message.reply_to,
    'created_at', v_message.created_at, 'read_at', v_message.read_at
  );
end;
$function$
;

-- ===== set_auto_deliver_hours
CREATE OR REPLACE FUNCTION public.set_auto_deliver_hours(p_hours integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_admin() or public.current_org_id() is null then
    raise exception using errcode = '42501', message = 'Accès réservé aux administrateurs.';
  end if;
  if p_hours is null or p_hours not between 1 and 720 then
    raise exception using errcode = '22023', message = 'Délai invalide (1 à 720 heures).';
  end if;
  update public.organizations set auto_deliver_hours = p_hours, updated_at = now() where id = public.current_org_id();
end;
$function$
;

-- ===== set_company_profile
CREATE OR REPLACE FUNCTION public.set_company_profile(p_profile jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
begin
  if not public.is_admin() or v_org is null then
    raise exception using errcode = '42501', message = 'Seul le Responsable du Pro peut modifier les informations de l’entreprise.';
  end if;
  if p_profile ? 'brand_color' and coalesce(p_profile ->> 'brand_color', '') !~ '^(#[0-9a-fA-F]{6})?$' then
    raise exception using errcode = '22023', message = 'Couleur invalide : utilisez le format #RRVVBB.';
  end if;
  update public.organizations set
    name = coalesce(nullif(left(btrim(coalesce(p_profile ->> 'name', '')), 120), ''), name),
    tagline = left(btrim(coalesce(p_profile ->> 'tagline', tagline)), 160),
    address = left(btrim(coalesce(p_profile ->> 'address', address)), 300),
    phone = left(btrim(coalesce(p_profile ->> 'phone', phone)), 60),
    email = left(btrim(coalesce(p_profile ->> 'email', email)), 160),
    tax_id = left(btrim(coalesce(p_profile ->> 'tax_id', tax_id)), 60),
    rib = left(btrim(coalesce(p_profile ->> 'rib', rib)), 80),
    brand_color = coalesce(p_profile ->> 'brand_color', brand_color),
    updated_at = now()
  where id = v_org;
end;
$function$
;

-- ===== set_invoice_due_date
CREATE OR REPLACE FUNCTION public.set_invoice_due_date()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.status = 'issued' and new.due_date is null then
    new.due_date := (coalesce(new.issued_at, now()) at time zone 'Africa/Tunis')::date
      + coalesce((select c.payment_terms_days from public.clients c where c.id = new.client_id), 30);
  end if;
  return new;
end;
$function$
;

-- ===== set_location_consent
CREATE OR REPLACE FUNCTION public.set_location_consent(p_consent boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if public.active_uid() is null then
    raise exception using errcode = '28000', message = 'Compte actif requis.';
  end if;
  update public.profiles set location_consent = coalesce(p_consent, false) where id = auth.uid();
  -- Withdrawing consent erases the last known position.
  if not coalesce(p_consent, false) then
    delete from public.user_locations where user_id = auth.uid();
  end if;
end;
$function$
;

-- ===== set_location_tracking
CREATE OR REPLACE FUNCTION public.set_location_tracking(p_user_id uuid, p_allowed boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not (public.is_admin() or public.is_org_owner(v_org)) then
    raise exception using errcode = '42501', message = 'Seul l’administrateur règle le repérage.';
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set location_tracking = coalesce(p_allowed, false) where id = p_user_id and org_id = v_org;
  perform set_config('appro.link_write', 'off', true);
  if not found then
    raise exception using errcode = 'P0002', message = 'Compte introuvable.';
  end if;
  perform public.notify(array[p_user_id], 'location.tracking', case when p_allowed then 'Repérage autorisé' else 'Repérage retiré' end,
    case when p_allowed then 'Votre administrateur peut voir votre dernière position si vous ne répondez pas à une demande dans la minute. Vous êtes prévenu à chaque consultation.'
         else 'Votre position ne sera plus montrée sans votre accord.' end);
end;
$function$
;

-- ===== set_my_home_layout
CREATE OR REPLACE FUNCTION public.set_my_home_layout(p_layout jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if public.active_uid() is null then
    raise exception using errcode = '28000', message = 'Compte actif requis.';
  end if;
  if not public.valid_home_layout(p_layout) then
    raise exception using errcode = '22023', message = 'Disposition de l’accueil invalide.';
  end if;
  update public.profiles set home_layout = p_layout where id = auth.uid();
end;
$function$
;

-- ===== set_my_notification_prefs
CREATE OR REPLACE FUNCTION public.set_my_notification_prefs(p_push boolean, p_email boolean)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.profiles set notify_push = p_push, notify_email = p_email where id = (select auth.uid());
$function$
;

-- ===== set_my_reminder_opt_out
CREATE OR REPLACE FUNCTION public.set_my_reminder_opt_out(p_opt_out boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_client uuid := public.current_client_id();
begin
  if v_client is null then
    raise exception using errcode = '42501', message = 'Réservé aux comptes clients.';
  end if;
  if coalesce(p_opt_out, false) and not exists (select 1 from public.clients c where c.id = v_client and c.reminder_opt_out_allowed) then
    raise exception using errcode = '42501', message = 'Votre fournisseur a rendu les rappels de paiement obligatoires pour votre compte.';
  end if;
  update public.clients set reminder_opt_out = coalesce(p_opt_out, false), updated_at = now() where id = v_client;
end;
$function$
;

-- ===== set_notification_important
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
    raise exception using errcode = 'P0002', message = 'Alerte introuvable.';
  end if;
end;
$function$
;

-- ===== set_notification_note
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
    raise exception using errcode = 'P0002', message = 'Alerte introuvable.';
  end if;
end;
$function$
;

-- ===== set_open_to_new
CREATE OR REPLACE FUNCTION public.set_open_to_new(p_open boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not (public.is_admin() or public.is_org_owner(public.current_org_id())) then
    raise exception using errcode = '42501', message = 'Seul le Responsable du Pro peut changer ce réglage.';
  end if;
  update public.organizations set open_to_new = coalesce(p_open, true), updated_at = now() where id = public.current_org_id();
end;
$function$
;

-- ===== set_pro_visibility
CREATE OR REPLACE FUNCTION public.set_pro_visibility(p_catalog text DEFAULT NULL::text, p_listed boolean DEFAULT NULL::boolean, p_messages boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not (public.is_admin() or public.is_org_owner(v_org)) then
    raise exception using errcode = '42501', message = 'Seul le Responsable du Pro peut changer ce réglage.';
  end if;
  if p_catalog is not null and p_catalog not in ('network', 'public') then
    raise exception using errcode = '22023', message = 'Visibilité inconnue.';
  end if;
  if p_catalog = 'public' and not exists (select 1 from public.organizations o where o.id = v_org and o.is_supplier) then
    raise exception using errcode = '22023', message = 'Seul un fournisseur a un catalogue.';
  end if;
  update public.organizations set catalog_visibility = coalesce(p_catalog, catalog_visibility),
    listed_in_directory = coalesce(p_listed, listed_in_directory), open_to_messages = coalesce(p_messages, open_to_messages), updated_at = now()
  where id = v_org;
  return public.my_pro();
end;
$function$
;

-- ===== staff_accounts
CREATE OR REPLACE FUNCTION public.staff_accounts()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de gérer les comptes clients.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('client_id', c.id, 'business_name', c.business_name) || public.account_figures(c.id) order by c.business_name)
    from public.clients c where c.supplier_org_id = public.current_org_id() and c.link_status = 'active'), '[]'::jsonb);
end;
$function$
;

-- ===== staff_add_payment
CREATE OR REPLACE FUNCTION public.staff_add_payment(p_invoice_id uuid, p_amount numeric, p_method text, p_paid_on date DEFAULT NULL::date, p_reference text DEFAULT NULL::text, p_credit_note_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_invoice public.client_invoices%rowtype;
  v_credit public.credit_notes%rowtype;
  v_balance numeric;
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas d’enregistrer des règlements.';
  end if;
  select i.* into v_invoice from public.client_invoices i where i.id = p_invoice_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Facture introuvable.';
  end if;
  if v_invoice.status not in ('issued', 'paid') then
    raise exception using errcode = '22023', message = 'Seule une facture émise peut recevoir un règlement.';
  end if;
  v_balance := v_invoice.total_ttc - v_invoice.amount_paid;
  if p_amount is null or p_amount <= 0 or p_amount > v_balance + 0.0005 then
    raise exception using errcode = '22023', message = format('Montant invalide : il reste %s TND à régler.', to_char(v_balance, 'FM999G999G990D000'));
  end if;
  if p_method not in ('cash', 'check', 'transfer', 'card', 'credit_note', 'other') then
    raise exception using errcode = '22023', message = 'Mode de règlement inconnu.';
  end if;
  if p_method = 'credit_note' then
    select c.* into v_credit from public.credit_notes c where c.id = p_credit_note_id for update;
    if not found or v_credit.client_id <> v_invoice.client_id or v_credit.status <> 'issued' then
      raise exception using errcode = '22023', message = 'Choisissez un avoir émis de ce client, pas encore utilisé.';
    end if;
    if p_amount > v_credit.total_ttc + 0.0005 then
      raise exception using errcode = '22023', message = 'Le montant dépasse celui de l’avoir.';
    end if;
    update public.credit_notes set status = 'deducted', settled_at = now(), invoice_id = coalesce(invoice_id, p_invoice_id), updated_at = now()
    where id = p_credit_note_id;
  end if;
  insert into public.invoice_payments (invoice_id, amount, method, paid_on, reference, credit_note_id, created_by)
  values (p_invoice_id, round(p_amount, 3), p_method, coalesce(p_paid_on, current_date), nullif(btrim(coalesce(p_reference, '')), ''),
          case when p_method = 'credit_note' then p_credit_note_id end, auth.uid());
  perform public.refresh_invoice_payment(p_invoice_id);
  return (select jsonb_build_object('status', i.status, 'amount_paid', i.amount_paid, 'balance', i.total_ttc - i.amount_paid)
          from public.client_invoices i where i.id = p_invoice_id);
end;
$function$
;

-- ===== staff_apply_deposit
CREATE OR REPLACE FUNCTION public.staff_apply_deposit(p_invoice_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== staff_client_figures
CREATE OR REPLACE FUNCTION public.staff_client_figures(p_client_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not (public.has_feature('orders.create') or public.has_feature('invoices.manage'))
     or not exists (select 1 from public.clients c where c.id = p_client_id and c.supplier_org_id = public.current_org_id()) then
    raise exception using errcode = '42501', message = 'Client introuvable.';
  end if;
  return public.account_figures(p_client_id);
end;
$function$
;

-- ===== staff_create_credit_note
CREATE OR REPLACE FUNCTION public.staff_create_credit_note(p_client_id uuid, p_invoice_id uuid, p_reason text, p_lines jsonb, p_issue boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== staff_create_invoice
CREATE OR REPLACE FUNCTION public.staff_create_invoice(p_client_id uuid, p_order_ids uuid[], p_draft boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_invoice_id uuid;
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Accès réservé à l’équipe du fournisseur.';
  end if;
  v_invoice_id := public.create_client_invoice(p_client_id, p_order_ids, auth.uid(), coalesce(p_draft, false));
  return (select jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number, 'status', i.status, 'total_ttc', i.total_ttc)
          from public.client_invoices i where i.id = v_invoice_id);
end;
$function$
;

-- ===== staff_create_return
CREATE OR REPLACE FUNCTION public.staff_create_return(p_order_id uuid, p_items jsonb, p_reason text, p_description text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  if not public.has_feature('returns.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de gérer les retours.';
  end if;
  v_id := public.create_return(p_order_id, p_items, p_reason, p_description, auth.uid(), 'approved');
  return (select jsonb_build_object('id', r.id, 'return_number', r.return_number) from public.returns r where r.id = v_id);
end;
$function$
;

-- ===== staff_credit_return
CREATE OR REPLACE FUNCTION public.staff_credit_return(p_return_id uuid, p_issue boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== staff_delete_invoice_draft
CREATE OR REPLACE FUNCTION public.staff_delete_invoice_draft(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status text;
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Accès réservé à l’équipe du fournisseur.';
  end if;
  select i.status into v_status from public.client_invoices i where i.id = p_invoice_id for update;
  if not found or v_status <> 'draft' then
    raise exception using errcode = '22023', message = 'Seul un brouillon peut être supprimé ; une facture validée s’annule.';
  end if;
  update public.orders set client_invoice_id = null where client_invoice_id = p_invoice_id;
  delete from public.client_invoices where id = p_invoice_id;
end;
$function$
;

-- ===== staff_delete_payment
CREATE OR REPLACE FUNCTION public.staff_delete_payment(p_payment_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_payment public.invoice_payments%rowtype;
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de modifier les règlements.';
  end if;
  select p.* into v_payment from public.invoice_payments p where p.id = p_payment_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Règlement introuvable.';
  end if;
  if exists (select 1 from public.client_invoices i where i.id = v_payment.invoice_id and i.status = 'cancelled') then
    raise exception using errcode = '22023', message = 'La facture est annulée.';
  end if;
  delete from public.invoice_payments where id = p_payment_id;
  if v_payment.credit_note_id is not null then
    update public.credit_notes set status = 'issued', settled_at = null, updated_at = now() where id = v_payment.credit_note_id and status = 'deducted';
  end if;
  perform public.refresh_invoice_payment(v_payment.invoice_id);
end;
$function$
;

-- ===== staff_flag_message
CREATE OR REPLACE FUNCTION public.staff_flag_message(p_message_id uuid, p_needs_reply boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_message public.messages%rowtype;
begin
  select * into v_message from public.messages m
  where m.id = p_message_id
    and (public.has_feature('messages.manage') or (m.client_id = public.current_client_id() and public.has_feature('client.messages')));
  if not found then
    raise exception using errcode = 'P0002', message = 'Message introuvable.';
  end if;
  if v_message.sender_id is distinct from auth.uid() and not (public.can_moderate_messages() and public.has_feature('messages.manage')) then
    raise exception using errcode = '42501', message = 'Seuls l’auteur du message, un administrateur ou un superviseur peuvent le marquer.';
  end if;
  update public.messages set needs_reply = coalesce(p_needs_reply, false) where id = p_message_id;
end;
$function$
;

-- ===== staff_inbox
CREATE OR REPLACE FUNCTION public.staff_inbox()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
begin
  if not public.has_feature('messages.manage') then
    raise exception using errcode = '42501', message = 'Accès réservé à l’équipe du fournisseur.';
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
        'unread', (select count(*) from (select * from (select * from public.messages where public.org_visible(public.client_org(client_id))) messages where public.org_visible(public.client_org(client_id))) m
                   where m.client_id = c.id and not m.from_staff and m.read_at is null)
      ) as entry
      from (select * from (select * from public.clients where public.org_visible(supplier_org_id)) clients where public.org_visible(supplier_org_id)) c
      left join lateral (
        select m.body, m.created_at, m.from_staff from (select * from (select * from public.messages where public.org_visible(public.client_org(client_id))) messages where public.org_visible(public.client_org(client_id))) m
        where m.client_id = c.id order by m.created_at desc limit 1
      ) last_message on true
      where c.active or last_message.created_at is not null
    ) entries
  ), '[]'::jsonb);
end;
$function$
;

-- ===== staff_issue_invoice
CREATE OR REPLACE FUNCTION public.staff_issue_invoice(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status text;
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Accès réservé à l’équipe du fournisseur.';
  end if;
  select i.status into v_status from public.client_invoices i where i.id = p_invoice_id for update;
  if not found or v_status <> 'draft' then
    raise exception using errcode = '22023', message = 'Cette facture est déjà validée.';
  end if;
  perform public.issue_invoice(p_invoice_id);
  return (select jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number)
          from public.client_invoices i where i.id = p_invoice_id);
end;
$function$
;

-- ===== staff_place_order
CREATE OR REPLACE FUNCTION public.staff_place_order(p_client_id uuid, p_items jsonb, p_delivery_point_id uuid DEFAULT NULL::uuid, p_requested_date date DEFAULT NULL::date, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_id uuid := public.active_uid();
  v_customer_id uuid;
  v_result jsonb;
  v_actor_name text;
begin
  if v_actor_id is null or not public.has_feature('orders.create') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de commander pour un client.';
  end if;
  select pr.id into v_customer_id from public.profiles pr
  where pr.client_id = p_client_id and pr.account_status = 'active'
  order by pr.created_at limit 1;
  select coalesce(nullif(pr.full_name, ''), u.email) into v_actor_name
  from public.profiles pr join auth.users u on u.id = pr.id where pr.id = v_actor_id;

  v_result := public.create_client_order(p_client_id, coalesce(v_customer_id, v_actor_id), v_actor_id,
    p_items, p_delivery_point_id, p_requested_date, p_note,
    format('Commande saisie par le fournisseur (%s) pour le client.', coalesce(v_actor_name, 'équipe')));

  if v_customer_id is not null then
    perform public.notify(array[v_customer_id], 'order.status',
      format('Commande #%s saisie par votre fournisseur', v_result ->> 'order_number'),
      'Votre fournisseur a enregistré cette commande pour vous ; suivez-la dans Commandes.', (v_result ->> 'id')::uuid);
  end if;
  return v_result;
end;
$function$
;

-- ===== staff_plan_vehicle
CREATE OR REPLACE FUNCTION public.staff_plan_vehicle(p_order_id uuid, p_vehicle_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== staff_price_order
CREATE OR REPLACE FUNCTION public.staff_price_order(p_client_id uuid, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.has_feature('orders.create') or not exists (select 1 from public.clients c where c.id = p_client_id and c.supplier_org_id = public.current_org_id()) then
    raise exception using errcode = '42501', message = 'Client introuvable.';
  end if;
  return public.price_lines(p_client_id, p_items);
end;
$function$
;

-- ===== staff_record_deposit
CREATE OR REPLACE FUNCTION public.staff_record_deposit(p_client_id uuid, p_kind text, p_amount numeric, p_method text, p_entry_date date DEFAULT NULL::date, p_reference text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== staff_revert_order
CREATE OR REPLACE FUNCTION public.staff_revert_order(p_order_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== staff_schedule_order
CREATE OR REPLACE FUNCTION public.staff_schedule_order(p_order_id uuid, p_before_order_id uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== staff_send_messages
CREATE OR REPLACE FUNCTION public.staff_send_messages(p_client_ids uuid[], p_body text, p_needs_reply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
  v_results jsonb := '[]'::jsonb;
begin
  if not public.is_staff() or not public.has_feature('messages.manage') then
    raise exception using errcode = '42501', message = 'La messagerie n’est pas activée pour votre profil.';
  end if;
  if coalesce(array_length(p_client_ids, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'Choisissez au moins un destinataire.';
  end if;
  foreach v_id in array p_client_ids loop
    if not exists (select 1 from public.clients c where c.id = v_id and c.supplier_org_id = public.current_org_id() and c.link_status = 'active') then
      raise exception using errcode = '42501', message = 'Un des destinataires n’est pas votre client.';
    end if;
    v_results := v_results || jsonb_build_array(public.send_message_v3(v_id, p_body, null, p_needs_reply, null));
  end loop;
  return v_results;
end;
$function$
;

-- ===== staff_send_payment_reminders
CREATE OR REPLACE FUNCTION public.staff_send_payment_reminders(p_client_id uuid DEFAULT NULL::uuid, p_force boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
declare
  v_invoice record;
  v_count int := 0;
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas d’envoyer des relances.';
  end if;
  for v_invoice in
    select i.id, i.invoice_number, i.client_id, i.total_ttc - i.amount_paid as balance, i.due_date
    from (select * from (select * from public.client_invoices where public.org_visible(public.client_org(client_id))) client_invoices where public.org_visible(public.client_org(client_id))) i join (select * from (select * from public.clients where public.org_visible(supplier_org_id)) clients where public.org_visible(supplier_org_id)) c on c.id = i.client_id
    where i.status = 'issued' and i.total_ttc - i.amount_paid > 0.0005
      and i.due_date < (now() at time zone 'Africa/Tunis')::date
      and (c.payment_reminders and public.module_enabled_for(c.supplier_org_id, 'reminders')) and not (c.reminder_opt_out_allowed and c.reminder_opt_out)
      and (p_client_id is null or i.client_id = p_client_id)
      and (p_force or i.last_reminder_at is null or i.last_reminder_at < now() - make_interval(days => c.reminder_interval_days))
    for update of i
  loop
    perform public.notify(public.client_users(v_invoice.client_id), 'invoice.reminder',
      format('Rappel : facture %s à régler', v_invoice.invoice_number),
      format('Reste à payer : %s TND (échéance le %s). Merci de procéder au règlement.',
        to_char(v_invoice.balance, 'FM999G999G990D000'), to_char(v_invoice.due_date, 'DD/MM/YYYY')), null);
    update public.client_invoices set last_reminder_at = now(), reminder_count = reminder_count + 1 where id = v_invoice.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$
;

-- ===== staff_set_credit_limit
CREATE OR REPLACE FUNCTION public.staff_set_credit_limit(p_client_id uuid, p_limit numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== staff_set_invoice_status
CREATE OR REPLACE FUNCTION public.staff_set_invoice_status(p_invoice_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_current text;
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Accès réservé à l’équipe du fournisseur.';
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
$function$
;

-- ===== staff_set_order_flags
CREATE OR REPLACE FUNCTION public.staff_set_order_flags(p_order_id uuid, p_special boolean DEFAULT NULL::boolean, p_reschedule boolean DEFAULT NULL::boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_special is not null and not (public.has_feature('orders.decide') or public.has_feature('orders.plan')) then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de marquer le suivi spécial.';
  end if;
  if p_reschedule is not null and not public.has_feature('orders.plan') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de planifier.';
  end if;
  update public.orders
  set special_follow = coalesce(p_special, special_follow), needs_reschedule = coalesce(p_reschedule, needs_reschedule), updated_at = now()
  where id = p_order_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Commande introuvable.';
  end if;
end;
$function$
;

-- ===== staff_update_claim
CREATE OR REPLACE FUNCTION public.staff_update_claim(p_claim_id uuid, p_status text, p_response text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_current text;
  v_response text := nullif(btrim(coalesce(p_response, '')), '');
begin
  if not public.has_feature('claims.manage') then
    raise exception using errcode = '42501', message = 'Accès réservé à l’équipe du fournisseur.';
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
$function$
;

-- ===== staff_update_credit_note
CREATE OR REPLACE FUNCTION public.staff_update_credit_note(p_credit_id uuid, p_action text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== staff_update_invoice_draft
CREATE OR REPLACE FUNCTION public.staff_update_invoice_draft(p_invoice_id uuid, p_order_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_invoice public.client_invoices%rowtype;
begin
  if not public.has_feature('invoices.manage') then
    raise exception using errcode = '42501', message = 'Accès réservé à l’équipe du fournisseur.';
  end if;
  select i.* into v_invoice from public.client_invoices i where i.id = p_invoice_id for update;
  if not found or v_invoice.status <> 'draft' then
    raise exception using errcode = '22023', message = 'Seul un brouillon peut être modifié.';
  end if;
  perform public.attach_invoice_orders(p_invoice_id, v_invoice.client_id, p_order_ids);
end;
$function$
;

-- ===== staff_update_order_status
CREATE OR REPLACE FUNCTION public.staff_update_order_status(p_order_id uuid, p_status order_status, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- Clients whose reconfirmation is switched off get the reopened order accepted at once.
  if p_status = 'awaiting_client' and v_order.status = 'declined'
     and exists (select 1 from public.clients c where c.id = v_order.client_id and not (c.reconfirm_declined and public.module_enabled_for(c.supplier_org_id, 'reconfirm'))) then
    return public.reopen_order_accepted(p_order_id, v_note, v_actor_id);
  end if;

  -- With a fleet, shipping goes through driver_ship_orders so the vehicle is recorded.
  if p_status = 'out_for_delivery' and exists (select 1 from public.vehicles v where v.active) then
    raise exception using errcode = '22023', message = 'Choisissez le véhicule : expédiez depuis Livraisons → À récupérer.';
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
$function$
;

-- ===== staff_update_return
CREATE OR REPLACE FUNCTION public.staff_update_return(p_return_id uuid, p_action text, p_note text DEFAULT NULL::text, p_restock boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- ===== stamp_status_actor
CREATE OR REPLACE FUNCTION public.stamp_status_actor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.changed_by is not null and new.changed_by_name is null then
    select coalesce(nullif(btrim(pr.full_name), ''), u.email) into new.changed_by_name
    from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = new.changed_by;
  end if;
  return new;
end;
$function$
;

-- ===== start_trial
CREATE OR REPLACE FUNCTION public.start_trial(p_org_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hours int := coalesce((public.platform_setting('new_accounts_trial_hours') #>> '{}')::int, 0);
begin
  if v_hours <= 0 or not exists (select 1 from public.organizations o where o.id = p_org_id and o.status = 'pending') then
    return false;
  end if;
  update public.organizations set status = 'active', trial_until = now() + make_interval(hours => v_hours), updated_at = now() where id = p_org_id;
  perform public.org_install_roles(p_org_id);
  if exists (select 1 from public.organizations o where o.id = p_org_id and o.is_supplier) then
    perform public.org_install_numbering(p_org_id);
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set account_status = 'active' where org_id = p_org_id and account_status = 'pending' and role <> 'platform';
  perform set_config('appro.link_write', 'off', true);
  perform public.notify(array(select pm.user_id from public.platform_members pm where pm.active and pm.role in ('superadmin', 'verification', 'account_manager')),
    'pro.trial', 'Nouveau Pro en essai',
    format('%s est actif pour %s h : validez-le (Appro+ → Pros) pour qu’il le reste.', (select o.name from public.organizations o where o.id = p_org_id), v_hours));
  return true;
end;
$function$
;

-- ===== switch_space
CREATE OR REPLACE FUNCTION public.switch_space(p_org_id uuid, p_mode text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_space public.pro_memberships%rowtype;
begin
  select * into v_space from public.pro_memberships where user_id = auth.uid() and org_id = p_org_id and mode = p_mode;
  if v_space.user_id is null then
    raise exception using errcode = '42501', message = 'Cet espace n’est pas le vôtre.';
  end if;
  if v_space.mode = 'buyer' and v_space.client_id is null then
    v_space.client_id := (select c.id from public.clients c where c.buyer_org_id = p_org_id and c.link_status = 'active' and c.active order by c.created_at limit 1);
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set org_id = v_space.org_id, role = v_space.role, client_id = case when v_space.mode = 'buyer' then v_space.client_id end
  where id = auth.uid();
  perform set_config('appro.link_write', 'off', true);
end;
$function$
;

-- ===== switch_supplier
CREATE OR REPLACE FUNCTION public.switch_supplier(p_client_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (select 1 from public.clients c join public.profiles pr on pr.id = auth.uid()
                 where c.id = p_client_id and c.buyer_org_id = pr.org_id and c.link_status = 'active' and c.active and pr.role = 'customer') then
    raise exception using errcode = '42501', message = 'Ce fournisseur n’est pas lié à votre Pro.';
  end if;
  update public.profiles set client_id = p_client_id where id = auth.uid();
end;
$function$
;

-- ===== sync_legacy_role
CREATE OR REPLACE FUNCTION public.sync_legacy_role(p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_template text := public.legacy_role_template(p_role);
begin
  if v_template is null or p_role in ('admin', 'platform') then
    return;
  end if;
  -- The matching role in the original supplier (team profiles) or in every buyer Pro of its
  -- clients (client profile) stores only what differs from its template.
  delete from public.org_role_overrides o
  using public.org_roles r join public.role_templates t on t.id = r.template_id
  where o.role_id = r.id and t.key = v_template
    and (r.org_id = public.legacy_org_id()
         or r.org_id in (select c.buyer_org_id from public.clients c where c.supplier_org_id = public.legacy_org_id()));
  insert into public.org_role_overrides (role_id, permission, allowed)
  select r.id, p.key, coalesce(rp.allowed, false)
  from public.org_roles r
  join public.role_templates t on t.id = r.template_id and t.key = v_template
  cross join public.permissions p
  left join public.role_permissions rp on rp.role::text = p_role and rp.feature = p.key
  where (r.org_id = public.legacy_org_id()
         or r.org_id in (select c.buyer_org_id from public.clients c where c.supplier_org_id = public.legacy_org_id()))
    and coalesce(rp.allowed, false) <> exists (select 1 from public.role_template_permissions tp where tp.template_id = t.id and tp.permission = p.key);
end;
$function$
;

-- ===== team_add_members
CREATE OR REPLACE FUNCTION public.team_add_members(p_conversation_id uuid, p_member_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_kind text;
begin
  if not public.is_team_conversation_member(p_conversation_id) then
    raise exception using errcode = '42501', message = 'Vous ne participez pas à cette conversation.';
  end if;
  select c.kind into v_kind from public.team_conversations c where c.id = p_conversation_id;
  if v_kind in ('role', 'all') then
    raise exception using errcode = '22023', message = 'Cette conversation est déjà ouverte à tout un profil ou à toute l’équipe.';
  end if;
  insert into public.team_conversation_members (conversation_id, user_id)
  select p_conversation_id, pr.id from public.profiles pr
  where pr.id = any(coalesce(p_member_ids, '{}'::uuid[])) and pr.account_status = 'active' and pr.role <> 'customer'
  on conflict do nothing;
  update public.team_conversations set kind = 'group' where id = p_conversation_id and kind = 'direct'
    and (select count(*) from public.team_conversation_members m where m.conversation_id = p_conversation_id) > 2;
end;
$function$
;

-- ===== team_conversation_title
CREATE OR REPLACE FUNCTION public.team_conversation_title(p_conversation_id uuid, p_viewer uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case c.kind
    when 'all' then 'Toute l’équipe'
    when 'role' then 'Tous les ' || public.team_role_label(c.target_role::text)
    else coalesce(nullif(btrim(c.title), ''), (
      select string_agg(coalesce(nullif(btrim(pr.full_name), ''), u.email), ', ' order by pr.full_name)
      from public.team_conversation_members m
      join public.profiles pr on pr.id = m.user_id
      left join auth.users u on u.id = pr.id
      where m.conversation_id = c.id and m.user_id <> p_viewer
    ), 'Conversation')
  end
  from public.team_conversations c where c.id = p_conversation_id;
$function$
;

-- ===== team_conversations_list
CREATE OR REPLACE FUNCTION public.team_conversations_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
declare
  v_me uuid := auth.uid();
begin
  if not public.has_feature('team.messages') then
    raise exception using errcode = '42501', message = 'La messagerie d’équipe n’est pas activée pour votre profil.';
  end if;
  return coalesce((
    select jsonb_agg(entry order by (entry ->> 'last_at') desc nulls last)
    from (
      select jsonb_build_object(
        'id', c.id,
        'kind', c.kind,
        'title', public.team_conversation_title(c.id, v_me),
        'target_role', c.target_role,
        'member_count', (select count(*) from public.team_member_ids(c.id)),
        'last_at', coalesce(c.last_message_at, c.created_at),
        'last_body', last_message.body,
        'last_sender', last_message.sender_name,
        'last_mine', last_message.sender_id = v_me,
        'unread', (select count(*) from public.team_messages tm
                   where tm.conversation_id = c.id and tm.sender_id is distinct from v_me
                     and tm.created_at > coalesce((select r.last_read_at from public.team_conversation_reads r
                                                   where r.conversation_id = c.id and r.user_id = v_me), '-infinity'::timestamptz))
      ) as entry
      from (select * from (select * from public.team_conversations where public.org_visible(org_id)) team_conversations where public.org_visible(org_id)) c
      left join lateral (
        select tm.body, tm.sender_id, coalesce(nullif(btrim(pr.full_name), ''), u.email) as sender_name
        from public.team_messages tm
        left join public.profiles pr on pr.id = tm.sender_id
        left join auth.users u on u.id = pr.id
        where tm.conversation_id = c.id order by tm.created_at desc limit 1
      ) last_message on true
      where exists (select 1 from public.team_member_ids(c.id) m where m = v_me)
        and (c.last_message_at is not null or c.created_by = v_me)
    ) entries
  ), '[]'::jsonb);
end;
$function$
;

-- ===== team_directory
CREATE OR REPLACE FUNCTION public.team_directory()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
begin
  if not public.has_feature('team.messages') then
    raise exception using errcode = '42501', message = 'La messagerie d’équipe n’est pas activée pour votre profil.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', pr.id,
      'name', coalesce(nullif(btrim(pr.full_name), ''), u.email),
      'role', public.team_role_of(pr.role)
    ) order by public.team_role_of(pr.role), coalesce(nullif(btrim(pr.full_name), ''), u.email))
    from (select * from (select * from public.profiles where (public.org_visible(org_id) or public.org_visible(public.client_org(client_id)))) profiles where (public.org_visible(org_id) or public.org_visible(public.client_org(client_id)))) pr left join auth.users u on u.id = pr.id
    where pr.account_status = 'active' and pr.role <> 'customer' and pr.id <> auth.uid()
  ), '[]'::jsonb);
end;
$function$
;

-- ===== team_flag_message
CREATE OR REPLACE FUNCTION public.team_flag_message(p_message_id uuid, p_needs_reply boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_conversation uuid;
  v_sender uuid;
begin
  select tm.conversation_id, tm.sender_id into v_conversation, v_sender from public.team_messages tm where tm.id = p_message_id;
  if v_conversation is null or not public.is_team_conversation_member(v_conversation) then
    raise exception using errcode = 'P0002', message = 'Message introuvable.';
  end if;
  if v_sender is distinct from public.active_uid() and not public.can_moderate_messages() then
    raise exception using errcode = '42501', message = 'Seuls l’auteur du message, un administrateur ou un superviseur peuvent le marquer.';
  end if;
  update public.team_messages set needs_reply = coalesce(p_needs_reply, false) where id = p_message_id;
end;
$function$
;

-- ===== team_locations
CREATE OR REPLACE FUNCTION public.team_locations()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not public.has_feature('location.view') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de voir les positions.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', pr.id, 'name', coalesce(nullif(btrim(pr.full_name), ''), u.email), 'role', pr.role,
      'consent', pr.location_consent, 'tracking', pr.location_tracking,
      'latitude', null, 'longitude', null, 'accuracy', null,
      'updated_at', l.updated_at, 'last_sign_in_at', u.last_sign_in_at
    ) order by pr.full_name)
    from public.profiles pr
    left join auth.users u on u.id = pr.id
    left join public.user_locations l on l.user_id = pr.id
    where pr.org_id = v_org and pr.account_status = 'active' and pr.role <> 'customer' and pr.id <> auth.uid()
  ), '[]'::jsonb);
end;
$function$
;

-- ===== team_mark_read
CREATE OR REPLACE FUNCTION public.team_mark_read(p_conversation_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_team_conversation_member(p_conversation_id) then
    return;
  end if;
  insert into public.team_conversation_reads (conversation_id, user_id, last_read_at) values (p_conversation_id, auth.uid(), now())
  on conflict (conversation_id, user_id) do update set last_read_at = now();
  update public.notifications set read_at = now()
  where user_id = auth.uid() and conversation_id = p_conversation_id and read_at is null;
end;
$function$
;

-- ===== team_member_ids
CREATE OR REPLACE FUNCTION public.team_member_ids(p_conversation_id uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
  select pr.id
  from (select * from (select * from public.team_conversations where public.org_visible(org_id)) team_conversations where public.org_visible(org_id)) c
  join (select * from (select * from public.profiles where (public.org_visible(org_id) or public.org_visible(public.client_org(client_id)))) profiles where (public.org_visible(org_id) or public.org_visible(public.client_org(client_id)))) pr on pr.account_status = 'active' and pr.role <> 'customer'
  where c.id = p_conversation_id and (
    c.kind = 'all'
    or (c.kind = 'role' and public.team_role_of(pr.role) = c.target_role::text)
    or pr.id = c.created_by
    or exists (select 1 from public.team_conversation_members m where m.conversation_id = c.id and m.user_id = pr.id)
  );
$function$
;

-- ===== team_messages_of
CREATE OR REPLACE FUNCTION public.team_messages_of(p_conversation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_team_conversation_member(p_conversation_id) then
    raise exception using errcode = '42501', message = 'Vous ne participez pas à cette conversation.';
  end if;
  return jsonb_build_object(
    'title', public.team_conversation_title(p_conversation_id, auth.uid()),
    'members', (select coalesce(jsonb_agg(coalesce(nullif(btrim(pr.full_name), ''), u.email) order by pr.full_name), '[]'::jsonb)
                from public.team_member_ids(p_conversation_id) m
                join public.profiles pr on pr.id = m left join auth.users u on u.id = pr.id),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', tm.id, 'conversation_id', tm.conversation_id, 'sender_id', tm.sender_id,
        'sender_name', coalesce(nullif(btrim(pr.full_name), ''), u.email, 'Ancien membre'),
        'body', tm.body, 'attachment', tm.attachment, 'needs_reply', tm.needs_reply, 'reply_to', tm.reply_to, 'created_at', tm.created_at
      ) order by tm.created_at desc)
      from (select * from public.team_messages where conversation_id = p_conversation_id order by created_at desc limit 200) tm
      left join public.profiles pr on pr.id = tm.sender_id
      left join auth.users u on u.id = pr.id
    ), '[]'::jsonb)
  );
end;
$function$
;

-- ===== team_role_label
CREATE OR REPLACE FUNCTION public.team_role_label(p_role text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_role when 'admin' then 'administrateurs' when 'supervisor' then 'superviseurs'
    when 'production' then 'équipe de production' when 'driver' then 'livreurs' else p_role end;
$function$
;

-- ===== team_role_of
CREATE OR REPLACE FUNCTION public.team_role_of(p_role app_role)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case when p_role::text = 'staff' then 'supervisor' else p_role::text end;
$function$
;

-- ===== team_send_message
CREATE OR REPLACE FUNCTION public.team_send_message(p_conversation_id uuid, p_body text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.team_send_message_v2(p_conversation_id, p_body, null, false);
$function$
;

-- ===== team_send_message_v2
CREATE OR REPLACE FUNCTION public.team_send_message_v2(p_conversation_id uuid, p_body text, p_attachment jsonb DEFAULT NULL::jsonb, p_needs_reply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.team_send_message_v3(p_conversation_id, p_body, p_attachment, p_needs_reply, null::uuid);
$function$
;

-- ===== team_send_message_v3
CREATE OR REPLACE FUNCTION public.team_send_message_v3(p_conversation_id uuid, p_body text, p_attachment jsonb DEFAULT NULL::jsonb, p_needs_reply boolean DEFAULT false, p_reply_to uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := public.active_uid();
  v_message public.team_messages%rowtype;
  v_sender text;
  v_attachment jsonb;
  v_preview text;
begin
  if v_me is null or not public.is_team_conversation_member(p_conversation_id) then
    raise exception using errcode = '42501', message = 'Vous ne participez pas à cette conversation.';
  end if;
  if p_reply_to is not null and not exists (select 1 from public.team_messages r where r.id = p_reply_to and r.conversation_id = p_conversation_id) then
    raise exception using errcode = '22023', message = 'Le message auquel vous répondez n’est pas dans cette conversation.';
  end if;
  v_attachment := public.clean_attachment(p_attachment, 'team/' || p_conversation_id::text);
  if char_length(coalesce(p_body, '')) > 2000 or (char_length(btrim(coalesce(p_body, ''))) = 0 and v_attachment is null) then
    raise exception using errcode = '22023', message = 'Écrivez un message (2000 caractères au plus) ou joignez un fichier.';
  end if;
  insert into public.team_messages (conversation_id, sender_id, body, attachment, needs_reply, reply_to)
  values (p_conversation_id, v_me, btrim(coalesce(p_body, '')), v_attachment, coalesce(p_needs_reply, false), p_reply_to)
  returning * into v_message;
  update public.team_conversations set last_message_at = v_message.created_at where id = p_conversation_id;
  insert into public.team_conversation_reads (conversation_id, user_id, last_read_at) values (p_conversation_id, v_me, v_message.created_at)
  on conflict (conversation_id, user_id) do update set last_read_at = excluded.last_read_at;

  select coalesce(nullif(btrim(pr.full_name), ''), u.email) into v_sender
  from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = v_me;
  v_preview := case when v_message.needs_reply then '❗ Réponse attendue · ' else '' end || coalesce(nullif(left(v_message.body, 140), ''), case v_attachment ->> 'kind'
    when 'image' then '📷 Photo' when 'video' then '🎬 Vidéo' when 'audio' then '🎤 Message vocal' else '📎 ' || (v_attachment ->> 'name') end);
  insert into public.notifications (user_id, event, title, body, conversation_id)
  select m, 'team.message',
         case when c.kind = 'direct' then format('Message de %s', v_sender)
              else format('%s · %s', v_sender, public.team_conversation_title(c.id, m)) end,
         v_preview, c.id
  from public.team_member_ids(p_conversation_id) as m
  join public.team_conversations c on c.id = p_conversation_id
  where m <> v_me;

  return jsonb_build_object('id', v_message.id, 'conversation_id', v_message.conversation_id, 'sender_id', v_message.sender_id,
    'sender_name', v_sender, 'body', v_message.body, 'attachment', v_message.attachment, 'needs_reply', v_message.needs_reply,
    'reply_to', v_message.reply_to, 'created_at', v_message.created_at);
end;
$function$
;

-- ===== team_start_conversation
CREATE OR REPLACE FUNCTION public.team_start_conversation(p_kind text, p_member_ids uuid[] DEFAULT NULL::uuid[], p_role app_role DEFAULT NULL::app_role, p_title text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
declare
  v_me uuid := public.active_uid();
  v_others uuid[];
  v_id uuid;
begin
  if v_me is null or not public.has_feature('team.messages') then
    raise exception using errcode = '42501', message = 'La messagerie d’équipe n’est pas activée pour votre profil.';
  end if;
  select coalesce(array_agg(distinct pr.id), '{}'::uuid[]) into v_others
  from (select * from (select * from public.profiles where (public.org_visible(org_id) or public.org_visible(public.client_org(client_id)))) profiles where (public.org_visible(org_id) or public.org_visible(public.client_org(client_id)))) pr
  where pr.id = any(coalesce(p_member_ids, '{}'::uuid[])) and pr.id <> v_me
    and pr.account_status = 'active' and pr.role <> 'customer';

  if p_kind = 'direct' then
    if cardinality(v_others) <> 1 then
      raise exception using errcode = '22023', message = 'Choisissez une personne.';
    end if;
    select c.id into v_id from public.team_conversations c
    where c.kind = 'direct'
      and exists (select 1 from public.team_conversation_members m where m.conversation_id = c.id and m.user_id = v_me)
      and exists (select 1 from public.team_conversation_members m where m.conversation_id = c.id and m.user_id = v_others[1])
    limit 1;
    if v_id is null then
      insert into public.team_conversations (kind, created_by) values ('direct', v_me) returning id into v_id;
      insert into public.team_conversation_members (conversation_id, user_id) values (v_id, v_me), (v_id, v_others[1]);
    end if;
  elsif p_kind = 'group' then
    if cardinality(v_others) < 1 then
      raise exception using errcode = '22023', message = 'Choisissez au moins une personne.';
    end if;
    insert into public.team_conversations (kind, title, created_by)
    values ('group', nullif(btrim(coalesce(p_title, '')), ''), v_me) returning id into v_id;
    insert into public.team_conversation_members (conversation_id, user_id)
    select v_id, u from unnest(array_append(v_others, v_me)) as u;
  elsif p_kind = 'role' then
    if p_role is null or p_role::text in ('customer', 'staff') then
      raise exception using errcode = '22023', message = 'Choisissez un profil de l’équipe.';
    end if;
    select c.id into v_id from public.team_conversations c where c.kind = 'role' and c.target_role = p_role limit 1;
    if v_id is null then
      insert into public.team_conversations (kind, target_role, created_by) values ('role', p_role, v_me) returning id into v_id;
    end if;
    -- Whoever writes to a profile also follows the conversation.
    insert into public.team_conversation_members (conversation_id, user_id) values (v_id, v_me) on conflict do nothing;
  elsif p_kind = 'all' then
    select c.id into v_id from public.team_conversations c where c.kind = 'all' limit 1;
    if v_id is null then
      insert into public.team_conversations (kind, created_by) values ('all', v_me) returning id into v_id;
    end if;
  else
    raise exception using errcode = '22023', message = 'Type de conversation inconnu.';
  end if;
  return v_id;
end;
$function$
;

-- ===== team_unread_count
CREATE OR REPLACE FUNCTION public.team_unread_count()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ /* org-scoped */
  select coalesce(sum((e ->> 'unread')::int), 0)::int
  from jsonb_array_elements(case when public.has_feature('team.messages') then public.team_conversations_list() else '[]'::jsonb end) e;
$function$
;

-- ===== team_with_feature
CREATE OR REPLACE FUNCTION public.team_with_feature(p_feature text, p_org_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pr.id from public.profiles pr
  where pr.account_status = 'active' and pr.role not in ('customer', 'platform')
    and pr.org_id = coalesce(p_org_id, public.acting_supplier_org_id())
    and public.user_has_permission(pr.id, p_feature);
$function$
;

-- ===== unregister_push_token
CREATE OR REPLACE FUNCTION public.unregister_push_token(p_token text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  delete from public.push_tokens where token = p_token and user_id = (select auth.uid());
$function$
;

-- ===== update_my_location
CREATE OR REPLACE FUNCTION public.update_my_location(p_latitude double precision, p_longitude double precision, p_accuracy double precision DEFAULT NULL::double precision)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if public.active_uid() is null or not public.has_feature('location.share')
     or not exists (select 1 from public.profiles pr where pr.id = auth.uid() and pr.location_consent) then
    return false;
  end if;
  insert into public.user_locations (user_id, latitude, longitude, accuracy, updated_at)
  values (auth.uid(), p_latitude, p_longitude, p_accuracy, now())
  on conflict (user_id) do update set latitude = excluded.latitude, longitude = excluded.longitude, accuracy = excluded.accuracy, updated_at = now();
  return true;
end;
$function$
;

-- ===== user_has_permission
CREATE OR REPLACE FUNCTION public.user_has_permission(p_user_id uuid, p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((
    select case when pr.account_status <> 'active' or pr.role = 'platform' then false
      when public.feature_module(p_permission) is not null and not public.module_enabled_for(public.user_module_org(pr.id, public.feature_module(p_permission)), public.feature_module(p_permission)) then false
      else coalesce(
        (select mo.allowed from public.member_overrides mo where mo.user_id = pr.id and mo.org_id = pr.org_id and mo.permission = p_permission),
        (select (c.feature_overrides ->> p_permission)::boolean from public.clients c where c.id = pr.client_id and pr.role = 'customer' and p_permission like 'client.%'),
        (select bool_or(public.role_grants(r.id, p_permission)) from public.member_roles mr join public.org_roles r on r.id = mr.role_id
          where mr.user_id = pr.id and r.org_id = pr.org_id and (mr.valid_until is null or mr.valid_until > now())
            and r.side = case when pr.role = 'customer' then 'buyer' else 'supplier' end),
        false) end
    from public.profiles pr where pr.id = p_user_id), false);
$function$
;

-- ===== user_module_org
CREATE OR REPLACE FUNCTION public.user_module_org(p_user uuid, p_key text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when pr.role = 'platform' then null
    when pr.role = 'customer' and not public.module_own_scope(p_key) then (select c.supplier_org_id from public.clients c where c.id = pr.client_id)
    else pr.org_id end
  from public.profiles pr where pr.id = p_user;
$function$
;

-- ===== user_org
CREATE OR REPLACE FUNCTION public.user_org(p_user_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select pr.org_id from public.profiles pr where pr.id = p_user_id; $function$
;

-- ===== user_permissions_mirror
CREATE OR REPLACE FUNCTION public.user_permissions_mirror()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := (select pr.org_id from public.profiles pr where pr.id = coalesce(new.user_id, old.user_id));
begin
  if tg_op = 'DELETE' then
    delete from public.member_overrides where user_id = old.user_id and permission = old.feature;
  elsif v_org is not null and exists (select 1 from public.permissions p where p.key = new.feature) then
    insert into public.member_overrides (user_id, org_id, permission, allowed) values (new.user_id, v_org, new.feature, new.allowed)
    on conflict (user_id, org_id, permission) do update set allowed = excluded.allowed;
  end if;
  return null;
end;
$function$
;

-- ===== valid_home_layout
CREATE OR REPLACE FUNCTION public.valid_home_layout(p_layout jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select p_layout is null or (
    jsonb_typeof(p_layout) = 'object'
    and jsonb_typeof(coalesce(p_layout -> 'tiles', '[]'::jsonb)) = 'array'
    and jsonb_typeof(coalesce(p_layout -> 'shortcuts', '[]'::jsonb)) = 'array'
    and jsonb_array_length(coalesce(p_layout -> 'tiles', '[]'::jsonb)) <= 30
    and jsonb_array_length(coalesce(p_layout -> 'shortcuts', '[]'::jsonb)) <= 30
  );
$function$
;
