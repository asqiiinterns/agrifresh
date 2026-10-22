// Roles (step 2a): the new engine gives exactly today's rights, account by account, right by right.
export async function runRoleChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1 }) {
  console.log("\n# Roles (new engine next to the current one)");
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  // A few personal exceptions and a client-record option, to make the comparison meaningful.
  await db.exec(`insert into public.user_permissions (user_id, feature, allowed) values ('${U.driver}', 'stats.view', true) on conflict (user_id, feature) do update set allowed = excluded.allowed`);
  await db.exec(`update public.clients set feature_overrides = '{"client.recurring": false}'::jsonb where id = '${c1}'`);
  for (const f of ["supabase/migrations/20261109_roles.sql", "supabase/migrations/20261109_roles.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const sa = await one(`select count(*)::int as n from public.platform_members where role = 'superadmin'`);
  sa.n >= 1 ? ok("super-admin listed in the Appro+ team") : bad("platform", sa);
  const roles = await one(`select count(*)::int as n from public.org_roles where org_id = public.legacy_org_id()`);
  roles.n === 7 ? ok("original supplier has the 7 supplier roles") : bad("supplier roles", roles);
  const perms = (await db.query(`select key, side from public.permissions order by key`)).rows;
  const users = (await db.query(`select id, role::text as role from public.profiles where account_status = 'active' and (role <> 'customer' or client_id is not null)`)).rows;
  let compared = 0; const diffs = [];
  for (const u of users) {
    const list = u.role === "admin" ? perms.filter((p) => p.side === "supplier") : perms;
    const rows = await as(u.id, `select p.key, public.has_feature_base(p.key) as old, public.has_permission(p.key) as new from unnest($1::text[]) as p(key)`, [list.map((p) => p.key)]).catch(() => null);
    if (!rows) { // has_feature_base is not executable by users: compare as the owner, impersonating the user.
      await db.exec(`select set_config('test.uid', '${u.id}', false)`);
      const r2 = (await db.query(`select p.key, public.has_feature_base(p.key) as old, public.has_permission(p.key) as new from unnest($1::text[]) as p(key)`, [list.map((p) => p.key)])).rows;
      for (const r of r2) { compared++; if (r.old !== r.new) diffs.push(`${u.role}:${r.key} old=${r.old} new=${r.new}`); }
    } else {
      for (const r of rows) { compared++; if (r.old !== r.new) diffs.push(`${u.role}:${r.key} old=${r.old} new=${r.new}`); }
    }
  }
  await db.exec(`select set_config('test.uid', '', false)`);
  diffs.length === 0 ? ok(`same rights for every account (${users.length} accounts, ${compared} checks)`) : bad("rights differ", diffs.slice(0, 15));
  const sup = await as(U.staff, `select public.platform_role() as r, public.platform_can('platform.pros.validate') as v`);
  sup[0].r === null && !sup[0].v ? ok("a Pro account has no platform right") : bad("platform leak", sup);
  const admin = (await one(`select id from public.profiles where role = 'admin' limit 1`)).id;
  const pa = await as(admin, `select public.platform_role() as r, public.platform_can('platform.pros.validate') as v`);
  pa[0].r === "superadmin" && pa[0].v ? ok("super-admin has the platform rights") : bad("superadmin platform", pa);
  const trans = await one(`select count(*)::int as n from public.member_roles mr where mr.user_id = $1 and mr.transitional`, [admin]);
  trans.n === 1 ? ok("super-admin runs the original supplier transitionally (until its owner is named)") : bad("transitional", trans);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration <= "20261109").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
