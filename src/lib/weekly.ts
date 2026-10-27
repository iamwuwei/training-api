import { randomUUID } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { writeBriefs } from "./briefs";
import { adjustmentLine, weeklyReview } from "./claude";
import { buildPlanBriefing, loadPlanBriefing } from "./briefing";
import { postCoachMessage } from "./coach";
import { historyBetween } from "./context";
import { type Querier, query, queryOne, withTransaction } from "./db";
import { sessionLabel, shortDate, sportName } from "./labels";
import { type CardDraft, describeCard, describeChange, validateCards } from "./proposals";
import type { CoachMessageRow, PlanRow, PlannedSessionRow, ProposalRow, StoredAdjustment, StoredAdjustments, WeeklyMessageMeta, WeeklyRerunRequest, WeeklyReviewRow } from "../types";

// The weekly review, written once by the scheduler (Monday 04:00 JST) and rewritten
// in place when the week's data changes afterwards: an activity of that week arrives
// late (the worker), or the athlete answers "沒跑" to one of its questions (the api).
// The same weekly_reviews row and the same thread message are updated; pending
// proposals are cancelled (superseded), applied ones stay and are facts for the new text.
//
// Every run — first generation and reruns — executes in the weekly Lambda (5 min).
// The api and the worker only ask for a rerun (`requestWeeklyRerun`: an async invoke
// of that Lambda); the worker's 90 s are for Strava and the verdict, not for a review
// plus briefs on top.
//
// One run per (plan, week) at a time: the whole thing — reads, the model call, the
// write — runs in one transaction holding an advisory lock, so two activities arriving
// together produce two runs in sequence (the second sees the first's result) instead
// of two runs overwriting each other.

const KEY_SESSION = /Long|長跑|MP|坡/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const lambda = new LambdaClient({});

export const WEEKLY_REVIEW_SELECT = `select id, plan_id, to_char(week_start, 'YYYY-MM-DD') as week_start, summary, adjustments, created_at, updated_at, update_reason from weekly_reviews`;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const SESSIONS_SELECT = `select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions
  where plan_id = $1 and superseded = false and scheduled_date between $2 and $3 order by planned_sessions.scheduled_date`;
const ACTIVITY_IDS_SELECT = `select id from activities where user_id = $1 and match_status <> 'ignored' and (start_time at time zone 'Asia/Tokyo')::date between $2 and $3`;

export interface WeeklyRunResult {
  review_id: string;
  adjustments: number;
  asks: number;
  /** Nothing was generated: another run already did this one's work while it waited for the lock (see `RerunGuard`). */
  skipped?: boolean;
}

/**
 * Why the caller wants a rerun, re-checked once the lock is held: the run that held it
 * before may have done the same work already, and a second model call would only
 * cancel the proposals it just made.
 */
export interface RerunGuard {
  /** The activity that arrived: skip when the review (as it is now) already lists it. */
  activityId?: string;
  /** The weekly_rerun job's requested_at: skip when the review was updated at or after it. */
  requestedAt?: string;
}

type Plan = PlanRow & { display_name: string };

/**
 * Generate (no review of that week yet) or regenerate (`existing` + `reason`) the
 * review of the week starting `weekStart` for `plan`. Posts / updates the thread
 * message, then rewrites the next two weeks' briefs. Serialised per (plan, week).
 */
export async function runWeeklyReview(plan: Plan, weekStart: string, existing?: WeeklyReviewRow, reason?: string, guard: RerunGuard = {}): Promise<WeeklyRunResult> {
  const weekEnd = addDays(weekStart, 6);
  const r = await withTransaction(async (q): Promise<Generated | { review_id: string; skipped: true }> => {
    await q("select pg_advisory_xact_lock(hashtext($1))", [`${plan.id}:${weekStart}`]);
    // What is there now that the lock is ours (the caller's `existing` may predate another run).
    const [current] = await q<WeeklyReviewRow>(`${WEEKLY_REVIEW_SELECT} where plan_id = $1 and week_start = $2 order by created_at desc limit 1`, [plan.id, weekStart]);
    const alreadyDone = current && alreadyDoneBy(current, existing, reason, guard);
    if (current && alreadyDone) {
      console.log(`weekly review ${current.id} for plan ${plan.id} week ${weekStart}: ${alreadyDone}; not running again`);
      return { review_id: current.id, skipped: true };
    }
    return generate(q, plan, weekStart, weekEnd, current, current ? reason ?? "重新回顧" : undefined);
  });
  if ("skipped" in r) return { review_id: r.review_id, adjustments: 0, asks: 0, skipped: true };

  // First generation only: an activity that arrived while the model was writing could
  // not trigger a rerun (the row did not exist yet for the worker to find). Bring it in
  // now — unless something about it is still in flight (an open check-in for its day,
  // an open question, a pending answer): that flow reruns the review when it settles.
  // The briefs are written once, by the rerun, when it happens.
  if (r.first) {
    const missed = await query<{ id: string; date: string; sport_type: string | null; label: string | null }>(
      `select a.id, to_char(a.start_time at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as date, a.sport_type, ps.label
         from activities a left join planned_sessions ps on ps.id = a.session_id
        where a.user_id = $1 and a.match_status <> 'ignored'
          and (a.start_time at time zone 'Asia/Tokyo')::date between $2 and $3
          and not (a.id = any($4::uuid[]))
          and not exists (
            select 1 from coach_messages m where m.user_id = a.user_id and (
                 (m.kind = 'checkin' and m.meta->>'state' = 'open' and m.meta->>'date' = to_char(a.start_time at time zone 'Asia/Tokyo', 'YYYY-MM-DD'))
              or (m.kind = 'ask' and m.meta->>'state' = 'open' and m.activity_id = a.id)
              or (m.role = 'athlete' and m.status = 'pending' and m.activity_id = a.id)))
        order by a.start_time`,
      [plan.user_id, weekStart, weekEnd, r.activities],
    );
    if (missed.length) {
      const m = missed[0];
      const why = `${shortDate(m.date)} 的 ${m.label ?? sportName(m.sport_type)} 進來了`;
      console.log(`weekly review ${r.review_id}: ${missed.length} activity(ies) arrived during generation, regenerating (${why})`);
      const row = await queryOne<WeeklyReviewRow>(`${WEEKLY_REVIEW_SELECT} where id = $1`, [r.review_id]);
      const rerun = await runWeeklyReview(plan, weekStart, row, why, { activityId: m.id });
      // The rerun found nothing to do (a requested rerun brought the activity in first and
      // wrote the briefs): this run still generated the review, so report that, not "skipped".
      if (!rerun.skipped) return rerun;
      return { review_id: r.review_id, adjustments: r.adjustments, asks: r.asks };
    }
  }
  await rewriteBriefs(plan, weekEnd);
  return { review_id: r.review_id, adjustments: r.adjustments, asks: r.asks };
}

/**
 * Ask the weekly Lambda to regenerate `weekly_review_id` (async invoke; this returns
 * as soon as the request is accepted). The api (沒跑, 都不是) and the worker (an
 * activity arrived) use it. Never throws: the caller has already written what the
 * athlete did (skipped_at, the dismissal), and that must not turn into a 500 that a
 * second press cannot repeat. False (and a log line) when the invoke fails or no
 * weekly Lambda is configured; the review is then regenerated by the next trigger.
 */
export async function requestWeeklyRerun(req: Omit<WeeklyRerunRequest, "requested_at">): Promise<boolean> {
  const fn = process.env.WEEKLY_FUNCTION_NAME;
  if (!fn) {
    console.warn(`WEEKLY_FUNCTION_NAME not set: weekly review ${req.weekly_review_id} not regenerated (${req.reason})`);
    return false;
  }
  const rerun: WeeklyRerunRequest = { ...req, requested_at: new Date().toISOString() };
  try {
    await lambda.send(new InvokeCommand({ FunctionName: fn, InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ rerun })) }));
    return true;
  } catch (err) {
    console.error(`weekly rerun invoke failed for review ${req.weekly_review_id} (${req.reason}); not regenerated`, err);
    return false;
  }
}

/**
 * The weekly Lambda, invoked with `{ rerun }`: regenerate that review in place. Throws
 * on failure so Lambda's async retry (twice) has another go; a retry after the rerun
 * already happened is skipped (`requested_at` / `activity_id`, checked under the lock).
 */
export async function rerunWeekly(req: WeeklyRerunRequest): Promise<WeeklyRunResult | undefined> {
  if (!UUID_RE.test(req.user_id) || !UUID_RE.test(req.weekly_review_id) || (req.activity_id !== undefined && !UUID_RE.test(req.activity_id)) || typeof req.reason !== "string" || Number.isNaN(Date.parse(req.requested_at))) {
    console.error("weekly rerun ignored: malformed request", JSON.stringify(req));
    return undefined;
  }
  const w = await queryOne<WeeklyReviewRow>(
    `${WEEKLY_REVIEW_SELECT} where id = $1 and plan_id in (select id from plans where user_id = $2)`,
    [req.weekly_review_id, req.user_id],
  );
  if (!w) return undefined;
  if (w.updated_at && new Date(w.updated_at).getTime() >= Date.parse(req.requested_at)) return { review_id: w.id, adjustments: 0, asks: 0, skipped: true }; // already done (checked again under the lock)
  const plan = await queryOne<Plan>(
    `select p.*, to_char(p.race_date, 'YYYY-MM-DD') as race_date, u.display_name from plans p join users u on u.id = p.user_id where p.id = $1`,
    [w.plan_id],
  );
  if (!plan) return undefined;
  const r = await runWeeklyReview(plan, w.week_start, w, req.reason, { requestedAt: req.requested_at, activityId: req.activity_id });
  if (!r.skipped) console.log(`weekly review ${r.review_id} regenerated (${req.reason}): ${r.adjustments} adjustments, ${r.asks} asks`);
  return r;
}

/**
 * With the lock held: is there nothing left for this run to do? A reason string
 * (for the log) when the review `current` already covers what the caller asked for.
 */
function alreadyDoneBy(current: WeeklyReviewRow, existing: WeeklyReviewRow | undefined, reason: string | undefined, guard: RerunGuard): string | null {
  if (!existing && !reason) return "written meanwhile";
  const stored = (current.adjustments ?? null) as StoredAdjustments | null;
  if (guard.activityId && stored?.activities?.includes(guard.activityId)) return `already saw activity ${guard.activityId}`;
  if (guard.requestedAt && current.updated_at && new Date(current.updated_at).getTime() >= Date.parse(guard.requestedAt)) return `updated after the rerun was requested (${guard.requestedAt})`;
  return null;
}

type Generated = WeeklyRunResult & { first: boolean; activities: string[] };

/** Store a validated card as a pending proposal of the weekly message. */
async function insertCard(q: Querier, userId: string, messageId: string, d: CardDraft): Promise<void> {
  await q(
    `insert into proposals (id, user_id, source, message_id, items, weeks, why, basis, basis_text, impact, flags, group_id, option, status)
     values ($1, $2, 'weekly', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')`,
    [d.id, userId, messageId, JSON.stringify(d.items), JSON.stringify(d.weeks), d.why, JSON.stringify(d.basis), d.basis_text, JSON.stringify(d.impact), JSON.stringify(d.flags), d.group_id, d.option ? JSON.stringify(d.option) : null],
  );
}

/** The read-model-write of one run, on the locked transaction `q`. */
async function generate(
  q: Querier,
  plan: Plan,
  weekStart: string,
  weekEnd: string,
  existing: WeeklyReviewRow | undefined,
  reason: string | undefined,
): Promise<Generated> {
  const sessions = await q<PlannedSessionRow>(SESSIONS_SELECT, [plan.id, weekStart, weekEnd]);
  const activities = await historyBetween(plan.user_id, weekStart, weekEnd);
  const activityIds = (await q<{ id: string }>(ACTIVITY_IDS_SELECT, [plan.user_id, weekStart, weekEnd])).map((r) => r.id);
  const hints = (await q<{ adjust_hint: string }>(
    `select r.adjust_hint from reviews r join activities a on a.id = r.activity_id
      where a.user_id = $1 and r.adjust_hint is not null
        and (a.start_time at time zone 'Asia/Tokyo')::date between $2 and $3
      order by a.start_time`,
    [plan.user_id, weekStart, weekEnd],
  )).map((r) => r.adjust_hint);
  const [previous] = await q<{ summary: string | null }>(
    "select summary from weekly_reviews where plan_id = $1 and week_start < $2 order by week_start desc limit 1",
    [plan.id, weekStart],
  );

  // The whole plan to the race, every activity so far, the constraints: what the chat gets too.
  const today = todayJst();
  const scope = await loadPlanBriefing(plan, today);
  const briefing = buildPlanBriefing(scope, today);
  const weeks = scope.weeks;

  // Key sessions (Long / MP / 坡跑) with no record: ask, don't conclude.
  const done = new Set(scope.sessions.filter((s) => s.done).map((s) => s.id));
  const message = existing ? (await q<CoachMessageRow>("select * from coach_messages where weekly_review_id = $1 order by created_at limit 1", [existing.id]))[0] : undefined;
  const askStateOf = (m: CoachMessageRow | undefined) => new Map(((m?.meta ?? {}) as Partial<WeeklyMessageMeta>).asks?.map((a) => [a.session_id, a.state]) ?? []);
  const oldAskState = askStateOf(message);
  const skipped = sessions.filter((s) => s.skipped_at);
  const asks = sessions
    .filter((s) => s.type !== "rest" && KEY_SESSION.test(s.label ?? "") && !done.has(s.id) && !s.skipped_at)
    .map((s) => ({ session: s, state: oldAskState.get(s.id) === "synced" ? "synced" as const : "open" as const }));

  // Facts for the new text: what the athlete already applied from the earlier version (old-style proposals and cards).
  const stored = (existing?.adjustments ?? null) as StoredAdjustments | null;
  const appliedCards = message
    ? await q<ProposalRow>("select * from proposals where message_id = $1 and user_id = $2 and status = 'applied' order by created_at", [message.id, plan.user_id])
    : [];
  const applied = [
    ...(stored?.items ?? []).filter((a) => a.status === "applied").map(adjustmentLine),
    ...appliedCards.map(describeCard),
  ];

  const review = await weeklyReview({
    plan, weeks, weekStart, weekEnd, briefing, sessions, activities, hints,
    previousSummary: previous?.summary ?? null,
    asks, skipped, applied, updateReason: reason ?? null,
  });

  // The same checks as a chat card (range, race day, fixed days, basis / impact present, ...):
  // a card that fails is not stored, the summary still is.
  let drafts: CardDraft[] = [];
  let rejected = false;
  if (review.proposals.length) {
    const checked = validateCards(scope, review.proposals, today);
    if (typeof checked === "string") {
      console.warn(`weekly review for plan ${plan.id} week ${weekStart}: proposals dropped (${checked})`);
      rejected = true;
    } else drafts = checked;
  }
  const metaAsks = (state: Map<string, string>) =>
    asks.map(({ session: s, state: st }) => ({ session_id: s.id, label: sessionLabel(s), date: s.scheduled_date, state: state.get(s.id) === "synced" ? "synced" as const : st }));

  if (!existing) {
    const id = randomUUID();
    const toStore: StoredAdjustments = { model: review.model, hints, items: [], activities: activityIds };
    const meta: WeeklyMessageMeta = {
      week_start: weekStart, proposals: drafts.length, asks: metaAsks(oldAskState),
      ...(drafts.length ? { proposal_ids: drafts.map((d) => d.id) } : {}),
      ...(rejected ? { proposal_rejected: true } : {}),
    };
    await q(
      `insert into weekly_reviews (id, plan_id, week_start, summary, adjustments) values ($1, $2, $3, $4, $5)`,
      [id, plan.id, weekStart, review.summary, JSON.stringify(toStore)],
    );
    const posted = await postCoachMessage({
      user_id: plan.user_id, role: "coach", kind: "weekly", text: review.summary, weekly_review_id: id,
      meta: meta as unknown as Record<string, unknown>,
    }, q);
    for (const d of drafts) await insertCard(q, plan.user_id, posted.id, d);
    return { review_id: id, adjustments: drafts.length, asks: asks.length, first: true, activities: activityIds };
  }

  // Regeneration. The athlete may have applied / dismissed a proposal or answered a
  // question while the model was writing: decide kept / cancelled from the row and the
  // message as they are now, not as they were read before the call.
  const [latest] = await q<WeeklyReviewRow>(`${WEEKLY_REVIEW_SELECT} where id = $1 for update`, [existing.id]);
  const latestStored = ((latest ?? existing).adjustments ?? null) as StoredAdjustments | null;
  const latestMessage = message ? (await q<CoachMessageRow>("select * from coach_messages where id = $1", [message.id]))[0] ?? message : undefined;
  const latestMeta = (latestMessage?.meta ?? {}) as Partial<WeeklyMessageMeta>;
  const now = new Date().toISOString();
  const cancelled: string[] = [];
  const kept: StoredAdjustment[] = [];
  for (const item of latestStored?.items ?? []) {
    if (item.status === "pending") {
      const [s] = await q<PlannedSessionRow>("select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions where id = $1", [item.session_id]);
      cancelled.push(describeChange(item, s?.scheduled_date ?? null));
      kept.push({ ...item, status: "superseded", decided_at: now });
    } else {
      kept.push(item);
    }
  }
  // The cards of the earlier version: pending ones are cancelled (an apply that got there first wins: its row is no longer pending), applied ones stay.
  let keptCardIds: string[] = [];
  if (latestMessage) {
    const gone = await q<ProposalRow>(
      "update proposals set status = 'superseded', decided_at = now() where message_id = $1 and user_id = $2 and status = 'pending' returning *",
      [latestMessage.id, plan.user_id],
    );
    for (const c of gone) cancelled.push(describeCard(c));
    keptCardIds = (await q<{ id: string }>("select id from proposals where message_id = $1 and user_id = $2 and status = 'applied' order by created_at", [latestMessage.id, plan.user_id])).map((r) => r.id);
  }
  const toStore: StoredAdjustments = { model: review.model, hints, items: kept, activities: activityIds };
  await q(
    `update weekly_reviews set summary = $2, adjustments = $3, updated_at = now(), update_reason = $4 where id = $1`,
    [existing.id, review.summary, JSON.stringify(toStore), reason ?? null],
  );
  const { proposal_ids: _oldIds, proposal_rejected: _oldRejected, ...carried } = latestMeta;
  const newMeta: WeeklyMessageMeta = {
    ...carried,
    week_start: weekStart,
    proposals: drafts.length,
    ...(keptCardIds.length || drafts.length ? { proposal_ids: [...keptCardIds, ...drafts.map((d) => d.id)] } : {}),
    ...(rejected ? { proposal_rejected: true } : {}),
    asks: metaAsks(askStateOf(latestMessage)),
    updated: { at: now, reason: reason ?? "" },
    cancelled: [...(latestMeta.cancelled ?? []), ...cancelled],
  };
  let messageId: string;
  if (latestMessage) {
    await q("update coach_messages set text = $2, meta = $3 where id = $1", [latestMessage.id, review.summary, JSON.stringify(newMeta)]);
    messageId = latestMessage.id;
  } else {
    messageId = (await postCoachMessage({ user_id: plan.user_id, role: "coach", kind: "weekly", text: review.summary, weekly_review_id: existing.id, meta: newMeta as unknown as Record<string, unknown> }, q)).id;
  }
  for (const d of drafts) await insertCard(q, plan.user_id, messageId, d);
  return { review_id: existing.id, adjustments: drafts.length, asks: asks.length, first: false, activities: activityIds };
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
export async function weeklyReviewFor(userId: string, date: string): Promise<(WeeklyReviewRow & { plan: Plan }) | undefined> {
  const plan = await queryOne<Plan>(
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
 * The review of the week of `localDate` if it exists and was written without
 * `activityId`; undefined when there is no review yet or it already saw the activity.
 * The review records the activity ids it saw, so a redelivery finds nothing to do.
 */
export async function reviewMissingActivity(userId: string, activityId: string, localDate: string): Promise<(WeeklyReviewRow & { plan: Plan }) | undefined> {
  const w = await weeklyReviewFor(userId, localDate);
  if (!w) return undefined;
  const stored = (w.adjustments ?? null) as StoredAdjustments | null;
  if (stored?.activities) return stored.activities.includes(activityId) ? undefined : w;
  // A review from before this feature: only an activity that happened after it counts.
  const a = await queryOne<{ start_time: Date }>("select start_time from activities where id = $1", [activityId]);
  if (!a || new Date(a.start_time).getTime() <= new Date(w.updated_at ?? w.created_at).getTime()) return undefined;
  return w;
}

/**
 * Worker: an activity of `localDate` was inserted or got its verdict. If that week's
 * review exists and did not see this activity, ask the weekly Lambda to regenerate it.
 */
export async function maybeRerunWeeklyReview(userId: string, activityId: string, localDate: string, reason: string): Promise<boolean> {
  const w = await reviewMissingActivity(userId, activityId, localDate);
  if (!w) return false;
  const sent = await requestWeeklyRerun({ user_id: userId, weekly_review_id: w.id, reason, activity_id: activityId }); // logs its own failure; the next activity / ask tries again
  if (sent) console.log(`weekly review ${w.id}: regeneration requested (${reason})`);
  return sent;
}
