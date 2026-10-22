// 20261127_default_vehicle.sql: shipping is never blocked for a vehicle.
export async function runVehicleChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Default vehicle");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261127_default_vehicle.sql", "supabase/migrations/20261127_default_vehicle.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  await sys(); await db.exec(`update public.vehicles set active = true where org_id = '${L}' and label in ('Camion A', 'Camion B'); delete from public.vehicles where org_id = '${Z}'`);
  const vB = (await one(`select id from public.vehicles where org_id = $1 and label = 'Camion B'`, [L])).id;
  const vA = (await one(`select id from public.vehicles where org_id = $1 and label = 'Camion A'`, [L])).id;
  await expectOk("AgriFresh marks Camion B as its default vehicle", owner, `select public.set_default_vehicle($1) as r`, [vB]);
  await expectFail("another Pro cannot", zitouna, `select public.set_default_vehicle($1)`, [vA], /introuvable|ne permet/);

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
  // Without a choice: the default vehicle
  const o1 = await place(owner, L);
  const s1 = (await as(owner, `select public.driver_ship_orders(array[$1]::uuid[], null) as r`, [o1]))[0].r;
  const n1 = await one(`select note from public.order_status_history where order_id = $1 and status = 'out_for_delivery'`, [o1]);
  s1.vehicle === "Camion B" && n1.note.includes("(par défaut)") ? ok("no vehicle chosen: the default one, said in the history", n1.note) : bad("default", { s1, n1 });
  // Planned vehicle kept
  const o2 = await place(owner, L);
  await as(owner, `select public.staff_plan_vehicle($1, $2)`, [o2, vA]);
  const s2 = (await as(owner, `select public.driver_ship_orders(array[$1]::uuid[], null) as r`, [o2]))[0].r;
  const forced = await one(`select count(*)::int as n from public.notifications where order_id = $1 and event = 'order.forced'`, [o2]);
  s2.vehicle === "Camion A" && forced.n === 0 ? ok("the planned vehicle is used, nothing forced") : bad("planned", { s2, forced });
  // The order's "Expédier" button with a fleet
  const o3 = await place(owner, L);
  const s3 = (await as(owner, `select public.staff_update_order_status($1, 'out_for_delivery', null) as r`, [o3]))[0].r;
  s3.status === "out_for_delivery" && s3.vehicle === "Camion B" ? ok("the « Expédier » button ships with the default vehicle") : bad("button", s3);
  // A Pro without any vehicle (AgriFresh has a fleet): no block
  const o4 = await place(zitouna, Z);
  const s4 = (await as(zitouna, `select public.staff_update_order_status($1, 'out_for_delivery', null) as r`, [o4]))[0].r;
  s4.status === "out_for_delivery" && !s4.vehicle ? ok("a Pro without vehicles ships without one (another Pro's fleet does not matter)") : bad("no fleet", s4);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((r) => r.migration <= "20261127_default_vehicle.sql").every((r) => r.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((r) => r.etat !== "OK"));
}
