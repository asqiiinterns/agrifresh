// 20261202_products.sql: identifiers, product sheets per category, import with history, catalogue presets.
export async function runProductsChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Products: identifiers, sheets, import, presets");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261202_products.sql", "supabase/migrations/20261202_products.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const driver = (await one(`select id from public.profiles where role = 'driver' and org_id = $1 and account_status = 'active' limit 1`, [L])).id;

  // 1. Identifiers
  const codes = await one(`select count(*)::int as n, count(platform_code)::int as coded from public.products`);
  codes.n === codes.coded ? ok("every product has an Appro+ code", codes.n) : bad("platform codes", codes);
  const p1 = await one(`select id, name from public.products where org_id = $1 order by name limit 1`, [L]);
  const p2 = await one(`select id from public.products where org_id = $1 order by name offset 1 limit 1`, [L]);
  await expectOk("the Pro sets a reference and a barcode", owner, `update public.products set sku = 'JUS-001', gtin = '6191234567890' where id = $1 returning sku`, [p1.id]);
  await expectFail("a wrong barcode is refused", owner, `update public.products set gtin = '12345' where id = $1`, [p1.id], /Code-barres/);
  await expectFail("the same reference twice in a Pro is refused", owner, `update public.products set sku = 'jus-001' where id = $1`, [p2.id], /duplicate|unique|existe/i);

  // 2. Sheets per category
  const cat = await one(`select id, name from public.categories where parent_id is null and active order by sort_order limit 1`);
  await expectFail("a Pro cannot define the sheets", owner, `select public.platform_set_category_fields($1, '[]'::jsonb)`, [cat.id], /Appro\+/);
  await expectFail("a list needs its choices", sa, `select public.platform_set_category_fields($1, '[{"label":"Variété","type":"list"}]'::jsonb)`, [cat.id], /choix/);
  await expectOk("Appro+ defines the fields of a category", sa, `select public.platform_set_category_fields($1, $2::jsonb) as r`, [cat.id,
    JSON.stringify([{ label: "Variété", type: "list", options: ["Maltaise", "Thomson"] }, { label: "Calibre", type: "number", unit: "mm" }])]);
  const fields = (await as(owner, `select public.category_fields($1) as r`, [cat.id]))[0].r;
  fields.length === 2 && fields[0].key === "variete" && fields[1].unit === "mm" ? ok("a Pro reads them (keys made from the labels)", fields.map((f) => f.key)) : bad("fields", fields);

  // 3. Import
  await expectFail("a driver cannot import", driver, `select public.products_import('x.csv', '[]'::jsonb)`, [], /ne permet pas/);
  const before = await one(`select price, stock_quantity, name from public.products where id = $1`, [p1.id]);
  const rows = [
    { sku: "JUS-001", price: "9,750" },                                           // partial: only the price
    { gtin: "6191234567890", stock_quantity: "42", attributes: { variete: "Maltaise" } }, // found by barcode
    { name: "Citron Beldi", price: "3.2", category: cat.name, unit_label: "kg", vat_rate: "7", sku: "CIT-01" }, // new
    { name: "Sans prix" },                                                         // ignored
    { sku: "JUS-001", vat_rate: "12" },                                            // invalid VAT: ignored
  ];
  const res = (await as(owner, `select public.products_import('catalogue.csv', $1::jsonb) as r`, [JSON.stringify(rows)]))[0].r;
  res.created === 1 && res.updated === 2 && res.ignored.length === 2 ? ok("partial file: 2 updated, 1 created, 2 lines ignored with the reason", res.ignored.map((i) => i.reason)) : bad("import", res);
  const after = await one(`select price, stock_quantity, name, attributes from public.products where id = $1`, [p1.id]);
  Number(after.price) === 9.75 && Number(after.stock_quantity) === 42 && after.name === before.name && after.attributes.variete === "Maltaise"
    ? ok("only the columns present changed") : bad("partial update", { before, after });
  const created = await one(`select price, category_id, vat_rate, platform_code, org_id from public.products where sku = 'CIT-01'`);
  created && Number(created.price) === 3.2 && created.category_id === cat.id && Number(created.vat_rate) === 7 && created.platform_code && created.org_id === L
    ? ok("the new product is created in the Pro, with its Appro+ code", created.platform_code) : bad("created", created);
  const history = (await as(owner, `select public.product_import_history() as r`))[0].r;
  history[0]?.file_name === "catalogue.csv" && history[0].changes.some((c) => c.before?.price !== undefined && c.after?.price !== undefined)
    ? ok("the import is kept with what it changed (before / after)") : bad("history", history[0]);
  const again = (await as(owner, `select public.products_import('catalogue.csv', $1::jsonb) as r`, [JSON.stringify([rows[0]])]))[0].r;
  again.unchanged === 1 && again.updated === 0 ? ok("the same file again changes nothing") : bad("idempotent", again);
  (await as(zitouna, `select public.product_import_history() as r`))[0].r.length === 0 ? ok("another Pro does not see this history") : bad("isolation", "");
  const zres = (await as(zitouna, `select public.products_import('z.csv', $1::jsonb) as r`, [JSON.stringify([{ sku: "JUS-001", price: "1" }])]))[0].r;
  zres.updated === 0 && Number((await one(`select price from public.products where id = $1`, [p1.id])).price) === 9.75
    ? ok("another Pro's file never touches this Pro's products") : bad("cross-Pro import", zres);

  // 4. Presets
  await expectOk("catalogue presets saved for the Pro", owner, `select public.set_catalog_presets('[{"name":"Clients","options":{"photo":true,"price":true},"default":true}]'::jsonb) as r`);
  (await as(owner, `select public.my_catalog_presets() as r`))[0].r[0]?.name === "Clients" ? ok("and read back") : bad("presets", "");
  await expectFail("a driver cannot change them", driver, `select public.set_catalog_presets('[]'::jsonb)`, [], /ne permet pas/);

  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((r) => r.migration <= "20261202_products.sql").every((r) => r.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((r) => r.etat !== "OK"));
}
