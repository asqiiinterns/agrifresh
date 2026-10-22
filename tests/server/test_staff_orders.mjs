// Orders entered by the team for a client.
export async function runStaffOrderChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P, c1, c2, c2points }) {
  console.log("\n# Staff orders migration");
  for (const f of ["supabase/migrations/20261026_staff_orders.sql", "supabase/migrations/20261026_staff_orders.sql"]) {
    try { await db.exec(file(f).replace("create extension if not exists pg_net;", "")); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const A = { admin: "00000000-0000-0000-0000-0000000000a1", prod: "00000000-0000-0000-0000-0000000000a2" };
  const items = JSON.stringify([{ product_id: P.oranges, quantity: 2 }]);

  await expectOk("client still orders normally", U.c1, `select public.place_client_order($1::jsonb, null, null, null) ->> 'status' as r`, [items]);
  await expectFail("client cannot use the staff function", U.c1, `select public.staff_place_order($1, $2::jsonb)`, [c1, items], /ne permet pas/);
  await expectFail("production cannot order for a client", A.prod, `select public.staff_place_order($1, $2::jsonb)`, [c1, items], /ne permet pas/);
  await expectFail("point required when several", U.staff, `select public.staff_place_order($1, $2::jsonb)`, [c2, items], /point de livraison/);
  const placed = await expectOk("supervisor orders for client 2", U.staff, `select public.staff_place_order($1, $2::jsonb, $3, current_date + 1, 'Par téléphone') as r`, [c2, items, c2points[0].id]);
  const id = placed?.[0]?.r?.id;
  const order = (await db.query(`select o.customer_id, o.client_id, h.note, h.changed_by from public.orders o join public.order_status_history h on h.order_id = o.id where o.id = $1`, [id])).rows[0];
  order.customer_id === U.c2 && order.client_id === c2 && order.changed_by === U.staff && order.note.includes("saisie par AgriFresh")
    ? ok("order belongs to the client's account, entered by the supervisor") : bad("staff order", JSON.stringify(order));
  const seen = await as(U.c2, `select count(*)::int as n from public.orders where id = $1`, [id]);
  seen[0].n === 1 ? ok("client sees the order in its history") : bad("client visibility", seen[0].n);
  const alert = await as(U.c2, `select title from public.notifications where order_id = $1 order by created_at limit 1`, [id]);
  alert[0]?.title?.includes("saisie par AgriFresh") ? ok("client alerted", alert[0].title) : bad("client alert", JSON.stringify(alert));
  const other = await as(U.c1, `select count(*)::int as n from public.orders where id = $1`, [id]);
  other[0].n === 0 ? ok("other clients do not see it") : bad("isolation", other[0].n);
  await expectOk("admin orders for client 1", A.admin, `select public.staff_place_order($1, $2::jsonb) ->> 'status' as r`, [c1, items]);
  await expectOk("admin removes the right from supervisors", A.admin, `select public.admin_set_permission('supervisor', 'orders.create', false) as r`);
  await expectFail("supervisor blocked once removed", U.staff, `select public.staff_place_order($1, $2::jsonb)`, [c1, items], /ne permet pas/);
  await expectOk("restore", A.admin, `select public.admin_set_permission('supervisor', 'orders.create', true) as r`);
  console.log("\n# Driver picks up and ships");
  const r = await expectOk("order to pick up", U.c1, `select public.place_client_order($1::jsonb, null, null, null) as r`, [items]);
  const oid = r?.[0]?.r?.id;
  for (const st of ["confirmed", "preparing", "ready"]) await expectOk(`→ ${st}`, U.staff, `select public.staff_update_order_status($1, $2::public.order_status, null) ->> 'status' as r`, [oid, st]);
  const pick = await as(U.driver, `select public.driver_pickups() as p`);
  pick[0].p.some((o) => o.id === oid) ? ok("driver sees the ready order", pick[0].p.length) : bad("pickups", JSON.stringify(pick[0].p));
  await expectFail("client cannot list pickups", U.c1, `select public.driver_pickups()`, [], /expédier/);
  await expectOk("driver ships it", U.driver, `select public.staff_update_order_status($1, 'out_for_delivery', null) ->> 'status' as r`, [oid]);
  await expectFail("driver cannot accept orders", U.driver, `select public.staff_update_order_status($1, 'cancelled', null)`, [oid], /personnel/);
  const by = (await db.query(`select changed_by from public.order_status_history where order_id=$1 and status='out_for_delivery'`, [oid])).rows[0].changed_by;
  by === U.driver ? ok("shipping recorded under the driver") : bad("shipped by", by);
}
