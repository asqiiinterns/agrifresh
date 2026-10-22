// Messages between team members: direct, group, profile, everyone.
export async function runTeamMessageChecks({ db, file, ok, bad, as, expectOk, expectFail, U }) {
  console.log("\n# Team messages");
  for (const f of ["supabase/migrations/20261029_team_messages.sql", "supabase/migrations/20261029_team_messages.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const A = { admin: "00000000-0000-0000-0000-0000000000a1", prod: "00000000-0000-0000-0000-0000000000a2" };
  const dir = await as(U.staff, `select public.team_directory() as r`);
  ok("supervisor sees the team directory", dir[0].r.map((p) => `${p.name}:${p.role}`));
  dir[0].r.some((p) => p.id === U.c1) ? bad("directory", "client listed") : ok("clients are not in the directory");
  await expectFail("client has no team messaging", U.c1, `select public.team_directory()`, [], /pas activée/);

  const d1 = await expectOk("supervisor → driver (one person)", U.staff, `select public.team_start_conversation('direct', array[$1]::uuid[]) as r`, [U.driver]);
  const d2 = await expectOk("same pair reuses the conversation", U.driver, `select public.team_start_conversation('direct', array[$1]::uuid[]) as r`, [U.staff]);
  d1?.[0]?.r === d2?.[0]?.r ? ok("one direct conversation per pair") : bad("direct reuse", [d1, d2]);
  const direct = d1?.[0]?.r;
  await expectOk("supervisor writes", U.staff, `select public.team_send_message($1, 'Passe au dépôt à 8h') ->> 'body' as r`, [direct]);
  const unread = await as(U.driver, `select public.team_unread_count() as r`);
  unread[0].r === 1 ? ok("driver has 1 unread") : bad("unread", unread);
  const alert = await as(U.driver, `select title, conversation_id from public.notifications where event = 'team.message' order by created_at desc limit 1`);
  alert[0]?.conversation_id === direct ? ok("driver alerted", alert[0].title) : bad("alert", alert);
  const peek = await as(A.prod, `select count(*)::int as n from public.team_messages where conversation_id = $1`, [direct]);
  peek[0].n === 0 ? ok("others cannot read a private conversation") : bad("privacy", peek);
  await expectFail("others cannot write in it", A.prod, `select public.team_send_message($1, 'hack')`, [direct], /participez pas/);
  await expectOk("driver reads", U.driver, `select public.team_mark_read($1) as r`, [direct]);
  const after = await as(U.driver, `select public.team_unread_count() as r, (select count(*)::int from public.notifications where conversation_id = $1 and read_at is null) as n`, [direct]);
  after[0].r === 0 && after[0].n === 0 ? ok("read clears the badge and the alert") : bad("mark read", after);

  const g = await expectOk("group with two people", U.staff, `select public.team_start_conversation('group', array[$1, $2]::uuid[], null, 'Tournée du matin') as r`, [U.driver, A.prod]);
  await expectOk("message to the group", U.staff, `select public.team_send_message($1, 'Départ 7h30') ->> 'id' as r`, [g?.[0]?.r]);
  const groupAlerts = await db.query(`select count(*)::int as n from public.notifications where conversation_id = $1`, [g?.[0]?.r]);
  groupAlerts.rows[0].n === 2 ? ok("both members alerted") : bad("group alerts", groupAlerts.rows[0].n);

  const r = await expectOk("message to all drivers", U.staff, `select public.team_start_conversation('role', null, 'driver') as r`);
  await expectOk("send", U.staff, `select public.team_send_message($1, 'Contrôle des véhicules vendredi') ->> 'id' as r`, [r?.[0]?.r]);
  const list = await as(U.driver, `select public.team_conversations_list() as r`);
  list[0].r.some((c) => c.title === "Tous les livreurs") ? ok("driver sees the drivers conversation", list[0].r.map((c) => c.title)) : bad("role list", list[0].r);
  const prodList = await as(A.prod, `select public.team_conversations_list() as r`);
  prodList[0].r.some((c) => c.kind === "role") ? bad("role isolation", "production sees drivers") : ok("production does not see the drivers conversation");

  const all = await expectOk("message to the whole team", A.admin, `select public.team_start_conversation('all') as r`);
  await expectOk("send", A.admin, `select public.team_send_message($1, 'Inventaire samedi') ->> 'id' as r`, [all?.[0]?.r]);
  const everyone = await db.query(`select count(*)::int as n from public.notifications where conversation_id = $1`, [all?.[0]?.r]);
  ok("team members alerted for the announcement", everyone.rows[0].n);
  const clientView = await as(U.c1, `select count(*)::int as n from public.team_messages`);
  clientView[0].n === 0 ? ok("clients never see team messages") : bad("client isolation", clientView);
  await expectOk("admin switches team messaging off for drivers", A.admin, `select public.admin_set_permission('driver', 'team.messages', false) as r`);
  await expectFail("driver blocked once off", U.driver, `select public.team_send_message($1, 'x')`, [direct], /participez pas/);
  await expectOk("restore", A.admin, `select public.admin_set_permission('driver', 'team.messages', true) as r`);
}
