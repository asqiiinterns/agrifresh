// Team built by a Pro's Responsable within Appro+'s frame; spaces (supplier / buyer, several Pros).
export async function runTeamSpaceChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Team within Appro+'s frame, and spaces");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const X = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  const R = (await one(`select u.id from auth.users u where lower(u.email) = 'chef@resto-medina.tn'`)).id;
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  const roles = (await as(X, `select public.org_roles_matrix() as r`))[0].r.roles;
  const owner = roles.find((r) => r.template_key === "supplier_owner");
  const sales = roles.find((r) => r.template_key === "supplier_sales");
  const V = "00000000-0000-0000-0000-0000000f0002";
  await sys(); await db.exec(`insert into auth.users (id, email) values ('${V}', 'vendeuse@epicerie.tn'); update public.profiles set account_status = 'active' where id = '${V}';`);

  await expectOk("the Responsable adds a collaborator with a role", X, `select public.org_add_member('vendeuse@epicerie.tn', $1) as r`, [sales.id]);
  const vr = await as(V, `select public.has_feature('orders.view') as o, public.has_feature('products.manage') as p`);
  vr[0].o && !vr[0].p ? ok("the collaborator has the Commercial rights only") : bad("collaborator rights", vr);
  await expectFail("the Responsable cannot edit its own Responsable role", X, `select public.org_set_role_permission($1, 'stats.view', false)`, [owner.id], /réglé par Appro\+/);
  await expectOk("Appro+ closes statistics to this Pro (its Responsable role)", sa, `select public.org_set_role_permission($1, 'stats.view', false) as r`, [owner.id]);
  await expectFail("the Responsable cannot open what Appro+ closed", X, `select public.org_set_role_permission($1, 'stats.view', true)`, [sales.id], /dépasse/);
  await expectOk("but configures within the frame", X, `select public.org_set_role_permission($1, 'calendar.view', false) as r`, [sales.id]);
  const capped = await as(V, `select public.has_feature('stats.view') as s, public.has_feature('calendar.view') as c`);
  !capped[0].s && !capped[0].c ? ok("closed by Appro+ = closed for the whole team, even if a role had it") : bad("ceiling", capped);

  // A client elsewhere becomes a collaborator here: one more space.
  await expectOk("the restaurant's Responsable joins Zitouna's sales team", X, `select public.org_add_member('chef@resto-medina.tn', $1) as r`, [sales.id]);
  const spaces = await as(R, `select public.my_spaces() as r`);
  spaces[0].r.length === 2 && spaces[0].r.some((s) => s.current && s.mode === "buyer") ? ok("two spaces, still in the buyer one", spaces[0].r.map((s) => `${s.org_name}·${s.mode}`)) : bad("spaces", spaces[0].r);
  await expectOk("switches to the supplier space", R, `select public.switch_space($1, 'supplier') as r`, [Z]);
  const sup = await as(R, `select public.has_feature('orders.view') as staff, public.has_feature('client.order') as buy, (select count(*) from public.orders where supplier_org_id <> '${Z}')::int as others`);
  sup[0].staff && !sup[0].buy && sup[0].others === 0 ? ok("supplier space: Zitouna's team rights, Zitouna's data only") : bad("supplier space", sup);
  const resto = (await one(`select id from public.organizations where name = 'Resto Médina'`)).id;
  await expectOk("back to the buyer space", R, `select public.switch_space($1, 'buyer') as r`, [resto]);
  const buy = await as(R, `select public.has_feature('orders.view') as staff, public.has_feature('client.order') as buy`);
  !buy[0].staff && buy[0].buy ? ok("buyer space: buyer rights only") : bad("buyer space", buy);
  await expectFail("cannot open someone else's space", R, `select public.switch_space(public.legacy_org_id(), 'supplier')`, [], /pas le vôtre/);
  const xs = await as(X, `select public.my_spaces() as r`);
  xs[0].r.filter((s) => s.org_id === Z).length === 2 ? ok("a supplier and buyer Pro's Responsable has both modes") : bad("dual", xs[0].r);
  await expectOk("the Responsable removes the collaborator", X, `select public.org_remove_member($1) as r`, [V]);
  const gone = await one(`select org_id from public.profiles where id = $1`, [V]);
  gone.org_id === null ? ok("removed from the team (account kept)") : bad("remove", gone);
}
