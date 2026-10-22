import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
const root = process.argv[2];
const db = new PGlite();
const file = (p) => readFileSync(`${root}/${p}`, "utf8").replace("create extension if not exists pgcrypto;", "");
let failures = 0;
let ok = (label, value) => console.log("  ✓", label, value === undefined ? "" : JSON.stringify(value));
let bad = (label, e) => { failures++; console.log("  ✗", label, e?.message ?? e); };

await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create role anon; create role authenticated;
  create publication supabase_realtime;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`);
for (const f of ["supabase/schema.sql", "supabase/migrations/20261017_customer_features.sql", "supabase/migrations/20261017_invoice_realtime.sql", "supabase/migrations/20261017_staff_orders.sql", "supabase/migrations/20261018_b2b_1_enums.sql", "supabase/migrations/20261018_b2b_2_flow.sql", "supabase/migrations/20261018_b2b_2_flow.sql"]) {
  try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
}

const U = { staff: "00000000-0000-0000-0000-00000000000a", driver: "00000000-0000-0000-0000-00000000000b", c1: "00000000-0000-0000-0000-00000000000c", c2: "00000000-0000-0000-0000-00000000000d", stranger: "00000000-0000-0000-0000-00000000000e" };
// Client 1 fiche exists before signup; client 2 signs up first.
await db.exec(`insert into public.clients (business_name, email) values ('Hôtel Lac', 'c1@x.tn');`);
await db.exec(`insert into auth.users (id, email) values
  ('${U.staff}','staff@x.tn'), ('${U.driver}','driver@x.tn'), ('${U.c1}','C1@x.tn'), ('${U.c2}','c2@x.tn'), ('${U.stranger}','who@x.tn');
  update public.profiles set role='staff' where id='${U.staff}';
  update public.profiles set role='driver' where id='${U.driver}';`);

async function as(uid, sql, params = []) {
  await db.exec(`reset role; select set_config('test.uid', '${uid ?? ""}', false); set role authenticated;`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec("reset role;"); }
}
async function expectOk(label, uid, sql, params) { try { const r = await as(uid, sql, params); ok(label, r.length === 1 ? Object.values(r[0])[0] : r.length); return r; } catch (e) { bad(label, e); } }
async function expectFail(label, uid, sql, params, pattern) { try { await as(uid, sql, params); bad(label, "should have failed"); } catch (e) { (pattern && !pattern.test(e.message)) ? bad(label, e) : ok(`${label} → refused: ${e.message}`); } }

console.log("\n# Linking & fiches");
const linked1 = (await db.query(`select client_id is not null as linked from public.profiles where id='${U.c1}'`)).rows[0];
linked1.linked ? ok("client 1 linked at signup") : bad("client 1 linked at signup", "not linked");
const c1 = (await db.query(`select id from public.clients where email='c1@x.tn'`)).rows[0].id;
await expectOk("staff creates point for client 1", U.staff, `insert into public.client_delivery_points (client_id, label, address_line, city) values ($1,'Cuisine','1 rue A','Tunis') returning id`, [c1]);
const c2rows = await expectOk("staff creates client 2 (RLS insert)", U.staff, `insert into public.clients (business_name, email) values ('Resto Marsa','c2@x.tn') returning id`);
const c2 = c2rows?.[0]?.id;
const linked2 = (await db.query(`select client_id from public.profiles where id='${U.c2}'`)).rows[0];
linked2.client_id === c2 ? ok("client 2 linked when fiche created after signup") : bad("client 2 link", linked2);
await expectOk("staff adds 2 points for client 2", U.staff, `insert into public.client_delivery_points (client_id, label, address_line, city) values ($1,'Marsa','2 av B','La Marsa'), ($1,'Lac','3 rue C','Tunis') returning id`, [c2]);
await expectFail("client cannot create a fiche", U.c1, `insert into public.clients (business_name) values ('Hack')`, [], /row-level security/);
await expectFail("client cannot escalate role", U.c1, `update public.profiles set role='admin' where id=auth.uid()`, [], /permission denied/);
const vis = await as(U.c1, `select business_name from public.clients`);
vis.length === 1 && vis[0].business_name === "Hôtel Lac" ? ok("client sees only own fiche") : bad("client fiche visibility", vis);
const acct = await as(U.c1, `select public.my_account() as a`);
ok("my_account client 1", { role: acct[0].a.role, points: acct[0].a.client.delivery_points.length });
const acctS = await as(U.stranger, `select public.my_account() as a`);
acctS[0].a.client === null ? ok("unknown e-mail has no client") : bad("stranger client", acctS[0].a);

console.log("\n# Ordering");
const prods = (await db.query(`select id, slug, stock_quantity from public.products order by slug`)).rows;
const P = Object.fromEntries(prods.map((p) => [p.slug, p.id]));
const items = JSON.stringify([{ product_id: P.oranges, quantity: 12.5 }, { product_id: P.tomates, quantity: 4 }, { product_id: P.oranges, quantity: 2.5 }]);
const o1 = await expectOk("client 1 orders without choosing point", U.c1, `select public.place_client_order($1::jsonb, null, current_date + 1, 'Avant 9h') as r`, [items]);
await expectFail("client 2 must choose point", U.c2, `select public.place_client_order($1::jsonb, null, null, null)`, [items], /point de livraison/);
const c2points = (await db.query(`select id, qr_token from public.client_delivery_points where client_id=$1 order by label`, [c2])).rows; // Lac, Marsa
const o2 = await expectOk("client 2 orders for point Lac", U.c2, `select public.place_client_order($1::jsonb, $2, null, null) as r`, [JSON.stringify([{ product_id: P.dattes, quantity: 3 }]), c2points[0].id]);
const o3 = await expectOk("client 2 second order for point Lac", U.c2, `select public.place_client_order($1::jsonb, $2, null, null) as r`, [JSON.stringify([{ product_id: P.citron, quantity: 1 }]), c2points[0].id]);
await expectFail("client 2 cannot use client 1 point", U.c2, `select public.place_client_order($1::jsonb, (select id from public.client_delivery_points where client_id=$2), null, null)`, [items, c1], /point de livraison/);
await expectFail("past date refused", U.c1, `select public.place_client_order($1::jsonb, null, current_date - 1, null)`, [items], /passée/);
await expectFail("stranger cannot order", U.stranger, `select public.place_client_order($1::jsonb, null, null, null)`, [items], /fiche client/);
await expectFail("old checkout revoked", U.c1, `select public.place_customer_order('[]'::jsonb, '{}'::jsonb, null)`, [], /permission denied/);
const stock = (await db.query(`select stock_quantity from public.products where id=$1`, [P.oranges])).rows[0].stock_quantity;
ok("oranges stock after 15 kg", stock);
const own = await as(U.c1, `select order_number, status, total, requested_delivery_date is not null as dated from public.orders`);
own.length === 1 ? ok("client 1 sees only own order", own[0]) : bad("client order visibility", own);
const inv = (await db.query(`select count(*)::int as n from public.invoices`)).rows[0].n;
ok("receipts created", inv);

console.log("\n# Staff workflow");
const id1 = o1?.[0]?.r?.id, id2 = o2?.[0]?.r?.id, id3 = o3?.[0]?.r?.id;
const step = (label, uid, id, status, note = null) => expectOk(label, uid, `select public.staff_update_order_status($1, $2::public.order_status, $3) as r`, [id, status, note]);
await expectFail("client cannot change status", U.c1, `select public.staff_update_order_status($1, 'confirmed', null)`, [id1], /personnel/);
await step("pending → on_hold", U.staff, id1, "on_hold", "Vérification du stock");
await expectFail("on_hold → preparing refused", U.staff, `select public.staff_update_order_status($1, 'preparing', null)`, [id1], /Transition impossible/);
await step("on_hold → confirmed", U.staff, id1, "confirmed");
await step("confirmed → preparing", U.staff, id1, "preparing");
await step("preparing → ready", U.staff, id1, "ready");
await expectFail("ready → delivered refused (scan only)", U.staff, `select public.staff_update_order_status($1, 'delivered', null)`, [id1], /QR code/);
await step("ready → out_for_delivery", U.staff, id1, "out_for_delivery");
for (const id of [id2, id3]) { await step("order accepted", U.staff, id, "confirmed"); await step("→ preparing", U.staff, id, "preparing"); await step("→ ready", U.staff, id, "ready"); await step("→ shipped", U.staff, id, "out_for_delivery"); }
const staffSees = await as(U.staff, `select count(*)::int as n from public.orders`);
ok("staff sees all orders", staffSees[0].n);
const embed = await as(U.staff, `select c.business_name from public.orders o join public.clients c on c.id=o.client_id limit 1`);
ok("staff reads client of order", embed[0]?.business_name);

console.log("\n# Driver");
await expectFail("client cannot list shipments", U.c1, `select public.driver_shipments()`, [], /livreurs/);
const ships = await as(U.driver, `select jsonb_array_length(public.driver_shipments()) as n`);
ok("driver shipments", ships[0].n);
const lac = await as(U.driver, `select public.driver_lookup_point($1) as r`, [c2points[0].qr_token]);
ok("scan Lac point → orders", lac[0].r.orders.map((o) => o.order_number));
await expectFail("unknown QR", U.driver, `select public.driver_lookup_point(gen_random_uuid())`, [], /inconnu/);
await expectFail("order of another point refused", U.driver, `select public.driver_confirm_delivery($1, array[$2]::uuid[])`, [c2points[0].qr_token, id1], /pas expédiée vers ce point/);
await expectOk("driver delivers only one of the two", U.driver, `select public.driver_confirm_delivery($1, array[$2]::uuid[]) as n`, [c2points[0].qr_token, id2]);
const st = (await db.query(`select order_number, status, delivered_by is not null as by from public.orders order by order_number`)).rows;
ok("statuses", st.map((r) => `${r.order_number}:${r.status}${r.by ? "+driver" : ""}`));
const pay = (await db.query(`select status from public.payments where order_id=$1`, [id2])).rows[0].status;
pay === "paid" ? ok("payment settled on delivery") : bad("payment", pay);

console.log("\n# Decline restocks");
const before = (await db.query(`select stock_quantity from public.products where id=$1`, [P.tomates])).rows[0].stock_quantity;
const o4 = await expectOk("client 1 new order", U.c1, `select public.place_client_order($1::jsonb, null, null, null) as r`, [JSON.stringify([{ product_id: P.tomates, quantity: 5 }])]);
await step("pending → declined", U.staff, o4?.[0]?.r?.id, "declined", "Rupture fournisseur");
const after = (await db.query(`select stock_quantity from public.products where id=$1`, [P.tomates])).rows[0].stock_quantity;
Number(before) === Number(after) ? ok("stock restored", after) : bad("restock", { before, after });
const note = await as(U.c1, `select status_note from public.orders where id=$1`, [o4?.[0]?.r?.id]);
ok("client sees decline reason", note[0]?.status_note);

console.log("\n# Messages");
await expectOk("client 1 writes", U.c1, `select public.send_message(null, 'Bonjour, livraison possible samedi ?') ->> 'from_staff' as r`);
await expectFail("client cannot write in another thread", U.c1, `select public.send_message($1, 'hack')`, [c2], /propre conversation/);
await expectFail("stranger cannot write", U.stranger, `select public.send_message(null, 'hello')`, [], /fiche client/);
await expectFail("cannot insert directly", U.c1, `insert into public.messages (client_id, from_staff, body) values ($1, true, 'fake staff')`, [c1], /permission denied/);
const inbox = await as(U.staff, `select public.staff_inbox() as r`);
ok("staff inbox", inbox[0].r.map((e) => `${e.business_name}:${e.unread}`));
await expectOk("staff replies", U.staff, `select public.send_message($1, 'Oui, samedi matin.') ->> 'from_staff' as r`, [c1]);
await as(U.staff, `select public.mark_messages_read($1)`, [c1]);
const unreadClient = await as(U.c1, `select count(*)::int as n from public.messages where from_staff and read_at is null`);
ok("client unread from staff", unreadClient[0].n);
const c2msgs = await as(U.c2, `select count(*)::int as n from public.messages`);
c2msgs[0].n === 0 ? ok("client 2 cannot read client 1 thread") : bad("message isolation", c2msgs[0].n);
await as(U.c1, `select public.mark_messages_read($1)`, [c1]);
const unread2 = await as(U.c1, `select count(*)::int as n from public.messages where from_staff and read_at is null`);
unread2[0].n === 0 ? ok("client marked read") : bad("client mark read", unread2[0].n);

const { runInvoiceChecks } = await import("./test_invoices.mjs");
await runInvoiceChecks({ db, file, ok, bad, as, expectOk, expectFail, step, U, P, c1, c2, c2points, id1, id3 });
const { runReconfirmChecks } = await import("./test_reconfirm.mjs");
await runReconfirmChecks({ db, file, ok, bad, as, expectOk, expectFail, step, U, P, c1, c2, c2points });
const { runOriginClaimChecks } = await import("./test_origin_claims.mjs");
await runOriginClaimChecks({ db, ok, bad, as, expectOk, expectFail, step, U, P, c1, c2 });
const { runPlanningChecks } = await import("./test_planning.mjs");
await runPlanningChecks({ db, file, ok, bad, as, expectOk, expectFail, step, U, P, c1, c2, c2points });
const { runPermissionChecks } = await import("./test_permissions.mjs");
await runPermissionChecks({ db, file, ok, bad, as, expectOk, expectFail, step, U, P, c1, c2, c2points });
const { runAccountChecks } = await import("./test_accounts.mjs");
await runAccountChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P });
const { runStatusChecks } = await import("./test_status.mjs");
await runStatusChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P });
const { runAlertChecks } = await import("./test_alerts.mjs");
await runAlertChecks({ db, file, ok, bad, as, expectOk, expectFail, step, U, P, c1, c2, c2points });
const { runStaffOrderChecks } = await import("./test_staff_orders.mjs");
await runStaffOrderChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P, c1, c2, c2points });
const { runSettingsChecks } = await import("./test_settings.mjs");
await runSettingsChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P, c1, c2, c2points });
const { runAlertImportantChecks } = await import("./test_alert_important.mjs");
await runAlertImportantChecks({ db, file, ok, bad, as, expectOk, expectFail, U });
const { runTeamMessageChecks } = await import("./test_team_messages.mjs");
await runTeamMessageChecks({ db, file, ok, bad, as, expectOk, expectFail, U });
const { runNumberingReturnChecks } = await import("./test_numbering_returns.mjs");
await runNumberingReturnChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P, c1 });
const { runBillingDecisionChecks } = await import("./test_billing_decisions.mjs");
await runBillingDecisionChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P, c1 });
const { runAttachmentChecks } = await import("./test_attachments.mjs");
await runAttachmentChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1, c2 });
const { runNeedsReplyChecks } = await import("./test_needs_reply.mjs");
await runNeedsReplyChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1 });
const { runLocationLeaveChecks } = await import("./test_location_leaves.mjs");
await runLocationLeaveChecks({ db, file, ok, bad, as, expectOk, expectFail, U });
const { runRecurringSignatureChecks } = await import("./test_recurring_signature.mjs");
await runRecurringSignatureChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P, c1 });
const { runRerunOrderChecks } = await import("./test_rerun_order.mjs");
await runRerunOrderChecks({ db, file, ok, bad, as, expectOk, U, c1 });
const { runMessageReplyChecks } = await import("./test_message_replies.mjs");
await runMessageReplyChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1, c2 });
const { runApproPlusChecks } = await import("./test_appro_plus.mjs");
await runApproPlusChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1 });
const { runModuleChecks } = await import("./test_modules.mjs");
await runModuleChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1 });
const { runProsChecks } = await import("./test_pros.mjs");
await runProsChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1, c2 });
const { runRoleChecks } = await import("./test_roles.mjs");
await runRoleChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1 });
const { runAccountsScriptChecks } = await import("./test_accounts_script.mjs");
await runAccountsScriptChecks({ db, file, ok, bad, as });
const { runSwitchChecks } = await import("./test_switch.mjs");
await runSwitchChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1 });
const { runIsolationChecks } = await import("./test_isolation.mjs");
await runIsolationChecks({ db, file, ok, bad, as, expectOk, expectFail, U, c1 });
const { runOnboardingChecks } = await import("./test_onboarding.mjs");
await runOnboardingChecks({ db, file, ok, bad, as, expectOk, expectFail, U });
const { runPlatformProChecks } = await import("./test_onboarding.mjs");
await runPlatformProChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runPlatformSettingsChecks } = await import("./test_onboarding.mjs");
await runPlatformSettingsChecks({ db, file, ok, bad, as, expectOk, expectFail, U });
const { runAccountRoutingChecks } = await import("./test_onboarding.mjs");
await runAccountRoutingChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runDirectoryChecks } = await import("./test_directory.mjs");
await runDirectoryChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runTeamSpaceChecks } = await import("./test_spaces.mjs");
await runTeamSpaceChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runAccountLedgerChecks } = await import("./test_accounts_ledger.mjs");
await runAccountLedgerChecks({ db, file, ok, bad, as, expectOk, expectFail, U, P, c1 });
const { runMultiCartChecks } = await import("./test_multi_cart.mjs");
await runMultiCartChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runCatalogNumberChecks } = await import("./test_catalog_numbers.mjs");
await runCatalogNumberChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runBuyerJourneyChecks } = await import("./test_buyer_journey.mjs");
await runBuyerJourneyChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runLot3Checks } = await import("./test_lot3.mjs");
await runLot3Checks({ db, file, ok, bad, as, expectOk, expectFail });
const { runProductInsertChecks } = await import("./test_product_insert.mjs");
await runProductInsertChecks({ db, file, ok, bad, as });
const { runThreadReadChecks } = await import("./test_thread_read.mjs");
await runThreadReadChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runLot4Checks } = await import("./test_lot4.mjs");
await runLot4Checks({ db, file, ok, bad, as, expectOk, expectFail });
const { runLot5Checks } = await import("./test_lot5.mjs");
await runLot5Checks({ db, file, ok, bad, as, expectOk, expectFail });
const { runCleanupChecks } = await import("./test_cleanup.mjs");
await runCleanupChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runLocationChecks } = await import("./test_location.mjs");
await runLocationChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runRightsChecks } = await import("./test_rights.mjs");
await runRightsChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runFixesChecks } = await import("./test_fixes.mjs");
await runFixesChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runVehicleChecks } = await import("./test_vehicle.mjs");
await runVehicleChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runPlanChecks } = await import("./test_plan.mjs");
await runPlanChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runReviewChecks } = await import("./test_review.mjs");
await runReviewChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runWorkflowChecks } = await import("./test_workflow.mjs");
await runWorkflowChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runStepsChecks } = await import("./test_steps.mjs");
await runStepsChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runLayoutsChecks } = await import("./test_layouts.mjs");
await runLayoutsChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runProductsChecks } = await import("./test_products.mjs");
await runProductsChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runWordingChecks } = await import("./test_wording.mjs");
await runWordingChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runReceptionChecks } = await import("./test_reception.mjs");
await runReceptionChecks({ db, file, ok, bad, as });
const { runHomeChecks } = await import("./test_home.mjs");
await runHomeChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runErrorsChecks } = await import("./test_errors.mjs");
await runErrorsChecks({ db, file, ok, bad, as, expectOk, expectFail });
const { runCreateMemberChecks } = await import("./test_create_member.mjs");
await runCreateMemberChecks({ db, file, ok, bad, as, expectOk, expectFail });
if (process.env.INVENTORY) { const { runInventory } = await import("./inventory.mjs"); await runInventory({ db }); }
if (process.env.DUMP !== undefined) { const { runDump } = await import("./dump_functions.mjs"); await runDump({ db }); }
if (process.env.POLDUMP !== undefined) { const { runPol } = await import("./pol.mjs"); await runPol({ db }); }
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
