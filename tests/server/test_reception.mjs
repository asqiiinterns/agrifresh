// 20261204_reception_qr.sql: the driver scans the delivery notes, then the reception QR shown in the client's app.
export async function runReceptionChecks({ db, file, ok, bad, as }) {
  console.log("\n# Reception QR after the delivery notes");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261204_reception_qr.sql", "supabase/migrations/20261204_reception_qr.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const customers = (await db.query(`select pr.id, pr.client_id, c.supplier_org_id, c.business_name
    from public.profiles pr join public.clients c on c.id = pr.client_id
    where pr.role = 'customer' and pr.account_status = 'active' and c.active and c.buyer_org_id is not null
      and exists (select 1 from public.orders o where o.client_id = c.id)
      and exists (select 1 from public.profiles d where d.org_id = c.supplier_org_id and d.role = 'driver' and d.account_status = 'active')`)).rows;
  if (!customers.length) { bad("reception QR", "no customer with orders and a driver"); return; }
  const cu = customers[0];
  const drv = await one(`select id from public.profiles where org_id = $1 and role = 'driver' and account_status = 'active' limit 1`, [cu.supplier_org_id]);
  await sys();
  await db.exec(`insert into public.org_modules (org_id, key, granted, enabled) values ('${cu.supplier_org_id}', 'delivery_qr', true, true)
    on conflict (org_id, key) do update set granted = true, enabled = true`);
  const o = await one(`select id, delivery_token, delivery_point_id from public.orders where client_id = $1 order by created_at limit 1`, [cu.client_id]);
  const point = await one(`select qr_token from public.client_delivery_points where id = $1`, [o.delivery_point_id]);
  const deliver = async (label, kind, token, expectOk, pattern) => {
    await sys();
    await db.exec(`update public.orders set status = 'out_for_delivery', delivered_at = null where id = '${o.id}'`);
    try {
      await as(drv.id, `select public.driver_deliver(array[]::uuid[], array[$1]::uuid[], $2, $3) as n`, [o.delivery_token, kind, token]);
      expectOk ? ok(label) : bad(label, "should have been refused");
    } catch (e) {
      !expectOk && (!pattern || pattern.test(e.message)) ? ok(`${label} → refused: ${e.message}`) : bad(label, e.message);
    }
  };
  // What ClientOrdersScreen shows.
  const shownQr = async () => {
    const acct = (await as(cu.id, `select public.my_account() as a`))[0].a;
    const qr = (await as(cu.id, `select public.my_reception_qr() as r`))[0].r;
    return qr?.token ?? (acct.client?.reception_qr ? acct.client.reception_token : null);
  };
  const setMode = async (reception) => {
    await sys();
    await db.exec(`update public.clients set custom_settings = array['reception_qr','scan_client_qr','scan_delivery_note','delivery_signature'],
      reception_qr = ${reception}, scan_client_qr = true, scan_delivery_note = true, delivery_signature = false where id = '${cu.client_id}'`);
  };

  await setMode(true);
  await deliver("reception mode: the QR shown in the client's app is accepted", "client", await shownQr(), true);
  await deliver("reception mode: the wall QR is still refused", "point", point.qr_token, false, /réception/);

  await setMode(false);
  const token = await shownQr();
  token ? ok("the buyer still shows its single reception QR") : bad("shown QR", token);
  await deliver("wall-QR mode: the client's reception QR is accepted too (was blocking)", "client", token, true);
  const proof = await one(`select note from public.order_status_history where order_id = $1 and status = 'delivered' order by created_at desc limit 1`, [o.id]);
  proof?.note.includes("réception") ? ok("the hand-over is traced with the reception QR", proof.note) : bad("trace", proof);
  await deliver("wall-QR mode: the wall QR still works", "point", point.qr_token, true);
  await deliver("wall-QR mode: another buyer's reception QR is refused", "client", "00000000-0000-0000-0000-000000000001", false, /pas celui de ce client/);

  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((r) => r.migration <= "20261204_reception_qr.sql").every((r) => r.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((r) => r.etat !== "OK"));
}
