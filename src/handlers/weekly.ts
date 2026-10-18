import { randomUUID } from "node:crypto";
import { weeklyReview } from "../lib/claude";
import { historyBetween, loadPlanWeeks } from "../lib/context";
import { query, queryOne } from "../lib/db";
import type { PlanRow, PlannedSessionRow, StoredAdjustments } from "../types";

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
  const upcomingEnd = addDays(weekStart, 27); // next three weeks are adjustable

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
    const activities = await historyBetween(plan.user_id, weekStart, weekEnd);
    const hints = (await query<{ adjust_hint: string }>(
      `select r.adjust_hint from reviews r join activities a on a.id = r.activity_id
        where a.user_id = $1 and r.adjust_hint is not null
          and (a.start_time at time zone 'Asia/Tokyo')::date between $2 and $3
        order by a.start_time`,
      [plan.user_id, weekStart, weekEnd],
    )).map((r) => r.adjust_hint);
    const previous = await queryOne<{ summary: string | null }>(
      "select summary from weekly_reviews where plan_id = $1 and week_start < $2 order by week_start desc limit 1",
      [plan.id, weekStart],
    );
    const weeks = await loadPlanWeeks(plan.id);

    const review = await weeklyReview({
      plan, weeks, weekStart, weekEnd, sessions, activities, hints,
      previousSummary: previous?.summary ?? null, upcoming,
    });

    // Proposals only: each adjustment waits for the athlete to apply or dismiss it
    // in the app (POST /weekly/{id}/adjustments/{index}).
    const stored: StoredAdjustments = {
      model: review.model,
      hints,
      items: review.adjustments.map((a) => ({ ...a, status: "pending" })),
    };
    const id = randomUUID();
    await query(
      `insert into weekly_reviews (id, plan_id, week_start, summary, adjustments)
       values ($1, $2, $3, $4, $5)`,
      [id, plan.id, weekStart, review.summary, JSON.stringify(stored)],
    );
    results.push({ plan_id: plan.id, review_id: id, adjustments: review.adjustments.length });
    console.log(`weekly review ${id} for plan ${plan.id} (${plan.display_name}) week ${weekStart}: ${review.adjustments.length} adjustments`);
  }

  return { week_start: weekStart, reviews: results };
};
