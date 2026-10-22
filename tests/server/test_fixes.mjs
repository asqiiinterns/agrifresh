// 20261126_fixes.sql: invitations traced for Appro+, new accounts rules, deleting an account, held messages,
// the card of a Pro, one's own details.
export async function runFixesChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Fixes: invitations, accounts, messages, cards, my details");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  await sys(); await db.exec(`alter table auth.users add column if not exists email_confirmed_at timestamptz`);
  for (const f of ["supabase/migrations/20261126_fixes.sql", "supabase/migrations/20261126_fixes.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const newUser = async (n, confirmed = true) => {
    const id = `00000000-0000-0000-0000-0000000e50${String(n).padStart(2, "0")}`;
    await sys(); await db.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${id}', 'fix${n}@x.tn', ${confirmed ? "now()" : "null"}) on conflict do nothing`);
    return id;
  };
  await expectOk("Appro+: 48 h for new spaces and for invited ones", sa, `select public.platform_set_setting('new_accounts_trial_hours', '48'::jsonb), public.platform_set_setting('invited_trial_hours', '24'::jsonb)`);

  // Step 1 · Zitouna invites a client: Appro+ is told and sees it
  const inv = (await as(zitouna, `select public.create_invitation('client', null, 'Boulangerie Nour', 'nour@x.tn') as r`))[0].r;
  const told = await one(`select body from public.notifications where user_id = $1 and event = 'invitation.created' order by created_at desc limit 1`, [sa]);
  told?.body?.includes("Boulangerie Nour") && told.body.includes(inv.code) ? ok("Appro+ is told: who, for whom, code, date", told.body) : bad("invitation alert", told);
  const list = (await as(sa, `select public.platform_invitations() as r`))[0].r;
  const row = list.find((item) => item.code === inv.code);
  row && row.org_name === "Épicerie Zitouna" && row.invited_by && row.contact === "nour@x.tn" ? ok("and finds it in the list of invitations") : bad("platform list", row);
  const mine = (await as(zitouna, `select public.my_invitations() as r`))[0].r;
  mine.some((item) => item.code === inv.code) ? ok("Zitouna's administrator sees its own invitations") : bad("my invitations", mine.length);
  await expectFail("a Pro does not invite for another", owner, `select public.platform_create_invitation($1, 'client')`, [Z], /Appro\+/);
  const forZ = (await as(sa, `select public.platform_create_invitation($1, 'client', 'Café Lac') as r`, [Z]))[0].r;
  forZ.org_name === "Épicerie Zitouna" ? ok("Appro+ invites a client on behalf of Zitouna", forZ.code) : bad("on behalf", forZ);

  // Step 2 · the invited person signs up, accepts, creates her business: active for the invited length
  const u1 = await newUser(1);
  await expectOk("the invited person accepts the code", u1, `select public.accept_invitation($1) ->> 'needs_space' as r`, [inv.code]);
  await expectOk("and creates her business", u1, `select public.register_pro('{"name":"Boulangerie Nour","is_buyer":true}'::jsonb) as r`);
  const o1 = await one(`select o.status, o.trial_until, (o.trial_until - now()) < interval '25 hours' as invited_length from public.profiles pr join public.organizations o on o.id = pr.org_id where pr.id = $1`, [u1]);
  o1.status === "active" && o1.invited_length ? ok("active for the invited period (24 h), then validated or suspended") : bad("invited trial", o1);
  const acc = (await as(sa, `select public.platform_accounts('fix1') as r`))[0].r[0];
  acc?.invited_by?.org_name === "Épicerie Zitouna" && acc.email_confirmed === true ? ok("Appro+ sees who invited this account", acc.invited_by.code) : bad("invited by", acc);

  // Step 3 · spontaneous sign-ups
  const u2 = await newUser(2);
  await expectOk("a business created spontaneously", u2, `select public.register_pro('{"name":"Société X","is_buyer":true}'::jsonb) as r`);
  (await one(`select o.status from public.profiles pr join public.organizations o on o.id = pr.org_id where pr.id = $1`, [u2])).status === "pending"
    ? ok("stays waiting for Appro+ (no automatic activation for a business)") : bad("business spontaneous", "active");
  const u3 = await newUser(3);
  await expectOk("a private person", u3, `select public.register_pro('{"name":"Leila B","kind":"person"}'::jsonb) as r`);
  (await one(`select o.status from public.profiles pr join public.organizations o on o.id = pr.org_id where pr.id = $1`, [u3])).status === "active"
    ? ok("is active for the trial") : bad("person trial", "pending");
  const u4 = await newUser(4, false);
  await expectOk("a person whose e-mail is not confirmed", u4, `select public.register_pro('{"name":"Sans Mail","kind":"person"}'::jsonb) as r`);
  (await one(`select o.status from public.profiles pr join public.organizations o on o.id = pr.org_id where pr.id = $1`, [u4])).status === "pending"
    ? ok("stays suspended until the e-mail is confirmed") : bad("unconfirmed", "active");
  ((await as(sa, `select public.platform_accounts('fix4') as r`))[0].r[0])?.email_confirmed === false ? ok("Appro+ sees it is not confirmed") : bad("confirmed flag", "");
  await expectOk("Appro+ allows spontaneous businesses", sa, `select public.platform_set_setting('self_signup_business_trial', 'true'::jsonb)`);
  const u5 = await newUser(5);
  await expectOk("then a new business", u5, `select public.register_pro('{"name":"Société Y","is_buyer":true}'::jsonb) as r`);
  (await one(`select o.status from public.profiles pr join public.organizations o on o.id = pr.org_id where pr.id = $1`, [u5])).status === "active" ? ok("is active for the trial") : bad("business allowed", "pending");

  // Step 4 · deleting an account
  const member = (await one(`select pr.id from public.profiles pr where pr.org_id = $1 and pr.id <> $2 and pr.role <> 'customer' and pr.account_status = 'active' limit 1`, [L, owner])).id;
  await expectFail("nobody deletes itself", owner, `select public.delete_account($1)`, [owner], /propre compte/);
  await expectFail("another Pro cannot", zitouna, `select public.delete_account($1)`, [member], /administrateur/);
  await expectOk("the administrator deletes an account", owner, `select public.delete_account($1) as r`, [member]);
  const deleted = (await as(owner, `select public.admin_list_accounts() as r`))[0].r.find((item) => item.id === member);
  deleted?.deleted_at && deleted.status === "suspended" ? ok("kept, marked deleted and suspended (filter in the list)") : bad("deleted", deleted);
  await expectOk("and restores it", owner, `select public.delete_account($1, true) as r`, [member]);
  await sys(); await db.exec(`update public.profiles set account_status = 'active' where id = '${member}'`);

  // Step 5 · a message to a closed Pro waits
  await expectOk("Zitouna closes its messages from outside", zitouna, `select public.set_pro_visibility(null, null, false) as r`);
  const o3 = (await one(`select org_id from public.profiles where id = $1`, [u3])).org_id;
  const conv = (await as(u3, `select public.org_send($1, 'Livrez-vous à La Marsa ?') as r`, [Z]))[0].r;
  const senderInbox = (await as(u3, `select public.org_inbox() as r`))[0].r.find((c) => c.conversation_id === conv);
  senderInbox?.held === true ? ok("sent anyway: the sender sees it waiting") : bad("held sender", senderInbox);
  const zInbox = (await as(zitouna, `select public.org_inbox() as r`))[0].r;
  !zInbox.some((c) => c.conversation_id === conv) ? ok("Zitouna does not see it yet") : bad("held visible", zInbox);
  await expectOk("Zitouna opens its messages", zitouna, `select public.set_pro_visibility(null, null, true) as r`);
  const zInbox2 = (await as(zitouna, `select public.org_inbox() as r`))[0].r.find((c) => c.conversation_id === conv);
  zInbox2 && zInbox2.held === false && Number(zInbox2.unread) === 1 ? ok("the waiting message arrives") : bad("released", zInbox2);

  // Step 6 · the card of a Pro, as it chose to show it
  const card = (await as(owner, `select public.pro_public_card($1) as r`, [o3]))[0].r;
  card.name === "Leila B" && card.phone === null && "address" in card ? ok("its card: what it chose to show (no phone by default)") : bad("card", card);
  await expectOk("it shows its phone", u3, `select public.set_profile_visibility('{"phone": true}'::jsonb) as r`);
  const card2 = (await as(owner, `select public.pro_public_card($1) as r`, [o3]))[0].r;
  card2.phone !== undefined && card2.phone !== null || card2.phone === "" ? ok("phone now shown") : bad("phone", card2);

  // Step 7 · my details
  await expectOk("I change my name and phone", u3, `select public.set_my_profile('Leila Ben Salah', '+216 20 000 000') as r`);
  const me = await one(`select full_name, phone from public.profiles where id = $1`, [u3]);
  me.full_name === "Leila Ben Salah" && me.phone ? ok("saved") : bad("my profile", me);
  const org = (await as(u3, `select public.my_org_profile() as r`))[0].r;
  org.name === "Leila B" && org.can_edit ? ok("a private person sees and may edit its own details (raison sociale not empty)") : bad("my org", org);
  await expectOk("and changes them", u3, `select public.set_company_profile('{"name":"Leila Ben Salah","address":"La Marsa"}'::jsonb) as r`);
  (await as(u3, `select public.my_org_profile() ->> 'address' as r`))[0].r === "La Marsa" ? ok("details saved") : bad("org saved", "");
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((r) => r.migration <= "20261126_fixes.sql").every((r) => r.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((r) => r.etat !== "OK"));
}
