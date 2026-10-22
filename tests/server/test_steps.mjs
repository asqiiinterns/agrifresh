// 20261130_workflow_steps.sql: production steps per Pro, shared ticks, own steps.
export async function runStepsChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Production steps");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261130_workflow_steps.sql", "supabase/migrations/20261130_workflow_steps.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const driver = (await one(`select id from public.profiles where role = 'driver' and org_id = $1 and account_status = 'active' limit 1`, [L])).id;
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  const buyer = await one(`select pr.id, pr.client_id from public.profiles pr join public.clients c on c.id = pr.client_id
    where pr.role = 'customer' and pr.account_status = 'active' and c.supplier_org_id = $1
      and exists (select 1 from public.client_delivery_points dp where dp.client_id = c.id and dp.active) limit 1`, [L]);
  const clientId = buyer?.client_id ?? (await one(`select c.id from public.clients c where c.supplier_org_id = $1 and c.link_status = 'active' and c.active and exists (select 1 from public.client_delivery_points dp where dp.client_id = c.id and dp.active) limit 1`, [L])).id;
  const point = await one(`select id from public.client_delivery_points where client_id = $1 and active limit 1`, [clientId]);
  const products = (await db.query(`select id from public.products where org_id = $1 and active order by stock_quantity desc limit 2`, [L])).rows;
  await sys(); await db.exec(`update public.clients set stock_managed = false, custom_settings = custom_settings || array['stock_managed'], credit_limit = null, auto_accept = false where id = '${clientId}'`);
  const place = async () => {
    const order = (await as(owner, `select public.staff_place_order($1, $2::jsonb, $3, null, null) as r`, [clientId, JSON.stringify(products.map((p) => ({ product_id: p.id, quantity: 1 }))), point.id]))[0].r;
    await as(owner, `select public.staff_update_order_status($1, 'confirmed', null)`, [order.id]);
    return order.id;
  };
  const items = async (orderId) => (await db.query(`select id from public.order_items where order_id = $1 order by id`, [orderId])).rows.map((r) => r.id);
  const status = async (orderId) => (await one(`select status from public.orders where id = $1`, [orderId])).status;

  // Settings
  await expectFail("a driver cannot set the steps", driver, `select public.set_workflow('{"auto_ready": true}'::jsonb)`, [], /administrateur/);
  await expectFail("ten steps at most", owner, `select public.set_workflow($1::jsonb)`, [JSON.stringify({ steps: Array.from({ length: 11 }, (_, i) => `É${i}`) })], /Dix/);
  const flow = (await as(owner, `select public.set_workflow('{"auto_ready": true, "steps": ["Découpe", "Emballage", "Découpe"]}'::jsonb) as r`))[0].r;
  flow.auto_ready === true && flow.preparing === true && flow.steps.length === 2 ? ok("the administrator sets auto « prepared » and two own steps", flow.steps) : bad("set_workflow", flow);
  (await as(driver, `select public.my_workflow_settings() as r`))[0].r.steps?.length === 2 ? ok("the team reads the settings") : bad("read settings", "");

  // Shared ticks
  const o1 = await place();
  const [i1, i2] = await items(o1);
  await expectFail("another Pro cannot tick", zitouna, `select public.prep_tick(array[$1]::uuid[], true)`, [i1], /plus à préparer|ne permet/);
  await expectOk("a first product ticked", owner, `select public.prep_tick(array[$1]::uuid[], true) as r`, [i1]);
  (await status(o1)) === "preparing" ? ok("the order starts its preparation") : bad("started", await status(o1));
  (await as(driver, `select public.prep_ticks() as r`))[0].r.includes(i1) ? ok("the tick is shared with the whole team") : bad("shared", "");
  await expectOk("the second product ticked", owner, `select public.prep_tick(array[$1]::uuid[], true) as r`, [i2]);
  (await status(o1)) === "ready" ? ok("all ticked: the order is marked prepared") : bad("auto ready", await status(o1));
  const note = (await one(`select note from public.order_status_history where order_id = $1 and status = 'ready'`, [o1])).note;
  note?.includes("tous les produits") ? ok("and the history says why", note) : bad("ready note", note);

  // Own steps, client visibility
  const o2 = await place();
  await expectFail("an unknown step", owner, `select public.prep_step($1, 'Peinture', true)`, [o2], /inconnue/);
  const done = (await as(owner, `select public.prep_step($1, 'Découpe', true) as r`, [o2]))[0].r;
  done.includes("Découpe") && (await status(o2)) === "preparing" ? ok("an own step done (and the preparation started)") : bad("step", done);
  if (buyer) {
    const seen = (await as(buyer.id, `select public.buyer_orders() as r`))[0].r.find((o) => o.id === o2);
    seen?.order_status_history.some((h) => (h.note ?? "").startsWith("Étape « Découpe »")) ? ok("the client sees the step") : bad("client sees", seen?.order_status_history);
    await as(owner, `select public.set_workflow('{"client_sees_steps": false}'::jsonb)`);
    const hidden = (await as(buyer.id, `select public.buyer_orders() as r`))[0].r.find((o) => o.id === o2);
    !hidden?.order_status_history.some((h) => (h.note ?? "").startsWith("Étape")) ? ok("hidden from the client when the Pro chooses so") : bad("client hidden", hidden?.order_status_history);
  } else ok("(no buyer account in the test data)");

  // Without the « En préparation » step
  await as(owner, `select public.set_workflow('{"preparing": false, "auto_ready": false}'::jsonb)`);
  const o3 = await place();
  await expectFail("« En préparation » refused when the step is off", owner, `select public.staff_update_order_status($1, 'preparing', null)`, [o3], /Transition impossible/);
  await expectOk("accepted → prepared directly", owner, `select public.staff_update_order_status($1, 'ready', null) ->> 'status' as r`, [o3]);
  await as(owner, `select public.set_workflow('{"preparing": true, "auto_ready": false, "steps": [], "client_sees_steps": true}'::jsonb)`);

  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((r) => r.migration <= "20261130_workflow_steps.sql").every((r) => r.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((r) => r.etat !== "OK"));
}
