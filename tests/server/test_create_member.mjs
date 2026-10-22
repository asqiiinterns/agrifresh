// Admin → Comptes → Ajouter: the order the app follows (sign-up, role, then activation) works; the former order did not.
export async function runCreateMemberChecks({ db, file, ok, bad, as, expectFail }) {
  console.log("\n# Adding a team member from Comptes");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const org = (await one(`select org_id from public.profiles where id = $1`, [owner])).org_id;
  for (const f of ["supabase/migrations/20261207_add_member.sql", "supabase/migrations/20261207_add_member.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const signUp = async (email) => { await sys(); return (await db.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [email])).rows[0].id; };

  // The former order: activate first → refused (what the user saw).
  const first = await signUp("livreur@2015.tn");
  await expectFail("activating before the role is refused (the bug)", owner, `select public.admin_set_account_status($1, 'active')`, [first], /appartient pas/);
  // The new order on the same half-created account (retry with the same e-mail).
  const attached = (await as(owner, `select public.admin_set_role('livreur@2015.tn', 'driver') as r`))[0].r;
  await as(owner, `select public.admin_set_account_status($1, 'active')`, [attached.id]);
  const p = await one(`select role::text, org_id, account_status from public.profiles where id = $1`, [attached.id]);
  p.role === "driver" && p.org_id === org && p.account_status === "active" ? ok("role first, then activation: the driver joins the team, active", p) : bad("member", p);
  // A brand-new account.
  await signUp("prepa@2015.tn");
  const a2 = (await as(owner, `select public.admin_set_role('prepa@2015.tn', 'production') as r`))[0].r;
  await as(owner, `select public.admin_set_account_status($1, 'active')`, [a2.id]);
  const p2 = await one(`select role::text, org_id, account_status from public.profiles where id = $1`, [a2.id]);
  p2.org_id === org && p2.account_status === "active" ? ok("a new account is created in the team", p2.role) : bad("new member", p2);
  // Another Pro's member cannot be taken.
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  await expectFail("another Pro's member cannot be taken over", zitouna, `select public.admin_set_role('prepa@2015.tn', 'driver')`, [], /appartient pas|réservé/i);

  // As on the user's database: without the automatic attachment (trigger off), adding a member still works.
  await sys(); await db.exec(`alter table public.profiles disable trigger profiles_fill_org`);
  const third = await signUp("liv@2015.com");
  const added = (await as(owner, `select public.admin_add_member('liv@2015.com', 'driver') as r`))[0].r;
  const p3 = await one(`select role::text, org_id, account_status from public.profiles where id = $1`, [third]);
  added.id === third && p3.org_id === org && p3.account_status === "active" && p3.role === "driver" ? ok("admin_add_member: team, role and activation in one call", p3) : bad("add member", p3);
  await signUp("liv4@2015.com");
  const viaRole = (await as(owner, `select public.admin_set_role('liv4@2015.com', 'production') as r`))[0].r;
  const p4 = await one(`select org_id from public.profiles where id = $1`, [viaRole.id]);
  p4.org_id === org ? ok("admin_set_role attaches a free account explicitly too") : bad("set role", p4);
  await sys(); await db.exec(`alter table public.profiles enable trigger profiles_fill_org`);
  await expectFail("another Pro cannot take a member", zitouna, `select public.admin_add_member('liv@2015.com', 'driver')`, [], /autre espace|Réservé/);
  const clientEmail = (await one(`select u.email from auth.users u join public.profiles pr on pr.id = u.id where pr.client_id is not null limit 1`)).email;
  await expectFail("a client record account cannot join a team", owner, `select public.admin_add_member($1, 'driver')`, [clientEmail], /fiche client|autre espace/);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((r) => r.migration <= "20261207_add_member.sql").every((r) => r.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((r) => r.etat !== "OK"));

  // 20261208: billing_board (À facturer) is valid on a real database too.
  for (const f of ["supabase/migrations/20261208_billing_board.sql", "supabase/migrations/20261208_billing_board.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const board = (await as(owner, `select public.billing_board() as r`))[0].r;
  Array.isArray(board.due) && Array.isArray(board.overdue) ? ok("billing_board answers", { due: board.due.length, overdue: board.overdue.length }) : bad("billing_board", board);
  const all = await db.query(file("supabase/check_migrations.sql"));
  all.rows.every((r) => r.etat === "OK") ? ok("check query: every migration installed", all.rows.length) : bad("check query", all.rows.filter((r) => r.etat !== "OK"));
}
