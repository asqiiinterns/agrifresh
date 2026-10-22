// Product origin, staff catalogue and claims (applied with 20261020_2).
export async function runOriginClaimChecks({ db, ok, bad, as, expectOk, expectFail, step, U, P, c1, c2 }) {
  console.log("\n# Product origin & catalogue");
  await expectOk("staff sets product origin", U.staff, `update public.products set origin_producer='Ferme Ben Salah', origin_region='Cap Bon', origin_label='Agriculture raisonnée', origin_note='Cueillies à la main' where id=$1 returning origin_region`, [P.oranges]);
  const edited = await as(U.c1, `update public.products set price=0 where id=$1 returning id`, [P.oranges]);
  edited.length === 0 ? ok("client update matches no row (RLS)") : bad("client edit", edited.length);
  const priceAfter = Number((await db.query(`select price from public.products where id=$1`, [P.oranges])).rows[0].price);
  priceAfter > 0 ? ok("client edit had no effect", priceAfter) : bad("client edited price", priceAfter);
  const cat = (await db.query(`select id from public.categories where slug='fruits'`)).rows[0].id;
  const created = await expectOk("staff creates an inactive product", U.staff, `insert into public.products (category_id, name, slug, unit_label, price, vat_rate, stock_quantity, active) values ($1,'Figues','figues','kg',12,0,20,false) returning id`, [cat]);
  const staffSees = await as(U.staff, `select count(*)::int as n from public.products where slug='figues'`);
  const clientSees = await as(U.c1, `select count(*)::int as n from public.products where slug='figues'`);
  staffSees[0].n === 1 && clientSees[0].n === 0 ? ok("inactive product visible to staff only") : bad("inactive visibility", [staffSees[0].n, clientSees[0].n]);
  await expectOk("staff sets client 1 show_origin", U.staff, `update public.clients set show_origin=true where id=$1 returning show_origin`, [c1]);
  const acct = await as(U.c1, `select public.my_account() -> 'client' ->> 'show_origin' as r`);
  acct[0].r === "true" ? ok("my_account exposes show_origin") : bad("show_origin", acct[0].r);
  const o = await expectOk("client 1 orders oranges", U.c1, `select public.place_client_order($1::jsonb, null, null, null) as r`, [JSON.stringify([{ product_id: P.oranges, quantity: 1 }, { product_id: P.tomates, quantity: 1 }])]);
  const id = o?.[0]?.r?.id;
  const snaps = (await db.query(`select product_name_snapshot as n, origin_snapshot as o from public.order_items where order_id=$1 order by n`, [id])).rows;
  snaps.find((s) => s.n.startsWith("Oranges"))?.o?.region === "Cap Bon" && snaps.find((s) => s.n.startsWith("Tomates"))?.o === null
    ? ok("origin frozen on the order line (null when none)", snaps.map((s) => s.o)) : bad("origin snapshot", JSON.stringify(snaps));
  await db.exec(`update public.products set origin_region='Sahel' where slug='oranges'`);
  const frozen = (await db.query(`select origin_snapshot ->> 'region' as r from public.order_items where order_id=$1 and product_name_snapshot like 'Oranges%'`, [id])).rows[0].r;
  frozen === "Cap Bon" ? ok("later product edits do not change past orders") : bad("snapshot changed", frozen);

  console.log("\n# Claims");
  await step("accept", U.staff, id, "confirmed");
  const claim = await expectOk("client files a claim", U.c1, `select public.client_create_claim($1, 'quality', 'Deux oranges abîmées') as r`, [id]);
  const claimId = claim?.[0]?.r?.id;
  await expectFail("claim reason required", U.c1, `select public.client_create_claim($1, 'nope', 'x')`, [id], /motif/);
  await expectFail("another client cannot claim on this order", U.c2, `select public.client_create_claim($1, 'other', 'x')`, [id], /introuvable/);
  await expectFail("client cannot insert claims directly", U.c1, `insert into public.claims (order_id, client_id, reason, description) values ($1,$2,'other','x')`, [id, c1], /permission denied/);
  const mine = await as(U.c1, `select count(*)::int as n from public.claims`);
  const theirs = await as(U.c2, `select count(*)::int as n from public.claims`);
  mine[0].n === 1 && theirs[0].n === 0 ? ok("claims visible to their client only") : bad("claim visibility", [mine[0].n, theirs[0].n]);
  await expectFail("client cannot handle claims", U.c1, `select public.staff_update_claim($1, 'resolved', 'ok')`, [claimId], /personnel/);
  await expectOk("staff takes the claim", U.staff, `select public.staff_update_claim($1, 'in_progress', null) as r`, [claimId]);
  await expectFail("resolution needs a response", U.staff, `select public.staff_update_claim($1, 'resolved', null)`, [claimId], /réponse/);
  await expectOk("staff resolves with a response", U.staff, `select public.staff_update_claim($1, 'resolved', 'Avoir de 2 kg sur la prochaine commande') as r`, [claimId]);
  const seen = await as(U.c1, `select status, staff_response, resolved_at is not null as done from public.claims where id=$1`, [claimId]);
  ok("client sees the response", seen[0]);
}
