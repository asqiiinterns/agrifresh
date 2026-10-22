// 20261128_plan_presets.sql: Appro+ applies a preset to a Pro's plan in one call.
export async function runPlanChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Plan presets");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261128_plan_presets.sql", "supabase/migrations/20261128_plan_presets.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  // The Pro switched modules off itself (its own "mode essentiel").
  for (const k of ["stock", "planning", "fleet"]) await as(zitouna, `select public.org_set_module($1, false)`, [k]);
  await expectFail("a Pro cannot apply a preset", zitouna, `select public.platform_set_org_plan($1, 'all')`, [Z], /Appro\+/);
  await expectOk("Appro+ « Tout inclure »", sa, `select public.platform_set_org_plan($1, 'all')`, [Z]);
  let st = (await as(sa, `select public.org_modules_state($1) as r`, [Z]))[0].r;
  ["stock", "planning", "fleet", "production"].every((k) => st[k].included && st[k].enabled) ? ok("every module included and switched back on for the Pro") : bad("all", { stock: st.stock, fleet: st.fleet });
  await expectOk("Appro+ « Formule Essentiel »", sa, `select public.platform_set_org_plan($1, 'essential')`, [Z]);
  st = (await as(sa, `select public.org_modules_state($1) as r`, [Z]))[0].r;
  st.delivery.included && !st.stock.included && !st.production.included ? ok("only the essential modules included") : bad("essential", { d: st.delivery, s: st.stock });
  await expectOk("Appro+ « Par défaut »", sa, `select public.platform_set_org_plan($1, 'default')`, [Z]);
  st = (await as(sa, `select public.org_modules_state($1) as r`, [Z]))[0].r;
  st.stock.granted === null && st.stock.included ? ok("every module follows the default again") : bad("default", st.stock);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((r) => r.migration <= "20261128_plan_presets.sql").every((r) => r.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((r) => r.etat !== "OK"));
}
