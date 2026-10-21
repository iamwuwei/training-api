import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { end, query } from "../src/lib/db";

// Runs sql/schema.sql against DATABASE_URL (Supabase). Schema is idempotent.

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "schema.sql"), "utf8");
  console.log(`connecting to ${new URL(process.env.DATABASE_URL ?? "postgresql://unset").host}…`);
  await query(sql);
  const tables = await query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by 1",
  );
  console.log("tables:", tables.map((t) => t.table_name).join(", "));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(end);
