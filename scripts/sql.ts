import "dotenv/config";
import { end, query } from "../src/lib/db";

// Run one SQL statement against Aurora with the same IAM connection the app uses.
// Usage: npm run sql -- "select now()"

async function main() {
  const sql = process.argv.slice(2).join(" ").trim();
  if (!sql) throw new Error('usage: npm run sql -- "select 1"');
  const rows = await query(sql);
  if (rows.length === 0) console.log("(no rows)");
  else console.table(rows);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(end);
