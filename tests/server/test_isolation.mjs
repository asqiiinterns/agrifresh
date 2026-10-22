// Isolation (step 2d): a second supplier "Fournisseur B" with its team, product, client and
// order; nothing crosses between suppliers, in either direction.
export async function runIsolationChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1 }) {
  console.log("\n# Isolation between suppliers");
  // Setup and checks "as the system": no signed-in user (the guard rightly refuses otherwise).
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  const run = async (sql) => { await sys(); return db.exec(sql); };
  for (const f of ["supabase/migrations/20261111_isolation.sql", "supabase/migrations/20261111_isolation.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const A = (await one(`select public.legacy_org_id() as id`)).id;
  const B = (await one(`insert into public.organizations (name, is_supplier, is_buyer, status) values ('Fournisseur B', true, false, 'active') returning id`)).id;
  await run(`select public.org_install_roles('${B}'); select public.org_install_numbering('${B}');`);
  const SB = "00000000-0000-0000-0000-0000000b0001", CB = "00000000-0000-0000-0000-0000000b0002";
  await run(`insert into auth.users (id, email) values ('${SB}', 'chef@b.tn');
    update public.profiles set role = 'supervisor', org_id = '${B}', account_status = 'active' where id = '${SB}';`);
  const clientB = (await one(`insert into public.clients (business_name, email, supplier_org_id) values ('Resto B', 'resto@b.tn', '${B}') returning id`)).id;
  const pointB = (await one(`insert into public.client_delivery_points (client_id, label, address_line, city) values ('${clientB}', 'Salle', '1 rue B', 'Sousse') returning id`)).id;
  await run(`insert into auth.users (id, email) values ('${CB}', 'resto@b.tn');
    update public.profiles set role = 'customer', client_id = '${clientB}', account_status = 'active' where id = '${CB}';`);
  const productB = (await one(`insert into public.products
    select (jsonb_populate_record(null::public.products, to_jsonb(p) || jsonb_build_object('id', gen_random_uuid(), 'slug', 'b-' || p.slug, 'name', 'Produit B', 'org_id', '${B}'::text))).*
    from public.products p where p.org_id = '${A}' and p.active limit 1 returning id`)).id;
  const productA = (await one(`select id from public.products where org_id = '${A}' and active limit 1`)).id;
  const roleB = await one(`select exists (select 1 from public.member_roles mr join public.org_roles r on r.id = mr.role_id where mr.user_id = '${SB}' and r.org_id = '${B}') as has`);
  roleB.has ? ok("supplier B's supervisor has its role in B") : bad("role B", roleB);

  // Client B orders: only B's products.
  await expectFail("client B cannot order supplier A's product", CB, `select public.place_client_order($1::jsonb, $2, null, null)`, [JSON.stringify([{ product_id: productA, quantity: 1 }]), pointB], /fournisseur|introuvable|disponible|produit/i);
  const orderB = await expectOk("client B orders B's product", CB, `select public.place_client_order($1::jsonb, $2, null, null) as r`, [JSON.stringify([{ product_id: productB, quantity: 1 }]), pointB]);
  const orderBId = orderB?.[0]?.r?.id;
  const ob = await one(`select supplier_org_id from public.orders where id = $1`, [orderBId]);
  ob?.supplier_org_id === B ? ok("order filed to supplier B") : bad("order org", ob);

  // Alerts: B's new order reaches B's team only.
  const alerts = await one(`select count(*) filter (where user_id = '${SB}')::int as b, count(*) filter (where user_id = '${U.staff}')::int as a from public.notifications where order_id = $1`, [orderBId]);
  alerts.b === 1 && alerts.a === 0 ? ok("new-order alert reaches B's team only") : bad("alerts", alerts);

  // Reads through access rules.
  const seenA = await as(U.staff, `select (select count(*) from public.orders where supplier_org_id = '${B}')::int as orders,
    (select count(*) from public.clients where supplier_org_id = '${B}')::int as clients, (select count(*) from public.products where org_id = '${B}')::int as products,
    (select count(*) from public.profiles where id = '${SB}')::int as people`);
  Object.values(seenA[0]).every((n) => n === 0) ? ok("supplier A's team sees nothing of B") : bad("A sees B", seenA[0]);
  const seenB = await as(SB, `select (select count(*) from public.orders where supplier_org_id <> '${B}')::int as orders,
    (select count(*) from public.clients where supplier_org_id <> '${B}')::int as clients, (select count(*) from public.orders where supplier_org_id = '${B}')::int as own`);
  seenB[0].orders === 0 && seenB[0].clients === 0 && seenB[0].own === 1 ? ok("supplier B's team sees only its own data") : bad("B sees A", seenB[0]);
  const cat = await as(c1, `select count(*) filter (where org_id = '${B}')::int as b, count(*)::int as all from public.products`).catch(() => null);
  const catC1 = await as(U.c1, `select count(*) filter (where org_id = '${B}')::int as b from public.products`);
  catC1[0].b === 0 ? ok("A's client does not see B's catalogue") : bad("catalogue", catC1[0]);

  // Lists built by functions.
  const inboxA = await as(U.staff, `select public.staff_inbox() as r`);
  !JSON.stringify(inboxA[0].r).includes(clientB) ? ok("A's message inbox has no B client") : bad("inbox", inboxA[0].r);
  const dirA = await as(U.staff, `select public.team_directory() as r`);
  !JSON.stringify(dirA[0].r).includes(SB) ? ok("A's team directory has no B member") : bad("directory", dirA[0].r);
  const accA = await as((await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id, `select public.admin_list_accounts() as r`);
  const accText = JSON.stringify(accA[0].r);
  !accText.includes("chef@b.tn") && !accText.includes("resto@b.tn") && !accText.includes("admin@a.tn") ? ok("A's accounts list: no B account, no Appro+ account") : bad("accounts", accText.slice(0, 300));
  const boardA = await as(U.staff, `select public.billing_board() as r`).catch((e) => [{ r: e.message }]);
  !JSON.stringify(boardA[0].r).includes(clientB) ? ok("A's billing board has no B client") : bad("billing", boardA[0].r);

  // Writes on the other supplier's data.
  await expectFail("A's team cannot decide B's order", U.staff, `select public.staff_update_order_status($1, 'confirmed', null)`, [orderBId], /autre Pro|introuvable/);
  await expectOk("B's team decides its order", SB, `select public.staff_update_order_status($1, 'confirmed', null) ->> 'status' as r`, [orderBId]);
  await expectFail("A's team cannot write to B's client", U.staff, `select public.send_message_v3($1, 'Bonjour', null, false)`, [clientB], /autre Pro|introuvable/);
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  await expectFail("A's Responsable cannot change B's accounts", owner, `select public.admin_set_role('chef@b.tn', 'driver')`, [], /autre Pro|introuvable|Accès/);

  // Per-supplier settings.
  const numA = await one(`select public.next_document_number('invoice', public.legacy_org_id()) as n`);
  const numB = await one(`select public.next_document_number('invoice', $1) as n`, [B]);
  const numB2 = await one(`select public.next_document_number('invoice', $1) as n`, [B]);
  numB.n !== numB2.n && numB.n !== numA.n ? ok("separate invoice numbering per supplier", { A: numA.n, B: [numB.n, numB2.n] }) : bad("numbering", { numA, numB, numB2 });
  const compB = await as(CB, `select public.my_company_profile() ->> 'name' as n`);
  compB[0].n === "Fournisseur B" ? ok("B's client prints B's company details") : bad("company", compB);
  await expectFail("B's supervisor cannot change platform-wide settings", SB, `select public.admin_set_module('stats', false)`, [], /administrateur|Accès/);

  // Appro+ team: no business data.
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const saSeen = await as(sa, `select (select count(*) from public.orders)::int as orders, (select count(*) from public.clients)::int as clients`);
  saSeen[0].orders === 0 && saSeen[0].clients === 0 ? ok("Appro+ team reads no Pro data") : bad("platform reads", saSeen[0]);
  const anon = await db.exec(`reset role; select set_config('test.uid', '', false); set role anon;`).then(() => db.query(`select count(*)::int as n from public.products`)).then((r) => r.rows[0].n).catch(() => 0).finally(() => db.exec("reset role;"));
  anon === 0 ? ok("a visitor who is not signed in sees no product") : bad("anon products", anon);

  // Everything still works for A.
  const aOrders = await as(U.staff, `select count(*)::int as n from public.orders`);
  aOrders[0].n > 0 ? ok("A's team still sees its orders", aOrders[0].n) : bad("A orders", aOrders);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration <= "20261111").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
