-- Diagnostic « Ajouter un compte » (lecture seule, ne modifie rien). Coller dans Supabase → SQL Editor → Run.
-- 1re partie : les administrateurs connectés récemment et l'état de leur espace.
-- 2e partie : les comptes essayés (e-mails contenant 2015) et où ils sont rattachés.
select 'admin' as quoi, u.email, pr.role::text as role, pr.account_status as statut_compte,
       o.name as espace, o.status as statut_espace, o.trial_until as essai_jusqu_au, pr.client_id is not null as fiche_client,
       u.last_sign_in_at as derniere_connexion
from auth.users u
join public.profiles pr on pr.id = u.id
left join public.organizations o on o.id = pr.org_id
where pr.role = 'admin'
union all
select 'compte essayé', u.email, pr.role::text, pr.account_status, o.name, o.status, o.trial_until, pr.client_id is not null, u.last_sign_in_at
from auth.users u
join public.profiles pr on pr.id = u.id
left join public.organizations o on o.id = pr.org_id
where u.email ilike '%2015%'
order by 1, 9 desc nulls last;
