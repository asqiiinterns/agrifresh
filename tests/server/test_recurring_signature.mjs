// Recurring orders, signature at delivery, migration check query.
export async function runRecurringSignatureChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P, c1 }) {
  console.log("\n# Recurring orders and signature");
  for (const f of ["supabase/migrations/20261104_recurring_signature.sql", "supabase/migrations/20261104_recurring_signature.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration <= "20261104").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows);
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const items = JSON.stringify([{ product_id: P.oranges, quantity: 2 }]);
  const tomorrowDow = ((new Date(Date.now() + 86400000).getDay() + 6) % 7) + 1;

  const rid = await expectOk("client programs a weekly order", U.c1, `select public.save_recurring_order(null, null, $1::jsonb, null, array[$2]::int[], 1, 'Chaque semaine') as r`, [items, tomorrowDow]);
  const row = await one(`select next_delivery, lead_days from public.recurring_orders where id = $1`, [rid[0].r]);
  ok("next delivery computed", row.next_delivery);
  await expectFail("empty weekdays refused", U.c1, `select public.save_recurring_order(null, null, $1::jsonb, null, array[]::int[])`, [items], /jour/);
  const before = await one(`select count(*)::int as n from public.orders where client_id = $1`, [c1]);
  const created = await expectOk("due orders are created", U.staff, `select public.run_recurring_orders() as r`);
  const after = await one(`select count(*)::int as n from public.orders where client_id = $1`, [c1]);
  created?.[0]?.r >= 1 && after.n === before.n + 1 ? ok("one order created for tomorrow") : bad("recurring run", { created, before, after });
  const again = await as(U.staff, `select public.run_recurring_orders() as r`);
  again[0].r === 0 ? ok("not created twice") : bad("idempotent", again);
  const moved = await one(`select next_delivery from public.recurring_orders where id = $1`, [rid[0].r]);
  String(moved.next_delivery) !== String(row.next_delivery) ? ok("next delivery moved a week later", moved.next_delivery) : bad("advance", moved);
  const note = await one(`select h.note from public.orders o join public.order_status_history h on h.order_id = o.id where o.id = (select last_order_id from public.recurring_orders where id = $1)`, [rid[0].r]);
  note?.note?.includes("récurrente") ? ok("traced as recurring") : bad("recurring trace", note);
  await expectFail("another client cannot delete it", U.c2, `select public.delete_recurring_order($1)`, [rid[0].r], /introuvable/);

  await db.exec(`update public.clients set custom_settings = array['delivery_signature','scan_delivery_note','scan_client_qr'], delivery_signature = true, scan_delivery_note = false, scan_client_qr = false where id = '${c1}'`);
  const order = await one(`select last_order_id as id from public.recurring_orders where id = $1`, [rid[0].r]);
  await db.exec(`update public.vehicles set active = false`);
  for (const st of ["confirmed", "preparing", "ready"]) await as(U.staff, `select public.staff_update_order_status($1, $2::public.order_status, null)`, [order.id, st]);
  await as(U.driver, `select public.driver_ship_orders(array[$1]::uuid[], null)`, [order.id]);
  const list = await as(U.driver, `select public.driver_shipments() as r`);
  list[0].r.find((s) => s.id === order.id)?.delivery_token ? ok("driver list carries the delivery token (offline scans)") : bad("token", list[0].r);
  await expectFail("signature required for this client", U.driver, `select public.driver_deliver_v2(array[$1]::uuid[], null)`, [order.id], /signer/);
  const sig = JSON.stringify({ path: "M10 10 L50 40 L90 20", width: 300, height: 150 });
  await expectOk("delivered with signature", U.driver, `select public.driver_deliver_v2(array[$1]::uuid[], null, null, null, $2::jsonb, 'M. Ben Salah') as r`, [order.id, sig]);
  const signed = await one(`select delivery_signature ->> 'signer' as signer from public.orders where id = $1`, [order.id]);
  signed.signer === "M. Ben Salah" ? ok("signature stored with the signer's name") : bad("signature", signed);
  await db.exec(`update public.clients set custom_settings = '{}' where id = '${c1}'`);
}
