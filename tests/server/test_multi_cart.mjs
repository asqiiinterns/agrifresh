// One cart across several suppliers: catalogue of all suppliers, one order per supplier, all or nothing.
export async function runMultiCartChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Multi-supplier cart");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261115_multi_supplier_cart.sql", "supabase/migrations/20261115_multi_supplier_cart.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const R = "00000000-0000-0000-0000-0000000f0001";
  const legacy = (await one(`select public.legacy_org_id() as id`)).id;
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  // Zitouna sells something too.
  await sys();
  const zp = (await db.query(`insert into public.products (name, slug, price, unit_label, active, stock_quantity, org_id) values ('Huile d''olive', 'huile-zitouna', 18, 'litre', true, 50, $1) returning id`, [Z])).rows[0].id;
  const current = (await one(`select client_id from public.profiles where id = $1`, [R])).client_id;

  const cat = (await as(R, `select public.buyer_catalog() as r`))[0].r;
  const orgs = new Set(cat.products.map((p) => p.client_id));
  cat.suppliers.length === 2 && orgs.size === 2 ? ok("the catalogue shows the products of both suppliers", { suppliers: cat.suppliers.map((s) => s.name), products: cat.products.length }) : bad("catalogue", { suppliers: cat.suppliers, orgs: [...orgs] });
  const zRel = cat.suppliers.find((s) => s.org_id === Z);
  const aRel = cat.suppliers.find((s) => s.org_id === legacy);
  const aProduct = cat.products.find((p) => p.client_id === aRel.client_id);
  zRel.delivery_points.length && aRel.delivery_points.length ? ok("delivery points come with each supplier") : bad("points", cat.suppliers);

  // Zitouna hides its prices from this client: the catalogue must not leak them.
  await sys(); await db.exec(`update public.clients set show_prices = false where id = '${zRel.client_id}'`);
  const hidden = (await as(R, `select public.buyer_catalog() as r`))[0].r.products.find((p) => p.id === zp);
  hidden && hidden.price === null ? ok("a supplier that hides its prices: no price in the catalogue") : bad("price leak", hidden);

  const orders = JSON.stringify([
    { client_id: aRel.client_id, items: [{ product_id: aProduct.id, quantity: 2 }] },
    { client_id: zRel.client_id, items: [{ product_id: zp, quantity: 3 }] },
  ]);
  const res = await expectOk("one cart, two suppliers: two orders", R, `select public.place_multi_order($1::jsonb, null, 'Livraison le matin') as r`, [orders]);
  const placed = res?.[0]?.r ?? [];
  const rows = await one(`select count(*)::int as n, count(distinct c.supplier_org_id)::int as orgs from public.orders o join public.clients c on c.id = o.client_id where o.id = any($1::uuid[])`, [placed.map((o) => o.id)]);
  rows.n === 2 && rows.orgs === 2 ? ok("each supplier received its own order", placed.map((o) => `${o.supplier_name} #${o.order_number}`)) : bad("orders", rows);
  const back = await one(`select client_id from public.profiles where id = $1`, [R]);
  back.client_id === current ? ok("the selected supplier is unchanged afterwards") : bad("current supplier", back);

  // One list with the orders of both suppliers, each following its supplier's settings.
  const list = (await as(R, `select public.buyer_orders() as r`))[0].r;
  const mine = list.filter((o) => placed.some((p) => p.id === o.id));
  mine.length === 2 && new Set(mine.map((o) => o.supplier_name)).size === 2 ? ok("the orders list shows the orders of both suppliers") : bad("buyer orders", list.map((o) => o.supplier_name));
  const zOrder = mine.find((o) => o.client_id === zRel.client_id);
  zOrder && zOrder.total === null && zOrder.order_items.every((i) => i.line_total === null) ? ok("prices stay hidden for the supplier that hides them") : bad("price leak in orders", zOrder);
  const aOrder = mine.find((o) => o.client_id === aRel.client_id);
  aOrder && Number(aOrder.total) > 0 && aOrder.order_status_history.length > 0 ? ok("the other supplier's order keeps its prices and timeline") : bad("A order", aOrder);
  await sys(); await db.exec(`update public.orders set status = 'delivered' where id = '${zOrder.id}'; update public.clients set history_enabled = false where id = '${zRel.client_id}'`);
  const noHistory = (await as(R, `select public.buyer_orders() as r`))[0].r;
  !noHistory.some((o) => o.id === zOrder.id) && noHistory.some((o) => o.id === aOrder.id) ? ok("a supplier that turned history off: its closed orders are hidden") : bad("history", noHistory.length);
  await sys(); await db.exec(`update public.clients set history_enabled = true where id = '${zRel.client_id}'`);
  const supplierSide = await as(aRel && (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id, `select jsonb_array_length(public.buyer_orders()) as n`);
  supplierSide[0].n === 0 ? ok("a supplier account gets no buyer orders list") : bad("supplier buyer_orders", supplierSide);

  const mixed = JSON.stringify([{ client_id: aRel.client_id, items: [{ product_id: zp, quantity: 1 }] }]);
  await expectFail("a product cannot be sent to another supplier", R, `select public.place_multi_order($1::jsonb)`, [mixed], /n’appartient pas/);
  const before = (await one(`select count(*)::int as n from public.orders`)).n;
  const halfBad = JSON.stringify([
    { client_id: aRel.client_id, items: [{ product_id: aProduct.id, quantity: 1 }] },
    { client_id: zRel.client_id, items: [{ product_id: zp, quantity: 99999 }] },
  ]);
  await expectFail("if one supplier refuses (stock), nothing is sent", R, `select public.place_multi_order($1::jsonb)`, [halfBad], /Stock insuffisant/);
  const after = (await one(`select count(*)::int as n from public.orders`)).n;
  after === before ? ok("no half-sent cart") : bad("partial cart", { before, after });

  // A supplier that closes ordering to this client disappears from the cart.
  await sys(); await db.exec(`update public.clients set feature_overrides = feature_overrides || '{"client.order": false}'::jsonb where id = '${zRel.client_id}'`);
  const closed = (await as(R, `select public.buyer_catalog() as r`))[0].r;
  closed.suppliers.length === 1 && !closed.products.some((p) => p.client_id === zRel.client_id) ? ok("a supplier that closed ordering to this client is left out") : bad("closed", closed.suppliers);
  await expectFail("and cannot receive an order from the cart", R, `select public.place_multi_order($1::jsonb)`, [JSON.stringify([{ client_id: zRel.client_id, items: [{ product_id: zp, quantity: 1 }] }])], /ne vous permet pas/);
  await sys(); await db.exec(`update public.clients set feature_overrides = feature_overrides - 'client.order', show_prices = true where id = '${zRel.client_id}'`);

  const other = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  const foreign = await as(other, `select public.buyer_catalog() as r`);
  foreign[0].r.products.length === 0 ? ok("a supplier account gets no buyer catalogue") : bad("supplier catalogue", foreign[0].r.suppliers);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration <= "20261115").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
