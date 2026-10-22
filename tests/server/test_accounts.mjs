// Account administration: list, validate, disable.
export async function runAccountChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P }) {
  console.log("\n# Accounts migration");
  await db.exec(`alter table auth.users add column if not exists email_confirmed_at timestamptz;
    alter table auth.users add column if not exists banned_until timestamptz;
    alter table auth.users add column if not exists created_at timestamptz default now();
    alter table auth.users add column if not exists last_sign_in_at timestamptz;
    update auth.users set email_confirmed_at = now() where email <> 'who@x.tn';`);
  for (const f of ["supabase/migrations/20261023_accounts.sql", "supabase/migrations/20261023_accounts.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const A = { admin: "00000000-0000-0000-0000-0000000000a1" };
  await expectFail("supervisor cannot list accounts", U.staff, `select public.admin_list_accounts()`, [], /administrateurs/);
  const list = await as(A.admin, `select public.admin_list_accounts() as l`);
  const accounts = list[0].l;
  accounts[0].email === "who@x.tn" && accounts[0].confirmed === false ? ok("unvalidated accounts listed first", accounts.length) : bad("list order", JSON.stringify(accounts[0]));
  const self = accounts.find((a) => a.email === "admin@x.tn");
  self?.is_self ? ok("admin sees itself flagged") : bad("is_self", JSON.stringify(self));
  ok("client account shows its fiche", accounts.find((a) => a.email === "C1@x.tn")?.client_name);

  await expectOk("admin validates an account", A.admin, `select public.admin_confirm_account($1) as r`, [U.stranger]);
  const confirmed = (await db.query(`select email_confirmed_at is not null as c from auth.users where id=$1`, [U.stranger])).rows[0].c;
  confirmed ? ok("e-mail confirmed") : bad("confirm", confirmed);

  await expectFail("admin cannot disable itself", A.admin, `select public.admin_set_account_disabled($1, true)`, [A.admin], /propre compte/);
  await expectOk("admin disables client 1", A.admin, `select public.admin_set_account_disabled($1, true) as r`, [U.c1]);
  const banned = (await db.query(`select banned_until > now() as b from auth.users where id=$1`, [U.c1])).rows[0].b;
  banned ? ok("sign-in banned") : bad("ban", banned);
  await expectFail("disabled client cannot order", U.c1, `select public.place_client_order($1::jsonb, null, null, null)`, [JSON.stringify([{ product_id: P.tomates, quantity: 1 }])], /compte actif|fiche client/);
  const seen = await as(U.c1, `select count(*)::int as n from public.orders`);
  seen[0].n === 0 ? ok("disabled client sees no orders") : bad("disabled orders", seen[0].n);
  const acct = await as(U.c1, `select public.my_account() as a`);
  acct[0].a.disabled === true && acct[0].a.features.length === 0 ? ok("my_account: disabled, no features") : bad("my_account disabled", JSON.stringify(acct[0].a));
  await expectOk("admin disables the driver", A.admin, `select public.admin_set_account_disabled($1, true) as r`, [U.driver]);
  await expectFail("disabled driver blocked", U.driver, `select public.driver_shipments()`, [], /livreurs/);
  await expectOk("re-enable client 1", A.admin, `select public.admin_set_account_disabled($1, false) as r`, [U.c1]);
  await expectOk("re-enable driver", A.admin, `select public.admin_set_account_disabled($1, false) as r`, [U.driver]);
  const back = await as(U.c1, `select count(*)::int as n from public.orders`);
  back[0].n > 0 ? ok("re-enabled client sees orders again") : bad("re-enable", back[0].n);
  const unbanned = (await db.query(`select banned_until from auth.users where id=$1`, [U.c1])).rows[0].banned_until;
  unbanned === null ? ok("ban lifted") : bad("unban", unbanned);
}
