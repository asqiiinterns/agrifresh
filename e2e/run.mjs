// Every automated check on a local copy of Appro+ (never the real database): npm run e2e
//   1. local Supabase (Docker) started if needed, database rebuilt from scratch with every migration and test accounts;
//   2. every server function analysed on a real Postgres (plpgsql_check): errors a real database refuses;
//   3. web app built against this database, then the robot opens every screen with every role.
// Stops at the first failing step. Results: e2e/results (one file per role), e2e/report (open index.html).
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setup } from "./setup.mjs";

const root = resolve(import.meta.dirname, "..");
const windows = process.platform === "win32";
const run = (cmd, args, env) => {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: windows, env: { ...process.env, ...env } });
  if (result.status !== 0) { console.error(`\n✖ Échec : ${cmd} ${args.join(" ")}`); process.exit(1); }
};
const step = (label) => console.log(`\n━━ ${label}`);

step("1. Base de test locale");
try { execFileSync("docker", ["info"], { stdio: "ignore" }); } catch { console.error("✖ Docker n’est pas démarré : lancez Docker Desktop."); process.exit(1); }
const running = spawnSync("docker", ["ps", "-q", "-f", "name=supabase_db_e2e"], { encoding: "utf8" }).stdout.trim();
if (!running) run("npx", ["supabase@latest", "start", "--workdir", "e2e", "-x", "studio,edge-runtime,logflare,vector,imgproxy,supavisor,postgres-meta"]);
const { env } = await setup();

step("2. Analyse de toutes les fonctions serveur (vrai Postgres)");
// Dynamic column names (format('%I')) cannot be checked statically: known and covered by the server tests.
const KNOWN = [/^products_import\|.*does not exist$/];
const sql = `create extension if not exists plpgsql_check;
select p.proname || '|' || r.message from pg_proc p join pg_namespace n on n.oid = p.pronamespace
join pg_language l on l.oid = p.prolang and l.lanname = 'plpgsql'
cross join lateral plpgsql_check_function_tb(p.oid, coalesce((select tgrelid from pg_trigger where tgfoid = p.oid limit 1), 0),
  fatal_errors := false, other_warnings := false, performance_warnings := false, extra_warnings := false) r
where n.nspname = 'public' and r.level = 'error';`;
const out = execFileSync("docker", ["exec", "-i", "supabase_db_e2e", "psql", "-U", "postgres", "-d", "postgres", "-q", "-t", "-A", "-f", "-"], { input: sql, encoding: "utf8" });
const errors = out.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("NOTICE") && !KNOWN.some((re) => re.test(line)));
if (errors.length) { console.error("✖ Fonctions refusées par Postgres :\n  " + errors.join("\n  ")); process.exit(1); }
console.log("✓ aucune erreur");

step("3. Version web de test");
run("npx", ["expo", "export", "--platform", "web", "--output-dir", "e2e/web"], {
  EXPO_NO_DOTENV: "1", EXPO_PUBLIC_SUPABASE_URL: env.api, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.anon,
});

step("4. Robot : tous les écrans, tous les rôles");
run("npx", ["playwright", "test"]);
console.log("\n✓ Tout est passé.");
