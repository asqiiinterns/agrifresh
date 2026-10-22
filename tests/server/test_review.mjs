// 20261129_review.sql: fixes found by the full review of lots 20261121 → 20261128.
export async function runReviewChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Review fixes");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261129_review.sql", "supabase/migrations/20261129_review.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  const driver = (await one(`select id from public.profiles where role = 'driver' and org_id = $1 and account_status = 'active' limit 1`, [L])).id;
  const newUser = async (n, confirmed = true) => {
    const id = `00000000-0000-0000-0000-0000000e51${String(n).padStart(2, "0")}`;
    await sys(); await db.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${id}', 'rev${n}@x.tn', ${confirmed ? "now()" : "null"}) on conflict do nothing`);
    return id;
  };

  // 1. Location
  const r1 = (await as(owner, `select public.request_location($1) as r`, [driver]))[0].r;
  await expectOk("the driver refuses", driver, `select public.answer_location_request($1, false) as r`, [r1]);
  await expectOk("a late second answer is ignored", driver, `select public.answer_location_request($1, true, 36.8, 10.1, 5) as r`, [r1]);
  (await one(`select status from public.location_requests where id = $1`, [r1])).status === "refused" ? ok("the request stays refused") : bad("late answer", "changed");
  await expectFail("tracking for an account of another Pro: not found", owner, `select public.set_location_tracking($1, true)`, [zitouna], /introuvable/);

  // 2. The Responsable's rights
  const rights = (await as(owner, `select public.org_members_rights() as r`))[0].r;
  rights.find((m) => m.id === owner)?.owner === true ? ok("the matrix knows the Responsable") : bad("owner flag", rights.find((m) => m.id === owner));
  const sup = await one(`select r.id from public.org_roles r join public.role_templates t on t.id = r.template_id where r.org_id = $1 and t.key = 'supplier_supervisor'`, [L]);
  const member = sup && await one(`select mr.user_id as id from public.member_roles mr join public.profiles pr on pr.id = mr.user_id where mr.role_id = $1 and pr.account_status = 'active' and pr.id <> $2 limit 1`, [sup.id, owner]);
  if (member) {
    await expectOk("the supervisors manage the roles", owner, `select public.org_set_role_permission($1, 'roles.manage', true) as r`, [sup.id]);
    await expectFail("a delegate cannot remove the Responsable's rights", member.id, `select public.org_set_member_permission($1, 'orders.view', false)`, [owner], /Responsable/);
  } else ok("(no supervisor member in the test data)");

  // 3. A held conversation is delivered once the Pros are in relation
  const u1 = await newUser(1);
  await expectOk("a new buyer space", u1, `select public.register_pro('{"name":"Rev Un","kind":"person"}'::jsonb) as r`);
  const o1 = (await one(`select org_id from public.profiles where id = $1`, [u1])).org_id;
  await sys(); await db.exec(`update public.organizations set status = 'active' where id = '${o1}'; update public.profiles set account_status = 'active' where id = '${u1}'`);
  await expectOk("Zitouna closes its messages", zitouna, `select public.set_pro_visibility(null, null, false) as r`);
  const conv = (await as(u1, `select public.org_send($1, 'Bonjour') as r`, [Z]))[0].r;
  !(await as(zitouna, `select public.org_inbox() as r`))[0].r.some((c) => c.conversation_id === conv) ? ok("held while not related") : bad("held", "visible");
  await sys(); await db.exec(`select public.ensure_relation('${Z}', '${o1}', 'invitation')`);
  const seen = (await as(zitouna, `select public.org_inbox() as r`))[0].r.find((c) => c.conversation_id === conv);
  seen && seen.held === false ? ok("delivered once they are in relation") : bad("released by relation", seen);
  await expectOk("Zitouna reopens its messages", zitouna, `select public.set_pro_visibility(null, null, true) as r`);

  // 4. Shipping within the acting Pro, and the history label
  const place = async (uid, orgId) => {
    const client = await one(`select c.id from public.clients c where c.supplier_org_id = $1 and c.link_status = 'active' and c.active
      and exists (select 1 from public.client_delivery_points dp where dp.client_id = c.id and dp.active) order by c.created_at limit 1`, [orgId]);
    const point = await one(`select id from public.client_delivery_points where client_id = $1 and active limit 1`, [client.id]);
    const product = await one(`select id from public.products where org_id = $1 and active order by stock_quantity desc limit 1`, [orgId]);
    await sys(); await db.exec(`update public.clients set stock_managed = false, custom_settings = custom_settings || array['stock_managed'], credit_limit = null, auto_accept = false where id = '${client.id}'`);
    const order = (await as(uid, `select public.staff_place_order($1, $2::jsonb, $3, null, null) as r`, [client.id, JSON.stringify([{ product_id: product.id, quantity: 1 }]), point.id]))[0].r;
    for (const st of ["confirmed", "preparing", "ready"]) await as(uid, `select public.staff_update_order_status($1, $2::public.order_status, null)`, [order.id, st]);
    return order.id;
  };
  const o = await place(owner, L);
  await expectFail("another Pro cannot ship it", zitouna, `select public.driver_ship_orders(array[$1]::uuid[], null)`, [o], /introuvable|ne permet/);
  await expectFail("nor change its status", zitouna, `select public.staff_update_order_status($1, 'cancelled', null)`, [o], /introuvable|réservé/);
  const vA = (await one(`select id from public.vehicles where org_id = $1 and label = 'Camion A'`, [L])).id;
  await as(owner, `select public.staff_plan_vehicle($1, $2)`, [o, vA]);
  await as(owner, `select public.driver_ship_orders(array[$1]::uuid[], null)`, [o]);
  const note = (await one(`select note from public.order_status_history where order_id = $1 and status = 'out_for_delivery'`, [o])).note;
  note.includes("(prévu)") && !note.includes("par défaut") ? ok("the planned vehicle is said « prévu »", note) : bad("label", note);

  // 5. A space whose e-mail is confirmed later starts its trial at the next check
  await expectOk("Appro+ setting: 48 h trial", (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id,
    `select public.platform_set_setting('new_accounts_trial_hours', '48'::jsonb)`);
  const u2 = await newUser(2, false);
  await expectOk("a person signs up, e-mail not confirmed", u2, `select public.register_pro('{"name":"Rev Deux","kind":"person"}'::jsonb) as r`);
  const o2 = (await one(`select org_id from public.profiles where id = $1`, [u2])).org_id;
  (await one(`select status from public.organizations where id = $1`, [o2])).status === "pending" ? ok("stays pending") : bad("pending", "active");
  await sys(); await db.exec(`update auth.users set email_confirmed_at = now() where id = '${u2}'`);
  await as(owner, `select public.expire_trials()`);
  const after = await one(`select o.status, o.trial_until is not null as trial from public.organizations o where o.id = $1`, [o2]);
  after.status === "active" && after.trial ? ok("confirmed later: the trial starts at the next check") : bad("late trial", after);

  // 6. Labels
  const area = await one(`select area, label from public.permissions where key = 'alerts.view'`);
  area.area === "Accueil et notifications" && area.label === "Onglet Notifications" ? ok("« Alertes » renamed « Notifications »") : bad("labels", area);

  // 7. A buyer's orders carry their supplier's details
  const buyer = await one(`select pr.id from public.profiles pr join public.orders o on o.client_id = pr.client_id where pr.role = 'customer' and pr.account_status = 'active' limit 1`);
  if (buyer) {
    const list = (await as(buyer.id, `select public.buyer_orders() as r`))[0].r;
    list.length && list[0].seller && list[0].seller.name ? ok("each order of a buyer carries its supplier (PDF)", list[0].seller.name) : bad("seller", list[0]);
  } else ok("(no buyer with orders in the test data)");
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((r) => r.migration <= "20261129_review.sql").every((r) => r.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((r) => r.etat !== "OK"));
}
