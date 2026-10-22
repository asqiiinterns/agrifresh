// Numbering, returns, credit notes, alert notes.
export async function runNumberingReturnChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P, c1 }) {
  console.log("\n# Numbering, returns and credit notes");
  for (const f of ["supabase/migrations/20261030_numbering_returns.sql", "supabase/migrations/20261030_numbering_returns.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const A = { admin: "00000000-0000-0000-0000-0000000000a1" };
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

  const al = await one(`select id from public.notifications where user_id = $1 limit 1`, [U.c1]);
  await expectOk("client marks an alert unread", U.c1, `select public.mark_notifications_unread(array[$1]::uuid[]) as r`, [al.id]);
  await expectOk("client adds a note", U.c1, `select public.set_notification_note($1, 'Rappeler le livreur') as r`, [al.id]);
  const n = await one(`select read_at, note from public.notifications where id = $1`, [al.id]);
  n.read_at === null && n.note === "Rappeler le livreur" ? ok("alert unread with note") : bad("alert note", n);
  await expectFail("someone else cannot annotate", U.c2, `select public.set_notification_note($1, 'x')`, [al.id], /introuvable/);

  const nums = (await db.query(`select doc_type, prefix, next_number from public.document_numbering order by doc_type`)).rows;
  ok("numbering seeded", nums.map((r) => `${r.doc_type}:${r.prefix}${r.next_number}`));
  await expectFail("supervisor cannot change numbering", U.staff, `select public.admin_set_numbering('delivery_note', 'BL', false, 4, 500, false)`, [], /administrateurs/);
  await expectOk("admin sets BL format and start", A.admin, `select public.admin_set_numbering('delivery_note', 'BL/', true, 4, 500, false) as r`);
  await expectOk("admin sets invoice start", A.admin, `select public.admin_set_numbering('invoice', 'F-', true, 6, 1000, true) as r`);
  const items = JSON.stringify([{ product_id: P.oranges, quantity: 3 }, { product_id: P.tomates, quantity: 2 }]);
  const o = await expectOk("order", U.c1, `select public.place_client_order($1::jsonb, null, null, null) as r`, [items]);
  const id = o?.[0]?.r?.id;
  await db.exec(`update public.clients set custom_settings = array['scan_delivery_note','scan_client_qr','invoice_mode'], scan_delivery_note = false, scan_client_qr = false, invoice_mode = 'auto' where id = '${c1}'`);
  await as(U.staff, `select public.staff_update_order_status($1, 'confirmed', null)`, [id]);
  const bl = await one(`select delivery_note_number, client_invoice_id from public.orders where id = $1`, [id]);
  /^BL\/\d{4}-0500$/.test(bl.delivery_note_number) ? ok("BL numbered with the new format", bl.delivery_note_number) : bad("BL number", bl);
  const inv = await one(`select invoice_number from public.client_invoices where id = $1`, [bl.client_invoice_id]);
  /^F-\d{4}-001000$/.test(inv?.invoice_number ?? "") ? ok("invoice numbered from the new start", inv.invoice_number) : bad("invoice number", inv);
  for (const st of ["preparing", "ready"]) await as(U.staff, `select public.staff_update_order_status($1, $2::public.order_status, null)`, [id, st]);
  await as(U.driver, `select public.driver_ship_orders(array[$1]::uuid[], null)`, [id]).catch(async () => {
    await db.exec(`update public.vehicles set active = false`);
    await as(U.driver, `select public.driver_ship_orders(array[$1]::uuid[], null)`, [id]);
  });
  await expectOk("delivered", U.driver, `select public.driver_deliver(array[$1]::uuid[], null, null, null) as r`, [id]);

  const stockBefore = (await one(`select stock_quantity from public.products where id = $1`, [P.oranges])).stock_quantity;
  await expectFail("too many returned", U.c1, `select public.client_request_return($1, $2::jsonb, 'quality')`, [id, JSON.stringify([{ product_id: P.oranges, quantity: 9 }])], /invalide/);
  const r = await expectOk("client asks to return 2 kg", U.c1, `select public.client_request_return($1, $2::jsonb, 'quality', 'Abîmées') as r`, [id, JSON.stringify([{ product_id: P.oranges, quantity: 2 }])]);
  const rid = r?.[0]?.r?.id;
  /^RT-\d{4}-00001$/.test(r?.[0]?.r?.return_number ?? "") ? ok("return numbered", r[0].r.return_number) : bad("return number", r);
  const alerted = await one(`select count(*)::int as n from public.notifications where event = 'return.new'`);
  alerted.n > 0 ? ok("team alerted of the return") : bad("return alert", alerted);
  await expectFail("client cannot approve", U.c1, `select public.staff_update_return($1, 'approve')`, [rid], /ne permet pas/);
  await expectFail("cannot receive before approval", U.staff, `select public.staff_update_return($1, 'receive')`, [rid], /impossible/);
  await expectOk("approve", U.staff, `select public.staff_update_return($1, 'approve', 'OK reprise') as r`, [rid]);
  await expectOk("receive with restock", U.staff, `select public.staff_update_return($1, 'receive', null, true) as r`, [rid]);
  const stockAfter = (await one(`select stock_quantity from public.products where id = $1`, [P.oranges])).stock_quantity;
  Number(stockAfter) === Number(stockBefore) + 2 ? ok("stock put back", stockAfter) : bad("restock", { stockBefore, stockAfter });
  const cn = await expectOk("credit note from the return, issued", U.staff, `select public.staff_credit_return($1, true) as r`, [rid]);
  const credit = cn?.[0]?.r;
  /^AV-\d{4}-00001$/.test(credit?.credit_number ?? "") && Number(credit.total_ttc) > 0 ? ok("credit note issued", credit) : bad("credit", credit);
  const ret = await one(`select status from public.returns where id = $1`, [rid]);
  ret.status === "credited" ? ok("return credited") : bad("return status", ret);
  const seen = await as(U.c1, `select count(*)::int as n from public.credit_notes`);
  seen[0].n === 1 ? ok("client sees its credit note") : bad("client credit", seen);
  await expectOk("mark refunded", U.staff, `select public.staff_update_credit_note($1, 'refunded') as r`, [credit.id]);
  const free = await expectOk("free credit note (draft)", U.staff, `select public.staff_create_credit_note($1, null, 'Geste commercial', $2::jsonb, false) as r`, [c1, JSON.stringify([{ label: "Remise fidélité", quantity: 1, unit_price: 10, vat_rate: 19 }])]);
  const draftId = free?.[0]?.r?.id;
  const hidden = await as(U.c1, `select count(*)::int as n from public.credit_notes where id = $1`, [draftId]);
  hidden[0].n === 0 ? ok("draft hidden from the client") : bad("draft visibility", hidden);
  const total = await one(`select total_ttc from public.credit_notes where id = $1`, [draftId]);
  Number(total.total_ttc) === 11.9 ? ok("totals with VAT", total.total_ttc) : bad("credit totals", total);
  await expectOk("delete the draft", U.staff, `select public.staff_update_credit_note($1, 'delete') as r`, [draftId]);
  const audit = await one(`select count(*)::int as n from public.audit_log where entity in ('returns', 'credit_notes')`);
  audit.n > 0 ? ok("returns and credit notes in the audit log", audit.n) : bad("audit", audit);
  await db.exec(`update public.clients set custom_settings = '{}' where id = '${c1}'`);
}
