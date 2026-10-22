// 20261201_role_layouts.sql: home and bottom menu per role of a Pro.
export async function runLayoutsChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Home and menu per role");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261201_role_layouts.sql", "supabase/migrations/20261201_role_layouts.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const role = await one(`select r.id from public.org_roles r join public.role_templates t on t.id = r.template_id where r.org_id = $1 and t.key = 'supplier_driver'`, [L])
    ?? await one(`select r.id from public.org_roles r join public.role_templates t on t.id = r.template_id where r.org_id = $1 and t.key not in ('supplier_owner', 'buyer_owner') and r.side = 'supplier' limit 1`, [L]);
  const member = await one(`select mr.user_id as id from public.member_roles mr join public.profiles pr on pr.id = mr.user_id
    where mr.role_id = $1 and pr.id <> $2 and pr.account_status = 'active' and not exists (
      select 1 from public.member_roles m2 join public.org_roles r2 on r2.id = m2.role_id join public.role_templates t2 on t2.id = r2.template_id
      where m2.user_id = pr.id and t2.key in ('supplier_owner', 'buyer_owner')) limit 1`, [role.id, owner]);
  const home = { tiles: ["shipping", "ready"], shortcuts: ["deliveries"] };
  const menu = { bar: ["deliveries", "messages"] };

  // The module decides (Appro+ plan)
  await sys(); await db.exec(`insert into public.org_modules (org_id, key, granted, enabled) values ('${L}', 'home_custom', false, null)
    on conflict (org_id, key) do update set granted = false`);
  await expectFail("module not in the plan: the administrator cannot", owner, `select public.set_org_role_layout($1, $2::jsonb, $3::jsonb)`, [role.id, JSON.stringify(home), JSON.stringify(menu)], /formule/);
  await expectOk("Appro+ always can", sa, `select public.set_org_role_layout($1, $2::jsonb, null) as r`, [role.id, JSON.stringify(home)]);
  await sys(); await db.exec(`update public.org_modules set granted = true where org_id = '${L}' and key = 'home_custom'`);
  await expectFail("six entries in the bar: refused", owner, `select public.set_org_role_layout($1, null, $2::jsonb)`, [role.id, JSON.stringify({ bar: ["a", "b", "c", "d", "e", "f"] })], /Cinq/);
  await expectOk("the administrator sets the role's home and bar", owner, `select public.set_org_role_layout($1, $2::jsonb, $3::jsonb) as r`, [role.id, JSON.stringify(home), JSON.stringify(menu)]);
  const list = (await as(owner, `select public.org_role_layouts_list() as r`))[0].r;
  list.allowed === true && list.layouts.some((l) => l.role_id === role.id) ? ok("the list shows it (and that it is allowed)") : bad("list", list);

  if (member) {
    await sys(); await db.exec(`update public.profiles set home_layout = null where id = '${member.id}'`);
    const acc = (await as(member.id, `select public.my_account() as r`))[0].r;
    JSON.stringify(acc.home_layout) === JSON.stringify(home) && acc.menu?.bar?.[0] === "deliveries" ? ok("a member of the role gets its home and bar") : bad("member layout", { home: acc.home_layout, menu: acc.menu });
    await sys(); await db.exec(`update public.profiles set home_layout = '{"tiles":["claims"],"shortcuts":[]}'::jsonb where id = '${member.id}'`);
    const own = (await as(member.id, `select public.my_account() as r`))[0].r;
    own.home_layout.tiles[0] === "claims" && JSON.stringify(own.role_home_layout) === JSON.stringify(home) ? ok("its own home comes first; « back to my role's home » is offered") : bad("own layout", own.home_layout);
    await sys(); await db.exec(`update public.profiles set home_layout = null where id = '${member.id}'`);
  } else ok("(no member with this role in the test data)");
  await expectOk("back to the default", owner, `select public.set_org_role_layout($1, null, null) as r`, [role.id]);

  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((r) => r.migration <= "20261201_role_layouts.sql").every((r) => r.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((r) => r.etat !== "OK"));
}
