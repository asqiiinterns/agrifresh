-- One-time reorganisation of the accounts (run in Supabase SQL Editor AFTER 20261109_roles.sql).
-- Safe to rerun: each step only does what is still to do, and the last query shows the result.
--
--   * admin@a.tn stays the only Appro+ account (super-admin of the platform);
--   * every other AgriFresh team account in @a.tn becomes @agrifresh.tn: same account, same
--     password, same history (nothing is deleted, so "accepted by…" / "delivered by…" stay);
--   * admin@agrifresh.tn becomes the Responsable of the AgriFresh Pro. It must exist first:
--     create it in the app ("Créer mon compte"), then run this script again.

-- 1. AgriFresh team: @a.tn -> @agrifresh.tn (skipped if the new address is already taken).
DO $$
DECLARE
  r record;
  v_new text;
BEGIN
  FOR r IN
    select u.id, lower(u.email) as email from auth.users u join public.profiles pr on pr.id = u.id
    where lower(u.email) like '%@a.tn' and lower(u.email) <> 'admin@a.tn' and pr.role <> 'customer'
  LOOP
    v_new := replace(r.email, '@a.tn', '@agrifresh.tn');
    IF exists (select 1 from auth.users other where lower(other.email) = v_new) THEN
      RAISE NOTICE '% non renommé : % existe déjà.', r.email, v_new;
      CONTINUE;
    END IF;
    update auth.users set email = v_new where id = r.id;
    IF to_regclass('auth.identities') IS NOT NULL THEN
      EXECUTE 'update auth.identities set identity_data = jsonb_set(identity_data, ''{email}'', to_jsonb($1::text)) where user_id = $2 and provider = ''email'''
        USING v_new, r.id;
    END IF;
    update public.profiles set org_id = coalesce(org_id, public.legacy_org_id()) where id = r.id;
    RAISE NOTICE '% → %', r.email, v_new;
  END LOOP;
END;
$$;

-- 2. admin@a.tn: the Appro+ super-admin, and nothing else.
insert into public.platform_members (user_id, role)
select u.id, 'superadmin' from auth.users u where lower(u.email) = 'admin@a.tn'
on conflict (user_id) do update set role = 'superadmin', active = true;
update public.profiles set is_superadmin = true, org_id = null
where id = (select u.id from auth.users u where lower(u.email) = 'admin@a.tn');

-- 3. admin@agrifresh.tn: Responsable of the AgriFresh Pro (once the account exists).
DO $$
DECLARE
  v_owner uuid := (select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn');
  v_role uuid := (select r.id from public.org_roles r join public.role_templates t on t.id = r.template_id
                  where r.org_id = public.legacy_org_id() and t.key = 'supplier_owner');
BEGIN
  IF v_owner IS NULL THEN
    RAISE NOTICE 'admin@agrifresh.tn n’existe pas encore : créez-le dans l’application (« Créer mon compte »), puis relancez ce script.';
    RETURN;
  END IF;
  delete from public.platform_members where user_id = v_owner;
  update public.profiles set role = 'admin', is_superadmin = false, org_id = public.legacy_org_id(),
    client_id = null, account_status = 'active' where id = v_owner;
  insert into public.member_roles (user_id, role_id) values (v_owner, v_role)
  on conflict (user_id, role_id) do update set transitional = false, valid_until = null;
  -- The super-admin no longer runs AgriFresh: its owner has taken over.
  delete from public.member_roles where transitional;
  RAISE NOTICE 'admin@agrifresh.tn est Responsable d’AgriFresh.';
END;
$$;

-- Result: who is where.
select lower(u.email) as email,
       case when pm.user_id is not null then 'Équipe Appro+ (' || pm.role || ')' else coalesce(o.name, '—') end as rattachement,
       pr.role::text as profil,
       coalesce((select string_agg(r.name, ', ' order by r.name) from public.member_roles mr join public.org_roles r on r.id = mr.role_id
                 where mr.user_id = u.id), '') as roles
from auth.users u
join public.profiles pr on pr.id = u.id
left join public.platform_members pm on pm.user_id = u.id
left join public.organizations o on o.id = pr.org_id
where pr.role <> 'customer'
order by rattachement, email;
