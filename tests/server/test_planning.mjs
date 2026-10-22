// Roles, production planning and per-client stock options.
export async function runPlanningChecks({ db, file, ok, bad, as, expectOk, expectFail, step, U, P, c1, c2, c2points }) {
  console.log("\n# Roles & planning migration");
  for (const f of ["supabase/migrations/20261021_1_roles.sql", "supabase/migrations/20261021_2_planning_stock.sql", "supabase/migrations/20261021_2_planning_stock.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const A = { admin: "00000000-0000-0000-0000-0000000000a1", prod: "00000000-0000-0000-0000-0000000000a2" };
  await db.exec(`insert into auth.users (id, email) values ('${A.admin}','admin@x.tn'), ('${A.prod}','prod@x.tn');
    update public.profiles set role='admin' where id='${A.admin}';`);
  const legacy = (await db.query(`select role from public.profiles where id=$1`, [U.staff])).rows[0].role;
  legacy === "supervisor" ? ok("legacy staff became supervisor") : bad("legacy role", legacy);

  console.log("\n# Team & client creation");
  await expectFail("supervisor cannot create a client", U.staff, `insert into public.clients (business_name) values ('Nouveau')`, [], /row-level security/);
  await expectOk("admin creates a client", A.admin, `insert into public.clients (business_name, email) values ('Épicerie Lac', 'epicerie@x.tn') returning business_name`);
  await expectOk("supervisor still edits clients", U.staff, `update public.clients set phone='71 000 000' where id=$1 returning phone`, [c2]);
  await expectFail("supervisor cannot manage the team", U.staff, `select public.admin_set_role('prod@x.tn', 'production')`, [], /administrateurs/);
  await expectOk("admin assigns production role", A.admin, `select public.admin_set_role('prod@x.tn', 'production') ->> 'role' as r`);
  await expectFail("admin cannot change own role", A.admin, `select public.admin_set_role('admin@x.tn', 'driver')`, [], /propre rôle/);
  await expectFail("client account cannot join the team", A.admin, `select public.admin_set_role('c1@x.tn', 'driver')`, [], /fiche client/);
  await expectFail("unknown e-mail", A.admin, `select public.admin_set_role('nobody@x.tn', 'driver')`, [], /Aucun compte/);
  const team = await as(A.admin, `select public.admin_list_team() as t`);
  ok("team list", team[0].t.map((m) => `${m.email}:${m.role}`));

  console.log("\n# Production role");
  const prodOrders = await as(A.prod, `select count(*)::int as n from public.orders`);
  prodOrders[0].n > 0 ? ok("production reads orders", prodOrders[0].n) : bad("production orders", prodOrders[0].n);
  const prodClients = await as(A.prod, `select count(*)::int as n from public.clients`);
  prodClients[0].n > 0 ? ok("production reads client names") : bad("production clients", prodClients[0].n);
  const o = await expectOk("client 2 order", U.c2, `select public.place_client_order($1::jsonb, $2, null, null) as r`, [JSON.stringify([{ product_id: P.oranges, quantity: 1 }]), c2points[0].id]);
  const id = o?.[0]?.r?.id;
  await expectFail("production cannot accept", A.prod, `select public.staff_update_order_status($1, 'confirmed', null)`, [id], /personnel/);
  await step("supervisor accepts", U.staff, id, "confirmed");
  await expectOk("production starts preparation", A.prod, `select public.staff_update_order_status($1, 'preparing', null) ->> 'status' as r`, [id]);
  await expectOk("production marks ready", A.prod, `select public.staff_update_order_status($1, 'ready', null) ->> 'status' as r`, [id]);
  await expectFail("production cannot ship", A.prod, `select public.staff_update_order_status($1, 'out_for_delivery', null)`, [id], /personnel/);
  await expectFail("production cannot read messages", A.prod, `select public.staff_inbox()`, [], /personnel/);

  console.log("\n# Execution queue");
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await expectOk(`queued order ${i + 1}`, U.c2, `select public.place_client_order($1::jsonb, $2, null, null) as r`, [JSON.stringify([{ product_id: P.oranges, quantity: 1 }]), c2points[0].id]);
    await step("accept", U.staff, r?.[0]?.r?.id, "confirmed");
    ids.push(r?.[0]?.r?.id);
  }
  const rankOf = async (orderId) => Number((await db.query(`select production_rank from public.orders where id=$1`, [orderId])).rows[0].production_rank);
  const ranks = [await rankOf(ids[0]), await rankOf(ids[1]), await rankOf(ids[2])];
  ranks[0] < ranks[1] && ranks[1] < ranks[2] ? ok("accepted orders queue at the end in order", ranks) : bad("queue order", ranks);
  await expectOk("place 3rd before 1st", U.staff, `select public.staff_schedule_order($1, $2) as r`, [ids[2], ids[0]]);
  (await rankOf(ids[2])) < (await rankOf(ids[0])) ? ok("3rd now runs first") : bad("schedule before", [await rankOf(ids[2]), await rankOf(ids[0])]);
  await expectOk("place 1st between 3rd and 2nd", U.staff, `select public.staff_schedule_order($1, $2) as r`, [ids[0], ids[1]]);
  const order = (await db.query(`select id from public.orders where id = any($1) order by production_rank`, [ids])).rows.map((r) => ids.indexOf(r.id) + 1);
  JSON.stringify(order) === "[3,1,2]" ? ok("queue order 3 → 1 → 2") : bad("queue", order);
  await expectFail("production cannot reorder", A.prod, `select public.staff_schedule_order($1, null)`, [ids[0]], /administration/);
  await step("ship leaves the queue", U.staff, id, "out_for_delivery");
  (await db.query(`select production_rank from public.orders where id=$1`, [id])).rows[0].production_rank === null ? ok("shipped order removed from queue") : bad("rank after ship", "not null");

  console.log("\n# Per-client stock options");
  await db.exec(`update public.products set stock_quantity = 2 where slug = 'citron'`);
  await expectOk("admin disables stock management for client 2", A.admin, `update public.clients set stock_managed=false, show_stock=true where id=$1 returning stock_managed`, [c2]);
  const acct = await as(U.c2, `select public.my_account() -> 'client' as c`);
  acct[0].c.show_stock === true && acct[0].c.stock_managed === false ? ok("my_account exposes stock options") : bad("stock options", JSON.stringify(acct[0].c));
  const big = await expectOk("order above stock accepted without stock management", U.c2, `select public.place_client_order($1::jsonb, $2, null, null) as r`, [JSON.stringify([{ product_id: P.citron, quantity: 10 }]), c2points[0].id]);
  const stock = Number((await db.query(`select stock_quantity from public.products where slug='citron'`)).rows[0].stock_quantity);
  stock === 2 ? ok("stock untouched") : bad("stock changed", stock);
  const reserved = (await db.query(`select stock_reserved from public.orders where id=$1`, [big?.[0]?.r?.id])).rows[0].stock_reserved;
  reserved === false ? ok("order flagged without reservation") : bad("stock_reserved", reserved);
  await step("decline", U.staff, big?.[0]?.r?.id, "declined");
  Number((await db.query(`select stock_quantity from public.products where slug='citron'`)).rows[0].stock_quantity) === 2 ? ok("no restock for unreserved order") : bad("restock", "changed");
  await step("reopen", U.staff, big?.[0]?.r?.id, "awaiting_client");
  await expectOk("client reconfirms without stock check", U.c2, `select public.client_respond_order($1, true, null) ->> 'status' as r`, [big?.[0]?.r?.id]);
  await expectFail("managed client still limited by stock", U.c1, `select public.place_client_order($1::jsonb, null, null, null)`, [JSON.stringify([{ product_id: P.citron, quantity: 10 }])], /Stock insuffisant/);
}
