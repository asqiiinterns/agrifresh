// Switch (step 2b): rights come from roles; nothing changes for AgriFresh accounts; the Appro+
// team leaves every Pro; Paramétrage changes still apply.
export async function runSwitchChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1 }) {
  console.log("\n# Switch to roles");
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const users = (await db.query(`select pr.id, pr.role::text as role, u.email from public.profiles pr join auth.users u on u.id = pr.id
    where pr.account_status = 'active' and not pr.is_superadmin and (pr.role <> 'customer' or pr.client_id is not null)`)).rows;
  const before = {};
  for (const u of users) before[u.id] = (await as(u.id, `select public.my_features() as f`))[0].f;
  for (const f of ["supabase/migrations/20261110_1_platform_profile.sql", "supabase/migrations/20261110_2_switch.sql", "supabase/migrations/20261110_2_switch.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const changed = [];
  for (const u of users) {
    const after = (await as(u.id, `select public.my_features() as f`))[0].f;
    // An administrator used to get the client-space rights too (never shown to the team): ignored.
    const keep = (list) => u.role === "admin" ? list.filter((f) => !f.startsWith("client.")) : list;
    if (JSON.stringify(keep(after)) !== JSON.stringify(keep(before[u.id]))) changed.push({ email: u.email, before: before[u.id], after });
  }
  changed.length === 0 ? ok(`same tabs and rights for every account after the switch (${users.length})`) : bad("rights changed", changed.slice(0, 3));
  const sa = await one(`select pr.id, pr.role::text as role, pr.org_id from public.profiles pr join auth.users u on u.id = pr.id where lower(u.email) = 'admin@a.tn'`);
  sa.role === "platform" && sa.org_id === null ? ok("admin@a.tn: platform profile, outside every Pro") : bad("platform profile", sa);
  const saf = await as(sa.id, `select public.my_features() as f, public.is_staff() as staff, public.is_admin() as admin`);
  saf[0].f.length === 0 && !saf[0].staff && !saf[0].admin ? ok("super-admin: no supplier or client right") : bad("super-admin rights", saf);
  await expectFail("super-admin cannot read AgriFresh's orders as staff", sa.id, `select public.staff_update_order_status(gen_random_uuid(), 'confirmed', null)`, [], /équipe du fournisseur|introuvable|Accès/);
  const team = await as(sa.id, `select jsonb_array_length(public.platform_team()) as n, jsonb_array_length(public.platform_pros()) as pros`);
  team[0].n >= 1 && team[0].pros >= 2 ? ok("Appro+ console: team and Pros", team[0]) : bad("console", team);
  await expectFail("a Pro account cannot open the Appro+ console", U.staff, `select public.platform_pros()`, [], /Appro\+/);
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  await expectFail("the AgriFresh owner cannot join the Appro+ team", sa.id, `select public.platform_set_member('admin@agrifresh.tn', 'support')`, [], /appartient à un Pro/);
  // Paramétrage (old screens) still drives the rights.
  const sup = await one(`select pr.id from public.profiles pr where pr.role = 'supervisor' and pr.org_id = public.legacy_org_id() and pr.account_status = 'active' limit 1`);
  const had = (await as(sup.id, `select public.has_feature('stats.view') as f`))[0].f;
  await expectOk("owner changes the Superviseur profile in Paramétrage", owner, `select public.admin_set_permission('supervisor', 'stats.view', $1) as r`, [!had]);
  const now = (await as(sup.id, `select public.has_feature('stats.view') as f`))[0].f;
  now === !had ? ok("supervisor's right follows Paramétrage") : bad("profile change", { had, now });
  await expectOk("owner sets a personal exception", owner, `select public.admin_set_user_permission($1, 'stats.view', $2) as r`, [sup.id, had]);
  const ex = (await as(sup.id, `select public.has_feature('stats.view') as f`))[0].f;
  ex === had ? ok("personal exception applies") : bad("exception", ex);
  await expectOk("module still wins", owner, `select public.admin_set_module('stats', false) as r`);
  const mod = (await as(sup.id, `select public.has_feature('stats.view') as f`))[0].f;
  !mod ? ok("module off hides it even with the exception") : bad("module", mod);
  await expectOk("module back on", owner, `select public.admin_set_module('stats', true) as r`);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration <= "20261110_9").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
