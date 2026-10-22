-- Comptes → Ajouter: one server function does the whole thing at once (attach to the team, role, activation),
-- instead of the app chaining several calls. Before, the role step relied on the trigger profiles_fill_org to attach
-- the account to the team first; on some databases it did not, and the guard refused with « Ce compte n'appartient
-- pas à votre équipe ». The team is now set explicitly. admin_set_role does the same for its other callers.
-- Functions redefined whole. Run AFTER 20261206_client_errors.sql. Safe to rerun.

-- p_email: an account just created by the app (or a free account: no team, no client record) joins the team
-- of the administrator with p_role, active at once. Returns its id.
create or replace function public.admin_add_member(p_email text, p_role public.app_role)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
  v_user uuid;
  v_profile public.profiles%rowtype;
begin
  if not public.is_admin() or v_org is null then
    raise exception using errcode = '42501', message = 'Réservé aux administrateurs d’un espace actif.';
  end if;
  if p_role not in ('admin', 'supervisor', 'production', 'driver', 'staff') then
    raise exception using errcode = '22023', message = 'Profil invalide pour un membre de l’équipe.';
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(p_email));
  if v_user is null then
    raise exception using errcode = 'P0002', message = 'Aucun compte avec cet e-mail.';
  end if;
  if v_user = auth.uid() then
    raise exception using errcode = '22023', message = 'Vous ne pouvez pas modifier votre propre compte.';
  end if;
  select * into v_profile from public.profiles where id = v_user;
  if v_profile.client_id is not null then
    raise exception using errcode = '22023', message = 'Ce compte est rattaché à une fiche client : utilisez une autre adresse pour l’équipe.';
  end if;
  if v_profile.org_id is not null and v_profile.org_id <> v_org then
    raise exception using errcode = '42501', message = 'Ce compte appartient déjà à un autre espace : la personne doit le quitter ou utiliser une autre adresse.';
  end if;
  if v_profile.role = 'platform' or coalesce(v_profile.is_superadmin, false) then
    raise exception using errcode = '42501', message = 'Ce compte appartient à l’équipe Appro+.';
  end if;
  update public.profiles
  set org_id = v_org, role = p_role, account_status = 'active', disabled = false, deleted_at = null
  where id = v_user;
  update auth.users set banned_until = null, email_confirmed_at = coalesce(email_confirmed_at, now()) where id = v_user;
  return jsonb_build_object('id', v_user, 'role', p_role, 'org_id', v_org);
end;
$$;
REVOKE ALL ON FUNCTION public.admin_add_member(text, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_add_member(text, public.app_role) TO authenticated;

-- Same fix for the role change: a free account is attached to the team explicitly.
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
  -- 20261207: a free account (no team yet) joins the administrator's team explicitly.
  update public.profiles
  set role = p_role,
      org_id = case when org_id is null and client_id is null and p_role <> 'customer' then public.current_org_id() else org_id end
  where id = v_user_id;
  return jsonb_build_object('id', v_user_id, 'role', p_role);
end;
$function$
;

notify pgrst, 'reload schema';
