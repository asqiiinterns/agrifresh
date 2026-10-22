// 20261206_client_errors.sql: errors of the application recorded for Appro+.
export async function runErrorsChecks({ db, file, ok, bad, as, expectFail }) {
  console.log("\n# Application errors");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261206_client_errors.sql", "supabase/migrations/20261206_client_errors.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const report = JSON.stringify({ screen: "admin", message: "TypeError: x is not a function", stack: "at A\nat B", component_stack: "in AccountsPage", platform: "web", app_version: "1.0.0" });
  await as(owner, `select public.log_client_error($1::jsonb)`, [report]);
  await as(owner, `select public.log_client_error($1::jsonb)`, [report]);
  await as(owner, `select public.log_client_error('"not an object"'::jsonb)`);
  const stored = await one(`select count(*)::int as n, max(occurrences) as occ, max(org_id::text) as org from public.client_errors`);
  stored.n === 1 && stored.occ === 2 && stored.org ? ok("an error is recorded once and counted when it repeats", stored) : bad("stored", stored);
  try { (await as(owner, `select count(*)::int as n from public.client_errors`))[0].n === 0 ? ok("nobody reads the table directly") : bad("direct read", ""); }
  catch (e) { /permission denied/.test(e.message) ? ok("nobody reads the table directly (refused)") : bad("direct read", e.message); }
  await expectFail("a Pro cannot read the errors", owner, `select public.platform_client_errors()`, [], /Appro\+/);
  const list = (await as(sa, `select public.platform_client_errors() as r`))[0].r;
  list.length === 1 && list[0].screen === "admin" && list[0].user && list[0].org_name ? ok("Appro+ reads them with the account and its Pro", list[0].user) : bad("list", list);
  await expectFail("a Pro cannot mark them treated", owner, `select public.platform_resolve_client_error(null)`, [], /Appro\+/);
  await as(sa, `select public.platform_resolve_client_error($1)`, [list[0].id]);
  (await as(sa, `select public.platform_client_errors() as r`))[0].r.length === 0 && (await as(sa, `select public.platform_client_errors(true) as r`))[0].r.length === 1
    ? ok("treated errors leave the list, still visible with « Toutes »") : bad("resolve", "");
  const anon = await one(`select has_function_privilege('anon', 'public.platform_client_errors(boolean)', 'execute') as a`);
  anon.a === false ? ok("not readable without an account") : bad("anon", anon);

  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((r) => r.migration <= "20261206_client_errors.sql").every((r) => r.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((r) => r.etat !== "OK"));
}
