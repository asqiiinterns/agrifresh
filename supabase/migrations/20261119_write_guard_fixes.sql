-- Writes refused with "Cette donnée appartient à un autre Pro." although the data was the Pro's own.
--   1. Adding a product (or a vehicle, a team conversation): the row's Pro comes from the column default.
--      20261108 set that default to the original supplier; rerun after 20261111 it overwrote the
--      default of 20261111 (the acting Pro), so every other Pro's new product went to AgriFresh and was
--      refused. The defaults are set back here, and 20261108 no longer overwrites them.
--   2. A Pro not active (waiting for Appro+, suspended) or a disabled account has no acting Pro: the
--      refusal now says so instead of speaking of another Pro.
--   3. A buyer opens the conversation of a supplier other than the selected one: reading it marks that
--      supplier's messages read, which the guard (following the selected supplier) refused. The
--      relation is checked first, then only the read receipts are written.
-- Run in Supabase SQL Editor AFTER 20261118_pro_modules_pricing.sql. Safe to rerun.

-- 1. New rows belong to the acting Pro.
alter table public.products alter column org_id set default public.acting_or_legacy_org_id();
alter table public.vehicles alter column org_id set default public.acting_or_legacy_org_id();
alter table public.team_conversations alter column org_id set default public.acting_or_legacy_org_id();

-- 2. A clear message when the account has no active Pro.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.org_write_guard()'::regprocedure);
BEGIN
  IF v_def not like '%pas actif%' THEN
    v_def := replace(v_def, E'message = \'Cette donnée appartient à un autre Pro.\'',
      E'message = case when v_acting is null then \'Votre espace Pro n’est pas actif (en attente de validation par Appro+ ou suspendu) : vous ne pouvez pas encore modifier ses données.\' else \'Cette donnée appartient à un autre Pro.\' end');
    IF v_def not like '%pas actif%' THEN
      RAISE EXCEPTION 'org_write_guard: message not found';
    END IF;
    EXECUTE v_def;
  END IF;
END;
$$;

-- 3. Reading a conversation with any of my suppliers.
create or replace function public.buyer_thread(p_client_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.buyer_relations('client.messages') c where c.id = p_client_id) then
    raise exception using errcode = '42501', message = 'Conversation introuvable.';
  end if;
  perform set_config('appro.link_write', 'on', true);
  update public.messages set read_at = now() where client_id = p_client_id and from_staff and read_at is null;
  perform set_config('appro.link_write', 'off', true);
  return coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at desc)
    from (select * from public.messages x where x.client_id = p_client_id order by x.created_at desc limit 200) m), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.buyer_thread(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_thread(uuid) TO authenticated;

notify pgrst, 'reload schema';
