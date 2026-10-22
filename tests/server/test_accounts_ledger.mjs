// Accounts between a supplier and its clients: deposits, statement, outstanding limit.
export async function runAccountLedgerChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P, c1 }) {
  console.log("\n# Accounts: deposits, statement, outstanding limit");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261114_accounts.sql", "supabase/migrations/20261114_accounts.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  await expectOk("customers see their invoices again (an earlier test turned it off)", owner, `select public.admin_set_permission('customer', 'client.invoices', true) as r`);
  const dep = await expectOk("AgriFresh records a 50 TND deposit from its client", owner, `select public.staff_record_deposit($1, 'deposit', 50, 'cash', null, 'REC-1', null) ->> 'deposits' as r`, [c1]);
  Number(dep?.[0]?.r) >= 50 ? ok("deposit available", dep[0].r) : bad("deposit", dep);
  const inv = await one(`select id, total_ttc - amount_paid as balance from public.client_invoices where client_id = $1 and status = 'issued' and total_ttc - amount_paid > 0 order by created_at limit 1`, [c1]);
  if (inv) {
    const amount = Math.min(Number(inv.balance), 20);
    await expectOk("applies part of the deposit to an invoice", owner, `select public.staff_apply_deposit($1, $2) as r`, [inv.id, amount]);
    const after = await one(`select total_ttc - amount_paid as balance from public.client_invoices where id = $1`, [inv.id]);
    Math.abs(Number(inv.balance) - amount - Number(after.balance)) < 0.001 ? ok("the invoice balance went down by the applied deposit") : bad("applied", { before: inv.balance, after });
    await expectFail("cannot apply more than the deposit left", owner, `select public.staff_apply_deposit($1, 100000)`, [inv.id], /Montant invalide/);
  } else ok("no open invoice to apply a deposit to (skipped)");
  const st = await as(U.c1, `select public.account_statement() as r`);
  const lines = st[0].r.lines;
  lines.some((l) => l.kind === "deposit") && st[0].r.figures ? ok("the client sees its statement with the deposit", { lines: lines.length, figures: st[0].r.figures }) : bad("statement", st[0].r);
  await expectFail("another client cannot read this account", U.c2, `select public.account_statement($1)`, [c1], /introuvable/);
  const chef = (await one(`select u.id from auth.users u where lower(u.email) = 'chef@b.tn'`)).id;
  await expectFail("another supplier cannot record a deposit here", chef, `select public.staff_record_deposit($1, 'deposit', 10, 'cash')`, [c1], /introuvable|ne permet pas/);
  const figures = (await as(owner, `select public.account_statement($1) -> 'figures' as f`, [c1]))[0].f;
  await expectFail("cannot pay back more than the deposit left", owner, `select public.staff_record_deposit($1, 'refund', $2, 'cash')`, [c1, Number(figures.deposits) + 1], /Il ne reste/);
  if (Number(figures.deposits) > 0) await expectOk("pays back what is left", owner, `select public.staff_record_deposit($1, 'refund', $2, 'cash') as r`, [c1, Number(figures.deposits)]);
  await expectOk("sets an outstanding limit of 0 (pay before ordering)", owner, `select public.staff_set_credit_limit($1, 0) as r`, [c1]);
  const items = JSON.stringify([{ product_id: P.oranges, quantity: 1 }]);
  await expectFail("the client cannot order beyond its limit", U.c1, `select public.place_client_order($1::jsonb, null, null, null)`, [items], /Encours atteint/);
  await expectOk("limit removed", owner, `select public.staff_set_credit_limit($1, null) as r`, [c1]);
  await expectOk("the client orders again", U.c1, `select public.place_client_order($1::jsonb, null, null, null) ->> 'id' as r`, [items]);
  const all = await as(owner, `select jsonb_array_length(public.staff_accounts()) as n`);
  all[0].n > 0 ? ok("accounts list for the supplier", all[0].n) : bad("accounts", all);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration <= "20261114").every((row) => row.etat === "OK") ? ok("check query: all installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
}
