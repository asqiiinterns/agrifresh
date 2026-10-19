-- Account status decided by the admin: pending (new sign-up), active, refused, suspended.
-- Run in Supabase SQL Editor AFTER 20261023_accounts.sql. Safe to rerun.
-- No e-mail confirmation: a new account signs in at once but stays "pending" (no rights,
-- no data) until an admin validates it. Refused and suspended accounts cannot sign in.
-- Also turn off Authentication → Providers → Email → "Confirm email" in Supabase.

-- Existing accounts stay usable; accounts created from now on start pending.
alter table public.profiles add column if not exists account_status text not null default 'active';
alter table public.profiles alter column account_status set default 'pending';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'profiles_account_status_check') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_account_status_check
      CHECK (account_status IN ('pending', 'active', 'refused', 'suspended'));
  END IF;
END;
$$;
update public.profiles set account_status = 'suspended' where disabled and account_status = 'active';

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = (select auth.uid()) and pr.role in ('staff', 'admin', 'supervisor') and pr.account_status = 'active'
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles pr where pr.id = (select auth.uid()) and pr.role = 'admin' and pr.account_status = 'active');
$$;

create or replace function public.current_client_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pr.client_id from public.profiles pr where pr.id = (select auth.uid()) and pr.account_status = 'active';
$$;

create or replace function public.active_uid()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pr.id from public.profiles pr where pr.id = (select auth.uid()) and pr.account_status = 'active';
$$;

create or replace function public.has_feature(p_feature text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when pr.account_status <> 'active' then false
      when pr.role = 'admin' then true
      else coalesce((
        select rp.allowed from public.role_permissions rp
        where rp.role = (case when pr.role = 'staff' then 'supervisor' else pr.role end)::public.app_role
          and rp.feature = p_feature
      ), false)
    end
    from public.profiles pr where pr.id = (select auth.uid())
  ), false);
$$;

create or replace function public.admin_set_account_status(p_user_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;
REVOKE ALL ON FUNCTION public.admin_set_account_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_account_status(uuid, text) TO authenticated;

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
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.admin_list_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_accounts() TO authenticated;

create or replace function public.my_account()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'role', pr.role,
    'full_name', pr.full_name,
    'features', public.my_features(),
    'disabled', pr.account_status <> 'active',
    'status', pr.account_status,
    'client', case when c.id is null or not c.active then null else jsonb_build_object(
      'id', c.id,
      'client_number', c.client_number,
      'business_name', c.business_name,
      'contact_name', c.contact_name,
      'phone', c.phone,
      'show_prices', c.show_prices,
      'show_origin', c.show_origin,
      'show_stock', c.show_stock,
      'stock_managed', c.stock_managed,
      'reception_qr', c.reception_qr,
      'reception_token', case when c.reception_qr then c.reception_token end,
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
$$;
REVOKE ALL ON FUNCTION public.my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_account() TO authenticated;
