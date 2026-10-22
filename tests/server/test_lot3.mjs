// Lot 3: modules per Pro, prices and discounts set by each supplier.
export async function runLot3Checks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Modules per Pro, prices and discounts");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  // Internal (revoked) functions, evaluated for a given signed-in account.
  const internal = async (uid, sql, params) => { await db.exec(`reset role; select set_config('test.uid', '${uid}', false);`); try { return (await db.query(sql, params)).rows[0]; } finally { await sys(); } };
  for (const f of ["supabase/migrations/20261118_pro_modules_pricing.sql", "supabase/migrations/20261118_pro_modules_pricing.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const R = "00000000-0000-0000-0000-0000000f0001";
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const cat = (await as(R, `select public.buyer_catalog() as r`))[0].r;
  const aRel = cat.suppliers.find((s) => s.org_id === L);
  const zRel = cat.suppliers.find((s) => s.org_id === Z);
  Array.isArray(cat.offers) ? ok("the buyer catalogue carries the offers") : bad("offers", cat);

  // ---- Modules per Pro ----
  const guarded = (await one(`select pg_get_functiondef('public.create_client_order(uuid, uuid, uuid, jsonb, uuid, date, text, text)'::regprocedure) as d`)).d;
  guarded.includes("module_enabled_for(v_client.supplier_org_id, 'stock')") ? ok("client options follow the modules of their supplier") : bad("guards", "not rewritten");
  const st = (await as(owner, `select public.org_modules_state() as r`))[0].r;
  st.stats?.effective === true && st.pricing?.included === true ? ok("a Pro reads its modules") : bad("state", st.stats);
  await expectFail("a Pro cannot read another Pro's modules", owner, `select public.org_modules_state($1)`, [Z], /Accès refusé/);
  await expectFail("a Pro no longer changes the platform defaults", owner, `select public.admin_set_module('stats', false)`, [], /équipe Appro\+/);

  await expectOk("Appro+ excludes Returns from Zitouna's plan", sa, `select public.platform_set_org_module($1, 'returns', false) as r`, [Z]);
  (await as(zitouna, `select public.has_feature('returns.manage') as r`))[0].r === false ? ok("Zitouna's team loses Returns") : bad("zitouna returns", "still on");
  (await as(owner, `select public.has_feature('returns.manage') as r`))[0].r === true ? ok("AgriFresh keeps it") : bad("agrifresh returns", "off");
  (await internal(R, `select public.buyer_relation_can($1, 'client.returns') as r`, [zRel.client_id])).r === false ? ok("the buyer cannot ask Zitouna for a return") : bad("buyer Z returns", "on");
  await expectFail("Zitouna cannot switch it back on itself", zitouna, `select public.org_set_module('returns', true)`, [], /pas inclus/);
  await expectFail("only Appro+ sets a plan", owner, `select public.platform_set_org_module($1, 'returns', true)`, [Z], /équipe Appro\+/);
  await expectOk("Appro+ puts Returns back on the default", sa, `select public.platform_set_org_module($1, 'returns', null) as r`, [Z]);
  (await as(zitouna, `select public.has_feature('returns.manage') as r`))[0].r === true ? ok("Zitouna has Returns again") : bad("zitouna returns back", "off");

  await expectOk("AgriFresh's Responsable switches Statistics off", owner, `select public.org_set_module('stats', false) as r`);
  (await as(owner, `select public.app_modules_state() ->> 'stats' as r`))[0].r === "false" ? ok("the app sees it off for AgriFresh") : bad("app state", "on");
  (await as(zitouna, `select public.app_modules_state() ->> 'stats' as r`))[0].r === "true" ? ok("but not for Zitouna") : bad("zitouna stats", "off");
  await expectOk("and back on", owner, `select public.org_set_module('stats', true) as r`);
  await expectFail("a buyer-side account cannot switch the supplier's modules", R, `select public.org_set_module('stats', false)`, [], /Responsable/);

  await expectOk("Appro+ turns Origin off by default", sa, `select public.admin_set_module('origin', false) as r`);
  await expectOk("and includes it for Zitouna", sa, `select public.platform_set_org_module($1, 'origin', true) as r`, [Z]);
  const oz = (await as(zitouna, `select public.org_modules_state() -> 'origin' as r`))[0].r;
  const ol = (await as(owner, `select public.org_modules_state() -> 'origin' as r`))[0].r;
  oz.effective === true && ol.effective === false ? ok("default off, included for one Pro", { oz: oz.effective, ol: ol.effective }) : bad("origin", { oz, ol });
  await expectOk("defaults restored", sa, `select public.admin_set_module('origin', true) as r`);
  await expectOk("plan restored", sa, `select public.platform_set_org_module($1, 'origin', null) as r`, [Z]);

  // ---- Prices and discounts ----
  const prod = await one(`select p.id, p.price::numeric as price from public.products p where p.org_id = $1 and p.active and p.price > 1 order by p.created_at limit 1`, [L]);
  const price = Number(prod.price);
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const cart = (qty) => JSON.stringify([{ client_id: aRel.client_id, items: [{ product_id: prod.id, quantity: qty }] }]);
  const priced = async (qty) => (await as(R, `select public.buyer_price_cart($1::jsonb) -> 0 as r`, [cart(qty)]))[0].r;

  const base = await priced(2);
  Number(base.subtotal) === r3(price * 2) && Number(base.discount) === 0 ? ok("no rule: catalogue price", base.subtotal) : bad("no rule", base);
  const ov = await expectOk("the supplier opens Prices and discounts", owner, `select jsonb_array_length(public.pricing_overview() -> 'clients') as r`);
  const gid = (await as(owner, `select public.pricing_save_group(null, 'Hôtels') as r`))[0].r;
  await expectFail("group names are unique", owner, `select public.pricing_save_group(null, 'hôtels')`, [], /déjà ce nom/);
  await expectOk("the buyer goes into the Hôtels group", owner, `select public.pricing_set_client_group($1, $2) as r`, [aRel.client_id, gid]);
  await expectFail("a supplier cannot group another supplier's client", owner, `select public.pricing_set_client_group($1, null)`, [zRel.client_id], /introuvable/);

  await expectFail("a percentage above 100 is refused", owner, `select public.pricing_save_rule('{"name":"X","kind":"percent","value":150}'::jsonb)`, [], /entre 0 et 100/);
  await expectFail("a net price needs chosen products", owner, `select public.pricing_save_rule('{"name":"X","kind":"net_price","value":1}'::jsonb)`, [], /produits choisis/);
  await expectFail("a rule cannot target another supplier's client", owner, `select public.pricing_save_rule($1::jsonb)`, [JSON.stringify({ name: "X", kind: "percent", value: 5, target: "client", client_id: zRel.client_id })], /Choisissez le client/);
  await expectFail("Zitouna's team cannot touch AgriFresh's rules", zitouna, `select public.pricing_save_rule($1::jsonb)`, [JSON.stringify({ name: "X", kind: "percent", value: 5, product_scope: "products", product_ids: [prod.id] })], /vos produits/);

  const pct = (await as(owner, `select public.pricing_save_rule('{"name":"Promo -10 %","kind":"percent","value":10}'::jsonb) as r`))[0].r;
  let p = await priced(2);
  Number(p.subtotal) === r3(price * 2 * 0.9) && p.lines[prod.id].label === "Promo -10 %" ? ok("percentage for all clients", p.subtotal) : bad("percent", p);
  const net = r3(price - 1);
  const netId = (await as(owner, `select public.pricing_save_rule($1::jsonb) as r`, [JSON.stringify({ name: "Prix hôtels", kind: "net_price", value: net, target: "group", price_group_id: gid, product_scope: "products", product_ids: [prod.id] })]))[0].r;
  p = await priced(2);
  Number(p.lines[prod.id].line_total) === r3(net * 2 * 0.9) && p.lines[prod.id].label === "Prix hôtels + Promo -10 %" ? ok("group net price, then the best discount on top", p.lines[prod.id]) : bad("net + percent", p.lines[prod.id]);
  const free = (await as(owner, `select public.pricing_save_rule($1::jsonb) as r`, [JSON.stringify({ name: "2 + 1 offert", kind: "free_units", buy_qty: 2, free_qty: 1 })]))[0].r;
  p = await priced(3);
  Number(p.lines[prod.id].line_total) === r3(net * 2) && p.lines[prod.id].label === "Prix hôtels + 2 + 1 offert" ? ok("X bought + Y free beats -10 % at 3 units", p.lines[prod.id].line_total) : bad("free units", p.lines[prod.id]);
  p = await priced(2);
  p.lines[prod.id].label === "Prix hôtels + Promo -10 %" ? ok("at 2 units the -10 % stays best") : bad("best of", p.lines[prod.id]);
  await expectOk("the free-units rule off", owner, `select public.pricing_set_rule_active($1, false) as r`, [free]);
  const tiers = (await as(owner, `select public.pricing_save_rule($1::jsonb) as r`, [JSON.stringify({ name: "Volume", kind: "tiers", stackable: true, tiers: [{ min_qty: 5, percent: 5 }, { min_qty: 10, percent: 10 }] })]))[0].r;
  p = await priced(10);
  Number(p.lines[prod.id].line_total) === r3(net * 10 * 0.9 * 0.9) ? ok("a stackable tier adds up (10 units: -10 % then -10 %)", p.lines[prod.id].line_total) : bad("tiers stack", p.lines[prod.id]);
  p = await priced(4);
  !p.lines[prod.id].label.includes("Volume") ? ok("below the first tier, no tier") : bad("tier min", p.lines[prod.id]);
  await expectOk("tiers off", owner, `select public.pricing_set_rule_active($1, false) as r`, [tiers]);

  const big = (await as(owner, `select public.pricing_save_rule($1::jsonb) as r`, [JSON.stringify({ name: "Grosse commande", kind: "percent", value: 20, min_order_amount: r3(price * 100) })]))[0].r;
  p = await priced(2);
  p.next.length === 1 && p.next[0].name === "Grosse commande" && Number(p.next[0].missing) > 0 ? ok("the cart says how much is missing for the next discount", p.next[0]) : bad("next", p.next);
  await expectOk("weekday rule never today", owner, `select public.pricing_save_rule($1::jsonb) as r`, [JSON.stringify({ name: "Jamais", kind: "percent", value: 90, weekdays: [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== (((new Date().getUTCDay() + 6) % 7) + 1)) })]);
  p = await priced(2);
  !p.applied.includes("Jamais") ? ok("a rule for other weekdays does not apply today") : bad("weekday", p.applied);

  const cat2 = (await as(R, `select public.buyer_catalog() -> 'offers' as r`))[0].r;
  cat2.some((o) => o.name === "Prix hôtels") && cat2.some((o) => o.name === "Grosse commande") ? ok("offers listed in the catalogue", cat2.length) : bad("catalog offers", cat2);
  (await as(zitouna, `select public.pricing_overview() -> 'rules' as r`))[0].r.length === 0 ? ok("Zitouna sees none of AgriFresh's rules") : bad("isolation", "leak");
  const staffP = (await as(owner, `select public.staff_price_order($1, $2::jsonb) as r`, [aRel.client_id, JSON.stringify([{ product_id: prod.id, quantity: 2 }])]))[0].r;
  Number(staffP.subtotal) === r3(net * 2 * 0.9) ? ok("the supplier's order entry shows the same prices") : bad("staff price", staffP);
  await expectFail("but not for another supplier's client", owner, `select public.staff_price_order($1, '[]'::jsonb)`, [zRel.client_id], /introuvable/);

  // Orders are priced by the server.
  const placed = (await as(R, `select public.place_multi_order($1::jsonb) as r`, [cart(2)]))[0].r[0];
  const o = await one(`select o.total::numeric as total, o.discount_total::numeric as discount, (select amount::numeric from public.payments where order_id = o.id) as pay,
    (select row_to_json(oi) from public.order_items oi where oi.order_id = o.id) as line from public.orders o where o.id = $1`, [placed.id]);
  Number(o.total) === r3(net * 2 * 0.9) && Number(placed.total) === Number(o.total) && Number(o.pay) === Number(o.total)
    && Number(o.line.list_price) === price && o.line.discount_label === "Prix hôtels + Promo -10 %" && Number(o.discount) === r3(price * 2 - Number(o.total))
    ? ok("the order carries discounted lines, total, discount and payment", { total: o.total, discount: o.discount }) : bad("order pricing", o);
  await expectOk("the buyer changes it to 3", R, `select public.client_modify_order($1, $2::jsonb) as r`, [placed.id, JSON.stringify([{ product_id: prod.id, quantity: 3 }])]);
  const o2 = await one(`select total::numeric as total from public.orders where id = $1`, [placed.id]);
  Number(o2.total) === r3(net * 3 * 0.9) ? ok("a change is priced again", o2.total) : bad("modify pricing", o2);

  await expectOk("Appro+ excludes the pricing module for AgriFresh", sa, `select public.platform_set_org_module($1, 'pricing', false) as r`, [L]);
  await expectFail("then the supplier cannot manage rules", owner, `select public.pricing_overview()`, [], /n’est pas actif/);
  p = await priced(2);
  Number(p.subtotal) === r3(price * 2) ? ok("and its clients pay catalogue prices") : bad("module off", p);
  await expectOk("pricing module back", sa, `select public.platform_set_org_module($1, 'pricing', null) as r`, [L]);
  await expectOk("deleting the group", owner, `select public.pricing_delete_group($1) as r`, [gid]);
  p = await priced(2);
  Number(p.subtotal) === r3(price * 2 * 0.9) ? ok("without its group the buyer loses the group price") : bad("group delete", p);
  for (const id of [pct, netId, free, tiers, big]) await as(owner, `select public.pricing_delete_rule($1)`, [id]);
  await sys(); await db.exec(`delete from public.pricing_rules`);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration < "20261119").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
