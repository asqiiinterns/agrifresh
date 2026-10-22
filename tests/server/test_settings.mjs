// Settings by role/user/client, client defaults, fleet & grouped shipments, audit trail, home layout.
export async function runSettingsChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P, c1, c2 }) {
  console.log("\n# Settings, fleet and audit migration");
  for (const f of ["supabase/migrations/20261027_settings_fleet_audit.sql", "supabase/migrations/20261027_settings_fleet_audit.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const A = { admin: "00000000-0000-0000-0000-0000000000a1" };
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const items = JSON.stringify([{ product_id: P.oranges, quantity: 1 }]);
  const feature = async (uid, f) => (await as(uid, `select public.has_feature($1) as r`, [f]))[0].r;

  console.log("\n# Tabs and exceptions");
  (await feature(U.staff, "home.view")) && (await feature(U.staff, "orders.view")) ? ok("supervisor gets Accueil and Commandes tabs") : bad("supervisor tabs", "missing");
  (await feature(U.c1, "client.order")) && !(await feature(U.c1, "home.view")) ? ok("client gets client tabs only") : bad("client tabs", "wrong");
  await expectOk("admin removes shipping for this driver only", A.admin, `select public.admin_set_user_permission($1, 'orders.ship', false) as r`, [U.driver]);
  !(await feature(U.driver, "orders.ship")) ? ok("driver exception applied") : bad("driver exception", "still allowed");
  await expectOk("admin clears the exception", A.admin, `select public.admin_set_user_permission($1, 'orders.ship', null) as r`, [U.driver]);
  (await feature(U.driver, "orders.ship")) ? ok("driver back to role rights") : bad("clear exception", "not restored");
  await expectFail("team feature refused for a customer", A.admin, `select public.admin_set_user_permission($1, 'orders.decide', true)`, [U.c1], /ne concerne pas/);
  await expectFail("supervisor cannot set exceptions", U.staff, `select public.admin_set_user_permission($1, 'orders.ship', false)`, [U.driver], /administrateurs/);
  await expectOk("client record hides messages and tries a team right", U.staff, `update public.clients set feature_overrides = '{"client.messages": false, "orders.decide": true}' where id = $1 returning feature_overrides::text as r`, [c1]);
  !(await feature(U.c1, "client.messages")) && !(await feature(U.c1, "orders.decide")) ? ok("client override applied, team right ignored") : bad("client override", "wrong");
  await expectOk("user exception beats client record", A.admin, `select public.admin_set_user_permission($1, 'client.messages', true) as r`, [U.c1]);
  (await feature(U.c1, "client.messages")) ? ok("user exception wins") : bad("precedence", "client record won");
  await expectOk("clean", A.admin, `select public.admin_set_user_permission($1, 'client.messages', null) as r`, [U.c1]);
  await db.exec(`update public.clients set feature_overrides = '{}'`);

  console.log("\n# Client defaults");
  await expectOk("admin: prices hidden for all clients", A.admin, `select public.admin_set_client_default('show_prices', 'false') as r`);
  const both = (await db.query(`select id, show_prices from public.clients where id in ($1, $2)`, [c1, c2])).rows;
  both.every((r) => r.show_prices === false) ? ok("default applied to every client") : bad("default", JSON.stringify(both));
  await expectOk("client 1 gets its own setting", U.staff, `update public.clients set custom_settings = array['show_prices'], show_prices = true where id = $1 returning show_prices as r`, [c1]);
  await expectOk("admin: default back to shown then hidden", A.admin, `select public.admin_set_client_default('show_prices', 'false') as r`);
  const p1 = await one(`select show_prices from public.clients where id=$1`, [c1]);
  p1.show_prices === true ? ok("customised client keeps its value") : bad("custom kept", p1);
  await expectOk("client 1 back to default", U.staff, `update public.clients set custom_settings = '{}' where id = $1 returning show_prices as r`, [c1]);
  await expectOk("restore default", A.admin, `select public.admin_set_client_default('show_prices', 'true') as r`);
  await expectFail("unknown option refused", A.admin, `select public.admin_set_client_default('hack', 'true')`, [], /inconnue/);
  await expectFail("supervisor cannot change defaults", U.staff, `select public.admin_set_client_default('show_prices', 'false')`, [], /administrateurs/);

  console.log("\n# Client history switched off");
  const delivered = await one(`select count(*)::int as n from public.orders where client_id=$1 and status in ('delivered','cancelled')`, [c2]);
  await db.exec(`update public.clients set custom_settings = array['history_enabled'], history_enabled = false where id = '${c2}'`);
  const seenOff = await as(U.c2, `select count(*)::int as n from public.orders where status in ('delivered','cancelled')`);
  const tl = await as(U.c2, `select count(*)::int as n from public.order_status_history`);
  seenOff[0].n === 0 && tl[0].n === 0 ? ok(`finished orders (${delivered.n}) and timelines hidden`) : bad("history off", JSON.stringify([seenOff, tl]));
  await db.exec(`update public.clients set custom_settings = '{}' where id = '${c2}'`);
  const seenOn = await as(U.c2, `select count(*)::int as n from public.order_status_history`);
  seenOn[0].n > 0 ? ok("history back with the default", seenOn[0].n) : bad("history on", seenOn);

  console.log("\n# Reopen without reconfirmation");
  await db.exec(`update public.clients set custom_settings = array['reconfirm_declined'], reconfirm_declined = false where id = '${c1}'`);
  const r1 = await expectOk("client 1 orders", U.c1, `select public.place_client_order($1::jsonb, null, null, null) as r`, [items]);
  const rid = r1?.[0]?.r?.id;
  await expectOk("declined", U.staff, `select public.staff_update_order_status($1, 'declined', 'Rupture') ->> 'status' as r`, [rid]);
  const reopened = await expectOk("reopen → accepted directly", U.staff, `select public.staff_update_order_status($1, 'awaiting_client', 'Arrivage') ->> 'status' as r`, [rid]);
  reopened?.[0]?.r === "confirmed" ? ok("no client reconfirmation needed") : bad("reopen", reopened);
  const h = await one(`select note, changed_by_name from public.order_status_history where order_id=$1 order by created_at desc limit 1`, [rid]);
  h.note.includes("directement") && h.changed_by_name ? ok("traced", h) : bad("reopen trace", h);
  await db.exec(`update public.clients set custom_settings = '{}' where id = '${c1}'`);

  console.log("\n# Fleet and grouped shipment");
  await expectFail("driver cannot add a vehicle", U.driver, `insert into public.vehicles (label) values ('Camion')`, [], /row-level security/);
  const v = await expectOk("admin adds a vehicle", A.admin, `insert into public.vehicles (label, plate) values ('Camion frigo', '123 TU 4567') returning id`);
  const vid = v?.[0]?.id;
  const ids = [];
  for (let n = 0; n < 2; n++) {
    const r = await expectOk("order to ship", U.c1, `select public.place_client_order($1::jsonb, null, null, null) as r`, [items]);
    ids.push(r?.[0]?.r?.id);
  }
  for (const id of ids) for (const st of ["confirmed", "preparing", "ready"]) await as(U.staff, `select public.staff_update_order_status($1, $2::public.order_status, null)`, [id, st]);
  await expectFail("single shipping without vehicle refused", U.driver, `select public.staff_update_order_status($1, 'out_for_delivery', null)`, [ids[0]], /véhicule/);
  await expectFail("vehicle required", U.driver, `select public.driver_ship_orders($1::uuid[], null)`, [ids], /véhicule/);
  const sh = await expectOk("driver ships both in the truck", U.driver, `select public.driver_ship_orders($1::uuid[], $2) as r`, [ids, vid]);
  sh?.[0]?.r?.count === 2 ? ok("one shipment, two orders", sh[0].r.shipment_number) : bad("shipment", sh);
  await expectFail("already shipped", U.driver, `select public.driver_ship_orders($1::uuid[], $2)`, [ids, vid], /plus prête/);
  const list = await as(U.driver, `select public.driver_shipments() as r`);
  const mine = list[0].r.filter((o) => ids.includes(o.id));
  mine.length === 2 && mine.every((o) => o.vehicle_label === "Camion frigo") ? ok("to-deliver list shows the vehicle") : bad("shipments list", JSON.stringify(mine));

  console.log("\n# Delivery proof per client options");
  await expectFail("scan of the delivery notes required by default", U.driver, `select public.driver_deliver($1::uuid[], null, null, null)`, [ids], /bon de livraison/);
  await db.exec(`update public.clients set custom_settings = array['scan_delivery_note','scan_client_qr'], scan_delivery_note = false, scan_client_qr = false where id = '${c1}'`);
  await expectOk("no scan needed for this client", U.driver, `select public.driver_deliver($1::uuid[], null, null, null) as r`, [ids]);
  const dn = await one(`select o.status, h.note from public.orders o join public.order_status_history h on h.order_id = o.id and h.status = 'delivered' where o.id = $1`, [ids[0]]);
  dn.status === "delivered" && dn.note.includes("sans scan") ? ok("delivered and traced", dn.note) : bad("delivery", dn);
  await db.exec(`update public.clients set custom_settings = '{}' where id = '${c1}'`);
  const hist = await as(U.driver, `select public.driver_history(current_date - 1) as r`);
  hist[0].r.some((o) => o.id === ids[0] && o.vehicle_label === "Camion frigo") ? ok("history keeps the vehicle") : bad("history vehicle", "missing");
  await db.exec(`update public.vehicles set active = false`);

  console.log("\n# Audit trail");
  const sup = await as(U.staff, `select count(*)::int as n from public.audit_log`);
  sup[0].n === 0 ? ok("supervisor cannot read the audit log by default") : bad("audit RLS", sup[0].n);
  const adm = await as(A.admin, `select count(*)::int as n, count(distinct actor_name)::int as actors from public.audit_log`);
  adm[0].n > 0 ? ok("admin reads the audit log", adm[0]) : bad("audit admin", adm);
  const ship = await as(A.admin, `select actor_name, label, changes -> 'status' as s from public.audit_log where entity = 'orders' and entity_id = $1 and changes ? 'status' order by id`, [ids[0]]);
  ship.length >= 4 && ship.every((r) => r.actor_name) ? ok("every status change has its author", ship.map((r) => `${r.actor_name}: ${JSON.stringify(r.s)}`)) : bad("order audit", JSON.stringify(ship));
  const secret = await as(A.admin, `select count(*)::int as n from public.audit_log where changes ? 'delivery_token' or changes ? 'reception_token'`);
  secret[0].n === 0 ? ok("QR secrets kept out of the log") : bad("secrets", secret[0].n);
  await expectOk("admin lets supervisors read the log", A.admin, `select public.admin_set_permission('supervisor', 'audit.view', true) as r`);
  const sup2 = await as(U.staff, `select count(*)::int as n from public.audit_log`);
  sup2[0].n > 0 ? ok("supervisor reads once allowed") : bad("audit permission", sup2[0].n);
  await expectOk("restore", A.admin, `select public.admin_set_permission('supervisor', 'audit.view', false) as r`);

  console.log("\n# Home screen layout");
  const layout = JSON.stringify({ tiles: ["decide", "ready"], shortcuts: ["staffOrder"] });
  await expectOk("admin sets the supervisor home", A.admin, `select public.admin_set_home_layout('supervisor', $1::jsonb) as r`, [layout]);
  const acc = await as(U.staff, `select public.my_account() -> 'home_layout' as r`);
  acc[0].r?.tiles?.length === 2 ? ok("supervisor gets the role layout") : bad("role layout", acc);
  await expectOk("supervisor customises its own", U.staff, `select public.set_my_home_layout($1::jsonb) as r`, [JSON.stringify({ tiles: ["today"], shortcuts: [] })]);
  const acc2 = await as(U.staff, `select public.my_account() -> 'home_layout' as r, public.my_account() -> 'role_home_layout' as d`);
  acc2[0].r.tiles[0] === "today" && acc2[0].d.tiles.length === 2 ? ok("own layout wins, role layout kept for reset") : bad("own layout", acc2);
  await expectFail("invalid layout refused", U.staff, `select public.set_my_home_layout('[1]'::jsonb)`, [], /invalide/);
  await expectFail("supervisor cannot set role layouts", U.staff, `select public.admin_set_home_layout('driver', $1::jsonb)`, [layout], /administrateurs/);
}
