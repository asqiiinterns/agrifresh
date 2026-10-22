// Re-running 20261101 after 20261102 (the order that failed in Supabase), then 20261102 again.
export async function runRerunOrderChecks({ db, file, ok, bad, as, expectOk, U, c1 }) {
  console.log("\n# Re-run order 1101 → 1102");
  for (const f of ["supabase/migrations/20261101_message_attachments.sql", "supabase/migrations/20261102_needs_reply.sql"]) {
    try { await db.exec(file(f)); ok(`re-applied ${f}`); } catch (e) { bad(`re-apply ${f}`, e); }
  }
  await expectOk("client message still works", U.c1, `select public.send_message(null, 'Test après réexécution') ->> 'body' as r`);
  await expectOk("message needing a reply still works", U.c1, `select public.send_message_v2(null, 'Urgent', null, true) ->> 'needs_reply' as r`);
}
