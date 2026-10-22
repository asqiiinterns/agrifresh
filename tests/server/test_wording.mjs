// 20261203_wording.sql: « notification » in the server messages.
export async function runWordingChecks({ db, file, ok, bad }) {
  console.log("\n# Wording");
  for (const f of ["supabase/migrations/20261203_wording.sql", "supabase/migrations/20261203_wording.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  await db.exec(`reset role; select set_config('test.uid', '', false);`);
  const left = (await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~* '''[^'']*alerte'`)).rows.map((r) => r.proname);
  left.length === 0 ? ok("no server message says « alerte » any more") : bad("alerte left", left);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((r) => r.migration <= "20261203_wording.sql").every((r) => r.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((r) => r.etat !== "OK"));
}
