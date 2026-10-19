-- Alerts can be flagged as important by the person who received them.
-- Run in Supabase SQL Editor AFTER 20261027_settings_fleet_audit.sql. Safe to rerun.

alter table public.notifications add column if not exists important boolean not null default false;

create or replace function public.set_notification_important(p_id uuid, p_important boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.notifications set important = coalesce(p_important, false)
  where id = p_id and user_id = (select public.active_uid());
  if not found then
    raise exception using errcode = 'P0002', message = 'Alerte introuvable.';
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.set_notification_important(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_notification_important(uuid, boolean) TO authenticated;
