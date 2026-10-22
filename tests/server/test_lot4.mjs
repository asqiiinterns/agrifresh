// Lot 4 (20261120): delivery amounts and deposit, invitations, product visibility, new accounts, directory, messages.
export async function runLot4Checks({ db, file, ok, bad, as, expectOk, expectFail }) {
  console.log("\n# Lot 4");
  const sys = async () => db.exec(`reset role; select set_config('test.uid', '', false);`);
  const one = async (sql, params) => { await sys(); return (await db.query(sql, params)).rows[0]; };
  for (const f of ["supabase/migrations/20261120_lot4.sql", "supabase/migrations/20261120_lot4.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const L = (await one(`select public.legacy_org_id() as id`)).id;
  const owner = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@agrifresh.tn'`)).id;
  const driver = (await one(`select id from public.profiles where role = 'driver' and org_id = $1 and account_status = 'active' limit 1`, [L]))?.id;
  const staff = (await one(`select pr.id from public.profiles pr where pr.org_id = $1 and pr.role in ('staff', 'supervisor', 'admin') and pr.account_status = 'active' and pr.id <> $2 limit 1`, [L, owner]))?.id ?? owner;

  // ---- A. Delivery: amounts for the driver, deposit ----
  const def = await one(`select value from public.client_setting_defaults where org_id = $1 and key = 'driver_prices'`, [L]);
  def?.value === false ? ok("every supplier has the 'amounts for the driver' default (off)") : bad("default", def);
  await expectOk("AgriFresh shows amounts to its drivers by default", owner, `select public.admin_set_client_default('driver_prices', 'true'::jsonb) as r`);
  const client = await one(`select c.id, c.driver_prices from public.clients c where c.supplier_org_id = $1 and c.link_status = 'active' and c.active
    and exists (select 1 from public.client_delivery_points dp where dp.client_id = c.id and dp.active) and not ('driver_prices' = any(c.custom_settings)) order by c.created_at limit 1`, [L]);
  client?.driver_prices === true ? ok("clients following the default get it") : bad("client follows default", client);
  await sys(); await db.exec(`update public.clients set custom_settings = array['scan_delivery_note','scan_client_qr','delivery_signature'], scan_delivery_note = false, scan_client_qr = false, delivery_signature = false, credit_limit = null where id = '${client.id}'`);
  const product = await one(`select id from public.products where org_id = $1 and active order by name limit 1`, [L]);
  const point = await one(`select id from public.client_delivery_points where client_id = $1 and active limit 1`, [client.id]);
  await sys(); await db.exec(`update public.vehicles set active = false where org_id = '${L}'`);
  const placed = await expectOk("an order for this client", owner, `select public.staff_place_order($1, $2::jsonb, $3, null, null) as r`, [client.id, JSON.stringify([{ product_id: product.id, quantity: 2 }]), point.id]);
  const orderId = placed?.[0]?.r?.id;
  for (const st of ["confirmed", "preparing", "ready"]) await as(owner, `select public.staff_update_order_status($1, $2::public.order_status, null)`, [orderId, st]);
  await as(driver, `select public.driver_ship_orders(array[$1]::uuid[], null)`, [orderId]);
  const list = (await as(driver, `select public.driver_shipments() as r`))[0].r;
  const line = list.find((s) => s.id === orderId);
  line?.show_prices === true && Number(line.total_ttc) > 0 ? ok("the driver sees the amount incl. VAT", line.total_ttc) : bad("driver amount", line);
  await sys(); await db.exec(`update public.clients set custom_settings = custom_settings || array['driver_prices'], driver_prices = false where id = '${client.id}'`);
  const hidden = (await as(driver, `select public.driver_shipments() as r`))[0].r.find((s) => s.id === orderId);
  hidden?.show_prices === false && hidden.total_ttc === null && hidden.total === null ? ok("a client record can hide them") : bad("hidden amounts", hidden);
  // An invoice already issued for the order: the deposit pays it.
  const inv = await as(owner, `select public.staff_create_invoice($1, array[$2]::uuid[]) as r`, [client.id, orderId]).catch((e) => ({ error: e.message }));
  const invId = (await one(`select client_invoice_id as id from public.orders where id = $1`, [orderId]))?.id;
  if (invId) await as(owner, `select public.staff_issue_invoice($1)`, [invId]).catch(() => null);
  const invoice = invId ? await one(`select status, total_ttc, amount_paid from public.client_invoices where id = $1`, [invId]) : null;
  console.log("  invoice:", JSON.stringify(invoice ?? inv));
  await expectFail("a negative deposit is refused", driver, `select public.driver_deliver_v3(array[$1]::uuid[], null, null, null, null, null, -5)`, [orderId], /invalide/);
  const delivered = await expectOk("delivered with a deposit of 5 TND in cash", driver, `select public.driver_deliver_v3(array[$1]::uuid[], null, null, null, null, null, 5, 'cash') as r`, [orderId]);
  const result = delivered?.[0]?.r;
  result?.count === 1 && Number(result.deposit) === 5 ? ok("one order delivered, deposit recorded", result) : bad("deliver v3", result);
  const entry = await one(`select kind, amount, method, reference, order_id from public.account_entries where order_id = $1`, [orderId]);
  entry?.kind === "deposit" && Number(entry.amount) === 5 && entry.reference?.startsWith("BL") ? ok("the deposit is on the client's account, with the BL", entry.reference) : bad("entry", entry);
  if (invoice?.status === "issued") {
    const paid = await one(`select amount_paid from public.client_invoices where id = $1`, [invId]);
    Number(paid.amount_paid) === Math.min(5, Number(invoice.total_ttc)) ? ok("and applied to the order's invoice") : bad("applied", paid);
  }
  const history = await one(`select note from public.order_status_history where order_id = $1 and status = 'delivered'`, [orderId]);
  history?.note?.includes("Acompte reçu : 5") ? ok("the history shows it", history.note) : bad("history", history);
  const alert = await one(`select count(*)::int as n from public.notifications where order_id = $1 and event = 'account.deposit'`, [orderId]);
  alert.n > 0 ? ok("the billing team is told") : bad("alert", alert);

  // ---- B/C. Platform settings, new accounts and trial ----
  const sa = (await one(`select u.id from auth.users u where lower(u.email) = 'admin@a.tn'`)).id;
  const Z = (await one(`select id from public.organizations where name = 'Épicerie Zitouna'`)).id;
  const zitouna = (await one(`select u.id from auth.users u where lower(u.email) = 'gerant@epicerie.tn'`)).id;
  await expectFail("a Pro cannot change the platform settings", owner, `select public.platform_set_setting('new_accounts_trial_hours', '48'::jsonb)`, [], /Appro\+/);
  await expectOk("Appro+ sets the web address", sa, `select public.platform_set_setting('app_url', '"https://appro.example.tn/"'::jsonb) as r`);
  const settings = (await as(null, `select public.public_settings() as r`).catch(() => null))?.[0]?.r ?? (await one(`select public.public_settings() as r`)).r;
  settings.app_url === "https://appro.example.tn" && settings.trial_hours === 0 ? ok("public settings (no trial by default)", settings) : bad("settings", settings);
  const newUser = async (n) => { const id = `00000000-0000-0000-0000-0000000e40${String(n).padStart(2, "0")}`; await sys(); await db.exec(`insert into auth.users (id, email) values ('${id}', 'nouveau${n}@x.tn') on conflict do nothing`); return id; };
  const u1 = await newUser(1);
  const st1 = await one(`select account_status, org_id from public.profiles where id = $1`, [u1]);
  st1?.account_status === "pending" ? ok("a new sign-up waits") : bad("new sign-up", st1);
  // Product visibility
  const before = (await as(u1, `select public.public_catalog() as r`))[0].r;
  before.suppliers.some((s) => s.org_id === Z) ? bad("Zitouna hidden by default", before.suppliers) : ok("a supplier's products are for its network by default");
  await expectFail("only the Responsable chooses", R0(), `select public.set_pro_visibility('public')`, [], /Responsable|actif/).catch(() => {});
  await expectOk("Zitouna opens its catalogue to everyone", zitouna, `select public.set_pro_visibility('public') ->> 'catalog_visibility' as r`);
  const cat = (await as(u1, `select public.public_catalog() as r`))[0].r;
  cat.suppliers.some((s) => s.org_id === Z) && cat.products.some((p) => p.org_id === Z) ? ok("a new account (waiting) sees its products", cat.products.length) : bad("public catalogue", cat);
  const zProduct = cat.products.find((p) => p.org_id === Z);
  const items = JSON.stringify([{ product_id: zProduct.id, quantity: 1 }]);
  await expectFail("without a space it cannot order", u1, `select public.order_from_public($1, $2::jsonb)`, [Z, items], /Créez d’abord/);
  await expectOk("it creates its space as a private person (no trial)", u1, `select public.register_pro('{"name":"Sami Ben Ali","kind":"person"}'::jsonb) as r`);
  const o1 = await one(`select o.status, o.kind, o.is_buyer, o.is_supplier, pr.account_status, pr.role from public.profiles pr join public.organizations o on o.id = pr.org_id where pr.id = $1`, [u1]);
  o1.status === "pending" && o1.kind === "person" && o1.is_buyer && !o1.is_supplier && o1.role === "customer" ? ok("person space waiting for Appro+", o1) : bad("person space", o1);
  await expectFail("waiting for Appro+: no order", u1, `select public.order_from_public($1, $2::jsonb)`, [Z, items], /validation/);
  (await as(u1, `select public.public_catalog() as r`))[0].r.products.length > 0 ? ok("but it still browses") : bad("browse while waiting", "empty");

  await expectOk("Appro+ turns on a 48 h trial", sa, `select public.platform_set_setting('new_accounts_trial_hours', '48'::jsonb) as r`);
  const u2 = await newUser(2);
  await expectOk("a new company registers", u2, `select public.register_pro('{"name":"Café du Port","is_buyer":true,"address":"Port de Sidi Bou Saïd"}'::jsonb) as r`);
  const o2 = await one(`select o.id, o.status, o.trial_until, pr.account_status from public.profiles pr join public.organizations o on o.id = pr.org_id where pr.id = $1`, [u2]);
  o2.status === "active" && o2.trial_until && o2.account_status === "active" ? ok("active at once, for 48 h", o2.trial_until) : bad("trial", o2);
  const platformAlert = await one(`select count(*)::int as n from public.notifications where event = 'pro.trial' and user_id = $1`, [sa]);
  platformAlert.n > 0 ? ok("Appro+ is told to validate it") : bad("pro.trial alert", platformAlert);
  const placedPublic = await expectOk("it orders from the public catalogue", u2, `select public.order_from_public($1, $2::jsonb, null, 'Première commande') as r`, [Z, items]);
  const pr = placedPublic?.[0]?.r;
  pr?.new_relation === true && pr.status === "pending" ? ok("the order creates the relation, the order waits for the supplier", pr.order_number) : bad("public order", pr);
  const link = await one(`select link_status, active, joined_via from public.clients where supplier_org_id = $1 and buyer_org_id = $2`, [Z, o2.id]);
  link?.link_status === "active" && link.joined_via === "public_catalog" ? ok("relation active, marked 'catalogue public'") : bad("relation", link);
  const zAlert = await one(`select count(*)::int as n from public.notifications where event = 'link.new_client' and user_id = $1`, [zitouna]);
  zAlert.n > 0 ? ok("the supplier is told of its new client") : bad("new client alert", zAlert);
  const cat2 = (await as(u2, `select public.public_catalog() as r`))[0].r;
  cat2.suppliers.some((s) => s.org_id === Z) ? bad("Zitouna still public for its client", "listed") : ok("once related, the supplier leaves the public catalogue (it is in Commander)");
  const feat = (await as(u2, `select public.my_account() -> 'features' as r`))[0].r;
  feat.includes("client.order") ? ok("the new client has the Commander tab") : bad("features", feat);
  // Trial over
  await sys(); await db.exec(`update public.organizations set trial_until = now() - interval '1 minute' where id = '${o2.id}'`);
  await expectOk("trials over are closed", u2, `select public.expire_trials() as r`);
  const o2b = await one(`select o.status, pr.account_status, pr.trial_suspended from public.profiles pr join public.organizations o on o.id = pr.org_id where pr.id = $1`, [u2]);
  o2b.status === "suspended" && o2b.account_status === "suspended" && o2b.trial_suspended ? ok("space and account suspended after 48 h") : bad("expired", o2b);
  await expectFail("suspended: no order", u2, `select public.order_from_public($1, $2::jsonb)`, [Z, items], /suspendu|validation/);
  await expectOk("Appro+ validates it", sa, `select public.platform_set_pro_status($1, 'active') as r`, [o2.id]);
  const o2c = await one(`select o.status, o.trial_until, pr.account_status from public.profiles pr join public.organizations o on o.id = pr.org_id where pr.id = $1`, [u2]);
  o2c.status === "active" && o2c.trial_until === null && o2c.account_status === "active" ? ok("validated: active for good") : bad("validated", o2c);
  const pros = (await as(sa, `select public.platform_pros() as r`))[0].r;
  pros.some((p) => "trial_until" in p) ? ok("the Appro+ list shows the trials") : bad("platform_pros", pros[0]);

  // ---- F. Invitations ----
  const invitation = (await as(zitouna, `select public.create_invitation('client', null, 'Resto Lac', '+21620000000') as r`))[0].r;
  /^[0-9A-F]{8}$/.test(invitation.code) && invitation.app_url === "https://appro.example.tn" ? ok("an invitation code for a new client", invitation.code) : bad("invitation", invitation);
  const again = (await as(zitouna, `select public.create_invitation('client', null, 'Resto Lac') as r`))[0].r;
  again.code === invitation.code ? ok("the same invitation is reused") : bad("reuse", again);
  await expectFail("a buyer-only space cannot invite clients", u2, `select public.create_invitation('client')`, [], /fournisseur/);
  const info = (await one(`select public.invitation_info($1) as r`, [invitation.code.toLowerCase()])).r;
  info?.org_name === "Épicerie Zitouna" && info.valid ? ok("the sign-in screen shows who invites") : bad("info", info);
  const u3 = await newUser(3);
  const acc = (await as(u3, `select public.accept_invitation($1) as r`, [invitation.code]))[0].r;
  acc.linked === false && acc.needs_space === true ? ok("accepted: it creates its space next") : bad("accept", acc);
  await expectOk("it creates its space", u3, `select public.register_pro('{"name":"Resto Lac","is_buyer":true}'::jsonb) as r`);
  const o3 = (await one(`select org_id from public.profiles where id = $1`, [u3])).org_id;
  const link3 = await one(`select link_status, joined_via from public.clients where supplier_org_id = $1 and buyer_org_id = $2`, [Z, o3]);
  link3?.link_status === "active" && link3.joined_via === "invitation" ? ok("and is at once a client of Zitouna") : bad("invited relation", link3);
  const told = await one(`select count(*)::int as n from public.notifications where event = 'invitation.accepted' and user_id = $1`, [zitouna]);
  told.n > 0 ? ok("Zitouna is told") : bad("accepted alert", told);
  await expectFail("an unknown code", u3, `select public.accept_invitation('ZZZZZZZZ')`, [], /inconnue/);
  // From a client record whose space has nobody yet
  const record = await one(`select c.id, c.buyer_org_id from public.clients c where c.supplier_org_id = $1 and c.buyer_org_id is not null
    and not exists (select 1 from public.profiles pr where pr.org_id = c.buyer_org_id) order by c.created_at limit 1`, [L]);
  if (record) {
    const rinv = (await as(owner, `select public.create_invitation('client', $1) as r`, [record.id]))[0].r;
    const u4 = await newUser(4);
    const racc = (await as(u4, `select public.accept_invitation($1) as r`, [rinv.code]))[0].r;
    const p4 = await one(`select org_id, client_id, account_status, role from public.profiles where id = $1`, [u4]);
    racc.linked && p4.org_id === record.buyer_org_id && p4.client_id === record.id && p4.role === "customer" ? ok("invited from a client record: Responsable of that client's space", p4.account_status) : bad("record invitation", { racc, p4 });
  } else ok("(no client record without account to test)");

  // ---- D/G. Directory and messages outside the network ----
  const dir = (await as(owner, `select public.pro_directory('clients') as r`))[0].r;
  const listed = dir.find((p) => p.id === o2.id);
  listed && "open_to_messages" in listed ? ok("the directory shows who accepts messages") : bad("directory", dir.slice(0, 2));
  await expectOk("Café du Port leaves the directory", u2, `select public.set_pro_visibility(null, false) ->> 'listed_in_directory' as r`).catch(() => null);
  const dir2 = (await as(owner, `select public.pro_directory('clients') as r`))[0].r;
  dir2.some((p) => p.id === o2.id) ? bad("still listed", "listed") : ok("no longer listed");
  await expectFail("AgriFresh does not accept messages from outside its network", u2, `select public.org_send($1, 'Bonjour')`, [L], /hors de son réseau/);
  await expectOk("AgriFresh opens its messages", owner, `select public.set_pro_visibility(null, null, true) ->> 'open_to_messages' as r`);
  const conv = await expectOk("Café du Port writes to AgriFresh", u2, `select public.org_send($1, 'Bonjour, livrez-vous Sidi Bou Saïd ?') as r`, [L]);
  const inbox = (await as(owner, `select public.org_inbox() as r`))[0].r;
  const entry2 = inbox.find((c) => c.org_id === o2.id);
  entry2 && Number(entry2.unread) === 1 && entry2.related === false ? ok("AgriFresh's inbox: one unread message from outside its network") : bad("org inbox", inbox);
  const thread = (await as(owner, `select public.org_thread($1) as r`, [conv[0].r]))[0].r;
  thread.messages[0].body.startsWith("Bonjour") && !thread.messages[0].mine ? ok("the thread opens") : bad("thread", thread);
  const inbox2 = (await as(owner, `select public.org_inbox() as r`))[0].r;
  Number(inbox2.find((c) => c.org_id === o2.id).unread) === 0 ? ok("and is marked read") : bad("read", inbox2);
  await expectOk("AgriFresh answers", owner, `select public.org_send($1, 'Oui, le mardi.') as r`, [o2.id]);
  await expectFail("a stranger cannot read it", zitouna, `select public.org_thread($1)`, [conv[0].r], /introuvable/);
  const check = await db.query(file("supabase/check_migrations.sql"));
  check.rows.filter((row) => row.migration < "20261121").every((row) => row.etat === "OK") ? ok("check query: all migrations installed", check.rows.length) : bad("check query", check.rows.filter((row) => row.etat !== "OK"));
  function R0() { return u1; }
}
