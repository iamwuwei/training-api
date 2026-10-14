import "dotenv/config";
import { end, query } from "../src/lib/db";
import { getActivities, refreshToken } from "../src/lib/strava";
import { processEvent } from "../src/handlers/worker";
import type { StravaConnectionRow } from "../src/types";

// Pull existing Strava runs (since the earliest active plan's first session, or
// --since YYYY-MM-DD) through the same path as the webhook worker.
// Usage: npm run backfill [-- --since 2026-10-08]

async function main() {
  const sinceArg = process.argv.indexOf("--since");
  const since = sinceArg > -1 ? process.argv[sinceArg + 1] : undefined;

  const conns = await query<StravaConnectionRow & { display_name: string; first_date: string | null }>(
    `select c.*, u.display_name,
            (select to_char(min(ps.scheduled_date), 'YYYY-MM-DD') from planned_sessions ps
               join plans p on p.id = ps.plan_id where p.user_id = c.user_id and p.status = 'active') as first_date
       from strava_connections c join users u on u.id = c.user_id`,
  );
  if (!conns.length) {
    console.log("no strava_connections yet — authorize via <OauthUrl>/start?user=<uuid> first");
    return;
  }

  for (const conn of conns) {
    const from = since ?? conn.first_date;
    if (!from) {
      console.log(`${conn.display_name}: no plan sessions, skipping`);
      continue;
    }
    let access = conn.access_token;
    if (new Date(conn.expires_at).getTime() < Date.now() + 60_000) {
      const t = await refreshToken(conn.refresh_token);
      await query(
        "update strava_connections set access_token = $2, refresh_token = $3, expires_at = to_timestamp($4) where user_id = $1",
        [conn.user_id, t.access_token, t.refresh_token, t.expires_at],
      );
      access = t.access_token;
    }

    const after = Math.floor(new Date(`${from}T00:00:00+09:00`).getTime() / 1000);
    const ids: number[] = [];
    for (let page = 1; ; page++) {
      const batch = await getActivities(access, { after, page, per_page: 100 });
      ids.push(...batch.filter((a) => a.type === "Run").map((a) => a.id));
      if (batch.length < 100) break;
    }
    console.log(`${conn.display_name}: ${ids.length} runs since ${from}`);

    for (const id of ids.sort((a, b) => a - b)) {
      await processEvent({ object_id: id, owner_id: Number(conn.strava_athlete_id) });
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(end);
