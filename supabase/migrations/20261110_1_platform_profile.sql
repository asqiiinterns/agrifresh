-- Pros, step 2b (part 1 of 2): a profile of its own for the Appro+ team ("platform"),
-- so that no check written for a supplier's team or administrator ever lets it in.
-- Kept in its own file: a new enum value can only be used once this one is committed.
-- Run in Supabase SQL Editor AFTER supabase/scripts/agrifresh_accounts.sql. Safe to rerun.
alter type public.app_role add value if not exists 'platform';
