import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { query, queryOne } from "./db";
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

/**
 * Have the worker write a new Claude review for the session `activityId` belongs to: the same fake Strava "update"
 * event the api always sent, for the group's PRIMARY activity (the worker reviews the whole session when it gets
 * the primary's event, and ignores any other segment's). Nothing is sent when the activity has no session / group
 * or there is no queue (local scripts).
 */
export async function requeueReview(userId: string, activityId: string, reason: string): Promise<void> {
  if (!process.env.QUEUE_URL) return;
  const act = await queryOne<{ session_id: string | null }>("select session_id from activities where id = $1 and user_id = $2", [activityId, userId]);
  if (!act?.session_id) return;
  const primary = (await loadGroup(userId, act.session_id))[0];
  if (!primary) return;
  const conn = await queryOne<{ strava_athlete_id: string }>("select strava_athlete_id from strava_connections where user_id = $1", [userId]);
  if (!conn) return;
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
}

/**
 * The make-up of the session changed (a segment added, removed, replaced, a memo edited): drop the group's Claude
 * reviews and, when the primary has no review left (a manual one stays), queue one new review of the whole session.
 * One model call per user action, however many segments there are. An empty group: nothing to do.
 */
export async function regroupReview(userId: string, sessionId: string, reason: string): Promise<void> {
  const group = await loadGroup(userId, sessionId);
  if (!group.length) return;
  const primary = group[0];
  const dropped = await query<{ id: string }>(
    "delete from reviews where activity_id = any($1::uuid[]) and source = 'claude' returning id",
    [group.map((g) => g.id)],
  );
  const hasManual = await queryOne<{ id: string }>("select id from reviews where activity_id = $1", [primary.id]);
  if (dropped.length > 0 || !hasManual) await requeueReview(userId, primary.id, reason);
}
