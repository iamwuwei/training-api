import { randomUUID } from "node:crypto";
import { weeklyReview } from "../lib/claude";
import { query } from "../lib/db";
import type { ActivityRow, PlanRow, PlannedSessionRow } from "../types";

// EventBridge Scheduler fires this every Sunday 21:00 Asia/Tokyo.
// Optional manual invoke: { "week_start": "YYYY-MM-DD" } (a Monday) to backfill.

const JST_OFFSET_MS = 9 * 3600 * 1000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

/** Monday of the week containing "now" in JST. */
function currentWeekStartJst(): string {
  const nowJst = new Date(Date.now() + JST_OFFSET_MS);
  const dow = nowJst.getUTCDay(); // 0 = Sunday
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(isoDate(nowJst), -back);
}

export const handler = async (event: { week_start?: string } = {}) => {
  const weekStart = event.week_start ?? currentWeekStartJst();
  const weekEnd = addDays(weekStart, 6);
  const upcomingEnd = addDays(weekStart, 20);

  const plans = await query<PlanRow & { display_name: string }>(
    `select p.*, to_char(p.race_date, 'YYYY-MM-DD') as race_date, u.display_name
       from plans p join users u on u.id = p.user_id
      where p.status = 'active'`,
  );

  const results: { plan_id: string; review_id: string; adjustments: number }[] = [];

  for (const plan of plans) {
    const sessions = await query<PlannedSessionRow>(
      `select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date
         from planned_sessions
        where plan_id = $1 and superseded = false and scheduled_date between $2 and $3
        order by planned_sessions.scheduled_date`,
      [plan.id, weekStart, weekEnd],
    );
    const upcoming = await query<PlannedSessionRow>(
      `select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date
         from planned_sessions
        where plan_id = $1 and superseded = false and scheduled_date between $2 and $3
        order by planned_sessions.scheduled_date`,
      [plan.id, addDays(weekEnd, 1), upcomingEnd],
    );
    const activities = await query<ActivityRow>(
      `select id, user_id, strava_activity_id, session_id, sport_type, start_time, distance_m, moving_time_sec,
              avg_pace_sec_km, avg_hr, max_hr, avg_watts, kcal, description, device_name, gear_id,
              gear_name, weather, splits, match_status
         from activities
        where user_id = $1
          and match_status <> 'ignored'
          and (sport_type is null or sport_type in ('Run', 'TrailRun', 'VirtualRun'))
          and (start_time at time zone 'Asia/Tokyo')::date between $2 and $3
        order by start_time`,
      [plan.user_id, weekStart, weekEnd],
    );

    const review = await weeklyReview({ plan, weekStart, weekEnd, sessions, activities, upcoming });

    // v1: record only. Adjustments are NOT applied automatically.
    const id = randomUUID();
    await query(
      `insert into weekly_reviews (id, plan_id, week_start, summary, adjustments)
       values ($1, $2, $3, $4, $5)`,
      [id, plan.id, weekStart, review.summary, JSON.stringify({ model: review.model, items: review.adjustments })],
    );
    results.push({ plan_id: plan.id, review_id: id, adjustments: review.adjustments.length });
    console.log(`weekly review ${id} for plan ${plan.id} (${plan.display_name}) week ${weekStart}: ${review.adjustments.length} adjustments`);
  }

  return { week_start: weekStart, reviews: results };
};
