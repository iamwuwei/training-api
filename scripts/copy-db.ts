import "dotenv/config";
import { types } from "pg";
import { dbConfigFromEnv, makePool, type DbConfig } from "../src/lib/db";

// Copies every table from the Aurora database (DB_HOST + IAM, from .env) into
// the database at --to <url> (Supabase). Run `DATABASE_URL=<url> npm run migrate`
// first so the schema exists there. Rows are inserted with ON CONFLICT DO
// NOTHING, so it can be re-run; it never deletes anything.
//
//   npm run copy-db -- --to "postgresql://postgres.<ref>:<password>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres"

// Parents before children (foreign keys).
const TABLES = [
  "users",
  "strava_connections",
  "plans",
  "plan_weeks",
  "planned_sessions",
  "activities",
  "reviews",
  "weekly_reviews",
  "coach_messages",
];

async function main() {
  const i = process.argv.indexOf("--to");
  const to = i >= 0 ? process.argv[i + 1] : undefined;
  if (!to) throw new Error('usage: npm run copy-db -- --to "<DATABASE_URL>"');

  // Read dates and timestamps as text so they round-trip exactly (a JS Date
  // would shift `date` columns by the local timezone).
  types.setTypeParser(1082, (v) => v); // date
  types.setTypeParser(1114, (v) => v); // timestamp
  types.setTypeParser(1184, (v) => v); // timestamptz

  const sourceConfig: DbConfig = { ...dbConfigFromEnv() };
  if (sourceConfig.kind === "url" && sourceConfig.url === to) throw new Error("source and target are the same database; unset DATABASE_URL in .env to read from Aurora");
  const source = await makePool(sourceConfig);
  const target = await makePool({ kind: "url", url: to });
  console.log(`source: ${sourceConfig.kind === "iam" ? sourceConfig.host : "DATABASE_URL"}\ntarget: ${new URL(to).host}\n`);

  try {
    for (const table of TABLES) {
      const { rows } = await source.query(`select * from ${table}`);
      let inserted = 0;
      for (const row of rows) {
        // json_populate_record casts every column from JSON, so jsonb, arrays,
        // dates and bigints all land in their real types.
        const res = await target.query(
          `insert into ${table} select * from json_populate_record(null::${table}, $1::json) on conflict do nothing`,
          [JSON.stringify(row)],
        );
        inserted += res.rowCount ?? 0;
      }
      const { rows: [{ n }] } = await target.query<{ n: string }>(`select count(*) as n from ${table}`);
      console.log(`${table.padEnd(18)} source ${String(rows.length).padStart(5)}   copied ${String(inserted).padStart(5)}   target now ${n}`);
    }
  } finally {
    await Promise.all([source.end(), target.end()]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
