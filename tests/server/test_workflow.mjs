// End-to-end use cases, step by step, across lots 20261121 → 20261129.
//   A. A supplier invites a client → the client joins → order → acceptance with a planned vehicle → preparation →
//      step back → shipped with the « Expédier » button → delivered with a payment collected by the driver →
//      the buyer sees it delivered, with its supplier's details for the PDF.
//   B. An accepted order stopped during preparation: cancelled with a reason the client sees.
export async function runWorkflowChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Workflows (use cases, step by step)");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const supplierName = (await one(`select name from public.organizations where id = $1`, [L])).name;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const driver = (await one(`select id from public.profiles where role = 'driver' and org_id = $1 and account_status = 'active' limit 1`, [L])).id;
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const uid = "00000000-0000-0000-0000-0000000e5201";
  await sys(); await db.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${uid}', 'flux@x.tn', now()) on conflict do nothing`);

  // A1 · the supplier invites a client; Appro+ sees the invitation
  const inv = (await as(owner, `select public.create_invitation('client', null, 'Épicerie Flux', 'flux@x.tn') as r`))[0].r;
  inv?.code ? ok("A1 · the supplier creates an invitation", inv.code) : bad("A1 invitation", inv);
  (await as(sa, `select public.platform_invitations() as r`))[0].r.some((row) => row.code === inv.code) ? ok("A1 · Appro+ sees it in Invitations") : bad("A1 platform list", "");

  // A2 · the client accepts and creates its space: active for the invited period, related to the supplier
  await expectOk("A2 · the invited person accepts the code", uid, `select public.accept_invitation($1) as r`, [inv.code]);
  await expectOk("A2 · and creates its space", uid, `select public.register_pro('{"name":"Épicerie Flux","is_buyer":true}'::jsonb) as r`);
  const space = await one(`select o.id, o.status from public.profiles pr join public.organizations o on o.id = pr.org_id where pr.id = $1`, [uid]);
  space.status === "active" ? ok("A2 · active for the invited period") : bad("A2 status", space);
  const record = await one(`select id, link_status from public.clients where supplier_org_id = $1 and buyer_org_id = $2`, [L, space.id]);
  record?.link_status === "active" ? ok("A2 · in relation with its supplier") : bad("A2 relation", record);
  const accepted = (await as(owner, `select public.my_invitations() as r`))[0].r.find((row) => row.code === inv.code);
  accepted?.acceptances?.length === 1 && accepted.acceptances[0].linked_at ? ok("A2 · the supplier's administrator sees who accepted and when") : bad("A2 acceptance", accepted);
  (await one(`select count(*)::int as n from public.notifications where user_id = $1 and event = 'invitation.accepted'`, [owner])).n > 0
    ? ok("A2 · the supplier is notified") : bad("A2 notified", 0);

  // A3 · an order for this client, accepted with a planned vehicle
  await sys(); await db.exec(`insert into public.client_delivery_points (client_id, label, address_line, city, active) values ('${record.id}', 'Magasin', '1 rue Flux', 'Tunis', true)`);
  await sys(); await db.exec(`update public.clients set stock_managed = false, scan_delivery_note = false, scan_client_qr = false, delivery_signature = false,
    custom_settings = custom_settings || array['stock_managed', 'scan_delivery_note', 'scan_client_qr', 'delivery_signature'], credit_limit = null, auto_accept = false where id = '${record.id}'`);
  const point = await one(`select id from public.client_delivery_points where client_id = $1`, [record.id]);
  const product = await one(`select id from public.products where org_id = $1 and active order by stock_quantity desc limit 1`, [L]);
  const order = (await as(owner, `select public.staff_place_order($1, $2::jsonb, $3, null, null) as r`, [record.id, JSON.stringify([{ product_id: product.id, quantity: 2 }]), point.id]))[0].r;
  (await one(`select status from public.orders where id = $1`, [order.id])).status === "pending" ? ok("A3 · the order waits for a decision") : bad("A3 pending", "");
  await expectOk("A3 · accepted", owner, `select public.staff_update_order_status($1, 'confirmed', null) ->> 'status' as r`, [order.id]);
  const vA = (await one(`select id from public.vehicles where org_id = $1 and label = 'Camion A'`, [L])).id;
  await expectOk("A3 · vehicle planned", owner, `select public.staff_plan_vehicle($1, $2) as r`, [order.id, vA]);

  // A4 · preparation, prepared, one step back, prepared again
  await expectOk("A4 · preparation starts", owner, `select public.staff_update_order_status($1, 'preparing', null) ->> 'status' as r`, [order.id]);
  await expectOk("A4 · prepared", owner, `select public.staff_update_order_status($1, 'ready', null) ->> 'status' as r`, [order.id]);
  await expectOk("A4 · one step back (a product was missing)", owner, `select public.staff_revert_order($1, 'Produit manquant') ->> 'status' as r`, [order.id]);
  (await one(`select status from public.orders where id = $1`, [order.id])).status === "preparing" ? ok("A4 · in preparation again") : bad("A4 revert", "");
  await expectOk("A4 · prepared again", owner, `select public.staff_update_order_status($1, 'ready', null) ->> 'status' as r`, [order.id]);

  // A5 · « Expédier » on the order: shipped at once with the planned vehicle
  const shipped = (await as(owner, `select public.staff_update_order_status($1, 'out_for_delivery', null) as r`, [order.id]))[0].r;
  shipped.status === "out_for_delivery" && shipped.vehicle === "Camion A" ? ok("A5 · shipped with the planned vehicle, never blocked") : bad("A5 ship", shipped);
  (await as(driver, `select public.driver_shipments() as r`))[0].r.some((row) => row.id === order.id) ? ok("A5 · in the driver's « À livrer »") : bad("A5 driver list", "");

  // A6 · delivered: the driver collects 12.5 TND in cash; the app reads it from the history
  await expectOk("A6 · delivered with a payment of 12,500 TND", driver, `select public.driver_deliver_v3(array[$1]::uuid[], null, null, null, null, null, 12.5, 'cash') as r`, [order.id]);
  const notes = (await one(`select string_agg(note, ' | ') as n from public.order_status_history where order_id = $1`, [order.id])).n ?? "";
  const match = /Acompte reçu : ([\d\s.,  ]+ TND)(?: \(([^)]+)\))?/.exec(notes);
  match ? ok("A6 · « Paiement reçu par le livreur » is shown on the order", `${match[1]} (${match[2]})`) : bad("A6 payment text", notes);
  (await one(`select count(*)::int as n from public.account_entries where order_id = $1 and kind = 'deposit'`, [order.id])).n === 1 ? ok("A6 · recorded on the client's account") : bad("A6 entry", 0);

  // A7 · the buyer sees it delivered, with its supplier's details (PDF of the right supplier)
  const mine = (await as(uid, `select public.buyer_orders() as r`))[0].r.find((row) => row.id === order.id);
  mine?.status === "delivered" && mine.seller?.name === supplierName ? ok("A7 · the buyer sees it delivered, from its supplier", supplierName) : bad("A7 buyer view", mine);

  // B · an accepted order stopped during preparation
  const order2 = (await as(owner, `select public.staff_place_order($1, $2::jsonb, $3, null, null) as r`, [record.id, JSON.stringify([{ product_id: product.id, quantity: 1 }]), point.id]))[0].r;
  for (const st of ["confirmed", "preparing"]) await as(owner, `select public.staff_update_order_status($1, $2::public.order_status, null)`, [order2.id, st]);
  await expectFail("B · a driver cannot stop it", driver, `select public.staff_update_order_status($1, 'cancelled', 'x')`, [order2.id], /réservé/);
  await expectOk("B · « Arrêter et annuler » with a reason", owner, `select public.staff_update_order_status($1, 'cancelled', 'Rupture de stock') ->> 'status' as r`, [order2.id]);
  const seen = (await as(uid, `select public.buyer_orders() as r`))[0].r.find((row) => row.id === order2.id);
  seen?.status === "cancelled" && seen.status_note === "Rupture de stock" ? ok("B · the client sees it cancelled, with the reason") : bad("B buyer view", seen);
}
