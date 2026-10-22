// Example data for screenshots (local test database only): a second buyer, orders at every step,
// an invoice with a partial payment, a message. Uses the same server functions as the app.
//   node e2e/demo-data.mjs   (after node e2e/setup.mjs)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const env = Object.fromEntries(readFileSync("e2e/.env.test", "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const PASSWORD = env.E2E_PASSWORD;
const fresh = () => createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const psql = (sql) => execFileSync("docker", ["exec", "-i", "supabase_db_e2e", "psql", "-U", "postgres", "-d", "postgres", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: sql, encoding: "utf8" }).trim();
async function as(email) { const c = fresh(); const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD }); if (error) throw new Error(`${email}: ${error.message}`); return c; }
const must = (label, r) => { if (r.error) throw new Error(`${label}: ${r.error.message}`); return r.data; };

const owner = await as("admin@agrifresh.tn");
const sa = await as("admin@a.tn");

// A second buyer, invited by AgriFresh.
const signup = await fresh().auth.signUp({ email: "gerant@cafe-medina.tn", password: PASSWORD, options: { data: { full_name: "Karim Gérant" } } });
if (signup.error && !/already/i.test(signup.error.message)) throw signup.error;
const cafe = await as("gerant@cafe-medina.tn");
const reg = await cafe.rpc("register_pro", { p_profile: { name: "Café Médina", is_buyer: true, phone: "71 333 333" } });
if (!reg.error) {
  must("validation café", await sa.rpc("platform_set_pro_status", { p_org_id: reg.data, p_status: "active" }));
  const invitation = must("invitation café", await owner.rpc("create_invitation", { p_side: "client", p_client_id: null, p_name: "Café Médina", p_contact: "+21622000000" }));
  must("acceptation café", await cafe.rpc("accept_invitation", { p_code: invitation.code }));
}
psql(`update public.clients set scan_delivery_note = false, scan_client_qr = false, delivery_signature = false,
  custom_settings = array['scan_delivery_note', 'scan_client_qr', 'delivery_signature'];`);

psql(`update public.products set stock_quantity = 500 where stock_quantity is not null;`);
const clients = must("clients", await owner.from("clients").select("id, business_name").order("business_name"));
const products = must("produits", await owner.from("products").select("id, name, price").eq("active", true).order("name").limit(8));
const line = (i, q) => ({ product_id: products[i % products.length].id, quantity: q });
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const place = async (client, items, note = "") => must("commande", await owner.rpc("staff_place_order", { p_client_id: client.id, p_items: items, p_delivery_point_id: null, p_requested_date: tomorrow, p_note: note || null }));
const step = async (order, status) => must(`statut ${status}`, await owner.rpc("staff_update_order_status", { p_order_id: order.id, p_status: status, p_note: null }));

const [lac, medina] = [clients.find((c) => c.business_name.includes("Lac")), clients.find((c) => c.business_name.includes("Médina"))];
const created = [];
for (const [client, items, note] of [
  [lac, [line(0, 12), line(1, 5)], "Livrer avant 9h"], [medina, [line(2, 3), line(3, 10)], ""],
  [lac, [line(4, 6)], ""], [medina, [line(5, 8), line(0, 4)], ""], [lac, [line(1, 2), line(6, 7)], ""],
  [medina, [line(2, 9)], ""], [lac, [line(3, 15), line(7, 2)], ""], [medina, [line(0, 5)], ""], [lac, [line(6, 4)], ""],
]) created.push(await place(client, items, note));

// Steps: 0-1 À décider, 2 accepted, 3 in preparation, 4 ready, 5 out for delivery, 6-8 delivered.
for (const o of created.slice(2)) await step(o, "confirmed");
for (const o of created.slice(3)) await step(o, "preparing");
for (const o of created.slice(4)) await step(o, "ready");
const driver = await as("livreur@agrifresh.tn");
must("expédition", await driver.rpc("driver_ship_orders", { p_order_ids: created.slice(5).map((o) => o.id), p_vehicle_id: null }));
// One hand-over per client.
for (const ids of [[created[6].id, created[8].id], [created[7].id]]) {
  must("livraison", await driver.rpc("driver_deliver", { p_order_ids: ids, p_delivery_tokens: [], p_client_qr_kind: null, p_client_qr_token: null }));
}

// An invoice for the Resto du Lac delivered orders, half paid.
const lacDelivered = [created[6], created[8]];
const invoice = must("facture", await owner.rpc("staff_create_invoice", { p_client_id: lac.id, p_order_ids: lacDelivered.map((o) => o.id), p_draft: false }));
const inv = must("lecture facture", await owner.from("client_invoices").select("id, total_ttc").eq("id", invoice.id).single());
must("règlement", await owner.rpc("staff_add_payment", { p_invoice_id: inv.id, p_amount: Math.round(Number(inv.total_ttc) / 2), p_method: "transfer", p_paid_on: new Date().toISOString().slice(0, 10), p_reference: "VIR-0412" }));

// A message from the buyer and an answer.
must("message équipe", await owner.rpc("send_message", { p_client_id: lac.id, p_body: "Bonjour, votre commande de demain partira à 7h30." }));
console.log(`✓ données d’exemple : ${created.length} commandes, 1 facture, 1 message`);
