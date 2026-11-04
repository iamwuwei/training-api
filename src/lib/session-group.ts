import { randomUUID } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { query, queryOne } from "./db";
import { recordSessionDone } from "./group-events";
import { isRunSport } from "./labels";
import { mergeSplits } from "./splits";
import type { StravaSplit } from "../types";

// A session (one planned_sessions row) can carry several activities: the watch was stopped by
// mistake and a second recording was started. The "group" of a session is the activities that
// point at it (activities.session_id), ignored ones left out, ordered by (start_time, id). The
// first one is the PRIMARY activity: Woo's review, the memo / RPE and the report page's address
// are all on it. Nothing is stored for this; it is derived from start_time, so there is no second
// source of truth to drift.
//
// combineGroup / mergeSplits / overlaps / sameKind are the same algorithm as
// training-web/app/lib/combine.ts and segments.ts (copied; keep the two in sync).

/** One session holds at most this many activities (more is almost always a mis-tap, and it bounds the review prompt). */
export const MAX_PER_SESSION = 5;

/**
 * Strava's `elapsed_time` (wall clock, pauses included) out of the stored raw JSON; null when raw has none (or not a
 * number). `alias` is the activities alias in the query. Not a column: `raw` already holds the whole Strava object.
 */
export const elapsedSql = (alias: string) =>
  `(case when ${alias}.raw->>'elapsed_time' ~ '^[0-9]{1,9}(\\.[0-9]+)?$' then round((${alias}.raw->>'elapsed_time')::numeric)::int end)`;

/** The members of a.session_id's group, in the same order loadGroup uses. `a` must be an activities alias. */
const groupOf = (extra = "") =>
  `from activities g where g.session_id = a.session_id and g.user_id = a.user_id and g.match_status <> 'ignored'${extra}`;

/**
 * Three columns for the activity SELECTs (ACTIVITY_SELECT): this activity's place in its session's group. NULL
 * (all three) for an activity with no session or an ignored one. `a` = activities. Position by (start_time, id),
 * the order loadGroup uses.
 */
export const SEGMENT_SELECT = `
  (case when a.session_id is not null and a.match_status <> 'ignored' then (select count(*)::int ${groupOf()}) end) as seg_count,
  (case when a.session_id is not null and a.match_status <> 'ignored' then (select count(*)::int ${groupOf(" and (g.start_time, g.id) <= (a.start_time, a.id)")}) end) as seg_index,
  (case when a.session_id is not null and a.match_status <> 'ignored' then (select g.id ${groupOf()} order by g.start_time, g.id limit 1) end) as seg_primary`;

/**
 * `left join` that gives every activity the start of its group (g.t0): a group is dated by its first activity, so a
 * second segment that starts after midnight stays on the primary's day and week. Use `coalesce(g.t0, a.start_time)`
 * for "the activity's date". `$1` must be the user id.
 */
export const GROUP_DATE_JOIN = `
    left join (select session_id, min(start_time) t0 from activities where user_id = $1 and session_id is not null and match_status <> 'ignored' group by session_id) g
           on g.session_id = a.session_id`;

/** The part of an activity row a group needs. */
export interface GroupActivity {
  id: string;
  strava_activity_id: string;
  session_id: string | null;
  sport_type: string | null;
  start_time: Date;
  distance_m: number;
  moving_time_sec: number;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_watts: number | null;
  kcal: number | null;
  description: string | null;
  memo: string | null;
  rpe: number | null;
  splits: StravaSplit[] | null;
  match_status: string;
  /** Strava's elapsed_time, or moving_time_sec when the raw JSON has none. */
  elapsed_sec: number;
  /** JST date of start_time, 'YYYY-MM-DD'. */
  date: string;
}

/** The columns loadGroup fills a GroupActivity from (`a` = activities). */
export const GROUP_ACTIVITY_SELECT = `
  a.id, a.strava_activity_id, a.session_id, a.sport_type, a.start_time, a.distance_m, a.moving_time_sec, a.avg_pace_sec_km,
  a.avg_hr, a.max_hr, a.avg_watts, a.kcal, a.description, a.memo, a.rpe, a.splits, a.match_status,
  coalesce(${elapsedSql("a")}, a.moving_time_sec) as elapsed_sec,
  to_char(a.start_time at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as date`;

/** The group of `sessionId`: not ignored, by (start_time, id). Empty = the session has no activity. */
export async function loadGroup(userId: string, sessionId: string): Promise<GroupActivity[]> {
  return query<GroupActivity>(
    `select ${GROUP_ACTIVITY_SELECT} from activities a
      where a.session_id = $1 and a.user_id = $2 and a.match_status <> 'ignored'
      order by a.start_time, a.id`,
    [sessionId, userId],
  );
}

// ---- the pure part --------------------------------------------------------------------

/** One recording of a multi-recording session, as the review prompt and the briefing print it. */
export interface SegmentInfo {
  start_hm: string;                 // 'HH:MM' (JST)
  distance_m: number;
  moving_time_sec: number;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  /** Minutes between the end of the previous recording (its start + elapsed) and this start; null for the first. */
  gap_min: number | null;
  memo: string | null;
}

/** The whole session as one activity. A group of one is that activity, field for field. */
export interface Combined {
  /** The primary activity. */
  id: string;
  sport_type: string | null;
  start_time: Date;
  /** JST date of the primary. */
  date: string;
  distance_m: number;
  moving_time_sec: number;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_watts: number | null;
  kcal: number | null;
  /** One recording: its own splits as stored. Several: each recording's whole kilometres joined and renumbered 1..n (an approximation); null when none has any. */
  splits: StravaSplit[] | null;
  /** Several recordings: the number of the first split of every recording after the first (where a divider goes). */
  boundaries: number[];
  /** The primary's. */
  description: string | null;
  memo: string | null;
  /** The primary's, else the earliest recording's that has one. */
  rpe: number | null;
  segments: SegmentInfo[];
}

type Totals = Pick<GroupActivity, "sport_type" | "distance_m" | "moving_time_sec" | "avg_pace_sec_km" | "avg_hr" | "max_hr" | "avg_watts" | "kcal">;

/** distance, time, pace, time-weighted HR / watts, max HR, kcal of a group (one: that activity's own numbers). */
export function sumGroup(group: Totals[]): Pick<Combined, "sport_type" | "distance_m" | "moving_time_sec" | "avg_pace_sec_km" | "avg_hr" | "max_hr" | "avg_watts" | "kcal"> {
  const first = group[0];
  if (group.length === 1) {
    return { sport_type: first.sport_type, distance_m: first.distance_m, moving_time_sec: first.moving_time_sec, avg_pace_sec_km: first.avg_pace_sec_km, avg_hr: first.avg_hr, max_hr: first.max_hr, avg_watts: first.avg_watts, kcal: first.kcal };
  }
  const distance_m = group.reduce((t, g) => t + g.distance_m, 0);
  const moving_time_sec = group.reduce((t, g) => t + g.moving_time_sec, 0);
  /** Average of `pick` over the recordings that have it, weighted by moving time; null when none does. */
  const weighted = (pick: (g: Totals) => number | null): number | null => {
    const have = group.filter((g) => pick(g) != null);
    const t = have.reduce((s, g) => s + g.moving_time_sec, 0);
    return t > 0 ? Math.round(have.reduce((s, g) => s + pick(g)! * g.moving_time_sec, 0) / t) : null;
  };
  const maxes = group.map((g) => g.max_hr).filter((v): v is number => v != null);
  const kcals = group.map((g) => g.kcal).filter((v): v is number => v != null);
  return {
    sport_type: first.sport_type,
    distance_m,
    moving_time_sec,
    avg_pace_sec_km: isRunSport(first.sport_type) && distance_m > 0 ? Math.round(moving_time_sec / (distance_m / 1000)) : null,
    avg_hr: weighted((g) => g.avg_hr),
    max_hr: maxes.length ? Math.max(...maxes) : null,
    avg_watts: weighted((g) => g.avg_watts),
    kcal: kcals.length ? kcals.reduce((t, v) => t + v, 0) : null,
  };
}

const hmJst = (d: Date) => new Date(new Date(d).getTime() + 9 * 3600 * 1000).toISOString().slice(11, 16);

/** `group` is non-empty and in (start_time, id) order, as loadGroup returns it. */
export function combineGroup(group: GroupActivity[]): Combined {
  const first = group[0];
  const merged = group.length > 1 ? mergeSplits(group.map((g) => g.splits)) : null;
  const segments = group.map((g, i): SegmentInfo => {
    const prev = group[i - 1];
    return {
      start_hm: hmJst(g.start_time),
      distance_m: g.distance_m,
      moving_time_sec: g.moving_time_sec,
      avg_pace_sec_km: g.avg_pace_sec_km,
      avg_hr: g.avg_hr,
      gap_min: prev ? Math.max(0, Math.round((new Date(g.start_time).getTime() - (new Date(prev.start_time).getTime() + prev.elapsed_sec * 1000)) / 60_000)) : null,
      memo: g.memo,
    };
  });
  return {
    id: first.id,
    ...sumGroup(group),
    start_time: first.start_time,
    date: first.date,
    splits: merged ? (merged.splits.length ? merged.splits : null) : first.splits,
    boundaries: merged ? merged.boundaries : [],
    description: first.description,
    memo: first.memo,
    rpe: first.rpe ?? group.find((g) => g.rpe != null)?.rpe ?? null,
    segments,
  };
}

/** Two recordings that cover a common stretch of time (a watch and a phone both recording): one run recorded twice, not two segments. */
export function overlaps(a: Pick<GroupActivity, "start_time" | "elapsed_sec">, b: Pick<GroupActivity, "start_time" | "elapsed_sec">): boolean {
  const as = new Date(a.start_time).getTime(), bs = new Date(b.start_time).getTime();
  return bs < as + a.elapsed_sec * 1000 && as < bs + b.elapsed_sec * 1000;
}

/** Both runs or both not runs (a null sport counts as a run). */
export const sameKind = (a: Pick<GroupActivity, "sport_type">, b: Pick<GroupActivity, "sport_type">): boolean =>
  isRunSport(a.sport_type) === isRunSport(b.sport_type);

// ---- re-judging -----------------------------------------------------------------------

const sqs = new SQSClient({});

export const REVIEW_DAILY_LIMIT_DEFAULT = 20;
/** Unset = the default; exactly "0" = no cap; a positive whole number = that cap. Anything else ("", "abc", "-3", "Infinity", "007") falls back to the default (and says so once): a bad value must not turn the cap off. */
export function parseReviewLimit(raw: string | undefined): number {
  if (raw === undefined) return REVIEW_DAILY_LIMIT_DEFAULT;
  if (raw === "0") return 0;
  if (/^[1-9][0-9]{0,5}$/.test(raw)) return Number(raw);
  console.warn(`REVIEW_DAILY_LIMIT=${JSON.stringify(raw).slice(0, 40)} is not "0" or a positive whole number, using ${REVIEW_DAILY_LIMIT_DEFAULT}`);
  return REVIEW_DAILY_LIMIT_DEFAULT;
}
const limitFromEnv = (): number => parseReviewLimit(process.env.REVIEW_DAILY_LIMIT);
/**
 * The day's cap on finished verdicts per user (JST day), counted by `reviewsToday` (the review messages in the thread). It is
 * asked twice: at the door, in `requeueReview` — every re-judge the app queues ("重新分析", removing / adding / replacing a
 * segment, 選錯了, 是這趟, the memo / RPE, the feel answer, a correction in the thread), where a refusal leaves a failed row
 * and one line in the thread (and a 429 for "重新分析") instead of a job — and again in the worker, right before the model is
 * called (`processEvent`), for every job that got that far, a Strava event's first review included (the first review is
 * queued through `requeueReview` too; nothing is exempt). 0 = no cap; unset = 20; an unreadable value is 20, never "no cap".
 * Worker concurrency is 2, so a day ends with at most REVIEW_DAILY_LIMIT + 1 finished verdicts. Failed verdicts are not counted.
 */
export const REVIEW_DAILY_LIMIT = limitFromEnv();
/** `reviews.comment` of the failed row written when the cap refused a re-judge; the api turns it into REVIEW_LIMIT_TEXT. */
export const REVIEW_LIMIT_MARKER = "分析失敗：limit";
/** ApiReview.error of that failed row. */
export const REVIEW_LIMIT_TEXT = `今天重新分析的次數用完了（每天 ${REVIEW_DAILY_LIMIT} 次）。數據和心得都存好了，明天按「重新分析」就會重判。`;
/** Woo's one line in the thread (once a day) when the cap refused a re-judge. */
export const REVIEW_LIMIT_THREAD = `今天重新分析的次數用完了（每天 ${REVIEW_DAILY_LIMIT} 次），這些我明天再看；數據和心得都存好了。`;

/** Verdicts finished today (JST): the review messages in the user's thread, one per finished verdict, the first review of an event included. A failed verdict posts none. */
export async function reviewsToday(userId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `select count(*)::int as n from coach_messages
      where user_id = $1 and role = 'coach' and kind = 'review'
        and (created_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date`,
    [userId],
  );
  return row?.n ?? 0;
}

export async function reviewLimitReached(userId: string): Promise<boolean> {
  return REVIEW_DAILY_LIMIT > 0 && (await reviewsToday(userId)) >= REVIEW_DAILY_LIMIT;
}

/**
 * Only the athlete's answers that are waiting for THIS verdict (the feel answer: a chat with `meta.answer_to`, the same set the
 * stage writer follows) are settled. Other pending messages that merely mention the activity (a question quoting it, a correction
 * Woo has not answered yet) are waiting for Woo's reply, not for a verdict: closing them would leave them without any reply.
 */
export async function settleAnswerMessages(userId: string, activityId: string): Promise<void> {
  await query(
    "update coach_messages set status = 'sent' where user_id = $1 and role = 'athlete' and kind = 'chat' and status = 'pending' and activity_id = $2 and meta ? 'answer_to'",
    [userId, activityId],
  );
}

/**
 * The cap refused a re-judge (at the door in requeueReview, or in the worker just before the model call): the data action that asked for it has already happened (the memo is saved, the segment is
 * bound), so say so instead of failing quietly. (1) a failed review row on the primary with the cap's marker (a manual
 * review stays); (2) one fixed line from Woo in the thread, once a day; (3) the athlete's pending answer to Woo's feel question
 * about any of the group's activities is settled, so the app stops waiting for a verdict that is not coming (not the other
 * pending messages: they wait for Woo's reply).
 */
export async function writeLimitedReview(userId: string, group: GroupActivity[]): Promise<void> {
  const primary = group[0];
  if (!primary) return;
  // A manual review stays; an earlier failed Claude row (the worker found the cap reached for a job queued before it was) is replaced by the cap's own.
  await query(
    `insert into reviews (id, activity_id, verdict, comment, reminders, source, model)
     values ($1, $2, null, $3, '[]', 'claude', null)
     on conflict (activity_id) do update set comment = excluded.comment, created_at = now()
       where reviews.source = 'claude' and reviews.verdict is null`,
    [randomUUID(), primary.id, REVIEW_LIMIT_MARKER],
  );
  const said = await queryOne<{ x: number }>(
    `select 1 as x from coach_messages
      where user_id = $1 and role = 'coach' and kind = 'chat' and text = $2
        and (created_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date limit 1`,
    [userId, REVIEW_LIMIT_THREAD],
  );
  if (!said) {
    const { postCoachMessage } = await import("./coach"); // coach.ts imports this file: loaded when needed, not at the top
    await postCoachMessage({ user_id: userId, role: "coach", kind: "chat", text: REVIEW_LIMIT_THREAD, activity_id: primary.id });
  }
  for (const g of group) await settleAnswerMessages(userId, g.id);
}

/**
 * A re-judge that was promised but could not be queued (the queue refused it): the session's Claude review is already gone,
 * so leave a failed row on the primary, or the report page waits for a verdict that is not coming, and say so once in the
 * thread (the same line a failed model call gets). Nothing when the primary has a review row (a manual one, or the cap's
 * own failed row, which has said its line). Never throws.
 */
export async function writeNotQueuedReview(userId: string, sessionId: string): Promise<void> {
  try {
    const primary = (await loadGroup(userId, sessionId))[0];
    if (!primary) return;
    const rows = await query<{ id: string }>(
      `insert into reviews (id, activity_id, verdict, comment, reminders, source, model)
       values ($1, $2, null, '分析失敗：not queued', '[]', 'claude', null)
       on conflict (activity_id) do nothing returning id`,
      [randomUUID(), primary.id],
    );
    if (!rows.length) return;
    const { postCoachMessage } = await import("./coach");
    await postCoachMessage({ user_id: userId, role: "coach", kind: "chat", text: "這次分析沒成功，報告頁可以按「重新分析」。", activity_id: primary.id });
  } catch (err) {
    console.error(`failed review row for session ${sessionId} not written`, err);
  }
}

/**
 * group-race 消息中心, for the binding paths that reach no re-judge at once: a check-in chip pick (the verdict waits for the
 * athlete's answer to Woo's feel question) and 是，就是這趟 after a chip. The fact "he finished this session" is the binding, not the
 * verdict, so it is recorded here, at the binding. Same single exit as requeueReview's (recordSessionDone: once per group and
 * session, never throws). The activity's session may be none (nothing happens).
 */
export async function recordBinding(userId: string, activityId: string): Promise<void> {
  try {
    const act = await queryOne<{ session_id: string | null }>("select session_id from activities where id = $1 and user_id = $2", [activityId, userId]);
    if (!act?.session_id) return;
    const primary = (await loadGroup(userId, act.session_id))[0];
    if (primary) await recordSessionDone(userId, act.session_id, primary.id);
  } catch (err) {
    console.error(`group event for activity ${activityId} not written`, err instanceof Error ? err.message : err);
  }
}

/**
 * Have the worker write a new Claude review for the session `activityId` belongs to: the same fake Strava "update"
 * event the api always sent, for the group's PRIMARY activity (the worker reviews the whole session when it gets
 * the primary's event, and ignores any other segment's). Returns whether one was queued. Nothing is sent (false) when
 * the activity has no session / group or there is no queue (local scripts), and when the day's cap (REVIEW_DAILY_LIMIT)
 * is reached: then writeLimitedReview says so instead.
 */
export async function requeueReview(userId: string, activityId: string, reason: string): Promise<boolean> {
  if (!process.env.QUEUE_URL) return false;
  const act = await queryOne<{ session_id: string | null }>("select session_id from activities where id = $1 and user_id = $2", [activityId, userId]);
  if (!act?.session_id) return false;
  const group = await loadGroup(userId, act.session_id);
  const primary = group[0];
  if (!primary) return false;
  // group-race 消息中心: every in-app binding of an activity to a session gets here, so this is where "he finished the session"
  // is recorded — once per group and session (a re-judge, a second segment write nothing more). Before the day's cap:
  // the cap limits verdicts, not the fact. One SQL, never throws, no retry, no queue message.
  await recordSessionDone(userId, act.session_id, primary.id);
  const conn = await queryOne<{ strava_athlete_id: string }>("select strava_athlete_id from strava_connections where user_id = $1", [userId]);
  if (!conn) return false;
  if (await reviewLimitReached(userId)) {
    await writeLimitedReview(userId, group);
    return false;
  }
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MessageBody: JSON.stringify({
        object_type: "activity",
        aspect_type: "update",
        object_id: Number(primary.strava_activity_id),
        owner_id: Number(conn.strava_athlete_id),
        updates: { reason },
      }),
    }),
  );
  return true;
}

/**
 * The make-up of the session changed (a segment added, removed, replaced, a memo edited): drop the group's Claude
 * reviews and, when the primary has no review left (a manual one stays), queue one new review of the whole session.
 * One model call per user action, however many segments there are. An empty group: nothing to do. Returns whether a
 * review was queued (false: nothing to do, a manual review stays, no queue, or the day's cap).
 */
export async function regroupReview(userId: string, sessionId: string, reason: string): Promise<boolean> {
  const group = await loadGroup(userId, sessionId);
  if (!group.length) return false;
  const primary = group[0];
  const dropped = await query<{ id: string }>(
    "delete from reviews where activity_id = any($1::uuid[]) and source = 'claude' returning id",
    [group.map((g) => g.id)],
  );
  const hasManual = await queryOne<{ id: string }>("select id from reviews where activity_id = $1", [primary.id]);
  if (dropped.length > 0 || !hasManual) return requeueReview(userId, primary.id, reason);
  return false;
}
