// 20261124_rights.sql: catalogue, locked display, delegation of roles, Appro+ assisting a Pro.
export async function runRightsChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Rights in cascade");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261124_rights.sql", "supabase/migrations/20261124_rights.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const driver = (await one(`select id from public.profiles where role = 'driver' and org_id = $1 and account_status = 'active' limit 1`, [L])).id;

  const cat = (await as(owner, `select public.rights_catalogue() as r`))[0].r;
  const ov = cat.find((p) => p.key === "orders.view");
  ov?.area === "Commandes" && ov.kind === "read" && cat.every((p) => p.area && p.kind) ? ok("every function has its area and kind", cat.length) : bad("catalogue", cat.filter((p) => !p.area || !p.kind).slice(0, 3));

  // Locked display
  (await as(driver, `select public.has_feature('invoices.manage') as r`))[0].r === false ? ok("the driver has no invoicing") : bad("driver stats", "has");
  let locked = (await as(driver, `select public.my_account() -> 'locked_features' as r`))[0].r;
  !locked.includes("invoices.manage") ? ok("hidden by default") : bad("default display", locked);
  await expectFail("only Appro+ decides the display", owner, `select public.platform_set_feature_display(null, 'invoices.manage', 'locked')`, [], /Appro\+/);
  await expectOk("Appro+ shows Invoicing locked for every Pro", sa, `select public.platform_set_feature_display(null, 'invoices.manage', 'locked') as r`);
  locked = (await as(driver, `select public.my_account() -> 'locked_features' as r`))[0].r;
  locked.includes("invoices.manage") ? ok("the driver sees it locked") : bad("locked", locked);
  await expectOk("but hides it for AgriFresh", sa, `select public.platform_set_feature_display($1, 'invoices.manage', 'hidden') as r`, [L]);
  locked = (await as(driver, `select public.my_account() -> 'locked_features' as r`))[0].r;
  !locked.includes("invoices.manage") ? ok("hidden again for this Pro only") : bad("org display", locked);
  const zLocked = (await as(zitouna, `select public.rights_catalogue() as r`))[0].r.find((p) => p.key === "invoices.manage");
  zLocked.display === "locked" ? ok("Zitouna keeps the default (locked)") : bad("zitouna display", zLocked);

  // Delegation
  const sup = await one(`select r.id from public.org_roles r join public.role_templates t on t.id = r.template_id where r.org_id = $1 and t.key = 'supplier_supervisor'`, [L]);
  const prod = await one(`select r.id from public.org_roles r join public.role_templates t on t.id = r.template_id where r.org_id = $1 and t.key = 'supplier_production'`, [L]);
  const member = await one(`select mr.user_id as id from public.member_roles mr join public.profiles pr on pr.id = mr.user_id where mr.role_id = $1 and pr.account_status = 'active' and pr.id <> $2 limit 1`, [sup?.id, owner]);
  if (sup && prod && member) {
    await expectFail("a supervisor cannot set roles yet", member.id, `select public.org_set_role_permission($1, 'orders.view', true)`, [prod.id], /ne pouvez pas/);
    await expectOk("the Responsable delegates the roles to the supervisors", owner, `select public.org_set_role_permission($1, 'roles.manage', true) as r`, [sup.id]);
    const has = (await as(member.id, `select public.has_feature('orders.view') as a, public.has_feature('invoices.manage') as b`))[0];
    await expectOk("a supervisor now gives a right it has", member.id, `select public.org_set_role_permission($1, 'orders.view', true) as r`, [prod.id]);
    if (!has.b) await expectFail("never one it does not have", member.id, `select public.org_set_role_permission($1, 'invoices.manage', true)`, [prod.id], /que vous n’avez pas/);
    else ok("(this supervisor has every right in the test data)");
    await expectFail("nor the Responsable role", member.id, `select public.org_set_role_permission((select r.id from public.org_roles r join public.role_templates t on t.id = r.template_id where r.org_id = $1 and t.key = 'supplier_owner'), 'orders.view', true)`, [L], /Appro\+/);
  } else ok("(no supervisor member in the test data)");

  // Appro+ assisting Zitouna
  await expectFail("a Pro cannot assist another", owner, `select public.platform_start_assist($1)`, [Z], /Appro\+/);
  const product = await one(`select id, price from public.products where org_id = $1 limit 1`, [Z]);
  await as(sa, `update public.products set price = price + 1 where id = $1`, [product.id]).catch(() => null);
  Number((await one(`select price from public.products where id = $1`, [product.id])).price) === Number(product.price) ? ok("Appro+ does not change a Pro's data on its own") : bad("platform write", "changed");
  await expectOk("Appro+ starts assisting Zitouna (reading)", sa, `select public.platform_start_assist($1, false, 'Aide au paramétrage') ->> 'org_name' as r`, [Z]);
  const acc = (await as(sa, `select public.my_account() as r`))[0].r;
  acc.role === "admin" && acc.assisting?.org_name === "Épicerie Zitouna" && acc.assisting.can_edit === false ? ok("it appears as the Pro's administrator, reading", acc.features.length) : bad("assisting account", { role: acc.role, a: acc.assisting });
  const reads = (await as(sa, `select public.has_feature('orders.view') as v, public.has_feature('orders.decide') as d, public.current_org_id() as org`))[0];
  reads.v && !reads.d && reads.org === Z ? ok("reading functions only") : bad("read assist", reads);
  const seen = await as(sa, `select count(*)::int as n from public.orders`);
  seen[0].n > 0 ? ok("it sees the Pro's orders", seen[0].n) : bad("orders seen", seen);
  await as(sa, `update public.products set price = price + 1 where id = $1`, [product.id]).catch(() => null);
  Number((await one(`select price from public.products where id = $1`, [product.id])).price) === Number(product.price) ? ok("reading only: no change") : bad("read assist write", "changed");
  const told = await one(`select count(*)::int as n from public.notifications where user_id = $1 and event = 'platform.assist'`, [zitouna]);
  told.n > 0 ? ok("Zitouna's Responsable is told") : bad("told", told);
  await expectOk("assisting with changes", sa, `select public.platform_start_assist($1, true, 'Correction des prix') ->> 'org_name' as r`, [Z]);
  await expectOk("it changes a price", sa, `update public.products set price = price + 1 where id = $1 returning price`, [product.id]);
  const log = await one(`select count(*)::int as n from public.audit_log where org_id = $1 and actor_id = $2`, [Z, sa]);
  log.n > 0 ? ok("the change is in Zitouna's journal, under its name", log.n) : bad("journal", log);
  const visible = await as(zitouna, `select count(*)::int as n from public.audit_log where actor_id = $1`, [sa]);
  const zAudit = (await as(zitouna, `select public.has_feature('audit.view') as r`))[0].r;
  !zAudit || visible[0].n > 0 ? ok("and Zitouna sees it in its journal") : bad("zitouna sees", visible);
  const lp = await one(`select id, price from public.products where org_id = $1 limit 1`, [L]);
  await as(sa, `update public.products set price = price + 5 where id = $1`, [lp.id]).catch(() => null);
  Number((await one(`select price from public.products where id = $1`, [lp.id])).price) === Number(lp.price) ? ok("never in another Pro") : bad("other pro write", "changed");
  await expectOk("the assistance ends", sa, `select public.platform_stop_assist() as r`);
  const after = (await as(sa, `select public.my_account() as r`))[0].r;
  after.role === "platform" && !after.assisting ? ok("back to the Appro+ console") : bad("after", after.role);
  await sys(); await db.exec(`update public.products set price = ${Number(product.price)} where id = '${product.id}'`);
  // Rights per account (20261125)
  for (const f of ["supabase/migrations/20261125_rights_accounts.sql", "supabase/migrations/20261125_rights_accounts.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const people = (await as(owner, `select public.org_members_rights() as r`))[0].r;
  const d = people.find((p) => p.id === driver);
  d && Array.isArray(d.granted) ? ok("the rights of every account in one call", people.length) : bad("members rights", people.slice(0, 1));
  const first = d.granted[0];
  await expectOk("an exception for one person (removed)", owner, `select public.org_set_member_permission($1, $2, false) as r`, [driver, first]);
  const d2 = (await as(owner, `select public.org_members_rights() as r`))[0].r.find((p) => p.id === driver);
  !d2.granted.includes(first) && d2.overrides[first] === false ? ok("taken into account at once", first) : bad("override", d2);
  await expectOk("back to its roles", owner, `select public.org_set_member_permission($1, $2, null) as r`, [driver, first]);
  await expectFail("nobody sets its own rights", owner, `select public.org_set_member_permission($1, 'orders.view', true)`, [owner], /propres droits/);
  await expectFail("another Pro cannot", zitouna, `select public.org_set_member_permission($1, 'orders.view', true)`, [driver], /ne pouvez pas/);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration <= "20261125_rights_accounts.sql").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
