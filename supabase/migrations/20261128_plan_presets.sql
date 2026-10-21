-- Appro+ → a Pro → Modules: the presets of the plan in one step.
--   all        every module included, and switched back on for the Pro (otherwise "Tout inclure"
--              seemed to do nothing on modules the Pro had switched off itself);
--   essential  only the essential modules included;
--   default    every module follows the Appro+ default again.

create or replace function public.platform_set_org_plan(p_org_id uuid, p_preset text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_essential text[] := array['delivery', 'invoicing', 'client_messages'];
begin
  if not public.platform_can('platform.pros.manage') then
    raise exception using errcode = '42501', message = 'Seule l’équipe Appro+ gère la formule d’un Pro.';
  end if;
  if p_preset not in ('all', 'essential', 'default') then
    raise exception using errcode = '22023', message = 'Formule inconnue.';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org_id) then
    raise exception using errcode = 'P0002', message = 'Pro introuvable.';
  end if;
  insert into public.org_modules (org_id, key, granted, enabled, updated_at, updated_by)
  select p_org_id, k,
    case p_preset when 'all' then true when 'essential' then k = any(v_essential) else null end,
    null, now(), auth.uid()
  from unnest(public.module_keys()) k
  on conflict (org_id, key) do update set
    granted = excluded.granted,
    enabled = case when p_preset = 'all' then null else public.org_modules.enabled end,
    updated_at = now(), updated_by = auth.uid();
end;
$$;

revoke all on function public.platform_set_org_plan(uuid, text) from public;
grant execute on function public.platform_set_org_plan(uuid, text) to authenticated;
