// Lot 2: a buyer with several suppliers, end to end.
export async function runBuyerJourneyChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Buyer journey across suppliers");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261117_buyer_journey.sql", "supabase/migrations/20261117_buyer_journey.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const R = "00000000-0000-0000-0000-0000000f0001";
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  const cat = (await as(R, `select public.buyer_catalog() as r`))[0].r;
  const aRel = cat.suppliers.find((s) => s.org_id === L);
  const zRel = cat.suppliers.find((s) => s.org_id === Z);
  const aP = cat.products.find((p) => p.client_id === aRel.client_id);
  const zP = cat.products.find((p) => p.client_id === zRel.client_id);
  "vat_rate" in aP ? ok("the buyer catalogue carries the VAT rate") : bad("vat", aP);

  // Reception QR per buyer.
  await sys(); await db.exec(`update public.clients set reception_qr = true, scan_client_qr = true where id in ('${aRel.client_id}', '${zRel.client_id}')`);
  const qr = (await as(R, `select public.my_reception_qr() as r`))[0].r;
  qr.token && qr.required ? ok("the buyer has one reception QR, required by its suppliers") : bad("qr", qr);
  const def = (await one(`select pg_get_functiondef('public.driver_deliver(uuid[], uuid[], text, uuid)'::regprocedure) as d`)).d;
  def.includes("b.reception_token") ? ok("drivers of every supplier accept the buyer's QR") : bad("driver_deliver", "not patched");

  // Notifications name the supplier.
  const placed = (await as(R, `select public.place_multi_order($1::jsonb) as r`, [JSON.stringify([
    { client_id: aRel.client_id, items: [{ product_id: aP.id, quantity: 1 }] },
    { client_id: zRel.client_id, items: [{ product_id: zP.id, quantity: 1 }] }])]))[0].r;
  const zOrder = placed.find((o) => o.client_id === zRel.client_id);
  const aOrder = placed.find((o) => o.client_id === aRel.client_id);
  await sys(); await db.exec(`insert into public.notifications (user_id, event, title, body, order_id) values ('${R}', 'order.status', 'Commande #${zOrder.order_number} acceptée', '', '${zOrder.id}')`);
  const n = await one(`select title from public.notifications where user_id = $1 order by created_at desc limit 1`, [R]);
  n.title.startsWith("Épicerie Zitouna · ") ? ok("a buyer's notification names its supplier", n.title) : bad("notification title", n);

  // Cancel / change before acceptance.
  const stockBefore = (await one(`select stock_quantity::numeric as s from public.products where id = $1`, [zP.id])).s;
  await expectOk("the buyer changes a pending order (quantity 3)", R, `select public.client_modify_order($1, $2::jsonb, 'Plutôt 3') ->> 'total' as r`, [zOrder.id, JSON.stringify([{ product_id: zP.id, quantity: 3 }])]);
  const items = await one(`select sum(quantity)::numeric as q, (select customer_note from public.orders where id = $1) as note from public.order_items where order_id = $1`, [zOrder.id]);
  Number(items.q) === 3 && items.note === "Plutôt 3" ? ok("lines and note replaced") : bad("modify", items);
  await expectFail("a product of another supplier cannot be slipped in", R, `select public.client_modify_order($1, $2::jsonb)`, [zOrder.id, JSON.stringify([{ product_id: aP.id, quantity: 1 }])], /plus disponible chez ce fournisseur/);
  await expectOk("the buyer cancels it", R, `select public.client_cancel_order($1) ->> 'status' as r`, [zOrder.id]);
  const after = await one(`select o.status::text as status, (select stock_quantity::numeric from public.products where id = $2) as s from public.orders o where o.id = $1`, [zOrder.id, zP.id]);
  after.status === "cancelled" && Number(after.s) === Number(stockBefore) + 1 ? ok("cancelled and stock given back", after) : bad("cancel", { after, stockBefore });
  const team = await one(`select count(*)::int as n from public.notifications where order_id = $1 and title like '%annulée par le client%'`, [zOrder.id]);
  team.n > 0 ? ok("the supplier's team is told") : bad("supplier alert", team);
  await sys(); await db.exec(`update public.orders set status = 'confirmed' where id = '${aOrder.id}'`);
  await expectFail("an accepted order can no longer be changed", R, `select public.client_cancel_order($1)`, [aOrder.id], /déjà traité/);
  await expectFail("another buyer cannot touch it", zitouna, `select public.client_cancel_order($1)`, [aOrder.id], /introuvable/);

  // Accounts and invoices of all suppliers.
  const accounts = (await as(R, `select public.buyer_accounts() as r`))[0].r;
  accounts.length === 2 ? ok("the buyer sees its account with each supplier") : bad("accounts", accounts);
  const st = await as(R, `select public.account_statement($1) -> 'figures' as f`, [zRel.client_id]);
  st[0].f ? ok("and the statement of a supplier that is not the selected one") : bad("statement", st);
  const inv = (await as(R, `select public.buyer_invoices() as r`))[0].r;
  Array.isArray(inv) && inv.every((i) => i.seller && i.supplier_name && i.status !== "draft") ? ok("invoices of all suppliers, each with its seller's details", inv.length) : bad("invoices", inv[0]);

  // Messages.
  const sent = await expectOk("one message to both suppliers", R, `select jsonb_array_length(public.buyer_send_message($1::uuid[], 'Fermé lundi')) as r`, [`{${aRel.client_id},${zRel.client_id}}`]);
  sent?.[0]?.r === 2 ? ok("a copy in each conversation") : bad("sent", sent);
  await expectFail("an attachment goes to one supplier only", R, `select public.buyer_send_message($1::uuid[], 'x', '{"path":"a"}'::jsonb)`, [`{${aRel.client_id},${zRel.client_id}}`], /seul fournisseur/);
  const inbox = (await as(R, `select public.buyer_inbox() as r`))[0].r;
  inbox.length === 2 && inbox.every((e) => e.last_body === "Fermé lundi") ? ok("the buyer's inbox: one conversation per supplier") : bad("inbox", inbox);
  await expectOk("Zitouna answers", zitouna, `select public.send_message_v3($1, 'Bien noté') as r`, [zRel.client_id]);
  const thread = (await as(R, `select public.buyer_thread($1) as r`, [zRel.client_id]))[0].r;
  thread[0].body === "Bien noté" ? ok("the buyer reads a non-selected supplier's conversation") : bad("thread", thread[0]);
  const unread = (await as(R, `select public.buyer_inbox() as r`))[0].r.find((e) => e.client_id === zRel.client_id).unread;
  Number(unread) === 0 ? ok("reading marks the answer read") : bad("unread", unread);
  await expectFail("a buyer cannot read a conversation that is not its own", zitouna, `select public.buyer_thread($1)`, [aRel.client_id], /introuvable/);
  const staffSent = await expectOk("AgriFresh writes to several clients at once", owner, `select jsonb_array_length(public.staff_send_messages(array(select id from public.clients where supplier_org_id = public.current_org_id() and link_status = 'active' limit 2), 'Fermeture exceptionnelle')) as r`);
  staffSent?.[0]?.r >= 1 ? ok("one copy per chosen client", staffSent[0].r) : bad("staff broadcast", staffSent);
  await expectFail("a supplier cannot write to another supplier's client", owner, `select public.staff_send_messages($1::uuid[], 'x')`, [`{${zRel.client_id}}`], /pas votre client/);

  const fig = await as(owner, `select public.staff_client_figures($1) as r`, [aRel.client_id]);
  fig[0].r && "outstanding" in fig[0].r ? ok("the supplier sees the outstanding figures when entering an order") : bad("figures", fig);
  await expectFail("but not for another supplier's client", owner, `select public.staff_client_figures($1)`, [zRel.client_id], /introuvable/);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration < "20261118").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
