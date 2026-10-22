// One-time account reorganisation: @a.tn team -> @agrifresh.tn, admin@a.tn = Appro+ only,
// admin@agrifresh.tn = AgriFresh Responsable once it exists.
export async function runAccountsScriptChecks({ db, file, ok, bad, as }) {
  console.log("\n# Accounts reorganisation script");
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const A = { admin: "00000000-0000-0000-0000-0000000a0001", sup: "00000000-0000-0000-0000-0000000a0002", drv: "00000000-0000-0000-0000-0000000a0003", owner: "00000000-0000-0000-0000-0000000a0004" };
  await db.exec(`insert into auth.users (id, email) values ('${A.admin}', 'admin@a.tn'), ('${A.sup}', 'superviseur@a.tn'), ('${A.drv}', 'livreur@a.tn');
    update public.profiles set role = 'admin', account_status = 'active' where id = '${A.admin}';
    update public.profiles set role = 'supervisor', account_status = 'active' where id = '${A.sup}';
    update public.profiles set role = 'driver', account_status = 'active' where id = '${A.drv}';`);
  const script = file("supabase/scripts/agrifresh_accounts.sql");
  try { await db.exec(script); ok("script runs before admin@agrifresh.tn exists"); } catch (e) { bad("first run", e); }
  const renamed = (await db.query(`select email from auth.users where id in ('${A.sup}', '${A.drv}') order by email`)).rows.map((r) => r.email);
  JSON.stringify(renamed) === JSON.stringify(["livreur@agrifresh.tn", "superviseur@agrifresh.tn"]) ? ok("team accounts renamed, same accounts", renamed) : bad("rename", renamed);
  const adm = await one(`select pr.is_superadmin, pr.org_id, pm.role from public.profiles pr left join public.platform_members pm on pm.user_id = pr.id where pr.id = $1`, [A.admin]);
  adm.is_superadmin && adm.org_id === null && adm.role === "superadmin" ? ok("admin@a.tn is the Appro+ super-admin") : bad("admin@a.tn", adm);
  await db.exec(`insert into auth.users (id, email) values ('${A.owner}', 'admin@agrifresh.tn'); update public.profiles set account_status = 'pending' where id = '${A.owner}';`);
  try { await db.exec(script); await db.exec(script); ok("script reruns cleanly once the owner exists"); } catch (e) { bad("second run", e); }
  const owner = await one(`select pr.role::text as role, pr.org_id = public.legacy_org_id() as agrifresh, pr.is_superadmin, pr.account_status,
    exists (select 1 from public.member_roles mr join public.org_roles r on r.id = mr.role_id join public.role_templates t on t.id = r.template_id where mr.user_id = pr.id and t.key = 'supplier_owner') as responsable
    from public.profiles pr where pr.id = $1`, [A.owner]);
  owner.agrifresh && owner.responsable && !owner.is_superadmin && owner.account_status === "active" ? ok("admin@agrifresh.tn is Responsable of AgriFresh, not super-admin") : bad("owner", owner);
  const trans = await one(`select count(*)::int as n from public.member_roles where transitional`);
  trans.n === 0 ? ok("super-admin no longer runs AgriFresh") : bad("transitional left", trans);
  const rights = await as(A.owner, `select public.has_permission('products.manage') as products, public.platform_role() as platform`);
  rights[0].products && rights[0].platform === null ? ok("owner manages products, has no platform role") : bad("owner rights", rights);
  const saRights = await as(A.admin, `select public.has_permission('products.manage') as products, public.platform_can('platform.pros.validate') as platform`);
  !saRights[0].products && saRights[0].platform ? ok("super-admin: platform rights only") : bad("super-admin rights", saRights);
  const drvRights = await as(A.drv, `select public.has_permission('deliveries') as d`);
  drvRights[0].d === true ? ok("renamed driver keeps its role and rights") : bad("driver", drvRights);
}
