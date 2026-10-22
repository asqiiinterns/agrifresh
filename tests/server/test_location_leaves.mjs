// Location with consent, reminders, leave requests.
export async function runLocationLeaveChecks({ db, file, ok, bad, as, expectOk, expectFail, U }) {
  console.log("\n# Location, reminders, leaves");
  for (const f of ["supabase/migrations/20261103_location_reminders_leaves.sql", "supabase/migrations/20261103_location_reminders_leaves.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const A = { admin: "00000000-0000-0000-0000-0000000000a1", prod: "00000000-0000-0000-0000-0000000000a2" };
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

  const before = await as(U.driver, `select public.update_my_location(36.8, 10.18, 15) as r`);
  before[0].r === false ? ok("no position stored without consent") : bad("consent", before);
  await expectOk("driver agrees to share", U.driver, `select public.set_location_consent(true) as r`);
  const after = await as(U.driver, `select public.update_my_location(36.8, 10.18, 15) as r`);
  after[0].r === true ? ok("position stored after consent") : bad("store", after);
  const supShare = await as(U.staff, `select public.set_location_consent(true), public.update_my_location(36.9, 10.2) as r`);
  supShare[0].r === false ? ok("supervisor profile not allowed to share by default") : bad("profile share", supShare);
  await expectFail("supervisor cannot see positions by default", U.staff, `select public.team_locations()`, [], /ne permet pas/);
  const map = await as(A.admin, `select public.team_locations() as r`);
  map[0].r.some((p) => p.latitude === 36.8) ? ok("admin sees the driver position") : bad("admin view", map);
  await expectOk("driver withdraws consent", U.driver, `select public.set_location_consent(false) as r`);
  const gone = await one(`select count(*)::int as n from public.user_locations where user_id = $1`, [U.driver]);
  gone.n === 0 ? ok("position erased on withdrawal") : bad("erase", gone);

  await expectOk("reminder created", U.staff, `insert into public.reminders (user_id, title, remind_at) values (auth.uid(), 'Appeler le transporteur', now() + interval '1 hour') returning title`);
  const other = await as(U.driver, `select count(*)::int as n from public.reminders`);
  other[0].n === 0 ? ok("reminders are private") : bad("reminder privacy", other);
  await expectFail("cannot create a reminder for someone else", U.driver, `insert into public.reminders (user_id, title, remind_at) values ($1, 'x', now())`, [U.staff], /row-level security/);

  const req = await expectOk("driver asks for leave", U.driver, `select public.request_leave('paid', current_date + 10, current_date + 14, false, 'Vacances') as r`);
  req?.[0]?.r?.status === "pending" ? ok("pending validation") : bad("leave pending", req);
  await expectFail("overlapping request refused", U.driver, `select public.request_leave('paid', current_date + 12, current_date + 13)`, [], /déjà une demande/);
  const alert = await one(`select count(*)::int as n from public.notifications where event = 'leave.new'`);
  alert.n > 0 ? ok("managers alerted") : bad("leave alert", alert);
  await expectFail("supervisor cannot validate by default", U.staff, `select public.decide_leave($1, 'approve')`, [req[0].r.id], /ne permet pas/);
  await expectOk("admin approves", A.admin, `select public.decide_leave($1, 'approve', 'Bonnes vacances') as r`, [req[0].r.id]);
  const seen = await as(A.prod, `select jsonb_array_length(public.leave_list(current_date, current_date + 30)) as n`);
  seen[0].n >= 1 ? ok("colleagues see approved absences") : bad("absence planning", seen);
  await expectOk("admin turns validation off", A.admin, `select public.admin_set_leave_approval(false) as r`);
  const auto = await as(A.prod, `select public.request_leave('training', current_date + 20, current_date + 20) ->> 'status' as r`);
  auto[0].r === "approved" ? ok("approved at once without validation") : bad("auto approve", auto);
  await expectOk("restore", A.admin, `select public.admin_set_leave_approval(true) as r`);
  await expectFail("client cannot ask for leave", U.c1, `select public.request_leave('paid', current_date, current_date)`, [], /ne permet pas/);
  const inc = await expectOk("driver reports a vehicle incident", U.driver, `select public.report_incident('vehicle', 'Crevaison', 'Pneu arrière crevé, route de Bizerte') as r`);
  const seenInc = await as(U.staff, `select count(*)::int as n from public.incidents`);
  seenInc[0].n === 1 ? ok("supervisor sees the incident") : bad("incident visibility", seenInc);
  const prodInc = await as(A.prod, `select count(*)::int as n from public.incidents`);
  prodInc[0].n === 0 ? ok("production does not") : bad("incident privacy", prodInc);
  await expectOk("supervisor resolves it", U.staff, `select public.resolve_incident($1, 'Dépanneuse envoyée') as r`, [inc[0].r]);
  await expectFail("client cannot report", U.c1, `select public.report_incident('delivery', 'x', 'y')`, [], /ne permet pas/);
}
