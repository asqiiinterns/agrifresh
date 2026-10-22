// Payments, reminders, billing board, order flags, messages needing a reply.
export async function runBillingDecisionChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P, c1 }) {
  console.log("\n# Billing and decisions");
  for (const f of ["supabase/migrations/20261031_billing_decisions.sql", "supabase/migrations/20261031_billing_decisions.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const A = { admin: "00000000-0000-0000-0000-0000000000a1" };
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  await as(A.admin, `select public.admin_set_permission('supervisor', 'invoices.manage', true)`);
  await as(A.admin, `select public.admin_set_permission('supervisor', 'messages.manage', true)`);

  const inv = await one(`select id, total_ttc, amount_paid, status, due_date from public.client_invoices where client_id = $1 and status = 'issued' order by issued_at desc limit 1`, [c1]);
  if (!inv) { bad("issued invoice", "none"); return; }
  ok("issued invoice has a due date", inv.due_date);
  const half = Math.round(Number(inv.total_ttc) / 2 * 1000) / 1000;
  await expectFail("client cannot record a payment", U.c1, `select public.staff_add_payment($1, 1, 'cash')`, [inv.id], /ne permet pas/);
  await expectFail("over-payment refused", U.staff, `select public.staff_add_payment($1, $2, 'cash')`, [inv.id, Number(inv.total_ttc) + 5], /reste/);
  await expectOk("partial payment by check", U.staff, `select public.staff_add_payment($1, $2, 'check', current_date, 'CHQ 1234') ->> 'status' as r`, [inv.id, half]);
  const mid = await one(`select status, amount_paid from public.client_invoices where id = $1`, [inv.id]);
  mid.status === "issued" && Number(mid.amount_paid) === half ? ok("invoice partly paid", mid.amount_paid) : bad("partial", mid);
  const credit = await expectOk("credit note to use", U.staff, `select public.staff_create_credit_note($1, null, 'Remise', $2::jsonb, true) as r`, [c1, JSON.stringify([{ label: "Remise", quantity: 1, unit_price: 0.5, vat_rate: 0 }])]);
  await expectOk("pay part with the credit note", U.staff, `select public.staff_add_payment($1, 0.5, 'credit_note', null, null, $2) ->> 'status' as r`, [inv.id, credit?.[0]?.r?.id]);
  const cs = await one(`select status from public.credit_notes where id = $1`, [credit?.[0]?.r?.id]);
  cs.status === "deducted" ? ok("credit note deducted") : bad("credit deducted", cs);
  const rest = await one(`select total_ttc - amount_paid as rest from public.client_invoices where id = $1`, [inv.id]);
  await expectOk("pay the rest by transfer", U.staff, `select public.staff_add_payment($1, $2, 'transfer') ->> 'status' as r`, [inv.id, rest.rest]);
  const paid = await one(`select status, paid_at from public.client_invoices where id = $1`, [inv.id]);
  paid.status === "paid" && paid.paid_at ? ok("invoice paid once the balance is zero") : bad("paid", paid);
  const pays = await as(U.c1, `select method from public.invoice_payments where invoice_id = $1 order by created_at`, [inv.id]);
  const sees = await as(U.c1, `select count(*)::int as n from public.client_invoices where id = $1`, [inv.id]);
  pays.length === 3 || (sees[0].n === 0 && pays.length === 0) ? ok("client sees its payments only with its invoices", pays.map((p) => p.method)) : bad("client payments", { pays, sees });
  const transfer = await one(`select id from public.invoice_payments where invoice_id = $1 and method = 'transfer'`, [inv.id]);
  await expectOk("delete a payment", U.staff, `select public.staff_delete_payment($1) as r`, [transfer.id]);
  const back = await one(`select status from public.client_invoices where id = $1`, [inv.id]);
  back.status === "issued" ? ok("invoice back to issued") : bad("back to issued", back);

  await db.exec(`update public.client_invoices set due_date = current_date - 10 where id = '${inv.id}'`);
  const sent = await expectOk("send reminders", U.staff, `select public.staff_send_payment_reminders() as r`);
  sent?.[0]?.r >= 1 ? ok("reminder sent") : bad("reminders", sent);
  const again = await as(U.staff, `select public.staff_send_payment_reminders() as r`);
  again[0].r === 0 ? ok("no second reminder before the interval") : bad("interval", again);
  await expectOk("client turns reminders off", U.c1, `select public.set_my_reminder_opt_out(true) as r`);
  await expectOk("admin makes reminders mandatory for all clients", A.admin, `select public.admin_set_client_default('reminder_opt_out_allowed', 'false') as r`);
  await expectFail("client can no longer opt out", U.c1, `select public.set_my_reminder_opt_out(true)`, [], /obligatoires/);
  const forced = await as(U.staff, `select public.staff_send_payment_reminders(null, true) as r`);
  forced[0].r >= 1 ? ok("reminder sent despite the old opt-out (mandatory)") : bad("mandatory", forced);
  await expectOk("restore default", A.admin, `select public.admin_set_client_default('reminder_opt_out_allowed', 'true') as r`);
  const acct = await as(U.c1, `select public.my_account() -> 'client' as c`);
  "reminder_opt_out_allowed" in acct[0].c ? ok("client account shows its reminder options") : bad("account", acct[0].c);

  await db.exec(`update public.clients set billing_frequency = 'every_n_days', billing_every_days = 7, billing_start = current_date - 30 where id = '${c1}'`);
  const o = await expectOk("order to invoice", U.c1, `select public.place_client_order($1::jsonb, null, null, null) as r`, [JSON.stringify([{ product_id: P.oranges, quantity: 1 }])]);
  await db.exec(`update public.clients set custom_settings = array['invoice_mode'], invoice_mode = 'manual' where id = '${c1}'`);
  await as(U.staff, `select public.staff_update_order_status($1, 'confirmed', null)`, [o?.[0]?.r?.id]);
  await db.exec(`update public.client_invoices set issued_at = now() - interval '20 days' where client_id = '${c1}'`);
  const board = await as(U.staff, `select public.billing_board() as b`);
  board[0].b.due.some((d) => d.client_id === c1) ? ok("client due for invoicing", board[0].b.due.find((d) => d.client_id === c1)) : bad("billing due", board[0].b);
  board[0].b.overdue.length ? ok("overdue invoices listed", board[0].b.overdue.length) : bad("overdue", board[0].b);
  await db.exec(`update public.clients set billing_frequency = 'monthly_day', billing_month_day = 1 where id = '${c1}'`);
  const next = await one(`select public.next_billing_date($1) as d`, [c1]);
  ok("monthly billing date", next.d);
  await db.exec(`update public.clients set billing_frequency = 'manual', custom_settings = '{}' where id = '${c1}'`);

  const oid = o?.[0]?.r?.id;
  await expectOk("special follow-up at acceptance", U.staff, `select public.staff_set_order_flags($1, true, null) as r`, [oid]);
  await expectOk("to reschedule", U.staff, `select public.staff_set_order_flags($1, null, true) as r`, [oid]);
  const flags = await one(`select special_follow, needs_reschedule from public.orders where id = $1`, [oid]);
  flags.special_follow && flags.needs_reschedule ? ok("flags saved") : bad("flags", flags);
  await expectFail("client cannot flag", U.c1, `select public.staff_set_order_flags($1, false, null)`, [oid], /ne permet pas/);

  const msg = await as(U.c1, `select public.send_message(null, 'Pouvez-vous me rappeler ?') ->> 'id' as id`);
  await expectOk("mark the message as needing a reply", U.staff, `select public.staff_flag_message($1, true) as r`, [msg[0].id]);
  const waiting = await as(U.staff, `select public.messages_needing_reply() as r`);
  waiting[0].r.some((w) => w.client_id === c1) ? ok("conversation waiting for a reply") : bad("needs reply", waiting);
  await as(U.staff, `select public.send_message($1, 'Bien sûr, je vous appelle.')`, [c1]);
  const after = await as(U.staff, `select public.messages_needing_reply() as r`);
  !after[0].r.some((w) => w.client_id === c1) ? ok("answering clears it") : bad("clear needs reply", after);
}
