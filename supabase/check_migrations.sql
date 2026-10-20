-- Which migrations are installed? Paste in Supabase SQL Editor and Run (read-only, changes nothing).
-- Each line: the migration file, then "OK" or "À EXÉCUTER". Run the missing ones in this order.
select migration, case when installed then 'OK' else 'À EXÉCUTER' end as etat
from (values
  (1,  '20261025_alerts.sql',                     to_regclass('public.notifications') is not null),
  (2,  '20261026_staff_orders.sql',               to_regprocedure('public.staff_place_order(uuid,jsonb,uuid,date,text)') is not null),
  (3,  '20261027_settings_fleet_audit.sql',       to_regclass('public.audit_log') is not null),
  (4,  '20261028_alert_important.sql',            exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'notifications' and column_name = 'important')),
  (5,  '20261029_team_messages.sql',              to_regclass('public.team_messages') is not null),
  (6,  '20261030_numbering_returns.sql',          to_regclass('public.credit_notes') is not null),
  (7,  '20261031_billing_decisions.sql',          to_regclass('public.invoice_payments') is not null),
  (8,  '20261101_message_attachments.sql',        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'messages' and column_name = 'attachment')),
  (9,  '20261102_needs_reply.sql',                to_regprocedure('public.team_add_members(uuid,uuid[])') is not null),
  (10, '20261103_location_reminders_leaves.sql',  to_regclass('public.incidents') is not null),
  (11, '20261104_recurring_signature.sql',        to_regclass('public.recurring_orders') is not null),
  (12, '20261105_message_replies.sql',            to_regprocedure('public.send_message_v3(uuid,text,jsonb,boolean,uuid)') is not null),
  (13, '20261106_appro_plus.sql',                 to_regclass('public.company_profile') is not null),
  (14, '20261107_modules.sql',                    to_regclass('public.app_modules') is not null)
) as checks(position, migration, installed)
order by position;
