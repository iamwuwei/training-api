import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { end, query, queryOne } from "../src/lib/db";
import type { SessionType } from "../src/types";

// Reads seed/plans.json -> users / plans / planned_sessions. Idempotent:
// users are keyed by fixed uuid, plans by (user, race_name, race_date),
// sessions by (plan, date) — re-running updates in place, never duplicates.

// Fixed uuids so the front-end / OAuth links stay stable across re-seeds.
// display_name: edit here when decided.
const USERS: Record<string, { id: string; display_name: string; email: string | null }> = {
  ww: { id: "7d1c3a0e-4f7b-4d2e-9c1a-5b8e2f6a1c01", display_name: "Wei Wu", email: null },
  gf: { id: "3f9a8b2c-6d1e-4a5f-8e7c-2b4d6f8a0c02", display_name: "gf", email: null },
};

interface SeedSession {
  date: string;
  type: SessionType;
  distance_m: number;
  pace_sec_km: number | null;
  note: string;
}
interface SeedPlan {
  user: string;
  race_name: string;
  race_date: string;
  goal_time_sec?: number | null;
  days_per_week?: number | null;
  sessions: SeedSession[];
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

    let inserted = 0, updated = 0;
    for (const s of p.sessions) {
      if (!TYPES.has(s.type)) throw new Error(`plans.json: bad type "${s.type}" on ${s.date}`);
      const existing = await queryOne<{ id: string }>(
        "select id from planned_sessions where plan_id = $1 and scheduled_date = $2 and superseded = false",
        [plan.id, s.date],
      );
      if (existing) {
        await query(
          `update planned_sessions set type = $2, target_distance_m = $3, target_pace_sec_km = $4, note = $5
            where id = $1`,
          [existing.id, s.type, s.distance_m, s.pace_sec_km, s.note || null],
        );
        updated++;
      } else {
        await query(
          `insert into planned_sessions (id, plan_id, scheduled_date, type, target_distance_m, target_pace_sec_km, note)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [randomUUID(), plan.id, s.date, s.type, s.distance_m, s.pace_sec_km, s.note || null],
        );
        inserted++;
      }
    }
    console.log(`plan ${p.race_name} (${p.race_date}) for ${p.user}: ${plan.id} — ${inserted} inserted, ${updated} updated`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(end);
