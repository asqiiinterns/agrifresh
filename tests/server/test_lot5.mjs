// Lot 5 (1) — 20261121_lot5_workflow.sql: going back a step, automatic acceptance and delivery, planned vehicle, delivery-note right.
export async function runLot5Checks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Lot 5 · order workflow");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261121_lot5_workflow.sql", "supabase/migrations/20261121_lot5_workflow.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const driver = (await one(`select id from public.profiles where role = 'driver' and org_id = $1 and account_status = 'active' limit 1`, [L])).id;
  const can = async (uid, feature) => (await as(uid, `select public.has_feature($1) as r`, [feature]))[0].r;
  (await can(owner, "orders.revert")) && (await can(owner, "orders.delivery_note")) ? ok("the Responsable has the new rights") : bad("owner rights", "missing");
  (await can(driver, "orders.revert")) === false ? ok("a driver cannot go back a step") : bad("driver revert", "allowed");

  const client = await one(`select c.id from public.clients c where c.supplier_org_id = $1 and c.link_status = 'active' and c.active
    and exists (select 1 from public.client_delivery_points dp where dp.client_id = c.id and dp.active) order by c.created_at limit 1`, [L]);
  const point = await one(`select id from public.client_delivery_points where client_id = $1 and active limit 1`, [client.id]);
  const product = await one(`select id from public.products where org_id = $1 and active order by stock_quantity desc, name limit 1`, [L]);
  const items = JSON.stringify([{ product_id: product.id, quantity: 1 }]);
  await sys(); await db.exec(`update public.clients set custom_settings = array['auto_accept','scan_delivery_note','scan_client_qr','delivery_signature','stock_managed'], auto_accept = true, stock_managed = false,
    scan_delivery_note = false, scan_client_qr = false, delivery_signature = false, credit_limit = null where id = '${client.id}'`);
  const placed = (await as(owner, `select public.staff_place_order($1, $2::jsonb, $3, null, null) as r`, [client.id, items, point.id]))[0].r;
  const auto = await one(`select o.status, (select h.changed_by_name from public.order_status_history h where h.order_id = o.id and h.status = 'confirmed') as who from public.orders o where o.id = $1`, [placed.id]);
  auto.status === "confirmed" && auto.who === "Acceptation automatique" && placed.status === "confirmed" ? ok("accepted automatically for this client", auto.who) : bad("auto accept", { auto, placed });

  // Going back
  await expectOk("back to « à décider »", owner, `select public.staff_revert_order($1, 'Erreur de saisie') ->> 'status' as r`, [placed.id]);
  const back = await one(`select status, production_rank, (select note from public.order_status_history h where h.order_id = $1 order by created_at desc limit 1) as note from public.orders where id = $1`, [placed.id]);
  back.status === "pending" && back.production_rank === null && back.note.includes("Erreur de saisie") ? ok("pending again, out of the queue, traced", back.note) : bad("revert", back);
  await expectFail("nothing before « à décider »", owner, `select public.staff_revert_order($1)`, [placed.id], /ne peut pas revenir/);
  for (const st of ["confirmed", "preparing"]) await as(owner, `select public.staff_update_order_status($1, $2::public.order_status, null)`, [placed.id, st]);
  await expectOk("preparing → accepted", owner, `select public.staff_revert_order($1) ->> 'status' as r`, [placed.id]);
  await expectFail("a driver is refused", driver, `select public.staff_revert_order($1)`, [placed.id], /ne permet pas/);
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  await expectFail("another Pro cannot touch it", zitouna, `select public.staff_revert_order($1)`, [placed.id], /introuvable/);

  // Planned vehicle, forced by the driver
  await sys(); await db.exec(`update public.vehicles set active = true where org_id = '${L}'`);
  await sys(); await db.exec(`insert into public.vehicles (label, plate, org_id, active) values ('Camion A', 'A-1', '${L}', true), ('Camion B', 'B-2', '${L}', true)`);
  const vA = (await one(`select id from public.vehicles where label = 'Camion A' and org_id = $1`, [L])).id;
  const vB = (await one(`select id from public.vehicles where label = 'Camion B' and org_id = $1`, [L])).id;
  await expectOk("the vehicle is planned at acceptance", owner, `select public.staff_plan_vehicle($1, $2) as r`, [placed.id, vA]);
  for (const st of ["preparing", "ready"]) await as(owner, `select public.staff_update_order_status($1, $2::public.order_status, null)`, [placed.id, st]);
  const pick = (await as(driver, `select public.driver_pickups() as r`))[0].r.find((p) => p.id === placed.id);
  pick?.planned_vehicle_id === vA ? ok("the driver's list shows the planned vehicle") : bad("pickup", pick);
  await expectOk("the driver ships in another one", driver, `select public.driver_ship_orders(array[$1]::uuid[], $2) ->> 'count' as r`, [placed.id, vB]);
  const forced = await one(`select (select note from public.order_status_history h where h.order_id = $1 and h.status = 'out_for_delivery') as note,
    (select count(*)::int from public.notifications n where n.order_id = $1 and n.event = 'order.forced') as alerts`, [placed.id]);
  forced.note.includes("véhicule prévu : Camion A") && forced.alerts > 0 ? ok("traced and the team is told (condition forcée)", forced.note) : bad("forced", forced);
  await expectOk("back from shipped to prepared", owner, `select public.staff_revert_order($1) ->> 'status' as r`, [placed.id]);
  const unshipped = await one(`select status, shipment_id from public.orders where id = $1`, [placed.id]);
  unshipped.status === "ready" && unshipped.shipment_id === null ? ok("prepared again, off the shipment") : bad("unship", unshipped);

  // Delivered automatically
  await sys(); await db.exec(`update public.clients set custom_settings = custom_settings || array['auto_deliver'], auto_deliver = true where id = '${client.id}'`);
  await as(driver, `select public.driver_ship_orders(array[$1]::uuid[], $2)`, [placed.id, vA]);
  await expectOk("not yet: shipped a moment ago", owner, `select public.auto_deliver_orders() as r`);
  (await one(`select status from public.orders where id = $1`, [placed.id])).status === "out_for_delivery" ? ok("still on its way") : bad("too early", "delivered");
  await sys(); await db.exec(`update public.order_status_history set created_at = now() - interval '25 hours' where order_id = '${placed.id}' and status = 'out_for_delivery'`);
  const n = (await as(owner, `select public.auto_deliver_orders() as r`))[0].r;
  const delivered = await one(`select o.status, o.delivered_at is not null as dated, (select h.note from public.order_status_history h where h.order_id = o.id and h.status = 'delivered') as note from public.orders o where o.id = $1`, [placed.id]);
  n >= 1 && delivered.status === "delivered" && delivered.dated && delivered.note.includes("automatiquement 24 h") ? ok("delivered automatically after 24 h", delivered.note) : bad("auto deliver", { n, delivered });
  await expectFail("the delay is 1 to 720 hours", owner, `select public.set_auto_deliver_hours(0)`, [], /invalide/);
  await expectOk("the supplier sets 12 h", owner, `select public.set_auto_deliver_hours(12) as r`);

  // Delivery note for the client
  await expectOk("default: the client sees its delivery notes", owner, `select public.admin_set_client_default('delivery_note_client', 'false'::jsonb) as r`);
  const dn = await one(`select delivery_note_client from public.clients where id = $1`, [client.id]);
  dn.delivery_note_client === false ? ok("the supplier can hide them from its clients") : bad("delivery note option", dn);
  await sys(); await db.exec(`update public.clients set custom_settings = array[]::text[] where id = '${client.id}'`);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration < "20261122").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
