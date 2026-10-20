-- Appro+: the app no longer carries a supplier's name. The seller's details (printed on its own
-- documents) become settings entered by the administrator, and every server message that named
-- the supplier now says "votre fournisseur" (or "Appro+" for the app itself).
-- Run in Supabase SQL Editor AFTER 20261105_message_replies.sql. Safe to rerun.

-- ---------------------------------------------------------------------------
-- Company profile: the seller's details for documents (readable by every signed-in user,
-- since they are printed on the documents clients receive; changed by an admin only).
-- ---------------------------------------------------------------------------
create table if not exists public.company_profile (
  id int primary key default 1 check (id = 1),
  name text not null default '',
  tagline text not null default '',
  address text not null default '',
  phone text not null default '',
  email text not null default '',
  tax_id text not null default '',
  rib text not null default '',
  brand_color text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.company_profile (id) values (1) on conflict (id) do nothing;
alter table public.company_profile enable row level security;
GRANT SELECT ON public.company_profile TO authenticated;
drop policy if exists "company_profile_read" on public.company_profile;
create policy "company_profile_read" on public.company_profile for select to authenticated using (true);

create or replace function public.set_company_profile(p_profile jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Seul un administrateur peut modifier les informations de l’entreprise.';
  end if;
  if p_profile ? 'brand_color' and coalesce(p_profile ->> 'brand_color', '') !~ '^(#[0-9a-fA-F]{6})?$' then
    raise exception using errcode = '22023', message = 'Couleur invalide : utilisez le format #RRVVBB.';
  end if;
  update public.company_profile set
    name = left(btrim(coalesce(p_profile ->> 'name', name)), 120),
    tagline = left(btrim(coalesce(p_profile ->> 'tagline', tagline)), 160),
    address = left(btrim(coalesce(p_profile ->> 'address', address)), 300),
    phone = left(btrim(coalesce(p_profile ->> 'phone', phone)), 60),
    email = left(btrim(coalesce(p_profile ->> 'email', email)), 160),
    tax_id = left(btrim(coalesce(p_profile ->> 'tax_id', tax_id)), 60),
    rib = left(btrim(coalesce(p_profile ->> 'rib', rib)), 80),
    brand_color = coalesce(p_profile ->> 'brand_color', brand_color),
    updated_at = now()
  where id = 1;
end;
$$;
REVOKE ALL ON FUNCTION public.set_company_profile(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_company_profile(jsonb) TO authenticated;

DO $$
BEGIN
  IF to_regprocedure('public.audit_row()') IS NOT NULL THEN
    EXECUTE 'drop trigger if exists audit_company_profile on public.company_profile';
    EXECUTE 'create trigger audit_company_profile after insert or update or delete on public.company_profile for each row execute function public.audit_row()';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Server messages: every function whose code names the supplier is rewritten in place
-- (same signature, security and grants), most specific wording first.
-- ---------------------------------------------------------------------------
create or replace function public.appro_rewrite(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
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
$$;

DO $$
DECLARE
  r record;
  v_def text;
BEGIN
  FOR r IN
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prosrc like '%AgriFresh%' and p.proname <> 'appro_rewrite'
  LOOP
    v_def := pg_get_functiondef(r.oid);
    EXECUTE public.appro_rewrite(v_def);
  END LOOP;
END;
$$;

-- What was already sent or stored keeps no trace of the old name either.
update public.notifications set title = public.appro_rewrite(title), body = public.appro_rewrite(body)
where title like '%AgriFresh%' or body like '%AgriFresh%';
update public.order_status_history set note = public.appro_rewrite(note) where note like '%AgriFresh%';
alter table public.app_settings alter column email_from set default 'Appro+ <onboarding@resend.dev>';
update public.app_settings set email_from = replace(email_from, 'AgriFresh', 'Appro+') where email_from like '%AgriFresh%';
