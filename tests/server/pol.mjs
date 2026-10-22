export async function runPol({ db }) {
  const r = await db.query(`select policyname, cmd, qual from pg_policies where tablename in ('orders','order_items') and schemaname='public' order by 1`);
  for (const x of r.rows) console.log("POL", x.policyname, x.cmd, x.qual);
}
