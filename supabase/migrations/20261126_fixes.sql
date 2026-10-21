-- Fixes and follow-ups (asked 2026-10-21):
--   A. invitations: Appro+ is told of every code created (who, for whom, when), sees them all with what became of them,
--      sees "invité par" on each account, and may invite on behalf of a Pro; a space created through an invitation
--      is active for N hours (Appro+ setting), then suspended until validated; a business created spontaneously is
--      not activated automatically unless Appro+ allows it; no automatic activation before the e-mail is confirmed;
--   B. an account can be deleted (kept, hidden by a filter, restorable);
--   C. a message to a Pro that does not accept messages from outside its network waits; it arrives when it opens them;
--   D. what a Pro shows of itself (address, phone, e-mail, tax id, relations) and its card before accepting a relation;
--   E. one's own name and phone, and one's business details (also for a buyer or a private person).
-- Functions redefined whole. Run AFTER 20261125_rights_accounts.sql. Safe to rerun.

-- ===========================================================================
-- A. Invitations and new accounts
-- ===========================================================================
insert into public.platform_settings (key, value) values ('invited_trial_hours', '48'::jsonb), ('self_signup_business_trial', 'false'::jsonb)
on conflict (key) do nothing;

create or replace function public.public_settings()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'app_url', coalesce(public.platform_setting('app_url') #>> '{}', ''),
    'trial_hours', coalesce((public.platform_setting('new_accounts_trial_hours') #>> '{}')::int, 0),
    'invited_trial_hours', coalesce((public.platform_setting('invited_trial_hours') #>> '{}')::int, 0),
    'self_signup_business_trial', coalesce((public.platform_setting('self_signup_business_trial') #>> '{}')::boolean, false));
$$;

create or replace function public.platform_set_setting(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas de modifier ce réglage.';
  end if;
  if p_key in ('new_accounts_trial_hours', 'invited_trial_hours') then
    if jsonb_typeof(p_value) is distinct from 'number' or (p_value #>> '{}')::numeric not between 0 and 720 then
      raise exception using errcode = '22023', message = 'Durée invalide (0 à 720 heures).';
    end if;
    p_value := to_jsonb(round((p_value #>> '{}')::numeric)::int);
  elsif p_key = 'self_signup_business_trial' then
    if jsonb_typeof(p_value) is distinct from 'boolean' then
      raise exception using errcode = '22023', message = 'Valeur invalide.';
    end if;
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
$$;

-- The e-mail of an account is confirmed (Supabase sets email_confirmed_at; read through jsonb so a database
-- without that column does not break).
create or replace function public.email_confirmed(p_user uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select (to_jsonb(u) ->> 'email_confirmed_at') is not null or (to_jsonb(u) ->> 'confirmed_at') is not null from auth.users u where u.id = p_user), false); $$;
REVOKE ALL ON FUNCTION public.email_confirmed(uuid) FROM PUBLIC, anon, authenticated;

-- Trial: through an invitation (its own length), or spontaneous (a private person; a business only when Appro+
-- allows it); never before the e-mail of the Responsable is confirmed.
drop function if exists public.start_trial(uuid);
create or replace function public.start_trial(p_org_id uuid, p_invited boolean default false)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations%rowtype;
  v_hours int := coalesce((public.platform_setting(case when p_invited then 'invited_trial_hours' else 'new_accounts_trial_hours' end) #>> '{}')::int, 0);
begin
  select * into v_org from public.organizations where id = p_org_id;
  if v_hours <= 0 or v_org.status is distinct from 'pending' then
    return false;
  end if;
  if not p_invited and v_org.kind = 'business' and not coalesce((public.platform_setting('self_signup_business_trial') #>> '{}')::boolean, false) then
    return false;
  end if;
  if not exists (select 1 from public.profiles pr where pr.org_id = p_org_id and public.email_confirmed(pr.id)) then
    return false;
  end if;
  update public.organizations set status = 'active', trial_until = now() + make_interval(hours => v_hours), updated_at = now() where id = p_org_id;
  perform public.org_install_roles(p_org_id);
  if v_org.is_supplier then
    perform public.org_install_numbering(p_org_id);
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.profiles set account_status = 'active' where org_id = p_org_id and account_status = 'pending' and role <> 'platform';
  perform set_config('appro.link_write', 'off', true);
  perform public.notify(array(select pm.user_id from public.platform_members pm where pm.active and pm.role in ('superadmin', 'verification', 'account_manager')),
    'pro.trial', 'Nouvel espace en période transitoire',
    format('%s est actif pour %s h%s : validez-le (Appro+ → Pros) pour qu’il le reste.', v_org.name, v_hours, case when p_invited then ' (invité)' else '' end));
  return true;
end;
$$;
REVOKE ALL ON FUNCTION public.start_trial(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- Who invited this account (latest invitation it accepted).
create or replace function public.invited_by_of(p_user uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('name', public.location_name(i.invited_by), 'org_name', o.name, 'code', i.code, 'created_at', i.created_at, 'accepted_at', a.accepted_at)
  from public.invitation_acceptances a join public.invitations i on i.id = a.invitation_id join public.organizations o on o.id = i.org_id
  where a.user_id = p_user order by a.accepted_at desc limit 1;
$$;
REVOKE ALL ON FUNCTION public.invited_by_of(uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.invitation_create(p_org_id uuid, p_side text, p_client_id uuid, p_name text, p_contact text, p_by_platform boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations%rowtype;
  v_code text;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_contact text := nullif(btrim(coalesce(p_contact, '')), '');
  v_new boolean := false;
begin
  select * into v_org from public.organizations where id = p_org_id;
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
    values (v_code, v_org.id, auth.uid(), p_side, p_client_id, v_name, v_contact);
    v_new := true;
  end if;
  -- Appro+ follows every invitation created (who, for whom, when).
  if v_new then
    perform public.notify(array(select pm.user_id from public.platform_members pm where pm.active and pm.role in ('superadmin', 'account_manager', 'verification')
        and pm.user_id <> auth.uid()),
      'invitation.created', format('Invitation créée · %s', v_org.name),
      format('%s%s invite %s comme %s%s (code %s, %s).', public.location_name(auth.uid()), case when p_by_platform then ' (Appro+, pour le compte du Pro)' else '' end,
        coalesce(v_name, 'une personne'), case when p_side = 'client' then 'client' else 'fournisseur' end, coalesce(' · ' || v_contact, ''), v_code,
        to_char(now() at time zone 'Africa/Tunis', 'DD/MM/YYYY HH24:MI')));
  end if;
  return jsonb_build_object('code', v_code, 'org_name', v_org.name, 'side', p_side, 'name', v_name,
    'app_url', coalesce(public.platform_setting('app_url') #>> '{}', ''));
end;
$$;
REVOKE ALL ON FUNCTION public.invitation_create(uuid, text, uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;

create or replace function public.create_invitation(p_side text, p_client_id uuid default null, p_name text default null, p_contact text default null)
returns jsonb language sql security definer set search_path = ''
as $$ select public.invitation_create(public.current_org_id(), p_side, p_client_id, p_name, p_contact, false); $$;
REVOKE ALL ON FUNCTION public.create_invitation(text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invitation(text, uuid, text, text) TO authenticated;

create or replace function public.platform_create_invitation(p_org_id uuid, p_side text, p_name text default null, p_contact text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Votre rôle Appro+ ne permet pas d’inviter pour un Pro.';
  end if;
  return public.invitation_create(p_org_id, p_side, null, p_name, p_contact, true);
end;
$$;
REVOKE ALL ON FUNCTION public.platform_create_invitation(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_create_invitation(uuid, text, text, text) TO authenticated;

-- Every invitation and what became of it: all of them for Appro+, those of my space for its administrator.
create or replace function public.invitations_list(p_org_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'code', i.code, 'created_at', i.created_at, 'expires_at', i.expires_at, 'org_name', o.name, 'side', i.side,
      'invited_by', public.location_name(i.invited_by), 'name', i.name, 'contact', i.contact, 'client_name', c.business_name, 'uses', i.uses,
      'acceptances', coalesce((select jsonb_agg(jsonb_build_object('name', public.location_name(a.user_id), 'accepted_at', a.accepted_at, 'linked_at', a.linked_at,
          'org_name', (select oo.name from public.profiles pr join public.organizations oo on oo.id = pr.org_id where pr.id = a.user_id)) order by a.accepted_at)
        from public.invitation_acceptances a where a.invitation_id = i.id), '[]'::jsonb))
    order by i.created_at desc), '[]'::jsonb)
  from (select * from public.invitations x where p_org_id is null or x.org_id = p_org_id order by x.created_at desc limit 500) i
  join public.organizations o on o.id = i.org_id
  left join public.clients c on c.id = i.client_id;
$$;
REVOKE ALL ON FUNCTION public.invitations_list(uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.platform_invitations()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.platform_can('platform.pros.view') then
    raise exception using errcode = '42501', message = 'Réservé à l’équipe Appro+.';
  end if;
  return public.invitations_list(null);
end;
$$;
REVOKE ALL ON FUNCTION public.platform_invitations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_invitations() TO authenticated;

create or replace function public.my_invitations()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not (public.is_admin() or public.is_org_owner(v_org) or public.has_feature('roles.manage')) then
    raise exception using errcode = '42501', message = 'Réservé à l’administrateur de l’espace.';
  end if;
  return public.invitations_list(v_org);
end;
$$;
REVOKE ALL ON FUNCTION public.my_invitations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_invitations() TO authenticated;

create or replace function public.invitation_link(p_invitation_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
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
  if v_org.id is null then
    if v_record.id is null or v_record.buyer_org_id is null
       or exists (select 1 from public.profiles pr where pr.org_id = v_record.buyer_org_id and pr.id <> p_user_id) then
      return false;
    end if;
    perform set_config('appro.link_write', 'on', true);
    perform public.attach_org_owner(v_record.buyer_org_id, p_user_id);
    update public.profiles set client_id = v_record.id where id = p_user_id;
    perform set_config('appro.link_write', 'off', true);
    perform public.start_trial(v_record.buyer_org_id, true);
  elsif v_inv.side = 'client' then
    if not v_org.is_buyer then
      return false;
    end if;
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
$$;

create or replace function public.register_pro(p_profile jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.profiles%rowtype;
  v_org uuid;
  v_kind text := case when p_profile ->> 'kind' = 'person' then 'person' else 'business' end;
  v_supplier boolean := coalesce((p_profile ->> 'is_supplier')::boolean, false) and v_kind = 'business';
  v_buyer boolean := coalesce((p_profile ->> 'is_buyer')::boolean, true) or v_kind = 'person';
  v_invited boolean := exists (select 1 from public.invitation_acceptances a where a.user_id = auth.uid());
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
  perform public.start_trial(v_org, v_invited);
  for v_acceptance in select a.invitation_id from public.invitation_acceptances a where a.user_id = auth.uid() and a.linked_at is null loop
    perform public.invitation_link(v_acceptance.invitation_id, auth.uid());
  end loop;
  return v_org;
end;
$$;

-- ===========================================================================
-- B. Deleting an account (kept and restorable; hidden from the lists by a filter)
-- ===========================================================================
alter table public.profiles add column if not exists deleted_at timestamptz;

create or replace function public.delete_account(p_user_id uuid, p_restore boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.profiles%rowtype;
begin
  select * into v_target from public.profiles where id = p_user_id;
  if v_target.id is null or v_target.role = 'platform' then
    raise exception using errcode = 'P0002', message = 'Compte introuvable.';
  end if;
  if p_user_id = auth.uid() then
    raise exception using errcode = '22023', message = 'Vous ne pouvez pas supprimer votre propre compte ici.';
  end if;
  if not (public.platform_can('platform.pros.manage')
          or (v_target.org_id is not null and v_target.org_id = public.current_org_id() and (public.is_admin() or public.is_org_owner(v_target.org_id)))) then
    raise exception using errcode = '42501', message = 'Seul l’administrateur de l’espace (ou Appro+) supprime un compte.';
  end if;
  perform set_config('appro.link_write', 'on', true);
  if coalesce(p_restore, false) then
    update public.profiles set deleted_at = null where id = p_user_id;
  else
    update public.profiles set deleted_at = now(), account_status = 'suspended' where id = p_user_id;
  end if;
  perform set_config('appro.link_write', 'off', true);
end;
$$;
REVOKE ALL ON FUNCTION public.delete_account(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_account(uuid, boolean) TO authenticated;

create or replace function public.admin_list_accounts()
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
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', u.id, 'email', u.email, 'full_name', coalesce(pr.full_name, ''), 'role', coalesce(pr.role::text, 'customer'),
      'status', coalesce(pr.account_status, 'pending'), 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
      'client_name', c.business_name, 'is_self', u.id = auth.uid(),
      'deleted_at', pr.deleted_at, 'email_confirmed', public.email_confirmed(u.id), 'invited_by', public.invited_by_of(u.id)
    ) order by (coalesce(pr.account_status, 'pending') = 'pending') desc, u.created_at desc)
    from auth.users u
    left join public.profiles pr on pr.id = u.id
    left join public.clients c on c.id = pr.client_id
    where coalesce(pr.role::text, 'customer') <> 'platform'
      and public.org_visible(pr.org_id)
  ), '[]'::jsonb);
end;
$$;

create or replace function public.platform_accounts(p_search text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.platform_can('platform.pros.view') then
    raise exception using errcode = '42501', message = 'Réservé à l’équipe Appro+.';
  end if;
  return coalesce((
    select jsonb_agg(x order by (x ->> 'status') = 'pending' desc, x ->> 'email') from (
      select jsonb_build_object('id', u.id, 'email', u.email, 'full_name', coalesce(pr.full_name, ''), 'role', pr.role,
        'status', pr.account_status, 'org_id', o.id, 'org_name', coalesce(o.name, c.business_name), 'org_kind', o.kind,
        'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
        'deleted_at', pr.deleted_at, 'email_confirmed', public.email_confirmed(u.id), 'invited_by', public.invited_by_of(u.id)) as x
      from auth.users u left join public.profiles pr on pr.id = u.id
      left join public.organizations o on o.id = pr.org_id left join public.clients c on c.id = pr.client_id
      where p_search is null or btrim(p_search) = ''
         or lower(u.email || ' ' || coalesce(pr.full_name, '') || ' ' || coalesce(o.name, '') || ' ' || coalesce(c.business_name, '')) like '%' || lower(btrim(p_search)) || '%'
      order by u.created_at desc limit 300) s
  ), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- C. Messages to a Pro closed to messages from outside its network: held until it opens them
-- ===========================================================================
alter table public.org_conversations add column if not exists held boolean not null default false;

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
      'conversation_id', cv.id, 'org_id', o.id, 'name', o.name, 'kind', o.kind, 'last_at', cv.last_at, 'held', cv.held,
      'last_body', (select m.body from public.org_messages m where m.conversation_id = cv.id order by m.created_at desc limit 1),
      'unread', (select count(*) from public.org_messages m where m.conversation_id = cv.id and m.sender_org_id <> v_org and m.read_at is null),
      'related', public.org_related(v_org, o.id)) order by cv.last_at desc)
    from public.org_conversations cv
    join public.organizations o on o.id = case when cv.org_a = v_org then cv.org_b else cv.org_a end
    where v_org in (cv.org_a, cv.org_b) and not (cv.held and cv.started_by is distinct from v_org)), '[]'::jsonb);
end;
$$;

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
  select * into v_cv from public.org_conversations cv where cv.org_a = v_a and cv.org_b = v_b;
  if v_cv.id is null then
    -- Closed to messages from outside its network: the conversation waits until it opens them.
    insert into public.org_conversations (org_a, org_b, started_by, held)
    values (v_a, v_b, v_org, not v_other.open_to_messages and not public.org_related(v_org, v_other.id))
    returning * into v_cv;
  elsif v_cv.held and v_cv.started_by is distinct from v_org then
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

-- ===========================================================================
-- D. What a Pro shows of itself, and its card
-- ===========================================================================
alter table public.organizations add column if not exists profile_visibility jsonb not null
  default '{"address": true, "phone": false, "email": false, "tax_id": false, "relations": true}'::jsonb;

create or replace function public.set_pro_visibility(p_catalog text default null, p_listed boolean default null, p_messages boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
  v_released int := 0;
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
  -- Opening the messages delivers those that waited.
  if p_messages then
    update public.org_conversations set held = false
    where held and v_org in (org_a, org_b) and started_by is distinct from v_org;
    get diagnostics v_released = row_count;
    if v_released > 0 then
      perform public.notify(array[auth.uid()], 'org.message', 'Messages en attente', format('%s conversation(s) de Pros hors de votre réseau vous attendaient.', v_released));
    end if;
  end if;
  return public.my_pro();
end;
$$;

create or replace function public.set_profile_visibility(p_visibility jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not (public.is_admin() or public.is_org_owner(v_org)) then
    raise exception using errcode = '42501', message = 'Seul le Responsable du Pro peut changer ce réglage.';
  end if;
  update public.organizations set profile_visibility = jsonb_build_object(
      'address', coalesce((p_visibility ->> 'address')::boolean, (profile_visibility ->> 'address')::boolean, true),
      'phone', coalesce((p_visibility ->> 'phone')::boolean, (profile_visibility ->> 'phone')::boolean, false),
      'email', coalesce((p_visibility ->> 'email')::boolean, (profile_visibility ->> 'email')::boolean, false),
      'tax_id', coalesce((p_visibility ->> 'tax_id')::boolean, (profile_visibility ->> 'tax_id')::boolean, false),
      'relations', coalesce((p_visibility ->> 'relations')::boolean, (profile_visibility ->> 'relations')::boolean, true)), updated_at = now()
  where id = v_org;
end;
$$;
REVOKE ALL ON FUNCTION public.set_profile_visibility(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_profile_visibility(jsonb) TO authenticated;

-- The card of a Pro (in the directory, or that asks to work with me): only what it chose to show.
create or replace function public.pro_public_card(p_org_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := public.current_org_id();
  v_org public.organizations%rowtype;
  v jsonb;
begin
  select * into v_org from public.organizations where id = p_org_id and status in ('active', 'pending');
  if v_org.id is null or v_me is null or not (v_org.listed_in_directory
      or exists (select 1 from public.clients c where (c.supplier_org_id = v_me and c.buyer_org_id = p_org_id) or (c.supplier_org_id = p_org_id and c.buyer_org_id = v_me))
      or exists (select 1 from public.org_conversations cv where cv.org_a = least(v_me, p_org_id) and cv.org_b = greatest(v_me, p_org_id))) then
    raise exception using errcode = 'P0002', message = 'Fiche non disponible.';
  end if;
  v := v_org.profile_visibility;
  return jsonb_build_object('id', v_org.id, 'name', v_org.name, 'kind', v_org.kind, 'is_supplier', v_org.is_supplier, 'is_buyer', v_org.is_buyer,
    'tagline', v_org.tagline, 'since', v_org.created_at, 'catalog_visibility', v_org.catalog_visibility,
    'address', case when coalesce((v ->> 'address')::boolean, true) then v_org.address end,
    'phone', case when coalesce((v ->> 'phone')::boolean, false) then v_org.phone end,
    'email', case when coalesce((v ->> 'email')::boolean, false) then v_org.email end,
    'tax_id', case when coalesce((v ->> 'tax_id')::boolean, false) then v_org.tax_id end,
    'clients', case when coalesce((v ->> 'relations')::boolean, true) then (select count(*) from public.clients c where c.supplier_org_id = v_org.id and c.link_status = 'active') end,
    'suppliers', case when coalesce((v ->> 'relations')::boolean, true) then (select count(*) from public.clients c where c.buyer_org_id = v_org.id and c.link_status = 'active') end);
end;
$$;
REVOKE ALL ON FUNCTION public.pro_public_card(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pro_public_card(uuid) TO authenticated;

-- ===========================================================================
-- E. My details and my business's (also a buyer's or a private person's space)
-- ===========================================================================
create or replace function public.my_org_profile()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', o.id, 'name', o.name, 'kind', o.kind, 'tagline', o.tagline, 'address', o.address, 'phone', o.phone, 'email', o.email,
    'tax_id', o.tax_id, 'rib', o.rib, 'brand_color', o.brand_color, 'profile_visibility', o.profile_visibility,
    'can_edit', public.is_admin() or public.is_org_owner(o.id))
  from public.organizations o where o.id = public.current_org_id();
$$;
REVOKE ALL ON FUNCTION public.my_org_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_org_profile() TO authenticated;

create or replace function public.set_company_profile(p_profile jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null or not (public.is_admin() or public.is_org_owner(v_org)) then
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
$$;

alter table public.profiles add column if not exists phone text;
create or replace function public.set_my_profile(p_full_name text, p_phone text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Connectez-vous d’abord.';
  end if;
  if char_length(btrim(coalesce(p_full_name, ''))) not between 2 and 120 then
    raise exception using errcode = '22023', message = 'Indiquez votre nom (2 à 120 caractères).';
  end if;
  update public.profiles set full_name = btrim(p_full_name), phone = nullif(left(btrim(coalesce(p_phone, '')), 40), '') where id = auth.uid();
end;
$$;
REVOKE ALL ON FUNCTION public.set_my_profile(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_profile(text, text) TO authenticated;

notify pgrst, 'reload schema';
