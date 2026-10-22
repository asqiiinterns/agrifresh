-- Rejoue « Ajouter un compte » comme l'application, en tant que hedi.hamdi2016@gmail.com.
-- Ne modifie RIEN : le script se termine volontairement par une « erreur » qui annule tout et affiche le rapport.
-- Coller dans Supabase → SQL Editor → Run, puis copier tout le message d'erreur affiché (c'est le rapport).
do $$
declare
  v_admin uuid := (select id from auth.users where lower(email) = 'hedi.hamdi2016@gmail.com');
  v_target uuid := (select id from auth.users where lower(email) = 'liv@2015.com');
  r text := E'\n';
  v_ctx text;
begin
  r := r || '1. cible avant : ' || coalesce((select row_to_json(p)::text from (select role, org_id, client_id, account_status, deleted_at from public.profiles where id = v_target) p), 'introuvable') || E'\n';
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  r := r || '2. uid | current_org | acting | acting_or_legacy : ' || concat_ws(' | ', auth.uid(), public.current_org_id(), public.acting_supplier_org_id(), public.acting_or_legacy_org_id()) || E'\n';
  r := r || '3. is_admin | platform_role | assisted_org : ' || concat_ws(' | ', public.is_admin(), coalesce(public.platform_role()::text, '-'), coalesce(public.assisted_org()::text, '-')) || E'\n';
  r := r || '4. triggers : ' || (select string_agg(tgname, ', ' order by tgname) from pg_trigger where tgrelid = 'public.profiles'::regclass and not tgisinternal) || E'\n';
  begin
    r := r || '5. admin_set_role : ' || public.admin_set_role('liv@2015.com', 'driver')::text || E'\n';
    r := r || '6. cible après : ' || (select row_to_json(p)::text from (select role, org_id, client_id, account_status from public.profiles where id = v_target) p) || E'\n';
  exception when others then
    get stacked diagnostics v_ctx = pg_exception_context;
    r := r || '5. ERREUR : ' || sqlerrm || E'\n   où : ' || v_ctx || E'\n';
  end;
  raise exception 'RAPPORT (rien n''a été modifié) :%', r;
end $$;
