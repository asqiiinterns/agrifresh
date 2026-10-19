-- Team roles, part 1/2: supervisor and production.
-- Run this file ALONE in Supabase SQL Editor, then run 20261021_2_planning_stock.sql.

alter type public.app_role add value if not exists 'supervisor';
alter type public.app_role add value if not exists 'production';
