// Account status: pending sign-ups, admin validation, refusal, suspension.
export async function runStatusChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P }) {
  console.log("\n# Account status migration");
  for (const f of ["supabase/migrations/20261024_account_status.sql", "supabase/migrations/20261024_account_status.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const A = { admin: "00000000-0000-0000-0000-0000000000a1", fresh: "00000000-0000-0000-0000-0000000000f1" };
  const existing = (await db.query(`select count(*)::int as n from public.profiles where account_status <> 'active'`)).rows[0].n;
  existing === 0 ? ok("existing accounts stay active") : bad("existing status", existing);

  // A new client signs up with the e-mail of a client record.
  await expectOk("admin creates a client record", A.admin, `insert into public.clients (business_name, email) values ('Boulangerie Nord', 'nord@x.tn') returning business_name`);
  await db.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${A.fresh}', 'nord@x.tn', now())`);
  const fresh = (await db.query(`select account_status, client_id is not null as linked from public.profiles where id=$1`, [A.fresh])).rows[0];
  fresh.account_status === "pending" && fresh.linked ? ok("new sign-up is pending and linked to its record") : bad("new sign-up", JSON.stringify(fresh));
  const acct = await as(A.fresh, `select public.my_account() as a`);
  acct[0].a.status === "pending" && acct[0].a.features.length === 0 ? ok("pending account: no features") : bad("pending my_account", JSON.stringify(acct[0].a));
  await expectFail("pending client cannot order", A.fresh, `select public.place_client_order($1::jsonb, null, null, null)`, [JSON.stringify([{ product_id: P.tomates, quantity: 1 }])], /compte actif/);

  const list = await as(A.admin, `select public.admin_list_accounts() as l`);
  list[0].l[0].status === "pending" ? ok("pending accounts listed first") : bad("list order", JSON.stringify(list[0].l[0]));
  await expectFail("supervisor cannot validate", U.staff, `select public.admin_set_account_status($1, 'active')`, [A.fresh], /administrateurs/);
  await expectFail("invalid status", A.admin, `select public.admin_set_account_status($1, 'maybe')`, [A.fresh], /invalide/);
  await expectFail("admin cannot change own status", A.admin, `select public.admin_set_account_status($1, 'suspended')`, [A.admin], /propre compte/);
  await expectOk("admin validates", A.admin, `select public.admin_set_account_status($1, 'active') as r`, [A.fresh]);
  const active = await as(A.fresh, `select public.my_account() as a`);
  active[0].a.status === "active" && active[0].a.disabled === false ? ok("validated client gets client features") : bad("validated", JSON.stringify(active[0].a));

  await expectOk("admin suspends", A.admin, `select public.admin_set_account_status($1, 'suspended') as r`, [A.fresh]);
  const ban = (await db.query(`select banned_until > now() as b from auth.users where id=$1`, [A.fresh])).rows[0].b;
  ban ? ok("suspended account banned from sign-in") : bad("suspend ban", ban);
  await expectOk("admin refuses", A.admin, `select public.admin_set_account_status($1, 'refused') as r`, [A.fresh]);
  await expectOk("admin puts it back to pending", A.admin, `select public.admin_set_account_status($1, 'pending') as r`, [A.fresh]);
  const unban = (await db.query(`select banned_until from auth.users where id=$1`, [A.fresh])).rows[0].banned_until;
  unban === null ? ok("pending account may sign in again (waiting screen)") : bad("pending ban", unban);
  await expectOk("staff profile pending → no rights", A.admin, `select public.admin_set_account_status($1, 'pending') as r`, [U.staff]);
  await expectFail("pending supervisor blocked", U.staff, `select public.staff_inbox()`, [], /personnel/);
  await expectOk("re-activate supervisor", A.admin, `select public.admin_set_account_status($1, 'active') as r`, [U.staff]);
}
