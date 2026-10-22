// 20261119: a buyer opens the conversation of a supplier other than the selected one, with unread answers.
export async function runThreadReadChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Reading a non-selected supplier's conversation");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  const R = "00000000-0000-0000-0000-0000000f0001";
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  const cat = (await as(R, `select public.buyer_catalog() as r`))[0].r;
  const aRel = cat.suppliers.find((s) => s.org_id === L);
  const zRel = cat.suppliers.find((s) => s.org_id === Z);
  // The buyer works with AgriFresh; Zitouna answers.
  await sys(); await db.exec(`select set_config('appro.link_write', 'on', false); update public.profiles set client_id = '${aRel.client_id}' where id = '${R}'; select set_config('appro.link_write', 'off', false);`);
  await expectOk("Zitouna writes to the buyer", zitouna, `select public.send_message_v3($1, 'Livraison demain') as r`, [zRel.client_id]);

  for (const f of ["supabase/migrations/20261119_write_guard_fixes.sql", "supabase/migrations/20261119_write_guard_fixes.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const thread = (await as(R, `select public.buyer_thread($1) as r`, [zRel.client_id]))[0].r;
  thread[0].body === "Livraison demain" ? ok("the buyer opens Zitouna's conversation while AgriFresh is selected") : bad("thread", thread[0]);
  const unread = (await as(R, `select public.buyer_inbox() as r`))[0].r.find((e) => e.client_id === zRel.client_id).unread;
  Number(unread) === 0 ? ok("and its answers are marked read") : bad("unread", unread);
  const sel = await one(`select client_id from public.profiles where id = $1`, [R]);
  sel.client_id === aRel.client_id ? ok("the selected supplier is unchanged") : bad("selected", sel);
  await expectFail("still refused for a conversation that is not the buyer's", zitouna, `select public.buyer_thread($1)`, [aRel.client_id], /introuvable/);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration < "20261120").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
