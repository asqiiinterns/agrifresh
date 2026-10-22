// 20261123_location.sql: a look at a colleague's position goes through a request the person answers.
export async function runLocationChecks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Location with consent");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261123_location.sql", "supabase/migrations/20261123_location.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const driver = (await one(`select id from public.profiles where role = 'driver' and org_id = $1 and account_status = 'active' limit 1`, [L])).id;
  const viewer = (await one(`select pr.id from public.profiles pr where pr.org_id = $1 and pr.account_status = 'active' and pr.role in ('staff', 'supervisor') and pr.id <> $2 limit 1`, [L, owner]))?.id;
  await sys(); await db.exec(`insert into public.user_locations (user_id, latitude, longitude, accuracy, updated_at) values ('${driver}', 36.8, 10.18, 20, now() - interval '10 minutes')
    on conflict (user_id) do update set latitude = 36.8, longitude = 10.18`);
  const direct = await as(owner, `select count(*)::int as n from public.user_locations where user_id = $1`, [driver]);
  direct[0].n === 0 ? ok("positions are no longer readable directly") : bad("direct read", direct);
  const team = (await as(owner, `select public.team_locations() as r`))[0].r;
  const row = team.find((p) => p.user_id === driver);
  row && row.latitude === null && "tracking" in row ? ok("the team list shows no position") : bad("team list", row);
  // Accepted
  const r1 = (await as(owner, `select public.request_location($1) as r`, [driver]))[0].r;
  const asked = (await as(driver, `select public.my_location_requests() as r`))[0].r;
  asked.some((x) => x.id === r1) ? ok("the person sees the request at once") : bad("request seen", asked);
  const told = await one(`select count(*)::int as n from public.notifications where user_id = $1 and event = 'location.request'`, [driver]);
  told.n > 0 ? ok("and is notified") : bad("notified", told);
  await expectOk("she accepts with her current position", driver, `select public.answer_location_request($1, true, 36.81, 10.17, 8) as r`, [r1]);
  const s1 = (await as(owner, `select public.location_request_status($1) as r`, [r1]))[0].r;
  s1.status === "accepted" && s1.latitude === 36.81 ? ok("the one asking sees it", s1.status) : bad("accepted", s1);
  // Refused
  const r2 = (await as(owner, `select public.request_location($1) as r`, [driver]))[0].r;
  await expectOk("she refuses", driver, `select public.answer_location_request($1, false) as r`, [r2]);
  const s2 = (await as(owner, `select public.location_request_status($1) as r`, [r2]))[0].r;
  s2.status === "refused" && s2.latitude === null ? ok("nothing shown") : bad("refused", s2);
  // No answer, not an admin, no tracking: expired
  if (viewer) {
    await sys(); await db.exec(`update public.role_permissions set allowed = true where feature = 'location.view'`);
    const canView = (await as(viewer, `select public.has_feature('location.view') as r`))[0].r;
    if (canView) {
      const r3 = (await as(viewer, `select public.request_location($1) as r`, [driver]))[0].r;
      await sys(); await db.exec(`update public.location_requests set created_at = now() - interval '2 minutes' where id = '${r3}'`);
      const s3 = (await as(viewer, `select public.location_request_status($1) as r`, [r3]))[0].r;
      s3.status === "expired" && s3.latitude === null ? ok("no answer, no tracking: nothing shown to a colleague") : bad("expired", s3);
      await expectOk("the administrator allows tracking for this account", owner, `select public.set_location_tracking($1, true) as r`, [driver]);
      const r4 = (await as(viewer, `select public.request_location($1) as r`, [driver]))[0].r;
      await sys(); await db.exec(`update public.location_requests set created_at = now() - interval '2 minutes' where id = '${r4}'`);
      const s4 = (await as(viewer, `select public.location_request_status($1) as r`, [r4]))[0].r;
      s4.status === "automatic" && s4.latitude !== null ? ok("tracking allowed: last known position after a minute") : bad("automatic", s4);
      await expectOk("tracking off again", owner, `select public.set_location_tracking($1, false) as r`, [driver]);
    } else ok("(no colleague with the right in the test data)");
  }
  // No answer, the administrator: shown, the person is told
  const r5 = (await as(owner, `select public.request_location($1) as r`, [driver]))[0].r;
  const early = (await as(owner, `select public.location_request_status($1) as r`, [r5]))[0].r;
  early.status === "pending" && early.seconds_left > 0 ? ok("waiting for the answer", early.seconds_left) : bad("pending", early);
  await sys(); await db.exec(`update public.location_requests set created_at = now() - interval '2 minutes' where id = '${r5}'`);
  const s5 = (await as(owner, `select public.location_request_status($1) as r`, [r5]))[0].r;
  const viewed = await one(`select count(*)::int as n from public.notifications where user_id = $1 and event = 'location.viewed'`, [driver]);
  s5.status === "automatic" && viewed.n > 0 ? ok("the administrator sees it after a minute, the person is told") : bad("admin automatic", { s5, viewed });
  const views = (await as(driver, `select public.my_location_views() as r`))[0].r;
  views.length >= 4 ? ok("the person can see every look at her position", views.length) : bad("views", views);
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  await expectFail("another Pro cannot ask", zitouna, `select public.request_location($1)`, [driver], /introuvable|ne permet pas/);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration <= "20261123_location.sql").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
  await expectFail("nobody else reads the answer", zitouna, `select public.location_request_status($1)`, [r1], /introuvable/);
}
