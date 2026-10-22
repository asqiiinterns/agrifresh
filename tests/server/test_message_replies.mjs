// Replies to a chosen message, and who may mark "needs a reply".
export async function runMessageReplyChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1, c2 }) {
  console.log("\n# Message replies");
  for (const f of ["supabase/migrations/20261105_message_replies.sql", "supabase/migrations/20261105_message_replies.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const first = await as(U.staff, `select public.send_message_v3($1, 'Livraison demain 8h, ça vous va ?', null, true) as r`, [c1]);
  const firstId = first[0].r.id;
  const own = await as(U.c1, `select public.messages_needing_reply() -> 'own' as r`);
  own[0].r === 1 ? ok("client sees 1 message waiting for its answer") : bad("own count", own);
  const reply = await expectOk("client replies to that message", U.c1, `select public.send_message_v3(null, 'Oui parfait', null, false, $1) ->> 'reply_to' as r`, [firstId]);
  reply?.[0]?.r === firstId ? ok("reply_to saved") : bad("reply_to", reply);
  const own2 = await as(U.c1, `select public.messages_needing_reply() -> 'own' as r`);
  own2[0].r === 0 ? ok("answer clears the client's count") : bad("own after reply", own2);
  const other = await as(U.staff, `select public.send_message_v3($1, 'Autre client', null, false) ->> 'id' as r`, [c2]);
  await expectFail("cannot reply to a message of another conversation", U.c1, `select public.send_message_v3(null, 'x', null, false, $1)`, [other[0].r], /pas dans cette conversation/);
  await expectOk("old v2 still works", U.c1, `select public.send_message_v2(null, 'via v2', null, false) ->> 'id' as r`);

  await expectFail("client cannot flag a team message", U.c1, `select public.staff_flag_message($1, true)`, [firstId], /auteur du message/);
  const mine = await as(U.c1, `select id from public.messages where client_id = $1 and body = 'Oui parfait'`, [c1]);
  await expectOk("client flags its own message", U.c1, `select public.staff_flag_message($1, true) as r`, [mine[0].id]);
  await expectOk("supervisor flags a client message", U.staff, `select public.staff_flag_message($1, false) as r`, [mine[0].id]);

  const conv = await as(U.staff, `select public.team_start_conversation('direct', array[$1]::uuid[]) as id`, [U.driver]);
  const id = conv[0].id;
  const tm = await as(U.staff, `select public.team_send_message_v3($1, 'Caisse prête ?', null, false) ->> 'id' as r`, [id]);
  await expectFail("driver cannot flag the supervisor's message", U.driver, `select public.team_flag_message($1, true)`, [tm[0].r], /auteur du message/);
  const dm = await expectOk("driver replies to it", U.driver, `select public.team_send_message_v3($1, 'Oui', null, false, $2) ->> 'id' as r`, [id, tm[0].r]);
  await expectOk("driver flags its own message", U.driver, `select public.team_flag_message($1, true) as r`, [dm[0].r]);
  await expectOk("supervisor flags any message of the conversation", U.staff, `select public.team_flag_message($1, true) as r`, [tm[0].r]);
  const thread = await as(U.driver, `select public.team_messages_of($1) -> 'messages' as r`, [id]);
  thread[0].r.some((m) => m.reply_to === tm[0].r) ? ok("thread returns reply_to") : bad("thread reply_to", thread);
  await expectOk("old team v2 still works", U.driver, `select public.team_send_message_v2($1, 'via v2', null, false) ->> 'id' as r`, [id]);
}
