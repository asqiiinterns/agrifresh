// 20261205_home_counts.sql: the home figures counted by the database give the same numbers as the lists.
export async function runHomeChecks({ db, file, ok, bad, as, expectFail }) {
  console.log("\n# Home counts computed by the database");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261205_home_counts.sql", "supabase/migrations/20261205_home_counts.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const today = (await one(`select current_date::text as d`)).d;
  // Some variety: an order due today, one delivered today, a special follow-up.
  await sys();
  await db.exec(`update public.orders set requested_delivery_date = current_date where id = (select id from public.orders where status in ('pending','confirmed') order by created_at limit 1)`);
  await db.exec(`update public.orders set special_follow = true where id = (select id from public.orders order by created_at desc limit 1)`);

  const users = [
    ["owner", (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id],
    ["other Pro", (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id],
    ["driver", (await one(`select id from public.profiles where role = 'driver' and account_status = 'active' limit 1`)).id],
  ];
  for (const [name, uid] of users) {
    const counts = (await as(uid, `select public.home_counts($1::date, 0) as r`, [today]))[0].r;
    // What the home used to compute from the lists, with the same person's rights.
    const orders = await as(uid, `select o.status::text, o.created_at::date::text as created, o.requested_delivery_date::text as due, o.special_follow, o.needs_reschedule,
      coalesce(o.delivered_at, (select max(h.created_at) from public.order_status_history h where h.order_id = o.id and h.status in ('delivered','declined','cancelled')), o.created_at)::date::text as closed
      from public.orders o where o.status not in ('delivered','declined','cancelled') or o.updated_at >= now() - interval '62 days' or o.created_at >= now() - interval '62 days'`);
    const n = (f) => orders.filter(f).length;
    const inv = await as(uid, `select status::text, total_ttc::float as t, amount_paid::float as p, due_date::text as due, issued_at::date::text as issued from public.client_invoices where status in ('issued','paid')`);
    const expected = {
      decide: n((o) => ["pending", "on_hold", "awaiting_client"].includes(o.status)),
      queue: n((o) => ["confirmed", "preparing", "ready"].includes(o.status)),
      prepare: n((o) => ["confirmed", "preparing"].includes(o.status)),
      ready: n((o) => o.status === "ready"),
      shipping: n((o) => o.status === "out_for_delivery"),
      placedToday: n((o) => o.created === today),
      dueToday: n((o) => o.due === today && !["delivered", "declined", "cancelled"].includes(o.status)),
      deliveredToday: n((o) => o.status === "delivered" && o.closed === today),
      special: n((o) => o.special_follow),
      reschedule: n((o) => o.needs_reschedule && ["confirmed", "preparing", "ready"].includes(o.status)),
      outstanding: Math.round(inv.filter((i) => i.status === "issued").reduce((s, i) => s + Math.max(0, i.t - (i.p ?? 0)), 0)),
      overdue: inv.filter((i) => i.status === "issued" && i.due && i.due < today && i.t - (i.p ?? 0) > 0.0005).length,
      claims: Number((await as(uid, `select count(*)::int as c from public.claims where status in ('open','in_progress')`))[0].c),
      returns: Number((await as(uid, `select count(*)::int as c from public.returns where status in ('requested','approved','received')`))[0].c),
    };
    const diff = Object.entries(expected).filter(([k, v]) => Number(counts[k]) !== v);
    diff.length === 0 ? ok(`${name}: same figures as the lists`, JSON.stringify(expected)) : bad(`${name}: figures differ`, diff.map(([k, v]) => `${k}: ${counts[k]} vs ${v}`));
  }
  const anon = await one(`select has_function_privilege('anon', 'public.home_counts(date,int)', 'execute') as a`);
  anon.a === false ? ok("not callable without an account") : bad("anon can call home_counts", anon);

  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((r) => r.migration <= "20261205_home_counts.sql").every((r) => r.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((r) => r.etat !== "OK"));
}
