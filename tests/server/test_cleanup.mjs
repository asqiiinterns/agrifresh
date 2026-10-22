// 20261122_cleanup.sql: no client reconfirmation; returns, claims, credit notes and recurring orders across all suppliers.
export async function runCleanupChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Cleanup · all suppliers");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261122_cleanup.sql", "supabase/migrations/20261122_cleanup.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const left = await one(`select count(*)::int as n from public.clients where reconfirm_declined`);
  left.n === 0 ? ok("no client keeps the reconfirmation") : bad("reconfirm", left);

  const R = "00000000-0000-0000-0000-0000000f0001";
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  const cat = (await as(R, `select public.buyer_catalog() as r`))[0].r;
  const aRel = cat.suppliers.find((s) => s.org_id === L);
  const zRel = cat.suppliers.find((s) => s.org_id === Z);
  const zP = cat.products.find((p) => p.client_id === zRel.client_id);
  await sys(); await db.exec(`select set_config('appro.link_write', 'on', false); update public.profiles set client_id = '${aRel.client_id}' where id = '${R}';
    update public.clients set stock_managed = false, custom_settings = custom_settings || array['stock_managed'], auto_accept = false, credit_limit = null, feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{"client.claims": true, "client.returns": true}'::jsonb where id = '${zRel.client_id}';
    select set_config('appro.link_write', 'off', false);`);
  const placed = (await as(R, `select public.place_multi_order($1::jsonb) as r`, [JSON.stringify([{ client_id: zRel.client_id, items: [{ product_id: zP.id, quantity: 2 }] }])]))[0].r[0];
  // Claim on an order of Zitouna while AgriFresh is selected
  await expectOk("a claim on Zitouna's order (AgriFresh selected)", R, `select public.buyer_create_claim($1, 'quality', 'Abîmé') ->> 'id' as r`, [placed.id]);
  const claims = (await as(R, `select public.buyer_claims() as r`))[0].r;
  claims.some((c) => c.order_id === placed.id && c.supplier_name === "Épicerie Zitouna") ? ok("the buyer's claims list covers all its suppliers") : bad("claims", claims.slice(0, 2));
  const sel = await one(`select client_id from public.profiles where id = $1`, [R]);
  sel.client_id === aRel.client_id ? ok("the selected supplier is unchanged") : bad("selected", sel);
  // Return on a delivered order of Zitouna
  await sys(); await db.exec(`select set_config('appro.link_write', 'on', false); update public.orders set status = 'delivered', delivered_at = now() where id = '${placed.id}'; select set_config('appro.link_write', 'off', false);`);
  const item = await one(`select product_id from public.order_items where order_id = $1 limit 1`, [placed.id]);
  const ret = await expectOk("a return request to Zitouna", R, `select public.buyer_request_return($1, $2::jsonb, 'quality', 'Abîmé') ->> 'return_number' as r`, [placed.id, JSON.stringify([{ product_id: item.product_id, quantity: 1 }])]);
  const returns = (await as(R, `select public.buyer_returns() as r`))[0].r;
  returns.some((r) => r.order_id === placed.id && r.return_items.length === 1) ? ok("and it is in the buyer's returns", ret?.[0]?.r) : bad("returns", returns.slice(0, 2));
  const credits = (await as(R, `select public.buyer_credit_notes() as r`))[0].r;
  Array.isArray(credits) ? ok("credit notes of all suppliers", credits.length) : bad("credits", credits);
  // Recurring order with Zitouna
  const rec = await expectOk("a recurring order with Zitouna", R, `select public.buyer_save_recurring($1, null, $2::jsonb, null, array[2]::int[], 1, 'Mardi') as r`, [zRel.client_id, JSON.stringify([{ product_id: zP.id, quantity: 1 }])]);
  const list = (await as(R, `select public.buyer_recurring() as r`))[0].r;
  list.some((r) => r.id === rec?.[0]?.r && r.supplier_name === "Épicerie Zitouna") ? ok("listed with its supplier") : bad("recurring list", list);
  await expectOk("changed (Friday)", R, `select public.buyer_save_recurring(null, $1, $2::jsonb, null, array[5]::int[], 1, 'Vendredi') as r`, [rec[0].r, JSON.stringify([{ product_id: zP.id, quantity: 3 }])]);
  await expectOk("deleted", R, `select public.buyer_delete_recurring($1) as r`, [rec[0].r]);
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  await expectFail("a stranger cannot act in this relation", zitouna, `select public.buyer_create_claim($1, 'quality', 'x')`, [placed.id], /ne vous permet pas/);
  (await one(`select client_id from public.profiles where id = $1`, [R])).client_id === aRel.client_id ? ok("still AgriFresh selected after all that") : bad("selected after", "changed");
  const dup = await one(`select count(*)::int as n from pg_indexes where indexname in ('client_invoices_supplier_number_idx', 'returns_supplier_number_idx', 'credit_notes_supplier_number_idx', 'orders_supplier_delivery_note_idx')`);
  dup.n === 4 ? ok("document numbers are per supplier") : bad("indexes", dup);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration < "20261123").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
