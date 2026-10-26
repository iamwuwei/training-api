import { query, queryOne } from "../lib/db";
import { isValidDate } from "../lib/labels";
import { rerunWeekly, runWeeklyReview, WEEKLY_REVIEW_SELECT } from "../lib/weekly";
import type { PlanRow, WeeklyRerunRequest, WeeklyReviewRow } from "../types";

// EventBridge Scheduler fires this every Monday 04:00 Asia/Tokyo for the week that
// just ended (Monday〜Sunday). A week that already has a review is skipped: the
// Scheduler / Lambda retries after a timeout must not regenerate (and cancel the
// proposals of) a review written a minute ago. Because of that skip a retry is safe,
// so a plan that failed (model 529, database still waking) makes the handler throw
// at the end and the retry picks up only the plans without a review. Manual invokes:
//   { "week_start": "YYYY-MM-DD" }                     backfill that week (a Monday); skipped if it has a review
//   { "week_start": "YYYY-MM-DD", "regenerate": true } regenerate it in place (reason 重新回顧); never retried
// The api and the worker invoke it asynchronously with
//   { "rerun": { user_id, weekly_review_id, reason, requested_at, activity_id? } }
// to regenerate one review in place (the athlete said 沒跑, an activity arrived late);
// a Lambda retry of that after the rerun happened is skipped (see rerunWeekly).

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

type Result = { plan_id: string; review_id?: string; adjustments?: number; asks?: number; skipped?: boolean; error?: string };

export type WeeklyEvent = { week_start?: string; regenerate?: boolean; rerun?: WeeklyRerunRequest };

export const handler = async (event: WeeklyEvent = {}) => {
  if (event.rerun) {
    const r = await rerunWeekly(event.rerun);
    return { rerun: event.rerun.weekly_review_id, ...(r ?? { ignored: true }) };
  }

  if (event.week_start !== undefined) {
    if (!isValidDate(event.week_start)) throw new Error("week_start must be a real date, YYYY-MM-DD");
    if (new Date(`${event.week_start}T00:00:00Z`).getUTCDay() !== 1) throw new Error("week_start must be a Monday");
  }
  const weekStart = event.week_start ?? lastWeekStartJst();
  const regenerate = event.week_start !== undefined && event.regenerate === true;

  const plans = await query<PlanRow & { display_name: string }>(
    `select p.*, to_char(p.race_date, 'YYYY-MM-DD') as race_date, u.display_name
       from plans p join users u on u.id = p.user_id
      where p.status = 'active'`,
  );

  const results: Result[] = [];

  // One plan failing (model error, timeout) must not stop the others; the failures are
  // collected and thrown together below so the retry only redoes those plans.
  for (const plan of plans) {
    try {
      const existing = await queryOne<WeeklyReviewRow>(
        `${WEEKLY_REVIEW_SELECT} where plan_id = $1 and week_start = $2 order by created_at desc limit 1`,
        [plan.id, weekStart],
      );
      if (existing && !regenerate) {
        console.log(`weekly review for plan ${plan.id} (${plan.display_name}) week ${weekStart} already exists (${existing.id}), skipping`);
        results.push({ plan_id: plan.id, review_id: existing.id, skipped: true });
        continue;
      }
      const r = await runWeeklyReview(plan, weekStart, existing, existing ? "重新回顧" : undefined);
      results.push({ plan_id: plan.id, ...r });
      console.log(`weekly review ${r.review_id} for plan ${plan.id} (${plan.display_name}) week ${weekStart}${existing ? " (regenerated)" : ""}: ${r.adjustments} adjustments, ${r.asks} asks`);
    } catch (err) {
      console.error(`weekly review failed for plan ${plan.id} (${plan.display_name}) week ${weekStart}`, err);
      results.push({ plan_id: plan.id, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    }
  }

  // Scheduled / backfill: a failed plan has no review row (the run is one transaction),
  // so a retry generates it and skips the rest. A manual regenerate is not retried —
  // a second regeneration would cancel the proposals the first one just made.
  const failed = results.filter((r) => r.error);
  if (failed.length && !regenerate) {
    throw new Error(`weekly review failed for ${failed.length} of ${plans.length} plan(s) week ${weekStart}: ${failed.map((r) => `${r.plan_id}: ${r.error}`).join("; ")}`);
  }

  return { week_start: weekStart, reviews: results };
};
