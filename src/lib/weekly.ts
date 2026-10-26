import { randomUUID } from "node:crypto";
import { writeBriefs } from "./briefs";
import { weeklyReview } from "./claude";
import { postCoachMessage } from "./coach";
import { historyBetween, loadPlanWeeks } from "./context";
import { query, queryOne } from "./db";
import { describeChange, sessionLabel } from "./proposals";
import type { CoachMessageRow, PlanRow, PlannedSessionRow, StoredAdjustment, StoredAdjustments, WeeklyMessageMeta, WeeklyReviewRow } from "../types";

// The weekly review, written once by the scheduler (Monday 04:00 JST) and rewritten
// in place when the week's data changes afterwards: an activity of that week arrives
// late (the worker), or the athlete answers "沒跑" to one of its questions (the api
// queues a weekly_rerun). The same weekly_reviews row and the same thread message are
// updated; pending proposals are cancelled (superseded), applied ones stay and are
// facts for the new text.

const KEY_SESSION = /Long|長跑|MP|坡/i;

export const WEEKLY_REVIEW_SELECT = `select id, plan_id, to_char(week_start, 'YYYY-MM-DD') as week_start, summary, adjustments, created_at, updated_at, update_reason from weekly_reviews`;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const SESSIONS_SELECT = `select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions
  where plan_id = $1 and superseded = false and scheduled_date between $2 and $3 order by planned_sessions.scheduled_date`;

export interface WeeklyRunResult { review_id: string; adjustments: number; asks: number }

/**
 * Generate (no `existing`) or regenerate (`existing` + `reason`) the review of the week
 * starting `weekStart` for `plan`. Posts / updates the thread message and rewrites the
 * next two weeks' briefs.
 */
export async function runWeeklyReview(
  plan: PlanRow & { display_name: string },
  weekStart: string,
  existing?: WeeklyReviewRow,
  reason?: string,
): Promise<WeeklyRunResult> {
  const weekEnd = addDays(weekStart, 6);
  const upcomingEnd = addDays(weekStart, 27); // next three weeks are adjustable

  const sessions = await query<PlannedSessionRow>(SESSIONS_SELECT, [plan.id, weekStart, weekEnd]);
  const upcoming = await query<PlannedSessionRow>(SESSIONS_SELECT, [plan.id, addDays(weekEnd, 1), upcomingEnd]);
  const activities = await historyBetween(plan.user_id, weekStart, weekEnd);
  const activityIds = (await query<{ id: string }>(
    `select id from activities where user_id = $1 and match_status <> 'ignored' and (start_time at time zone 'Asia/Tokyo')::date between $2 and $3`,
    [plan.user_id, weekStart, weekEnd],
  )).map((r) => r.id);
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

  // Key sessions (Long / MP / 坡跑) with no record: ask, don't conclude.
  const done = new Set((await query<{ session_id: string }>(
    "select distinct session_id from activities where user_id = $1 and session_id is not null and match_status <> 'ignored'",
    [plan.user_id],
  )).map((r) => r.session_id));
  const message = existing ? await queryOne<CoachMessageRow>("select * from coach_messages where weekly_review_id = $1 order by created_at limit 1", [existing.id]) : undefined;
  const oldMeta = (message?.meta ?? {}) as Partial<WeeklyMessageMeta>;
  const oldAskState = new Map((oldMeta.asks ?? []).map((a) => [a.session_id, a.state]));
  const skipped = sessions.filter((s) => s.skipped_at);
  const asks = sessions
    .filter((s) => s.type !== "rest" && KEY_SESSION.test(s.label ?? "") && !done.has(s.id) && !s.skipped_at)
    .map((s) => ({ session: s, state: oldAskState.get(s.id) === "synced" ? "synced" as const : "open" as const }));

  const stored = (existing?.adjustments ?? null) as StoredAdjustments | null;
  const applied = (stored?.items ?? []).filter((a) => a.status === "applied");

  const review = await weeklyReview({
    plan, weeks, weekStart, weekEnd, sessions, activities, hints,
    previousSummary: previous?.summary ?? null, upcoming,
    asks, skipped, applied, updateReason: reason ?? null,
  });

  const fresh: StoredAdjustment[] = review.adjustments.map((a) => ({ ...a, status: "pending" }));
  const meta: WeeklyMessageMeta = {
    week_start: weekStart,
    proposals: fresh.length,
    asks: asks.map(({ session: s, state }) => ({ session_id: s.id, label: sessionLabel(s), date: s.scheduled_date, state })),
  };

  if (!existing) {
    const id = randomUUID();
    const toStore: StoredAdjustments = { model: review.model, hints, items: fresh, activities: activityIds };
    await query(
      `insert into weekly_reviews (id, plan_id, week_start, summary, adjustments) values ($1, $2, $3, $4, $5)`,
      [id, plan.id, weekStart, review.summary, JSON.stringify(toStore)],
    );
    await postCoachMessage({
      user_id: plan.user_id, role: "coach", kind: "weekly", text: review.summary, weekly_review_id: id,
      meta: meta as unknown as Record<string, unknown>,
    });
    await rewriteBriefs(plan, weekEnd);
    return { review_id: id, adjustments: fresh.length, asks: asks.length };
  }

  // Regeneration: pending proposals are cancelled, applied / dismissed ones kept, new ones appended.
  const now = new Date().toISOString();
  const cancelled: string[] = [];
  const kept: StoredAdjustment[] = [];
  for (const item of stored?.items ?? []) {
    if (item.status === "pending") {
      const s = await queryOne<PlannedSessionRow>("select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions where id = $1", [item.session_id]);
      cancelled.push(describeChange(item, s?.scheduled_date ?? null));
      kept.push({ ...item, status: "superseded", decided_at: now });
    } else {
      kept.push(item);
    }
  }
  const toStore: StoredAdjustments = { model: review.model, hints, items: [...kept, ...fresh], activities: activityIds };
  await query(
    `update weekly_reviews set summary = $2, adjustments = $3, updated_at = now(), update_reason = $4 where id = $1`,
    [existing.id, review.summary, JSON.stringify(toStore), reason ?? null],
  );
  const newMeta: WeeklyMessageMeta = {
    ...oldMeta, ...meta,
    updated: { at: now, reason: reason ?? "" },
    cancelled: [...(oldMeta.cancelled ?? []), ...cancelled],
  };
  if (message) {
    await query("update coach_messages set text = $2, meta = $3 where id = $1", [message.id, review.summary, JSON.stringify(newMeta)]);
  } else {
    await postCoachMessage({ user_id: plan.user_id, role: "coach", kind: "weekly", text: review.summary, weekly_review_id: existing.id, meta: newMeta as unknown as Record<string, unknown> });
  }
  await rewriteBriefs(plan, weekEnd);
  return { review_id: existing.id, adjustments: fresh.length, asks: asks.length };
}

/** Woo's one line per session for the next two weeks, rewritten with this week in mind. */
async function rewriteBriefs(plan: PlanRow, weekEnd: string): Promise<void> {
  try {
    await writeBriefs(plan.user_id, addDays(weekEnd, 1), addDays(weekEnd, 14), true);
  } catch (err) {
    console.error(`briefs after weekly review failed for plan ${plan.id}`, err);
  }
}

/** The review of the week that contains `date` (JST) for the user's active plan, if any. */
export async function weeklyReviewFor(userId: string, date: string): Promise<(WeeklyReviewRow & { plan: PlanRow & { display_name: string } }) | undefined> {
  const plan = await queryOne<PlanRow & { display_name: string }>(
    `select p.*, to_char(p.race_date, 'YYYY-MM-DD') as race_date, u.display_name
       from plans p join users u on u.id = p.user_id
      where p.user_id = $1 and p.status = 'active' order by p.race_date limit 1`,
    [userId],
  );
  if (!plan) return undefined;
  const w = await queryOne<WeeklyReviewRow>(
    `${WEEKLY_REVIEW_SELECT} where plan_id = $1 and week_start <= $2::date and week_start + 6 >= $2::date order by created_at desc limit 1`,
    [plan.id, date],
  );
  return w ? { ...w, plan } : undefined;
}

/**
 * Worker: an activity of `localDate` was inserted or got its verdict. If that week's
 * review exists and did not see this activity, regenerate it. Idempotent: the review
 * records the activity ids it saw, so a redelivery does nothing.
 */
export async function maybeRerunWeeklyReview(userId: string, activityId: string, localDate: string, reason: string): Promise<boolean> {
  const w = await weeklyReviewFor(userId, localDate);
  if (!w) return false;
  const stored = (w.adjustments ?? null) as StoredAdjustments | null;
  if (stored?.activities) {
    if (stored.activities.includes(activityId)) return false;
  } else {
    // A review from before this feature: only an activity that happened after it counts.
    const a = await queryOne<{ start_time: Date }>("select start_time from activities where id = $1", [activityId]);
    if (!a || new Date(a.start_time).getTime() <= new Date(w.updated_at ?? w.created_at).getTime()) return false;
  }
  try {
    const { plan, ...row } = w;
    const r = await runWeeklyReview(plan, w.week_start, row, reason);
    console.log(`weekly review ${r.review_id} regenerated (${reason}): ${r.adjustments} adjustments, ${r.asks} asks`);
    return true;
  } catch (err) {
    console.error(`weekly review rerun failed for user ${userId} (${reason})`, err); // not requeued: the next activity / ask tries again
    return false;
  }
}
