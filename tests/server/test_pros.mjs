// Pros, step 1: structure and filing of existing data; nothing changes for the app.
export async function runProsChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1, c2 }) {
  console.log("\n# Pros (foundations)");
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  for (const f of ["supabase/migrations/20261108_pros_foundation.sql", "supabase/migrations/20261108_pros_foundation.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const legacy = await one(`select id, name, is_supplier, is_buyer, status from public.organizations where legacy`);
  legacy?.is_supplier && legacy.status === "active" ? ok("original supplier Pro", legacy.name) : bad("legacy", legacy);
  const count = await one(`select count(*)::int as n from public.organizations where legacy`);
  count.n === 1 ? ok("rerun keeps a single original supplier") : bad("legacy count", count);
  const unfiled = await one(`select (select count(*) from public.clients where buyer_org_id is null or supplier_org_id is null)::int as clients,
    (select count(*) from public.products where org_id is null)::int as products, (select count(*) from public.orders where supplier_org_id is null)::int as orders`);
  unfiled.clients + unfiled.products + unfiled.orders === 0 ? ok("every record, product and order filed") : bad("unfiled", unfiled);
  const buyers = await one(`select count(distinct buyer_org_id)::int as n, count(*)::int as records from public.clients`);
  buyers.n === buyers.records ? ok("one buyer Pro per client record", buyers.n) : bad("buyers", buyers);
  const admin = await one(`select is_superadmin, org_id from public.profiles where role = 'admin' limit 1`);
  admin.is_superadmin && admin.org_id === null ? ok("admin became super-admin, outside any Pro") : bad("superadmin", admin);
  const staff = await one(`select org_id from public.profiles where id = $1`, [U.staff]);
  staff.org_id === legacy.id ? ok("team account attached to the original supplier") : bad("staff org", staff);
  const cust = await one(`select pr.org_id = c.buyer_org_id as same from public.profiles pr join public.clients c on c.id = pr.client_id where pr.id = $1`, [U.c1]);
  cust?.same ? ok("client account attached to its buyer Pro") : bad("client org", cust);
  // Today's screens keep working: a new record, a new order.
  const rec = await as(U.staff, `insert into public.clients (business_name, email) values ('Café Neuf', 'neuf@x.tn') returning supplier_org_id, buyer_org_id`);
  rec[0].supplier_org_id === legacy.id && rec[0].buyer_org_id ? ok("new record filed to the creator's Pro with a new buyer Pro") : bad("new record", rec);
  await expectOk("staff still sees all its clients", U.staff, `select count(*)::int as n from public.clients`);
  const sent = await as(U.c1, `select public.send_message_v3(null, 'Toujours là', null, false) ->> 'id' as r`);
  sent[0].r ? ok("client flows unchanged") : bad("client flow", sent);
  const self = await as(U.staff, `select public.current_org_id() = public.legacy_org_id() as same, public.is_superadmin() as sa`);
  self[0].same && !self[0].sa ? ok("current_org_id / is_superadmin") : bad("helpers", self);
}
