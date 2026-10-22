-- Diagnostic des notifications (lecture seule). Supabase → SQL Editor → Run.
-- Pour chaque compte : téléphone enregistré pour les notifications (APK), réglage push, dernière notification reçue.
select u.email,
       pr.notify_push as push_active,
       (select count(*) from public.push_tokens t where t.user_id = u.id) as telephones_enregistres,
       (select n.title || ' · ' || to_char(n.created_at, 'DD/MM HH24:MI') from public.notifications n where n.user_id = u.id order by n.created_at desc limit 1) as derniere_notification,
       (select count(*) from public.notifications n where n.user_id = u.id and n.event = 'location.request') as demandes_de_position,
       exists (select 1 from pg_extension where extname = 'pg_net') as envoi_push_possible
from auth.users u
join public.profiles pr on pr.id = u.id
where pr.account_status = 'active' and pr.role <> 'customer'
order by u.last_sign_in_at desc nulls last
limit 30;
