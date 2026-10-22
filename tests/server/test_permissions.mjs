// Per-role feature permissions.
export async function runPermissionChecks({ db, file, ok, bad, as, expectOk, expectFail, step, U, P, c1, c2, c2points }) {
  console.log("\n# Permissions migration");
  for (const f of ["supabase/migrations/20261022_permissions.sql", "supabase/migrations/20261022_permissions.sql"]) {
    try { await db.exec(file(f)); ok(`applied ${f}`); } catch (e) { bad(`apply ${f}`, e); }
  }
  const A = { admin: "00000000-0000-0000-0000-0000000000a1", prod: "00000000-0000-0000-0000-0000000000a2" };
  const features = async (uid) => (await as(uid, `select public.my_account() -> 'features' as f`))[0].f;
  const sup = await features(U.staff);
  sup.includes("orders.decide") && !sup.includes("clients.create") ? ok("supervisor defaults", sup.length) : bad("supervisor defaults", JSON.stringify(sup));
  const prod = await features(A.prod);
  JSON.stringify(prod) === JSON.stringify(["production.update", "production.view"]) ? ok("production defaults", prod) : bad("production defaults", JSON.stringify(prod));
  (await features(A.admin)).length === 16 ? ok("admin has every feature") : bad("admin features", (await features(A.admin)).length);
  const cust = await features(U.c1);
  cust.length === 3 ? ok("customer defaults", cust) : bad("customer defaults", JSON.stringify(cust));

  console.log("\n# Admin changes rights");
  await expectFail("supervisor cannot change rights", U.staff, `select public.admin_set_permission('production', 'orders.ship', true)`, [], /administrateurs/);
  await expectFail("admin rights are locked", A.admin, `select public.admin_set_permission('admin', 'orders.ship', false)`, [], /ne se modifient pas/);
  await expectFail("unknown feature", A.admin, `select public.admin_set_permission('driver', 'nope', true)`, [], /inconnue/);

  const o = await expectOk("client 2 order", U.c2, `select public.place_client_order($1::jsonb, $2, null, null) as r`, [JSON.stringify([{ product_id: P.oranges, quantity: 1 }]), c2points[0].id]);
  const id = o?.[0]?.r?.id;
  await expectOk("admin removes 'accept orders' from supervisors", A.admin, `select public.admin_set_permission('supervisor', 'orders.decide', false) as r`);
  await expectFail("supervisor can no longer accept", U.staff, `select public.staff_update_order_status($1, 'confirmed', null)`, [id], /personnel/);
  await expectOk("admin still accepts", A.admin, `select public.staff_update_order_status($1, 'confirmed', null) ->> 'status' as r`, [id]);
  await expectOk("restore", A.admin, `select public.admin_set_permission('supervisor', 'orders.decide', true) as r`);

  await expectOk("give production the right to ship", A.admin, `select public.admin_set_permission('production', 'orders.ship', true) as r`);
  await expectOk("production prepares", A.prod, `select public.staff_update_order_status($1, 'preparing', null) ->> 'status' as r`, [id]);
  await expectOk("production marks ready", A.prod, `select public.staff_update_order_status($1, 'ready', null) ->> 'status' as r`, [id]);
  await expectOk("production now ships", A.prod, `select public.staff_update_order_status($1, 'out_for_delivery', null) ->> 'status' as r`, [id]);

  await expectOk("remove deliveries from drivers", A.admin, `select public.admin_set_permission('driver', 'deliveries', false) as r`);
  await expectFail("driver blocked", U.driver, `select public.driver_shipments()`, [], /livreurs/);
  await expectOk("restore deliveries", A.admin, `select public.admin_set_permission('driver', 'deliveries', true) as r`);

  await expectOk("remove invoices from supervisors", A.admin, `select public.admin_set_permission('supervisor', 'invoices.manage', false) as r`);
  await expectFail("supervisor invoice refused", U.staff, `select public.staff_create_invoice($1, array[$2]::uuid[], true)`, [c2, id], /personnel/);

  await expectOk("allow supervisors to create clients", A.admin, `select public.admin_set_permission('supervisor', 'clients.create', true) as r`);
  await expectOk("supervisor creates a client", U.staff, `insert into public.clients (business_name) values ('Café Port') returning business_name`);

  await expectOk("disable messages for customers", A.admin, `select public.admin_set_permission('customer', 'client.messages', false) as r`);
  await expectFail("customer message refused", U.c1, `select public.send_message(null, 'Bonjour')`, [], /messagerie/);
  await expectOk("disable invoices for customers", A.admin, `select public.admin_set_permission('customer', 'client.invoices', false) as r`);
  const inv = await as(U.c1, `select count(*)::int as n from public.client_invoices`);
  inv[0].n === 0 ? ok("customer invoices hidden") : bad("customer invoices", inv[0].n);
  await expectOk("disable claims for customers", A.admin, `select public.admin_set_permission('customer', 'client.claims', false) as r`);
  await expectFail("customer claim refused", U.c1, `select public.client_create_claim($1, 'other', 'x')`, [id], /réclamations/);

  await expectOk("remove product management from supervisors", A.admin, `select public.admin_set_permission('supervisor', 'products.manage', false) as r`);
  const edited = await as(U.staff, `update public.products set price = 1 where slug = 'oranges' returning id`);
  edited.length === 0 ? ok("supervisor product edit blocked (RLS)") : bad("product edit", edited.length);
  const read = await as(U.staff, `select count(*)::int as n from public.products`);
  read[0].n > 0 ? ok("supervisor still reads the catalogue") : bad("product read", read[0].n);
}
