-- Reconfirmation by the client, part 1/2: new order status.
-- Run this file ALONE in Supabase SQL Editor, then run 20261020_2_reconfirm_drafts.sql.

alter type public.order_status add value if not exists 'awaiting_client' after 'declined';
