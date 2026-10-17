-- B2B ordering, part 1/2: new statuses and the driver role.
-- Run this file ALONE in Supabase SQL Editor, then run 20261018_b2b_2_flow.sql.
-- Postgres only allows new enum values to be used once this transaction commits.

alter type public.order_status add value if not exists 'on_hold' after 'pending';
alter type public.order_status add value if not exists 'declined' after 'confirmed';
alter type public.app_role add value if not exists 'driver';
