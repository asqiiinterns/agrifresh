// Alerts: notifications, push and e-mail delivery (pg_net and Vault stubbed).
export async function runAlertChecks({ db, file, ok, bad, as, expectOk, expectFail, step, U, P, c1, c2, c2points }) {
  console.log("\n# Alerts migration");
  await db.exec(`
    create schema if not exists net;
    create table if not exists net.calls (id serial primary key, url text, body jsonb, headers jsonb);
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
    returns bigint language sql as $$ insert into net.calls (url, body, headers) values (url, body, headers) returning id::bigint $$;
    create schema if not exists vault;
    create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
    create or replace view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
    create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid
      language sql as $$ insert into vault.secrets (name, secret, description) values (new_name, new_secret, new_description) returning id $$;
    create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null) returns void
      language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;
  `);
  const src = (f) => file(f).replace("create extension if not exists pg_net;", "");
  for (const f of ["supabase/migrations/20261025_alerts.sql", "supabase/migrations/20261025_alerts.sql"]) {
    try { await db.exec(src(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const A = { admin: "00000000-0000-0000-0000-0000000000a1" };
  const calls = async () => (await db.query(`select url, body, headers from net.calls order by id`)).rows;
  const unread = async (uid) => (await as(uid, `select count(*)::int as n from public.notifications where read_at is null`))[0].n;

  console.log("\n# In-app alerts");
  await expectFail("invalid push token refused", U.c2, `select public.register_push_token('abc', 'android')`, [], /invalide/);
  await expectOk("client 2 registers a push token", U.c2, `select public.register_push_token('ExponentPushToken[client2]', 'android') as r`);
  await expectOk("supervisor registers a push token", U.staff, `select public.register_push_token('ExponentPushToken[staff]', 'android') as r`);
  const before = (await calls()).length;
  const o = await expectOk("client 2 orders", U.c2, `select public.place_client_order($1::jsonb, $2, null, null) as r`, [JSON.stringify([{ product_id: P.oranges, quantity: 1 }]), c2points[0].id]);
  const id = o?.[0]?.r?.id;
  (await unread(U.staff)) > 0 ? ok("supervisor alerted of the new order") : bad("staff alert", 0);
  (await unread(A.admin)) > 0 ? ok("admin alerted too") : bad("admin alert", 0);
  const push = (await calls()).slice(before).find((c) => c.url.includes("exp.host") && JSON.stringify(c.body).includes("ExponentPushToken[staff]"));
  push ? ok("push sent to the supervisor's phone", push.body[0].title) : bad("push to staff", JSON.stringify(await calls()));
  await step("accept", U.staff, id, "confirmed");
  const clientAlert = await as(U.c2, `select title from public.notifications order by created_at desc limit 1`);
  clientAlert[0]?.title?.includes("acceptée") ? ok("client alerted of acceptance", clientAlert[0].title) : bad("client alert", JSON.stringify(clientAlert));
  const otherClient = await as(U.c1, `select count(*)::int as n from public.notifications where order_id = $1`, [id]);
  otherClient[0].n === 0 ? ok("other clients see nothing") : bad("isolation", otherClient[0].n);

  console.log("\n# Preferences and settings");
  await expectOk("client turns push off", U.c2, `select public.set_my_notification_prefs(false, true) as r`);
  const n1 = (await calls()).length;
  await step("prepare", U.staff, id, "preparing");
  const pushAfter = (await calls()).slice(n1).filter((c) => JSON.stringify(c.body).includes("ExponentPushToken[client2]"));
  pushAfter.length === 0 ? ok("no push when the person turned it off") : bad("push despite prefs", pushAfter.length);
  (await unread(U.c2)) > 0 ? ok("alert still listed in the app") : bad("in-app after pref", 0);
  await expectOk("client turns push back on", U.c2, `select public.set_my_notification_prefs(true, true) as r`);
  await expectFail("supervisor cannot change alert settings", U.staff, `select public.admin_set_notification_setting('order.status', false, false)`, [], /administrateurs/);
  await expectOk("admin turns off status pushes", A.admin, `select public.admin_set_notification_setting('order.status', false, false) as r`);
  const n2 = (await calls()).length;
  await step("ready", U.staff, id, "ready");
  (await calls()).slice(n2).length === 0 ? ok("event disabled: no push") : bad("disabled event", (await calls()).slice(n2).length);
  await expectOk("restore status pushes", A.admin, `select public.admin_set_notification_setting('order.status', true, true) as r`);

  console.log("\n# E-mails");
  await expectFail("test e-mail needs a key", A.admin, `select public.admin_send_test_email('a@x.tn')`, [], /clé API/);
  await expectOk("admin stores the API key", A.admin, `select public.admin_set_email_api_key('re_test_key') as r`);
  await expectOk("admin replaces the API key", A.admin, `select public.admin_set_email_api_key('re_live_key') as r`);
  const status = await as(A.admin, `select public.admin_email_status() as s`);
  status[0].s.has_key === true && status[0].s.enabled === false ? ok("status: key stored, sending off") : bad("email status", JSON.stringify(status[0].s));
  const keyLeak = await as(A.admin, `select count(*)::int as n from public.app_settings where email_from like '%re_live%'`);
  keyLeak[0].n === 0 ? ok("key not readable from app tables") : bad("key leak", keyLeak[0].n);
  await expectFail("test e-mail needs sending on", A.admin, `select public.admin_send_test_email('a@x.tn')`, [], /Activez/);
  await expectOk("admin enables e-mails", A.admin, `select public.admin_set_email_settings(true, 'AgriFresh <commandes@agrifresh.tn>') as r`);
  const n3 = (await calls()).length;
  await expectOk("test e-mail", A.admin, `select public.admin_send_test_email('a@x.tn') as r`);
  const mail = (await calls()).slice(n3).find((c) => c.url.includes("resend"));
  mail && mail.headers.Authorization === "Bearer re_live_key" && mail.body.from.includes("commandes@agrifresh.tn") ? ok("Resend called with the stored key") : bad("resend call", JSON.stringify(mail));
  const n4 = (await calls()).length;
  await step("ship", U.staff, id, "out_for_delivery");
  const statusMail = (await calls()).slice(n4).find((c) => c.url.includes("resend"));
  statusMail && JSON.stringify(statusMail.body.to).includes("c2@x.tn") ? ok("status e-mail to the client", statusMail.body.subject) : bad("status e-mail", JSON.stringify((await calls()).slice(n4)));

  console.log("\n# Other events");
  await expectOk("re-enable client messages", A.admin, `select public.admin_set_permission('customer', 'client.messages', true) as r`);
  await expectOk("client 2 writes a message", U.c2, `select public.send_message(null, 'Bonjour') ->> 'id' as r`);
  const msgAlert = await as(U.staff, `select title from public.notifications where event = 'message.new' order by created_at desc limit 1`);
  msgAlert[0]?.title?.includes("Resto Marsa") ? ok("team alerted of the message", msgAlert[0].title) : bad("message alert", JSON.stringify(msgAlert));
  await db.exec(`insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-0000000000f9', 'nouveau@x.tn', now())`);
  const pending = await as(A.admin, `select title, body from public.notifications where event = 'account.pending' order by created_at desc limit 1`);
  pending[0]?.body?.includes("nouveau@x.tn") ? ok("admins alerted of the pending account") : bad("pending alert", JSON.stringify(pending));

  console.log("\n# Read state");
  await expectOk("mark all read", U.c2, `select public.mark_notifications_read(null) as r`);
  (await unread(U.c2)) === 0 ? ok("all read") : bad("mark read", await unread(U.c2));
  await expectFail("notifications not editable directly", U.c2, `update public.notifications set title = 'x'`, [], /permission denied/);
}
