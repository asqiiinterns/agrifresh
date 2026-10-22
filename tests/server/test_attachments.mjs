// Attachments in client and team messages (storage is stubbed in PGlite).
export async function runAttachmentChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1, c2 }) {
  console.log("\n# Message attachments");
  await db.exec(`
    create schema if not exists storage;
    create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select, insert on storage.objects to authenticated;
  `);
  for (const f of ["supabase/migrations/20261101_message_attachments.sql", "supabase/migrations/20261101_message_attachments.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const photo = (folder) => JSON.stringify({ path: `${folder}/abc-photo.jpg`, kind: "image", name: "photo.jpg", size: 1200, mime: "image/jpeg" });
  await db.exec(`update public.role_permissions set allowed = true where role = 'customer' and feature = 'client.messages'`);
  await expectOk("client uploads into its folder", U.c1, `insert into storage.objects (bucket_id, name) values ('attachments', $1) returning name`, [`client/${c1}/abc-photo.jpg`]);
  await expectFail("client cannot upload into another client's folder", U.c1, `insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [`client/${c2}/x.jpg`], /row-level security/);
  const sent = await expectOk("client sends a photo without text", U.c1, `select public.send_message_v2(null, '', $1::jsonb) -> 'attachment' ->> 'kind' as r`, [photo(`client/${c1}`)]);
  sent?.[0]?.r === "image" ? ok("photo message saved") : bad("photo", sent);
  await expectFail("attachment of another folder refused", U.c1, `select public.send_message_v2(null, 'x', $1::jsonb)`, [photo(`client/${c2}`)], /invalide/);
  await expectFail("empty message refused", U.c1, `select public.send_message_v2(null, '  ', null)`, [], /joignez/);
  await expectOk("old send_message still works", U.c1, `select public.send_message(null, 'Merci') ->> 'body' as r`);
  const peek = await as(U.c2, `select count(*)::int as n from storage.objects where name like $1`, [`client/${c1}/%`]);
  peek[0].n === 0 ? ok("other clients cannot read the file") : bad("storage privacy", peek);
  const staffSees = await as(U.staff, `select count(*)::int as n from storage.objects where name like $1`, [`client/${c1}/%`]);
  staffSees[0].n === 1 ? ok("the team reads the client's files") : bad("staff storage", staffSees);

  const conv = await as(U.staff, `select public.team_start_conversation('direct', array[$1]::uuid[]) as id`, [U.driver]);
  const id = conv[0].id;
  await expectOk("voice note in a team conversation", U.staff, `select public.team_send_message_v2($1, '', $2::jsonb) ->> 'id' as r`, [id, JSON.stringify({ path: `team/${id}/voice.m4a`, kind: "audio", name: "vocal.m4a", size: 3000, mime: "audio/mp4" })]);
  const alert = await as(U.driver, `select body from public.notifications where conversation_id = $1 order by created_at desc limit 1`, [id]);
  alert[0]?.body?.includes("vocal") ? ok("alert shows a voice note", alert[0].body) : bad("voice alert", alert);
  const thread = await as(U.driver, `select public.team_messages_of($1) -> 'messages' -> 0 -> 'attachment' ->> 'kind' as k`, [id]);
  thread[0].k === "audio" ? ok("thread returns the attachment") : bad("thread attachment", thread);
  await expectFail("non-member cannot upload to the conversation", U.c1, `insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [`team/${id}/x.jpg`], /row-level security/);
}
