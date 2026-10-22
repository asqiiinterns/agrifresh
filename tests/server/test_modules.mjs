// Modules: switching one off removes its rights (admins included) and its client options.
export async function runModuleChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1 }) {
  console.log("\n# Modules");
  for (const f of ["supabase/migrations/20261107_modules.sql", "supabase/migrations/20261107_modules.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const admin = (await one(`select id from public.profiles where role = 'admin' limit 1`)).id;
  const state = await as(U.c1, `select public.app_modules_state() as s`);
  Object.values(state[0].s).every(Boolean) && Object.keys(state[0].s).length === 30 ? ok("30 modules, all on by default") : bad("default state", state[0].s);
  const before = await as(U.staff, `select public.has_feature('invoices.manage') as f`);
  before[0].f ? ok("supervisor has invoices.manage") : bad("before", before);
  await expectFail("non-admin cannot switch a module", U.staff, `select public.admin_set_module('invoicing', false)`, [], /administrateur/);
  await expectFail("unknown module refused", admin, `select public.admin_set_module('nope', false)`, [], /inconnu/);
  await expectOk("admin switches invoicing off", admin, `select public.admin_set_module('invoicing', false) as r`);
  const off = await as(U.staff, `select public.has_feature('invoices.manage') as f, public.has_feature('orders.view') as core`);
  !off[0].f && off[0].core ? ok("invoicing gone, core rights kept") : bad("after off", off);
  const adminOff = await as(admin, `select public.has_feature('invoices.manage') as f, public.my_features() ? 'invoices.manage' as listed`);
  !adminOff[0].f && !adminOff[0].listed ? ok("even the admin loses it, and it leaves my_features") : bad("admin", adminOff);
  const clientOff = await as(U.c1, `select public.my_features() ? 'client.invoices' as listed`);
  !clientOff[0].listed ? ok("client tab Factures gone") : bad("client tab", clientOff);
  await expectOk("admin switches invoicing back on", admin, `select public.admin_set_module('invoicing', true) as r`);
  const on = await as(U.staff, `select public.has_feature('invoices.manage') as f`);
  on[0].f ? ok("right back as before (role setting kept)") : bad("back on", on);

  // Client options: signature required by the client record, until the module is off.
  await db.exec(`update public.clients set custom_settings = array['delivery_signature','scan_delivery_note','scan_client_qr','show_origin'], show_origin = true, delivery_signature = true, scan_delivery_note = false, scan_client_qr = false where id = '${c1}'`);
  const acc = await as(U.c1, `select public.my_account() -> 'client' ->> 'show_origin' as origin`);
  await expectOk("admin switches origin off", admin, `select public.admin_set_module('origin', false) as r`);
  const acc2 = await as(U.c1, `select public.my_account() -> 'client' ->> 'show_origin' as origin`);
  acc[0].origin === "true" && acc2[0].origin === "false" ? ok("client option show_origin counts as off", { before: acc[0].origin }) : bad("origin", acc2);
  await expectOk("origin back on", admin, `select public.admin_set_module('origin', true) as r`);
  const guarded = await one(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc like '%module_enabled(''signature'')%'`);
  guarded.n > 0 ? ok("signature checks guarded in functions", guarded.n) : bad("signature guard", guarded);
  const again = await one(`select public.apply_module_guards() as n`);
  again.n === 0 ? ok("guards are not applied twice") : bad("idempotent", again);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration <= "20261107").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
