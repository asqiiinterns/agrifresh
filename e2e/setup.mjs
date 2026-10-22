// Builds a fresh local Appro+ database for the automated tests (never the real one):
//   node e2e/setup.mjs
// 1. empties the local Supabase (Docker), 2. installs supabase/schema.sql and every migration in order,
// 3. creates the test accounts (password Test1234!) and their spaces through the app's own functions,
// 4. writes e2e/.env.test with the local address and key for the web app and the robot.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workdir = join(root, "e2e");
const windows = process.platform === "win32";
export const PASSWORD = "Test1234!";

const sh = (cmd, args, input) => execFileSync(cmd, args, { cwd: root, input, encoding: "utf8", shell: windows, stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

function status() {
  const out = sh("npx", ["supabase@latest", "status", "--workdir", workdir, "-o", "json"]);
  const json = JSON.parse(out.slice(out.indexOf("{")));
  return { api: json.API_URL, anon: json.ANON_KEY ?? json.PUBLISHABLE_KEY, service: json.SERVICE_ROLE_KEY ?? json.SECRET_KEY, db: json.DB_URL };
}

const container = "supabase_db_e2e";
function psql(sql, label) {
  try {
    return sh("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-f", "-"], sql);
  } catch (error) {
    throw new Error(`${label ?? "SQL"} : ${error.stderr || error.message}`);
  }
}
// Runs SQL as an account (auth.uid() = that account), like the app does.
const asUser = (id, sql, label) => psql(`begin;
select set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '${id}', true);
set local role authenticated;
${sql}
commit;`, label);

export async function setup({ log = console.log } = {}) {
  log("• Remise à zéro de la base locale");
  sh("npx", ["supabase@latest", "db", "reset", "--workdir", workdir]);
  const files = ["supabase/schema.sql", ...readdirSync(join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => `supabase/migrations/${f}`)];
  log(`• Installation de ${files.length} fichiers SQL`);
  const env = status();
  const users = {};
  async function createUser(email, fullName) {
    const res = await fetch(`${env.api}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: env.service, Authorization: `Bearer ${env.service}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: fullName } }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`création ${email} : ${JSON.stringify(body)}`);
    users[email] = body.id;
    return body.id;
  }

  // The migrations, with the accounts script where the real history ran it (before 20261110_2_switch).
  const beforeSwitch = files.filter((f, index) => index === 0 || f < "supabase/migrations/20261110_2");
  for (const f of beforeSwitch) psql(readFileSync(join(root, f), "utf8"), f);

  log("• Comptes de test");
  // Appro+ and the AgriFresh team (the historical supplier), set up by the accounts script.
  const sa = await createUser("admin@a.tn", "Équipe Appro+");
  const sup = await createUser("superviseur@a.tn", "Sami Superviseur");
  const drv = await createUser("livreur@a.tn", "Lotfi Livreur");
  const prep = await createUser("production@a.tn", "Pia Production");
  psql(`update public.profiles set role = 'admin', account_status = 'active' where id = '${sa}';
    update public.profiles set role = 'supervisor', account_status = 'active' where id = '${sup}';
    update public.profiles set role = 'driver', account_status = 'active' where id = '${drv}';
    update public.profiles set role = 'production', account_status = 'active' where id = '${prep}';`, "rôles");
  const script = readFileSync(join(root, "supabase/scripts/agrifresh_accounts.sql"), "utf8");
  psql(script, "script comptes (1)");
  const owner = await createUser("admin@agrifresh.tn", "Adel Responsable");
  psql(script, "script comptes (2)");
  for (const f of files.filter((f) => !beforeSwitch.includes(f))) psql(readFileSync(join(root, f), "utf8"), f);

  // A buyer with its own space, invited by AgriFresh as a client.
  const buyer = await createUser("acheteur@resto.tn", "Rania Acheteuse");
  asUser(buyer, `select public.register_pro('{"name":"Resto du Lac","is_buyer":true,"phone":"71 111 111"}'::jsonb);`, "inscription acheteur");
  const buyerOrg = psql(`select org_id from public.profiles where id = '${buyer}';`).trim();
  asUser(sa, `select public.platform_set_pro_status('${buyerOrg}', 'active');`, "validation acheteur");
  const code = asUser(owner, `select public.create_invitation('client', null, 'Resto du Lac', '+21620000000') ->> 'code';`, "invitation").trim().split("\n").filter(Boolean).pop();
  asUser(buyer, `select public.accept_invitation('${code}');`, "acceptation invitation");

  // Delivery QR codes and signature off by default: the robot scans nothing.
  psql(`update public.clients set scan_delivery_note = false, scan_client_qr = false, delivery_signature = false,
    custom_settings = array['scan_delivery_note', 'scan_client_qr', 'delivery_signature'];`, "options clients");

  const accounts = { platform: "admin@a.tn", owner: "admin@agrifresh.tn", supervisor: "superviseur@agrifresh.tn", production: "production@agrifresh.tn", driver: "livreur@agrifresh.tn", buyer: "acheteur@resto.tn" };
  writeFileSync(join(workdir, ".env.test"), [
    `EXPO_PUBLIC_SUPABASE_URL=${env.api}`,
    `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${env.anon}`,
    `E2E_PASSWORD=${PASSWORD}`,
    `E2E_ACCOUNTS=${JSON.stringify(accounts)}`,
  ].join("\n") + "\n");
  log("• Prêt : " + Object.values(accounts).join(", "));
  return { env, accounts };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  setup().catch((error) => { console.error(`\n✖ ${error.message}`); process.exit(1); });
}
