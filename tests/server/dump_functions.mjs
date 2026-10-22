// Dumps the current definition of given functions (after every migration) to fn_dump.sql.
import { writeFileSync } from "node:fs";
export async function runDump({ db }) {
  const names = process.env.DUMP === "*" ? [] : (process.env.DUMP ?? "").split(",").filter(Boolean);
  const rows = (await db.query(`select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and ($1::text[] = '{}' or p.proname = any($1::text[])) order by p.proname`, [names])).rows;
  writeFileSync(new URL("./fn_dump.sql", import.meta.url), rows.map((r) => `-- ===== ${r.proname}\n${r.def};\n`).join("\n"));
  console.log("DUMPED", rows.length);
}
