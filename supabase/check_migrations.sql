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
  (14, '20261107_modules.sql',                    to_regclass('public.app_modules') is not null),
  (15, '20261108_pros_foundation.sql',            to_regclass('public.organizations') is not null),
  (16, '20261109_roles.sql',                      to_regclass('public.org_roles') is not null),
  (17, '20261110_1_platform_profile.sql + 20261110_2_switch.sql', to_regprocedure('public.platform_pros()') is not null),
  (18, '20261111_isolation.sql',                  to_regprocedure('public.acting_supplier_org_id()') is not null),
  (19, '20261112_pro_onboarding.sql',             to_regprocedure('public.register_pro(jsonb)') is not null),
  (20, '20261113_directory.sql',                  to_regprocedure('public.pro_directory(text,text)') is not null),
  (21, '20261114_accounts.sql',                   to_regclass('public.account_entries') is not null),
  (22, '20261115_multi_supplier_cart.sql',        to_regprocedure('public.place_multi_order(jsonb, date, text)') is not null),
  (23, '20261116_catalog_numbers.sql',           to_regclass('public.org_counters') is not null),
  (24, '20261117_buyer_journey.sql',             to_regprocedure('public.client_cancel_order(uuid, text)') is not null),
  (25, '20261118_pro_modules_pricing.sql',       to_regclass('public.pricing_rules') is not null and to_regprocedure('public.platform_set_org_module(uuid,text,boolean)') is not null and to_regprocedure('public.buyer_price_cart(jsonb)') is not null),
  (26, '20261119_write_guard_fixes.sql',         coalesce(pg_get_functiondef(to_regprocedure('public.buyer_thread(uuid)')) like '%appro.link_write%', false)
                                                 and coalesce(pg_get_functiondef(to_regprocedure('public.org_write_guard()')) like '%pas actif%', false)
                                                 and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'org_id' and column_default like '%acting_or_legacy_org_id%')),
  (27, '20261120_lot4.sql',                      to_regprocedure('public.order_from_public(uuid,jsonb,date,text)') is not null and to_regprocedure('public.accept_invitation(text)') is not null
                                                 and to_regprocedure('public.driver_deliver_v3(uuid[],uuid[],text,uuid,jsonb,text,numeric,text)') is not null and to_regclass('public.org_messages') is not null),
  (28, '20261121_lot5_workflow.sql',             to_regprocedure('public.staff_revert_order(uuid,text)') is not null and to_regprocedure('public.auto_deliver_orders()') is not null
                                                 and coalesce(pg_get_functiondef(to_regprocedure('public.driver_ship_orders(uuid[],uuid)')) like '%planned_vehicle_id%', false)),
  (29, '20261122_cleanup.sql',                   to_regprocedure('public.buyer_returns()') is not null and to_regprocedure('public.buyer_save_recurring(uuid,uuid,jsonb,uuid,int[],int,text,boolean)') is not null),
  (30, '20261123_location.sql',                  to_regclass('public.location_requests') is not null and to_regprocedure('public.location_request_status(uuid)') is not null),
  (31, '20261124_rights.sql',                    to_regclass('public.platform_assist') is not null and to_regprocedure('public.rights_catalogue(uuid)') is not null),
  (32, '20261125_rights_accounts.sql',           to_regprocedure('public.org_members_rights(uuid)') is not null and to_regprocedure('public.org_set_member_permission(uuid,text,boolean)') is not null),
  (33, '20261126_fixes.sql',                     to_regprocedure('public.platform_invitations()') is not null and to_regprocedure('public.delete_account(uuid,boolean)') is not null and to_regprocedure('public.pro_public_card(uuid)') is not null),
  (34, '20261127_default_vehicle.sql',           to_regprocedure('public.set_default_vehicle(uuid)') is not null),
  (35, '20261128_plan_presets.sql',             to_regprocedure('public.platform_set_org_plan(uuid,text)') is not null),
  (36, '20261129_review.sql',                   to_regprocedure('public.member_is_owner(uuid,uuid)') is not null),
  (37, '20261130_workflow_steps.sql',           to_regprocedure('public.prep_tick(uuid[],boolean)') is not null)
) as checks(position, migration, installed)
order by position;
