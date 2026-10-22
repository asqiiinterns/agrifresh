// 20261119: "Cette donnée appartient à un autre Pro." when a Pro adds a product (same insert as the app).
export async function runProductInsertChecks({ db, file, ok, bad, as }) {
  console.log("\n# Adding a product");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  let n = 0;
  const add = async (uid) => {
    n++;
    await as(uid, `insert into public.products (name, description, unit_label, price, vat_rate, stock_quantity, active, slug, updated_at) values ('Test ${n}', '', 'kg', 2, 0, 5, true, 'test-diag-${n}', now())`);
    return (await one(`select org_id from public.products where slug = $1`, [`test-diag-${n}`])).org_id;
  };
  const expectAdd = async (label, uid, org) => { try { const got = await add(uid); got === org ? ok(label) : bad(label, got); } catch (e) { bad(label, e); } };
  const expectRefused = async (label, uid, pattern) => { try { await add(uid); bad(label, "should have failed"); } catch (e) { pattern.test(e.message) ? ok(`${label} → ${e.message}`) : bad(label, e); } };

  // Before the fix: 20261108 rerun after 20261111 gave every new product to AgriFresh.
  const f08 = file("supabase/migrations/20261108_pros_foundation.sql");
  const guarded = ["products", "vehicles", "team_conversations"].every((t) => f08.includes(`IF to_regprocedure('public.acting_or_legacy_org_id()') IS NULL THEN EXECUTE 'alter table public.${t} alter column org_id set default`));
  guarded && !/^alter table public\.\w+ alter column org_id set default/m.test(f08) ? ok("20261108 no longer overwrites the defaults when rerun") : bad("20261108", "still overwrites");
  await sys(); await db.exec(`alter table public.products alter column org_id set default public.legacy_org_id()`);
  await expectRefused("a database where the default was overwritten refuses Zitouna's product", zitouna, /autre Pro/);

  for (const f of ["supabase/migrations/20261119_write_guard_fixes.sql", "supabase/migrations/20261119_write_guard_fixes.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  await expectAdd("Zitouna adds a product (its own)", zitouna, Z);
  await expectAdd("AgriFresh adds a product (its own)", owner, L);
  await sys(); await db.exec(`update public.organizations set status = 'pending' where id = '${Z}'`);
  await expectRefused("a Pro waiting for Appro+ is told why", zitouna, /pas actif/);
  await sys(); await db.exec(`update public.organizations set status = 'active' where id = '${Z}'`);
  try {
    await as(zitouna, `update public.products set price = 1 where org_id = $1`, [L]);
    const p = await one(`select count(*)::int as n from public.products where org_id = $1 and price = 1`, [L]);
    p.n === 0 ? ok("Zitouna cannot change AgriFresh's products") : bad("cross update", p);
  } catch (e) { ok(`Zitouna cannot change AgriFresh's products → ${e.message}`); }
  await sys(); await db.exec(`delete from public.products where slug like 'test-diag-%'`);
}
