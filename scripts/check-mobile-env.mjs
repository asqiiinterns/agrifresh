import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env.local");
let contents;

try {
  contents = readFileSync(envPath, "utf8");
} catch {
  console.error("Configuration Supabase absente : créez .env.local depuis .env.example avant de générer l’APK.");
  process.exit(1);
}

const readValue = (name) => {
  const match = contents.match(new RegExp(`^\\s*${name}\\s*=\\s*[\"']?([^\\r\\n\"']+)[\"']?\\s*$`, "m"));
  return match?.[1]?.trim();
};

const url = readValue("VITE_SUPABASE_URL");
const key = readValue("VITE_SUPABASE_ANON_KEY");

if (!url || !key || /YOUR_PROJECT|YOUR_SUPABASE|placeholder/i.test(`${url} ${key}`)) {
  console.error("VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY doivent contenir les valeurs de votre projet Supabase dans .env.local.");
  process.exit(1);
}

console.log("Configuration Supabase mobile détectée.");
