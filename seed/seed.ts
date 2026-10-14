import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { end, query, queryOne } from "../src/lib/db";
import type { SessionType } from "../src/types";

// Reads seed/plans.json -> users / plans / plan_weeks / planned_sessions, and
// attaches hand-typed results (verdict, 心得, 提醒, weather, shoes, device) from
// the xlsx to Strava activities on the same local date. Idempotent:
// users keyed by fixed uuid, plans by (user, race_name, race_date), weeks by
// (plan, week_no), sessions by (plan, date), reviews by activity.
//
// Order: `npm run migrate` -> `npm run seed` -> `npm run backfill` -> `npm run seed`
// (the second seed attaches results to the backfilled activities).

// Fixed uuids so the front-end / OAuth links stay stable across re-seeds.
// email: the Apple ID email (or private relay address) used for Sign in with Apple —
// first login links users.apple_sub to the row whose email matches.
const USERS: Record<string, { id: string; display_name: string; email: string | null }> = {
  ww: { id: "7d1c3a0e-4f7b-4d2e-9c1a-5b8e2f6a1c01", display_name: "Wei Wu", email: null },
  gf: { id: "3f9a8b2c-6d1e-4a5f-8e7c-2b4d6f8a0c02", display_name: "gf", email: null },
};

interface SeedWeek {
  week_no: number;
  start: string;
  end: string;
  phase: string | null;
  focus: string | null;
}
interface SeedSession {
  date: string;
  week_no: number | null;
  phase: string | null;
  label: string;
  type: SessionType;
  distance_m: number;
  content: string | null;
  note: string | null;
  target: string | null;
  pace_sec_km: number | null;
  pace_min_sec_km: number | null;
  pace_max_sec_km: number | null;
  hr_min: number | null;
  hr_max: number | null;
}
interface SeedResult {
  date: string;
  distance_m: number;
  memo: string | null;
  moving_time_sec: number | null;
  pace_sec_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_watts: number | null;
  kcal: number | null;
  weather: string | null;
  shoes: string | null;
  device: string | null;
  verdict: string | null;
  reminders: string[];
}
interface SeedPlan {
  user: string;
  race_name: string;
  race_date: string;
  goal_time_sec?: number | null;
  days_per_week?: number | null;
  weeks?: SeedWeek[];
  sessions: SeedSession[];
  results?: SeedResult[];
}

const TYPES = new Set<SessionType>(["easy", "long", "tempo", "interval", "rest", "race"]);

async function main() {
  const file = path.join(__dirname, "plans.json");
  const plans = JSON.parse(fs.readFileSync(file, "utf8")) as SeedPlan[];

  for (const [key, u] of Object.entries(USERS)) {
    await query(
      `insert into users (id, email, display_name) values ($1, $2, $3)
       on conflict (id) do update set display_name = excluded.display_name, email = excluded.email`,
      [u.id, u.email, u.display_name],
    );
    console.log(`user ${key}: ${u.id} (${u.display_name})`);
  }

  for (const p of plans) {
    const user = USERS[p.user];
    if (!user) throw new Error(`plans.json: unknown user key "${p.user}"`);

    let plan = await queryOne<{ id: string }>(
      "select id from plans where user_id = $1 and race_name = $2 and race_date = $3",
      [user.id, p.race_name, p.race_date],
    );
    if (plan) {
      await query("update plans set goal_time_sec = $2, days_per_week = $3 where id = $1", [
        plan.id, p.goal_time_sec ?? null, p.days_per_week ?? null,
      ]);
    } else {
      plan = { id: randomUUID() };
      await query(
        `insert into plans (id, user_id, race_name, race_date, goal_time_sec, days_per_week, status)
         values ($1, $2, $3, $4, $5, $6, 'active')`,
        [plan.id, user.id, p.race_name, p.race_date, p.goal_time_sec ?? null, p.days_per_week ?? null],
      );
    }

    for (const w of p.weeks ?? []) {
      await query(
        `insert into plan_weeks (id, plan_id, week_no, week_start, week_end, phase, focus)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (plan_id, week_no) do update set
           week_start = excluded.week_start, week_end = excluded.week_end,
           phase = excluded.phase, focus = excluded.focus`,
        [randomUUID(), plan.id, w.week_no, w.start, w.end, w.phase, w.focus],
      );
    }

    let inserted = 0, updated = 0;
    for (const s of p.sessions) {
      if (!TYPES.has(s.type)) throw new Error(`plans.json: bad type "${s.type}" on ${s.date}`);
      const vals = [
        s.type, s.distance_m, s.pace_sec_km, s.note, s.week_no, s.phase, s.label, s.content,
        s.target, s.pace_min_sec_km, s.pace_max_sec_km, s.hr_min, s.hr_max,
      ];
      const existing = await queryOne<{ id: string }>(
        "select id from planned_sessions where plan_id = $1 and scheduled_date = $2 and superseded = false",
        [plan.id, s.date],
      );
      if (existing) {
        await query(
          `update planned_sessions set
             type = $2, target_distance_m = $3, target_pace_sec_km = $4, note = $5, week_no = $6,
             phase = $7, label = $8, content = $9, target = $10, target_pace_min_sec_km = $11,
             target_pace_max_sec_km = $12, target_hr_min = $13, target_hr_max = $14
           where id = $1`,
          [existing.id, ...vals],
        );
        updated++;
      } else {
        await query(
          `insert into planned_sessions
             (id, plan_id, scheduled_date, type, target_distance_m, target_pace_sec_km, note, week_no,
              phase, label, content, target, target_pace_min_sec_km, target_pace_max_sec_km,
              target_hr_min, target_hr_max)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [randomUUID(), plan.id, s.date, ...vals],
        );
        inserted++;
      }
    }
    console.log(
      `plan ${p.race_name} (${p.race_date}) for ${p.user}: ${plan.id} — ` +
        `${(p.weeks ?? []).length} weeks, ${inserted} sessions inserted, ${updated} updated`,
    );

    // Hand-typed results -> reviews on the Strava activity of the same local date.
    let attached = 0;
    const pending: string[] = [];
    for (const r of p.results ?? []) {
      const activity = await queryOne<{ id: string }>(
        `select id from activities
          where user_id = $1 and match_status <> 'ignored'
            and (start_time at time zone 'Asia/Tokyo')::date = $2
          order by distance_m desc limit 1`,
        [user.id, r.date],
      );
      if (!activity) {
        pending.push(r.date);
        continue;
      }
      await query(
        `update activities set
           weather = coalesce(weather, $2), gear_name = coalesce(gear_name, $3),
           device_name = coalesce(device_name, $4)
         where id = $1`,
        [activity.id, r.weather, r.shoes, r.device],
      );
      if (r.verdict || r.memo || r.reminders.length) {
        await query(
          `insert into reviews (id, activity_id, verdict, comment, reminders, source, model)
           values ($1, $2, $3, $4, $5, 'manual', null)
           on conflict (activity_id) do update set
             verdict = excluded.verdict, comment = excluded.comment, reminders = excluded.reminders,
             source = 'manual', model = null`,
          [randomUUID(), activity.id, r.verdict, r.memo, JSON.stringify(r.reminders)],
        );
        attached++;
      }
    }
    if (p.results?.length) {
      console.log(`results: ${attached} reviews attached` +
        (pending.length ? `; no activity yet for ${pending.join(", ")} (run \`npm run backfill\`, then seed again)` : ""));
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(end);
