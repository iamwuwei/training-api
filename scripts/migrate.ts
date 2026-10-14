import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { end, query } from "../src/lib/db";

// Runs sql/schema.sql against Aurora using your local AWS credentials
// (IAM auth, same as the Lambdas). Schema is idempotent.

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "schema.sql"), "utf8");
  console.log(`connecting to ${process.env.DB_HOST} (Aurora may take ~15 s to wake)…`);
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
