// Appro+: no supplier name left in server functions or stored alerts; company profile settings.
export async function runApproPlusChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1 }) {
  console.log("\n# Appro+");
  const before = (await db.query(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc like '%AgriFresh%'`)).rows[0].n;
  ok("functions naming the supplier before", before);
  for (const f of ["supabase/migrations/20261106_appro_plus.sql", "supabase/migrations/20261106_appro_plus.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const after = (await db.query(`select string_agg(p.proname, ', ') as names, count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc like '%AgriFresh%' and p.proname <> 'appro_rewrite'`)).rows[0];
  after.n === 0 ? ok("no function names AgriFresh any more") : bad("functions left", after.names);
  const stored = (await db.query(`select count(*)::int as n from public.notifications where title like '%AgriFresh%' or body like '%AgriFresh%'`)).rows[0].n;
  stored === 0 ? ok("stored alerts cleaned") : bad("stored alerts", stored);
  const secdef = (await db.query(`select prosecdef, proconfig from pg_proc where proname = 'send_message_v3'`)).rows[0];
  secdef.prosecdef && String(secdef.proconfig).includes("search_path") ? ok("rewritten functions keep security definer + search_path") : bad("secdef", secdef);
  await expectFail("driver-only function names no supplier", U.c1, `select public.driver_shipments()`, [], /^Accès réservé aux livreurs\.$/);
  await expectOk("messages still work after rewrite", U.c1, `select public.send_message_v3(null, 'Bonjour', null, false) ->> 'id' as r`);
  await expectOk("everyone reads the company profile", U.c1, `select count(*)::int as n from public.company_profile`);
  await expectFail("client cannot change it", U.c1, `select public.set_company_profile('{"name":"X"}'::jsonb)`, [], /administrateur/);
  const admin = (await db.query(`select id from public.profiles where role = 'admin' limit 1`)).rows[0]?.id;
  if (admin) {
    await expectOk("admin sets the company profile", admin, `select public.set_company_profile('{"name":"Ma Société","brand_color":"#24543b","rib":"12 345"}'::jsonb) as r`);
    const p = (await db.query(`select name, brand_color, rib from public.company_profile`)).rows[0];
    p.name === "Ma Société" && p.brand_color === "#24543b" ? ok("profile saved", p) : bad("profile", p);
    await expectFail("bad colour refused", admin, `select public.set_company_profile('{"brand_color":"vert"}'::jsonb)`, [], /Couleur/);
  } else bad("admin user", "none in test db");
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration <= "20261106").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
