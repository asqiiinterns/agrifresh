// After every migration: which functions and policies touch business data, and how.
export async function runInventory({ db }) {
  const tables = ["orders", "order_items", "order_status_history", "clients", "client_delivery_points", "products", "categories", "client_invoices", "invoices",
    "invoice_payments", "credit_notes", "credit_note_items", "returns", "return_items", "claims", "messages", "shipments", "vehicles", "recurring_orders",
    "document_numbering", "team_conversations", "team_messages", "leave_requests", "incidents", "reminders", "user_locations", "audit_log", "notifications",
    "role_permissions", "user_permissions", "client_setting_defaults", "home_layouts", "app_settings", "notification_settings", "company_profile", "payments"];
  const fns = (await db.query(`select p.proname as name, p.provolatile as vol, p.prosecdef as secdef, p.prosrc as src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' order by p.proname`)).rows;
  const out = [];
  for (const f of fns) {
    const touched = tables.filter((t) => new RegExp(`public\\.${t}\\b`).test(f.src));
    if (!touched.length) continue;
    const guard = /is_staff\(\)|has_feature\(|is_admin\(\)|current_client_id\(\)|is_driver|role in|role =/.test(f.src) ? "guarded" : "open";
    const writes = /\b(insert into|update public|delete from)\b/i.test(f.src);
    out.push(`${f.name}\t${f.vol === "v" ? "volatile" : "stable"}\t${writes ? "writes" : "reads"}\t${guard}\t${touched.join(",")}`);
  }
  console.log("FUNCTIONS", out.length); console.log(out.join("\n"));
  const pols = (await db.query(`select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' order by tablename, policyname`)).rows;
  console.log("POLICIES", pols.length);
  for (const p of pols) console.log(`${p.tablename}\t${p.cmd}\t${p.policyname}\t${(p.qual ?? "").replace(/\s+/g, " ").slice(0, 160)}\t${(p.with_check ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
}
