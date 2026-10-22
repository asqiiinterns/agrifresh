// Alerts flagged as important by their recipient only.
export async function runAlertImportantChecks({ db, file, ok, bad, as, expectOk, expectFail, U }) {
  console.log("\n# Important alerts");
  for (const f of ["supabase/migrations/20261028_alert_important.sql", "supabase/migrations/20261028_alert_important.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const mine = (await db.query(`select id from public.notifications where user_id = $1 limit 1`, [U.c1])).rows[0];
  if (!mine) { bad("alert to flag", "none for client 1"); return; }
  await expectOk("client flags its alert", U.c1, `select public.set_notification_important($1, true) as r`, [mine.id]);
  const flagged = await as(U.c1, `select important from public.notifications where id = $1`, [mine.id]);
  flagged[0]?.important === true ? ok("flag saved") : bad("flag", flagged);
  await expectFail("someone else cannot flag it", U.c2, `select public.set_notification_important($1, true)`, [mine.id], /introuvable/);
  await expectOk("client clears the flag", U.c1, `select public.set_notification_important($1, false) as r`, [mine.id]);
}
