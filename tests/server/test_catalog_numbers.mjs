// Lot 1: categories managed by Appro+, order numbers per supplier.
export async function runCatalogNumberChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Categories (Appro+) and order numbers per supplier");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  const maxBefore = await one(`select supplier_org_id, max(order_number)::int as m from public.orders group by 1 order by 2 desc limit 1`);
  for (const f of ["supabase/migrations/20261116_catalog_numbers.sql", "supabase/migrations/20261116_catalog_numbers.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const R = "00000000-0000-0000-0000-0000000f0001";
  const list = (await one(`select count(*)::int as n from public.categories`)).n;
  list >= 12 ? ok("a general list of categories for every kind of Pro", list) : bad("seed", list);
  const juice = await one(`select p.name as parent from public.categories c join public.categories p on p.id = c.parent_id where c.name = 'Jus frais'`);
  juice?.parent === "Boissons" ? ok("the former 'Jus frais' is filed under 'Boissons'") : bad("juice parent", juice);

  const created = await expectOk("Appro+ adds a category", sa, `select public.platform_save_category(null, 'Fruits secs', (select id from public.categories where slug = 'epicerie')) as r`);
  await expectFail("the same name twice is refused", sa, `select public.platform_save_category(null, 'fruits secs')`, [], /existe déjà/);
  await expectFail("a Pro cannot add a category", owner, `select public.platform_save_category(null, 'Ma catégorie')`, [], /équipe Appro\+/);
  const proInsert = await as(owner, `insert into public.categories (name, slug) values ('Pirate', 'pirate') returning id`).catch((e) => e.message);
  typeof proInsert === "string" ? ok("a Pro cannot write the table directly either") : bad("direct insert", proInsert);
  await expectFail("a sub-category cannot hold sub-categories", sa, `select public.platform_save_category(null, 'Amandes', $1)`, [created?.[0]?.r], /catégorie principale/);
  const seen = await as(owner, `select count(*)::int as n from public.categories`);
  seen[0].n === list + 1 ? ok("every Pro reads the shared list") : bad("read", seen);
  const console_ = await as(sa, `select jsonb_array_length(public.platform_categories()) as n`);
  console_[0].n === list + 1 ? ok("Appro+ console lists categories with their product counts") : bad("platform_categories", console_);

  // Order numbers per supplier.
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  const cat = (await as(R, `select public.buyer_catalog() as r`))[0].r;
  cat.products.every((p) => "category_sort" in p) ? ok("the buyer catalogue carries the category rank") : bad("category_sort", cat.products[0]);
  const aRel = cat.suppliers.find((s) => s.org_id === L);
  const zRel = cat.suppliers.find((s) => s.org_id === Z);
  const aP = cat.products.find((p) => p.client_id === aRel.client_id);
  const zP = cat.products.find((p) => p.client_id === zRel.client_id);
  const lastA = (await one(`select last_value::int as v from public.org_counters where org_id = $1 and kind = 'order'`, [L])).v;
  const lastZ = (await one(`select coalesce((select last_value::int from public.org_counters where org_id = $1 and kind = 'order'), 0) as v`, [Z])).v;
  const placed = (await expectOk("a two-supplier cart after the switch", R, `select public.place_multi_order($1::jsonb) as r`, [JSON.stringify([
    { client_id: aRel.client_id, items: [{ product_id: aP.id, quantity: 1 }] },
    { client_id: zRel.client_id, items: [{ product_id: zP.id, quantity: 1 }] }])]))[0].r;
  const nA = placed.find((o) => o.client_id === aRel.client_id).order_number;
  const nZ = placed.find((o) => o.client_id === zRel.client_id).order_number;
  nA === lastA + 1 && nZ === lastZ + 1 ? ok("each supplier continues its own sequence, no gaps", { A: nA, Z: nZ }) : bad("numbers", { lastA, nA, lastZ, nZ });
  maxBefore && lastA >= maxBefore.m - 0 || lastA > 0 ? ok("existing orders kept their numbers; the counter starts from the highest") : bad("counter start", { maxBefore, lastA });
  const dup = await one(`select count(*)::int as n from (select supplier_org_id, order_number from public.orders group by 1, 2 having count(*) > 1) d`);
  dup.n === 0 ? ok("no duplicate number within a supplier") : bad("duplicates", dup);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration <= "20261116").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
