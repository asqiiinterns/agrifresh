// Onboarding (step 2c): a new Pro signs up, waits, is validated; roles managed by Appro+ and the Responsable.
export async function runOnboardingChecks({ db, file, ok, bad, as, expectOk, expectFail, U }) {
  console.log("\n# Pro onboarding and roles");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  const run = async (sql) => { await sys(); return db.exec(sql); };
  for (const f of ["supabase/migrations/20261112_pro_onboarding.sql", "supabase/migrations/20261112_pro_onboarding.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const X = "00000000-0000-0000-0000-0000000c0001", Y = "00000000-0000-0000-0000-0000000c0002";
  await run(`insert into auth.users (id, email) values ('${X}', 'gerant@epicerie.tn'), ('${Y}', 'vendeur@epicerie.tn');`);
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;

  await expectFail("a Pro needs a name", X, `select public.register_pro('{"name":"","is_supplier":true}'::jsonb)`, [], /nom/);
  const reg = await expectOk("a new account creates its Pro (supplier and buyer)", X, `select public.register_pro('{"name":"Épicerie Zitouna","is_supplier":true,"is_buyer":true,"phone":"71 000 000"}'::jsonb) as r`);
  const Z = reg?.[0]?.r;
  const pend = await as(X, `select public.my_pro() ->> 'status' as s, public.has_feature('products.manage') as p`);
  pend[0].s === "pending" && !pend[0].p ? ok("waiting for Appro+, no rights yet") : bad("pending", pend);
  await expectFail("cannot register twice", X, `select public.register_pro('{"name":"Autre","is_buyer":true}'::jsonb)`, [], /appartient déjà/);
  await expectFail("a Pro cannot validate itself", X, `select public.platform_set_pro_status($1, 'active')`, [Z], /Appro\+/);
  await expectOk("Appro+ validates the Pro", sa, `select public.platform_set_pro_status($1, 'active') as r`, [Z]);
  const act = await as(X, `select public.my_pro() ->> 'status' as s, public.has_feature('products.manage') as p, public.has_feature('client.order') as buy`);
  act[0].s === "active" && act[0].p && act[0].buy ? ok("validated: the Responsable manages products and can buy") : bad("active", act);
  const tpl = (await one(`select to_jsonb(p) - 'org_id' as j from public.products p limit 1`)).j;
  const row = { ...tpl, id: "00000000-0000-0000-0000-0000000c00aa", slug: "z-huile", name: "Huile Zitouna" };
  const prod = await as(X, `insert into public.products select * from jsonb_populate_record(null::public.products, $1::jsonb) returning org_id`, [JSON.stringify(row)]).catch((e) => [{ org_id: e.message }]);
  prod[0].org_id === Z ? ok("its products belong to its Pro") : bad("product org", prod);
  const seenA = await as(U.staff, `select count(*)::int as n from public.products where name = 'Huile Zitouna'`);
  seenA[0].n === 0 ? ok("other suppliers do not see them") : bad("product leak", seenA);

  // Roles: Appro+ decides whether the Pro edits its roles; the Responsable assigns them.
  const m = await as(X, `select public.org_roles_matrix() as r`);
  const matrix = m[0].r;
  matrix.roles.length === 12 && matrix.can_edit === false ? ok("roles screen: 12 roles (supplier + buyer), not editable yet") : bad("matrix", { n: matrix.roles.length, edit: matrix.can_edit });
  const sales = matrix.roles.find((r) => r.template_key === "supplier_sales");
  await expectFail("the Responsable cannot edit roles unless allowed", X, `select public.org_set_role_permission($1, 'stats.view', true)`, [sales.id], /ne pouvez pas/);
  await expectOk("Appro+ edits the role for the Pro", sa, `select public.org_set_role_permission($1, 'stats.view', true) as r`, [sales.id]);
  await expectOk("Appro+ allows the Pro to edit its roles", sa, `select public.platform_set_pro_profile($1, true, true, true) as r`, [Z]);
  await expectOk("the Responsable now edits a role", X, `select public.org_set_role_permission($1, 'audit.view', true) as r`, [sales.id]);
  await expectFail("a buyer right cannot go into a supplier role", X, `select public.org_set_role_permission($1, 'client.order', true)`, [sales.id], /ne concerne pas/);
  const custom = await expectOk("a role made to measure, from Commercial", X, `select public.org_create_role(null, 'Commercial senior', 'supplier', $1) as r`, [sales.id]);

  await expectOk("the Responsable adds a colleague to its team", X, `select public.admin_set_role('vendeur@epicerie.tn', 'supervisor') as r`);
  const y = await one(`select org_id from public.profiles where id = $1`, [Y]);
  y.org_id === Z ? ok("the colleague joins the Responsable's Pro") : bad("team join", y);
  await run(`update public.profiles set account_status = 'active' where id = '${Y}'`);
  await expectOk("gives the colleague the made-to-measure role", X, `select public.org_set_member_role($1, $2, true) as r`, [Y, custom[0].r]);
  const seeAs = await as(X, `select public.org_member_permissions($1) as r`, [Y]);
  seeAs[0].r.includes("audit.view") && seeAs[0].r.includes("stats.view") ? ok("« see as »: the colleague's real rights", seeAs[0].r.length) : bad("see as", seeAs[0].r);
  const ownerRole = matrix.roles.find((r) => r.template_key === "supplier_owner").id;
  await expectFail("cannot remove one's own Responsable role", X, `select public.org_set_member_role($1, $2, false)`, [X, ownerRole], /propre rôle/);
  await expectFail("another Pro cannot read these roles", owner, `select public.org_roles_matrix($1)`, [Z], /Réservé/);
  await expectFail("another Pro cannot assign these roles", owner, `select public.org_set_member_role($1, $2, true)`, [Y, ownerRole], /ne pouvez pas/);

  // Suspension.
  await expectOk("Appro+ suspends the Pro", sa, `select public.platform_set_pro_status($1, 'suspended') as r`, [Z]);
  const susp = await as(X, `select public.has_feature('products.manage') as p, public.current_org_id() as o, (select count(*) from public.products where org_id = '${Z}')::int as n`);
  !susp[0].p && susp[0].o === null && susp[0].n === 0 ? ok("a suspended Pro cannot work (data kept)") : bad("suspended", susp);
  const kept = await one(`select count(*)::int as n from public.products where org_id = $1`, [Z]);
  kept.n === 1 ? ok("its data is kept") : bad("kept", kept);
  await expectFail("the original supplier cannot be suspended", sa, `select public.platform_set_pro_status(public.legacy_org_id(), 'suspended')`, [], /premier fournisseur/);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration <= "20261112").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}

export async function runPlatformProChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Appro+ creates and manages Pros");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  await expectFail("a private person cannot be a supplier", sa, `select public.platform_save_pro(null, '{"name":"Mme Ben Ali","kind":"person","is_supplier":true}'::jsonb)`, [], /particulier/);
  const p = await expectOk("Appro+ creates a private buyer with its future owner's e-mail", sa,
    `select public.platform_save_pro(null, '{"name":"Mme Ben Ali","kind":"person","is_buyer":true,"owner_email":"mme.benali@x.tn"}'::jsonb) as r`);
  const P = p?.[0]?.r;
  const W = "00000000-0000-0000-0000-0000000d0001";
  await sys(); await db.exec(`insert into auth.users (id, email) values ('${W}', 'Mme.BenAli@x.tn')`);
  const w = await one(`select org_id, role::text as role, account_status from public.profiles where id = $1`, [W]);
  w.org_id === P && w.role === "admin" && w.account_status === "active" ? ok("her sign-up attaches her to her Pro as Responsable") : bad("attach on sign-up", w);
  const card = await as(sa, `select public.platform_pro($1) as r`, [P]);
  card[0].r.kind === "person" && card[0].r.members.length === 1 ? ok("Appro+ sees the full card") : bad("card", card[0].r);
  await expectOk("Appro+ edits it (details, activities)", sa, `select public.platform_save_pro($1, '{"name":"Mme Ben Ali","kind":"person","is_buyer":true,"phone":"22 000 000"}'::jsonb) as r`, [P]);
  await expectFail("an owner e-mail of another Pro is refused", sa, `select public.platform_save_pro($1, '{"name":"Mme Ben Ali","kind":"person","is_buyer":true,"owner_email":"admin@agrifresh.tn"}'::jsonb)`, [P], /autre Pro/);
  const m = await as(sa, `select jsonb_array_length(public.org_roles_matrix($1) -> 'roles') as n`, [P]);
  m[0].n === 5 ? ok("its buyer roles are managed by Appro+", m[0].n) : bad("roles", m);
}

export async function runPlatformSettingsChecks({ db, file, ok, bad, as, expectOk, expectFail, U }) {
  console.log("\n# Appro+ platform settings");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  await expectOk("super-admin switches a module", sa, `select public.admin_set_module('stats', false) as r`);
  await expectOk("and back", sa, `select public.admin_set_module('stats', true) as r`);
  await expectOk("super-admin reads alert/e-mail settings", sa, `select public.admin_email_status() is not null as r`);
  const t = await as(sa, `select jsonb_array_length(public.platform_templates() -> 'templates') as n`);
  t[0].n === 12 ? ok("12 role templates") : bad("templates", t);
  const sup = await one(`select pr.id from public.profiles pr where pr.role = 'supervisor' and pr.org_id = public.legacy_org_id() and pr.account_status = 'active' limit 1`);
  const before = (await as(sup.id, `select public.has_feature('fleet.manage') as f`))[0].f;
  await expectOk("super-admin changes the Superviseur template", sa, `select public.platform_set_template_permission('supplier_supervisor', 'fleet.manage', $1) as r`, [!before]);
  const after = (await as(sup.id, `select public.has_feature('fleet.manage') as f`))[0].f;
  after === before ? ok("a Pro role with its own setting keeps it (stored difference wins)", { before, after }) : ok("roles following the template change with it", { before, after });
  await expectFail("a Pro cannot change templates", U.staff, `select public.platform_set_template_permission('supplier_supervisor', 'fleet.manage', true)`, [], /super-admin/);
  const acc = await as(sa, `select jsonb_array_length(public.platform_accounts('')) as n, jsonb_array_length(public.platform_accounts('agrifresh')) as f`);
  acc[0].n > 5 && acc[0].f >= 1 ? ok("every account, with search", acc[0]) : bad("accounts", acc);
  await expectOk("super-admin suspends an account", sa, `select public.platform_set_account_status($1, 'suspended') as r`, [U.c2]);
  await expectOk("and reactivates it", sa, `select public.platform_set_account_status($1, 'active') as r`, [U.c2]);
}

export async function runAccountRoutingChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# New accounts: Appro+ or the right supplier, never a mix");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const F = "00000000-0000-0000-0000-0000000e0001", K = "00000000-0000-0000-0000-0000000e0002";
  await sys();
  await db.exec(`insert into public.clients (business_name, email, supplier_org_id) values ('Café Kram', 'kram@x.tn', public.legacy_org_id());`);
  await db.exec(`insert into auth.users (id, email) values ('${F}', 'inconnu@x.tn'), ('${K}', 'kram@x.tn');
    update public.profiles set account_status = 'pending' where id in ('${F}', '${K}');`);
  const notes = await one(`select
      count(*) filter (where user_id = '${sa}' and body like 'inconnu@x.tn%')::int as sa_free,
      count(*) filter (where user_id = '${owner}' and body like 'inconnu@x.tn%')::int as owner_free,
      count(*) filter (where user_id = '${owner}' and body like 'kram@x.tn%')::int as owner_client,
      count(*) filter (where user_id = '${sa}' and body like 'kram@x.tn%')::int as sa_client
    from public.notifications where event = 'account.pending'`);
  notes.sa_free === 1 && notes.owner_free === 0 ? ok("a free sign-up alerts Appro+, not AgriFresh") : bad("free sign-up alert", notes);
  notes.owner_client === 0 && notes.sa_client === 1 ? ok("a client sign-up alerts Appro+ too (a Pro never manages other Pros' accounts)") : bad("client sign-up alert", notes);
  const list = await as(owner, `select public.admin_list_accounts() as r`);
  const text = JSON.stringify(list[0].r);
  !text.includes("inconnu@x.tn") && !text.includes("kram@x.tn") ? ok("AgriFresh's accounts: its own team only") : bad("AgriFresh list", text.slice(0, 200));
  await expectFail("AgriFresh cannot validate a free sign-up", owner, `select public.admin_set_account_status($1, 'active')`, [F], /Appro\+|introuvable|Accès/);
  const pa = await as(sa, `select public.platform_accounts('inconnu') as r`);
  pa[0].r.length === 1 ? ok("Appro+ finds and validates it") : bad("platform list", pa);
  await expectOk("Appro+ validates the free sign-up", sa, `select public.platform_set_account_status($1, 'active') as r`, [F]);
  await expectFail("AgriFresh cannot validate its client's account either", owner, `select public.admin_set_account_status($1, 'active')`, [K], /Appro\+|équipe/);
  const kramPro = await as(owner, `insert into public.clients (business_name, email) values ('Bar Neuf', 'barneuf@x.tn') returning buyer_org_id`);
  const st = await one(`select status from public.organizations where id = $1`, [kramPro[0].buyer_org_id]);
  st.status === "pending" ? ok("a client record created by a supplier waits for Appro+") : bad("buyer Pro status", st);
}
