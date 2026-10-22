// Reconfirmation by the client and invoice drafts.
export async function runReconfirmChecks({ db, file, ok, bad, as, expectOk, expectFail, step, U, P, c1, c2, c2points }) {
  console.log("\n# Reconfirm & drafts migration");
  for (const f of ["supabase/migrations/20261020_1_enums.sql", "supabase/migrations/20261020_2_reconfirm_drafts.sql", "supabase/migrations/20261020_2_reconfirm_drafts.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const stockOf = async (slug) => Number((await db.query(`select stock_quantity from public.products where slug=$1`, [slug])).rows[0].stock_quantity);

  console.log("\n# Declined → awaiting client → reconfirmed");
  const start = await stockOf("tomates");
  const o = await expectOk("client 1 orders 6 kg tomatoes", U.c1, `select public.place_client_order($1::jsonb, null, null, null) as r`, [JSON.stringify([{ product_id: P.tomates, quantity: 6 }])]);
  const id = o?.[0]?.r?.id;
  await step("staff declines", U.staff, id, "declined", "Pas de livraison ce jour");
  (await stockOf("tomates")) === start ? ok("stock released on decline") : bad("decline stock", await stockOf("tomates"));
  await expectFail("client cannot reconfirm a declined order", U.c1, `select public.client_respond_order($1, true, null)`, [id], /n’attend pas/);
  await step("staff reopens for reconfirmation", U.staff, id, "awaiting_client", "Livraison possible demain");
  await expectFail("staff cannot confirm in place of the client", U.staff, `select public.staff_update_order_status($1, 'confirmed', null)`, [id], /Seul le client/);
  await expectFail("another client cannot answer", U.c2, `select public.client_respond_order($1, true, null)`, [id], /introuvable/);
  const seen = await as(U.c1, `select status, status_note from public.orders where id=$1`, [id]);
  ok("client sees status + reason", seen[0]);
  await expectOk("client reconfirms", U.c1, `select public.client_respond_order($1, true, null) ->> 'status' as r`, [id]);
  (await stockOf("tomates")) === start - 6 ? ok("stock reserved again", await stockOf("tomates")) : bad("reconfirm stock", await stockOf("tomates"));
  const inv = (await db.query(`select i.status, i.invoice_number from public.client_invoices i join public.orders o on o.client_invoice_id=i.id where o.id=$1`, [id])).rows[0];
  inv?.status === "issued" && inv.invoice_number ? ok("auto-mode client: invoice issued on reconfirmation", inv.invoice_number) : bad("auto invoice on reconfirm", JSON.stringify(inv));
  const history = await as(U.c1, `select h.status, h.changed_by = o.customer_id as by_client, h.note from public.order_status_history h join public.orders o on o.id=h.order_id where h.order_id=$1 order by h.created_at, h.id`, [id]);
  ok("timeline visible to client", history.map((h) => `${h.status}${h.by_client ? "(client)" : "(staff)"}`));

  console.log("\n# Awaiting client → refused / cancelled");
  const o2 = await expectOk("client 1 second order", U.c1, `select public.place_client_order($1::jsonb, null, null, null) as r`, [JSON.stringify([{ product_id: P.tomates, quantity: 2 }])]);
  const id2 = o2?.[0]?.r?.id;
  await step("decline", U.staff, id2, "declined");
  await step("reopen", U.staff, id2, "awaiting_client");
  const before = await stockOf("tomates");
  await expectOk("client refuses", U.c1, `select public.client_respond_order($1, false, 'Plus besoin') ->> 'status' as r`, [id2]);
  (await stockOf("tomates")) === before ? ok("no stock change on refusal") : bad("refusal stock", await stockOf("tomates"));
  const o3 = await expectOk("client 1 third order", U.c1, `select public.place_client_order($1::jsonb, null, null, null) as r`, [JSON.stringify([{ product_id: P.tomates, quantity: 1 }])]);
  const id3b = o3?.[0]?.r?.id;
  await step("decline", U.staff, id3b, "declined"); await step("reopen", U.staff, id3b, "awaiting_client");
  const before3 = await stockOf("tomates");
  await step("staff cancels while awaiting client", U.staff, id3b, "cancelled");
  (await stockOf("tomates")) === before3 ? ok("no double restock on cancel from awaiting") : bad("cancel awaiting stock", await stockOf("tomates"));
  await db.exec(`update public.products set stock_quantity = 0 where slug = 'citron'`);
  const o4 = await expectOk("order before stock runs out", U.c2, `select public.place_client_order($1::jsonb, $2, null, null) as r`, [JSON.stringify([{ product_id: P.oranges, quantity: 1 }]), c2points[0].id]);
  const id4 = o4?.[0]?.r?.id;
  await step("decline", U.staff, id4, "declined"); await step("reopen", U.staff, id4, "awaiting_client");
  await db.exec(`update public.products set stock_quantity = 0 where slug = 'oranges'`);
  await expectFail("reconfirm refused without stock", U.c2, `select public.client_respond_order($1, true, null)`, [id4], /Stock insuffisant/);
  await db.exec(`update public.products set stock_quantity = 50 where slug in ('oranges','citron')`);

  console.log("\n# Invoice drafts");
  const accepted = [];
  for (let i = 0; i < 2; i += 1) {
    const r = await expectOk(`client 2 order ${i + 1}`, U.c2, `select public.place_client_order($1::jsonb, $2, null, null) as r`, [JSON.stringify([{ product_id: P.dattes, quantity: 1 }]), c2points[0].id]);
    await step("accept", U.staff, r?.[0]?.r?.id, "confirmed");
    accepted.push(r?.[0]?.r?.id);
  }
  const seqBefore = (await db.query(`select last_value from public.client_invoice_number_seq`)).rows[0].last_value;
  const draft = await expectOk("staff saves a draft with 1 BL", U.staff, `select public.staff_create_invoice($1, array[$2]::uuid[], true) as r`, [c2, accepted[0]]);
  const draftId = draft?.[0]?.r?.id;
  draft?.[0]?.r?.invoice_number === null ? ok("draft has no number") : bad("draft number", draft?.[0]?.r?.invoice_number);
  const seqAfter = (await db.query(`select last_value from public.client_invoice_number_seq`)).rows[0].last_value;
  String(seqBefore) === String(seqAfter) ? ok("no number consumed by the draft") : bad("sequence", [seqBefore, seqAfter]);
  const hidden = await as(U.c2, `select count(*)::int as n from public.client_invoices where id=$1`, [draftId]);
  hidden[0].n === 0 ? ok("draft hidden from client") : bad("draft visible", hidden[0].n);
  await expectOk("staff adds the 2nd BL to the draft", U.staff, `select public.staff_update_invoice_draft($1, array[$2,$3]::uuid[]) as r`, [draftId, accepted[0], accepted[1]]);
  const totals = (await db.query(`select total_ht, total_vat, total_ttc from public.client_invoices where id=$1`, [draftId])).rows[0];
  Number(totals.total_ht) === 29 && Number(totals.total_vat) === 2.03 ? ok("draft totals refreshed (2 × dates, TVA 7 %)", totals) : bad("draft totals", JSON.stringify(totals));
  await expectFail("draft cannot be marked paid", U.staff, `select public.staff_set_invoice_status($1, 'paid')`, [draftId], /brouillon/);
  await step("cancel one order of the draft", U.staff, accepted[1], "cancelled");
  const afterCancel = (await db.query(`select total_ht from public.client_invoices where id=$1`, [draftId])).rows[0];
  Number(afterCancel.total_ht) === 14.5 ? ok("cancelled order removed from the draft", afterCancel.total_ht) : bad("draft after cancel", afterCancel.total_ht);
  const issued = await expectOk("staff issues the draft", U.staff, `select public.staff_issue_invoice($1) ->> 'invoice_number' as r`, [draftId]);
  await expectFail("issued invoice cannot be edited as draft", U.staff, `select public.staff_update_invoice_draft($1, array[$2]::uuid[])`, [draftId, accepted[0]], /brouillon/);
  await expectFail("issued invoice cannot be deleted", U.staff, `select public.staff_delete_invoice_draft($1)`, [draftId], /brouillon/);
  const visible = await as(U.c2, `select invoice_number from public.client_invoices where id=$1`, [draftId]);
  visible.length === 1 ? ok("issued invoice visible to client", visible[0].invoice_number) : bad("issued visibility", visible.length);
  const r3 = await expectOk("client 2 order 3", U.c2, `select public.place_client_order($1::jsonb, $2, null, null) as r`, [JSON.stringify([{ product_id: P.dattes, quantity: 1 }]), c2points[0].id]);
  await step("accept", U.staff, r3?.[0]?.r?.id, "confirmed");
  const d2 = await expectOk("another draft", U.staff, `select public.staff_create_invoice($1, array[$2]::uuid[], true) ->> 'id' as r`, [c2, r3?.[0]?.r?.id]);
  await expectOk("delete draft", U.staff, `select public.staff_delete_invoice_draft($1) as r`, [d2?.[0]?.r]);
  const freed = (await db.query(`select client_invoice_id from public.orders where id=$1`, [r3?.[0]?.r?.id])).rows[0].client_invoice_id;
  freed === null ? ok("deleted draft releases its BL") : bad("delete draft", freed);
  await expectFail("client cannot create drafts", U.c2, `select public.staff_create_invoice($1, array[$2]::uuid[], true)`, [c2, r3?.[0]?.r?.id], /personnel/);
}
