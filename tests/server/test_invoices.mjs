// Appended to test.mjs at runtime: invoicing, VAT and two-scan delivery checks.
export async function runInvoiceChecks({ db, file, ok, bad, as, expectOk, expectFail, step, U, P, c1, c2, c2points, id1, id3 }) {
  console.log("\n# Invoices & delivery notes migration");
  for (const f of ["supabase/migrations/20261019_invoices_delivery_notes.sql", "supabase/migrations/20261019_invoices_delivery_notes.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  await db.exec(`update public.products set vat_rate = 19 where slug = 'jus-orange'; update public.products set vat_rate = 7 where slug = 'dattes';`);
  await expectOk("staff sets client 1 options", U.staff, `update public.clients set invoice_mode='auto', show_prices=false, reception_qr=true, tax_id='1234567/A' where id=$1 returning invoice_mode`, [c1]);
  await expectFail("bad invoice mode refused", U.staff, `update public.clients set invoice_mode='weekly' where id=$1`, [c1], /check constraint/);
  const acct2 = await as(U.c1, `select public.my_account() as a`);
  const cl = acct2[0].a.client;
  cl.show_prices === false && cl.reception_qr === true && cl.reception_token ? ok("my_account exposes display & reception options") : bad("my_account options", JSON.stringify(cl));
  const acct3 = await as(U.c2, `select public.my_account() as a`);
  acct3[0].a.client.reception_token === null ? ok("reception token hidden when option off") : bad("token leak", JSON.stringify(acct3[0].a.client));

  console.log("\n# Automatic invoice on acceptance");
  const o5 = await expectOk("client 1 orders juice + oranges", U.c1, `select public.place_client_order($1::jsonb, null, null, null) as r`, [JSON.stringify([{ product_id: P["jus-orange"], quantity: 2 }, { product_id: P.oranges, quantity: 3 }])]);
  const id5 = o5?.[0]?.r?.id;
  const vatSnap = (await db.query(`select vat_rate from public.order_items where order_id=$1 order by vat_rate desc`, [id5])).rows.map((r) => Number(r.vat_rate));
  ok("VAT snapshot on lines", vatSnap);
  await step("accept (auto mode)", U.staff, id5, "confirmed");
  const inv5 = (await db.query(`select i.invoice_number, i.total_ht, i.total_vat, i.stamp_duty, i.total_ttc from public.client_invoices i join public.orders o on o.client_invoice_id=i.id where o.id=$1`, [id5])).rows[0];
  inv5 && Number(inv5.total_ht) === 29.6 && Number(inv5.total_vat) === 3.23 && Number(inv5.total_ttc) === 33.83
    ? ok("auto invoice HT 29.600 / TVA 3.230 / timbre 1 / TTC 33.830", inv5.invoice_number) : bad("auto invoice", JSON.stringify(inv5));
  const clientInv = await as(U.c1, `select count(*)::int as n from public.client_invoices`);
  const otherInv = await as(U.c2, `select count(*)::int as n from public.client_invoices`);
  clientInv[0].n === 1 && otherInv[0].n === 0 ? ok("invoices visible only to their client") : bad("invoice visibility", JSON.stringify([clientInv, otherInv]));

  console.log("\n# Manual invoice");
  const o6 = await expectOk("client 2 orders dates", U.c2, `select public.place_client_order($1::jsonb, $2, null, null) as r`, [JSON.stringify([{ product_id: P.dattes, quantity: 2 }]), c2points[0].id]);
  const id6 = o6?.[0]?.r?.id;
  await step("accept (manual mode)", U.staff, id6, "confirmed");
  const none = (await db.query(`select client_invoice_id from public.orders where id=$1`, [id6])).rows[0].client_invoice_id;
  none === null ? ok("no automatic invoice in manual mode") : bad("manual mode", none);
  await expectFail("client cannot create invoices", U.c2, `select public.staff_create_invoice($1, array[$2]::uuid[])`, [c2, id6], /personnel/);
  await expectFail("cannot invoice another client's order", U.staff, `select public.staff_create_invoice($1, array[$2]::uuid[])`, [c2, id5], /facturé|autre client/);
  const manual = await expectOk("staff groups 2 delivery notes on one invoice", U.staff, `select public.staff_create_invoice($1, array[$2, $3]::uuid[]) as r`, [c2, id6, id3]);
  await expectFail("delivery note cannot be invoiced twice", U.staff, `select public.staff_create_invoice($1, array[$2]::uuid[])`, [c2, id6], /facturé/);
  const manualId = manual?.[0]?.r?.id;
  await expectOk("mark invoice paid", U.staff, `select public.staff_set_invoice_status($1, 'paid') as r`, [manualId]);
  await expectFail("cancel order sharing an invoice refused", U.staff, `select public.staff_update_order_status($1, 'cancelled', null)`, [id6], /annulez d/);
  await expectOk("cancel invoice", U.staff, `select public.staff_set_invoice_status($1, 'cancelled') as r`, [manualId]);
  const released = (await db.query(`select count(*)::int as n from public.orders where id in ($1,$2) and client_invoice_id is null`, [id6, id3])).rows[0].n;
  released === 2 ? ok("delivery notes released", released) : bad("release", released);
  await expectFail("cancelled invoice is frozen", U.staff, `select public.staff_set_invoice_status($1, 'paid')`, [manualId], /ne peut plus/);

  console.log("\n# Two-scan delivery");
  const tokens = Object.fromEntries((await db.query(`select id, delivery_token from public.orders`)).rows.map((r) => [r.id, r.delivery_token]));
  const lacQr = c2points[0].qr_token, marsaQr = c2points[1].qr_token;
  await expectFail("old single-scan revoked", U.driver, `select public.driver_confirm_delivery($1, array[$2]::uuid[])`, [lacQr, id3], /permission denied/);
  await expectOk("driver scans delivery note", U.driver, `select public.driver_lookup_delivery($1) ->> 'business_name' as r`, [tokens[id3]]);
  await expectFail("delivery note not shipped", U.driver, `select public.driver_lookup_delivery($1)`, [tokens[id6]], /pas en cours de livraison/);
  await expectFail("wrong point QR refused", U.driver, `select public.driver_confirm_handover(array[$1]::uuid[], 'point', $2)`, [tokens[id3], marsaQr], /ne correspond pas/);
  await expectFail("two clients in one handover refused", U.driver, `select public.driver_confirm_handover(array[$1,$2]::uuid[], 'point', $3)`, [tokens[id3], tokens[id1], lacQr], /plusieurs clients/);
  await expectOk("BL + point QR delivers", U.driver, `select public.driver_confirm_handover(array[$1]::uuid[], 'point', $2) as n`, [tokens[id3], lacQr]);
  await step("client 1 order → preparing", U.staff, id5, "preparing");
  await step("→ ready", U.staff, id5, "ready");
  await step("→ shipped", U.staff, id5, "out_for_delivery");
  const c1point = (await db.query(`select qr_token from public.client_delivery_points where client_id=$1`, [c1])).rows[0].qr_token;
  await expectFail("reception-QR client: wall QR refused", U.driver, `select public.driver_confirm_handover(array[$1, $2]::uuid[], 'point', $3)`, [tokens[id5], tokens[id1], c1point], /QR de réception/);
  await expectOk("reception-QR client: 2 BLs + client QR", U.driver, `select public.driver_confirm_handover(array[$1, $2]::uuid[], 'client', $3) as n`, [tokens[id5], tokens[id1], cl.reception_token]);
  const hist = await as(U.driver, `select jsonb_array_length(public.driver_history(current_date - 30)) as n`);
  ok("driver history (own deliveries)", hist[0].n);
  await expectFail("client cannot read delivery history", U.c1, `select public.driver_history(current_date)`, [], /livreurs/);
  const histStaff = await as(U.staff, `select jsonb_array_length(public.driver_history(current_date - 30)) as n`);
  ok("staff history (all deliveries)", histStaff[0].n);
  await expectFail("staff cannot skip scan", U.staff, `select public.staff_update_order_status($1, 'delivered', null)`, [id6], /Transition impossible|bon de livraison/);
}
