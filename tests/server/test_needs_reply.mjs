// "Needs a reply" on client and team messages.
export async function runNeedsReplyChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1 }) {
  console.log("\n# Needs a reply");
  for (const f of ["supabase/migrations/20261102_needs_reply.sql", "supabase/migrations/20261102_needs_reply.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const sent = await expectOk("client sends a message needing a reply", U.c1, `select public.send_message_v2(null, 'Urgent : livraison demain ?', null, true) ->> 'needs_reply' as r`);
  sent?.[0]?.r === "true" ? ok("flag saved at sending") : bad("flag at sending", sent);
  let board = await as(U.staff, `select public.messages_needing_reply() as r`);
  board[0].r.clients.some((c) => c.client_id === c1) ? ok("team sees the client waiting") : bad("clients waiting", board[0].r);
  const staffMsg = await as(U.staff, `select public.send_message_v2($1, 'Oui, avant 9h. Confirmez-vous ?', null, true) as r`, [c1]);
  board = await as(U.staff, `select public.messages_needing_reply() as r`);
  !board[0].r.clients.some((c) => c.client_id === c1) ? ok("team answer clears the client's flag") : bad("clear client", board[0].r);
  const own = await one(db, `select needs_reply from public.messages where id = $1`, [staffMsg[0].r.id]);
  own.needs_reply ? ok("team message itself waits for the client") : bad("staff flag", own);
  await as(U.c1, `select public.send_message(null, 'Confirmé')`);
  const cleared = await one(db, `select needs_reply from public.messages where id = $1`, [staffMsg[0].r.id]);
  !cleared.needs_reply ? ok("client answer clears the team's flag") : bad("clear staff", cleared);

  const conv = await as(U.staff, `select public.team_start_conversation('direct', array[$1]::uuid[]) as id`, [U.driver]);
  const id = conv[0].id;
  const m = await expectOk("team message needing a reply", U.staff, `select public.team_send_message_v2($1, 'Peux-tu passer prendre la caisse ?', null, true) ->> 'id' as r`, [id]);
  const waiting = await as(U.driver, `select public.messages_needing_reply() -> 'team' as r`);
  waiting[0].r.some((w) => w.conversation_id === id) ? ok("driver sees it waiting") : bad("team waiting", waiting);
  const alert = await as(U.driver, `select body from public.notifications where conversation_id = $1 order by created_at desc limit 1`, [id]);
  alert[0]?.body?.startsWith("❗") ? ok("alert marked", alert[0].body) : bad("alert mark", alert);
  const mine = await as(U.staff, `select public.messages_needing_reply() -> 'team' as r`);
  !mine[0].r.some((w) => w.conversation_id === id) ? ok("the sender does not see its own message as waiting") : bad("own", mine);
  await as(U.driver, `select public.team_send_message($1, 'OK')`, [id]);
  const done = await one(db, `select needs_reply from public.team_messages where id = $1`, [m[0].r]);
  !done.needs_reply ? ok("reply clears it") : bad("team clear", done);
  await expectOk("flag an existing team message", U.driver, `select public.team_flag_message($1, true) as r`, [m[0].r]);
  await expectFail("outsider cannot flag", U.c1, `select public.team_flag_message($1, true)`, [m[0].r], /introuvable/);
  const A = { prod: "00000000-0000-0000-0000-0000000000a2" };
  await expectOk("add production to the conversation", U.staff, `select public.team_add_members($1, array[$2]::uuid[]) as r`, [id, A.prod]);
  const kind = await one(db, `select kind, (select count(*)::int from public.team_conversation_members where conversation_id = $1) as n from public.team_conversations where id = $1`, [id]);
  kind.kind === "group" && kind.n === 3 ? ok("conversation became a group of 3") : bad("add members", kind);
  await expectFail("outsider cannot add people", U.c1, `select public.team_add_members($1, array[$2]::uuid[])`, [id, U.c1], /participez pas/);
}

async function one(db, sql, params) { return (await db.query(sql, params)).rows[0]; }
