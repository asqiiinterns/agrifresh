// Directory of validated Pros, links asked and accepted, buyers with several suppliers.
export async function runDirectoryChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Directory and links");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261113_directory.sql", "supabase/migrations/20261113_directory.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  // A buyer-only Pro (restaurant), validated by Appro+.
  const R = "00000000-0000-0000-0000-0000000f0001";
  await sys(); await db.exec(`insert into auth.users (id, email) values ('${R}', 'chef@resto-medina.tn')`);
  const org = await as(R, `select public.register_pro('{"name":"Resto Médina","is_buyer":true,"address":"5 rue de la Kasbah"}'::jsonb) as r`);
  const RO = org[0].r;
  await expectOk("Appro+ validates the restaurant", sa, `select public.platform_set_pro_status($1, 'active') as r`, [RO]);
  const prof = await one(`select role::text as role, account_status from public.profiles where id = $1`, [R]);
  prof.role === "customer" && prof.account_status === "active" ? ok("a buyer-only Pro's Responsable is a client account") : bad("buyer owner", prof);

  const dir = await as(R, `select public.pro_directory('suppliers', '') as r`);
  const agri = dir[0].r.find((p) => p.is_supplier && p.name);
  dir[0].r.every((p) => p.is_supplier) && agri ? ok("the buyer finds validated suppliers", dir[0].r.length) : bad("directory", dir[0].r);
  const notSupplier = await as(R, `select public.pro_directory('clients', '')`).catch((e) => e.message);
  /activité/.test(String(notSupplier)) ? ok("a buyer cannot look for clients") : bad("wrong side", notSupplier);
  const legacy = (await one(`select public.legacy_org_id() as id`)).id;
  const link = await expectOk("the buyer asks AgriFresh to be its supplier", R, `select public.pro_link_request($1, 'buyer') as r`, [legacy]);
  const L = link?.[0]?.r;
  const before = await as(R, `select public.my_suppliers() as r`);
  before[0].r.length === 0 ? ok("no supplier to order from until accepted") : bad("before accept", before);
  await expectFail("the buyer cannot accept its own request", R, `select public.pro_link_respond($1, true)`, [L], /Aucune demande/);
  const links = await as(owner, `select public.my_links() as r`);
  links[0].r.clients.some((c) => c.client_id === L && c.to_answer) ? ok("AgriFresh sees the request to answer") : bad("my_links", links[0].r);
  await expectOk("AgriFresh accepts", owner, `select public.pro_link_respond($1, true) as r`, [L]);
  const rec = await one(`select active, link_status, (select count(*) from public.client_delivery_points dp where dp.client_id = c.id)::int as points from public.clients c where id = $1`, [L]);
  rec.active && rec.link_status === "active" && rec.points === 1 ? ok("link active, delivery point created from the buyer's address") : bad("accepted link", rec);
  const sup = await as(R, `select public.my_suppliers() as r, public.has_feature('client.order') as can`);
  sup[0].r.length === 1 && sup[0].r[0].current && sup[0].can ? ok("the buyer works with AgriFresh and can order") : bad("after accept", sup[0]);
  const prods = await as(R, `select count(*)::int as n, count(distinct org_id)::int as orgs from public.products where active`);
  prods[0].n > 0 && prods[0].orgs === 1 ? ok("it sees AgriFresh's catalogue only") : bad("catalogue", prods);

  // A second supplier, the buyer closed to new ones, then a switch between suppliers.
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  await expectOk("Appro+ reactivates Zitouna", sa, `select public.platform_set_pro_status($1, 'active') as r`, [Z]);
  const X = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  await expectOk("the buyer closes itself to new suppliers", R, `select public.set_open_to_new(false) as r`);
  await expectFail("a supplier cannot ask a closed buyer", X, `select public.pro_link_request($1, 'supplier')`, [RO], /nouveau fournisseur/);
  await expectOk("the buyer reopens", R, `select public.set_open_to_new(true) as r`);
  const l2 = await expectOk("Zitouna asks to supply the restaurant", X, `select public.pro_link_request($1, 'supplier') as r`, [RO]);
  await expectOk("the restaurant accepts", R, `select public.pro_link_respond($1, true) as r`, [l2[0].r]);
  const two = await as(R, `select public.my_suppliers() as r`);
  two[0].r.length === 2 ? ok("the buyer now has two suppliers") : bad("two suppliers", two);
  await expectOk("it switches to Zitouna", R, `select public.switch_supplier($1) as r`, [l2[0].r]);
  const z = await as(R, `select count(*) filter (where org_id = '${Z}')::int as z, count(*) filter (where org_id = '${legacy}')::int as a from public.products where active`);
  z[0].a === 0 ? ok("after switching, it sees Zitouna's catalogue, not AgriFresh's", z[0]) : bad("switch", z);
  await expectFail("cannot switch to a supplier it is not linked to", R, `select public.switch_supplier(gen_random_uuid())`, [], /pas lié/);
  await expectFail("the restaurant cannot manage AgriFresh's accounts", R, `select public.admin_set_role('livreur@agrifresh.tn', 'customer')`, [], /Accès|équipe|Appro\+/);
  await expectFail("a supplier cannot create a client record itself", owner, `insert into public.clients (business_name) values ('Client direct')`, [], /annuaire/);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration <= "20261113").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
