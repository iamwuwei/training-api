import { query, queryOne } from "../lib/db";
import { runWeeklyReview, WEEKLY_REVIEW_SELECT } from "../lib/weekly";
import type { PlanRow, WeeklyReviewRow } from "../types";

// EventBridge Scheduler fires this every Monday 04:00 Asia/Tokyo for the week that
// just ended (Monday〜Sunday). Optional manual invoke: { "week_start": "YYYY-MM-DD" }
// (a Monday) to backfill; a week that already has a review is regenerated in place.

const JST_OFFSET_MS = 9 * 3600 * 1000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

/** Monday of the last completed week: the week that contains "yesterday" in JST. */
function lastWeekStartJst(): string {
  const yesterdayJst = new Date(Date.now() + JST_OFFSET_MS - 86_400_000);
  const dow = yesterdayJst.getUTCDay(); // 0 = Sunday
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(isoDate(yesterdayJst), -back);
}

export const handler = async (event: { week_start?: string } = {}) => {
  const weekStart = event.week_start ?? lastWeekStartJst();

  const plans = await query<PlanRow & { display_name: string }>(
    `select p.*, to_char(p.race_date, 'YYYY-MM-DD') as race_date, u.display_name
       from plans p join users u on u.id = p.user_id
      where p.status = 'active'`,
  );

  const results: { plan_id: string; review_id: string; adjustments: number; asks: number }[] = [];

  for (const plan of plans) {
    const existing = await queryOne<WeeklyReviewRow>(
      `${WEEKLY_REVIEW_SELECT} where plan_id = $1 and week_start = $2 order by created_at desc limit 1`,
      [plan.id, weekStart],
    );
    const r = await runWeeklyReview(plan, weekStart, existing, existing ? "重新回顧" : undefined);
    results.push({ plan_id: plan.id, ...r });
    console.log(`weekly review ${r.review_id} for plan ${plan.id} (${plan.display_name}) week ${weekStart}${existing ? " (regenerated)" : ""}: ${r.adjustments} adjustments, ${r.asks} asks`);
  }

  return { week_start: weekStart, reviews: results };
};
