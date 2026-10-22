import { randomUUID } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { isDbWaking, query, queryOne } from "../lib/db";
import { type CheckinMeta } from "../lib/checkin";
import { COACH_NAME, MAX_MESSAGE_CHARS, postCoachMessage } from "../lib/coach";
import { deauthorize } from "../lib/strava";
import type { ActivityRow, CoachAskJob, CoachMessageRow, CoachReplyJob, PlanRow, PlanWeekRow, PlannedSessionRow, ReviewRow, StoredAdjustments, StravaConnectionRow, UserRow, WeeklyReviewRow } from "../types";
import type {
  ActivitiesResponse,
  ApiActivity,
  DeleteStravaResponse,
  ApiReview,
  ErrorResponse,
  MatchStatus,
  Verdict,
  MeResponse,
  PlanResponse,
  PutReviewRequest,
  PutReviewResponse,
  PutSessionRequest,
  PutSessionResponse,
  PutMemoRequest,
  PutMemoResponse,
  RereviewResponse,
  WeeklyResponse,
  ApiWeeklyReview,
  PostAdjustmentRequest,
  PostAdjustmentResponse,
  ApiCoachMessage,
  CoachResponse,
  PostCoachMessageRequest,
  PostCoachMessageResponse,
  ApiCheckin,
  PostCheckinPickRequest,
  PostCheckinPickResponse,
  PutCoachSeenResponse,
} from "../../types/api";

// Lambda training-api-prod. Behind API Gateway (HTTP API) with a Cognito JWT authorizer: by the time we
// run, the ID token is already verified and its claims are on the event.
// CORS is handled by the HTTP API (infra/lib/stack.ts).
//
//   GET /me                          who am I + Strava link status + the link URL
//   DELETE /me/strava                unlink Strava (revoke + drop strava_connections row)
//   GET /plan                        active plan + weeks + sessions + matched activities (with reviews)
//   GET /activities?status=<status>  all activities (with reviews), newest first
//   PUT /activities/{id}/review      set a manual verdict
//   PUT /activities/{id}/session     the athlete's pick: which planned session this activity was (+ memo/RPE), or ignore it
//   PUT /activities/{id}/memo        athlete's own note + RPE (re-triggers the Claude review)
//   POST /activities/{id}/rereview   drop the Claude review (failed or stale) and queue a new one
//   GET /weekly                      weekly coach reviews with their adjustment proposals
//   POST /weekly/{id}/adjustments/{index}   apply or dismiss one proposal
//   GET /coach                       the coach's thread (weekly reviews, verdicts, chat)
//   POST /coach/messages             say something to the coach; the worker answers
//   PUT /coach/seen                  the thread was opened; clears coach_unread on GET /plan
//   POST /coach/checkins/{id}/pick   which activity was today's session (Woo's check-in chips)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set<string>(["auto", "confirmed", "unplanned", "ignored"] satisfies MatchStatus[]);
const VERDICTS = new Set<string>(["達成", "達成但有提醒", "未達成"]);

const sqs = new SQSClient({});

const json = <T extends MeResponse | DeleteStravaResponse | PlanResponse | ActivitiesResponse | PutReviewResponse | PutSessionResponse | PutMemoResponse | RereviewResponse | WeeklyResponse | PostAdjustmentResponse | CoachResponse | PostCoachMessageResponse | PutCoachSeenResponse | PostCheckinPickResponse | ErrorResponse>(
  statusCode: number,
  body: T,
): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

/**
 * Cognito `sub` -> users.id. Closed system: a row must already carry this sub,
 * or (first login) have the same email as the ID token; otherwise 403.
 */
async function resolveUser(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<UserRow | undefined> {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const sub = typeof claims.sub === "string" ? claims.sub : undefined;
  const email = typeof claims.email === "string" ? claims.email : undefined;
  if (!sub) return undefined;

  let user = await queryOne<UserRow>("select * from users where cognito_sub = $1", [sub]);
  if (!user && email) {
    user = await queryOne<UserRow>("select * from users where cognito_sub is null and lower(email) = lower($1)", [email]);
    if (user) await query("update users set cognito_sub = $2 where id = $1", [user.id, sub]);
  }
  if (!user) console.log(`login rejected: sub=${sub} email=${email ?? "-"}`);
  return user;
}

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  try {
    return await route(event);
  } catch (err) {
    if (isDbWaking(err)) {
      // Aurora is resuming from 0 ACU: tell the client to retry in a few seconds.
      console.warn("database waking up:", err instanceof Error ? err.message : err);
      return {
        statusCode: 503,
        headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "8" },
        body: JSON.stringify({ error: "database starting, retry shortly" } satisfies ErrorResponse),
      };
    }
    // Anything else: answer with the message instead of letting API Gateway turn it
    // into a bare "Internal Server Error", so the app can show what went wrong.
    console.error("api error:", err);
    return json(500, { error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
  }
};

async function route(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const q = event.queryStringParameters ?? {};

  const user = await resolveUser(event);
  if (!user) return json(403, { error: "not registered" });

  if (method === "GET" && path === "/me") return getMe(user, event);
  if (method === "DELETE" && path === "/me/strava") return deleteStrava(user);
  if (method === "GET" && path === "/plan") return getPlan(user.id);
  if (method === "GET" && path === "/activities") return getActivities(user.id, q.status);

  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
  const sub = /^\/activities\/([^/]+)\/(review|session|memo)$/.exec(path);
  if (method === "PUT" && sub) {
    if (sub[2] === "review") return putReview(user.id, sub[1], raw);
    if (sub[2] === "session") return putSession(user.id, sub[1], raw);
    return putMemo(user.id, sub[1], raw);
  }
  const re = /^\/activities\/([^/]+)\/rereview$/.exec(path);
  if (method === "POST" && re) return rereview(user.id, re[1]);

  if (method === "GET" && path === "/weekly") return getWeekly(user.id);
  if (method === "GET" && path === "/coach") return getCoach(user.id);
  if (method === "PUT" && path === "/coach/seen") return putCoachSeen(user.id);
  const pick = /^\/coach\/checkins\/([^/]+)\/pick$/.exec(path);
  if (method === "POST" && pick) return postCheckinPick(user.id, pick[1], raw);
  if (method === "POST" && path === "/coach/messages") return postCoach(user.id, raw);
  const adj = /^\/weekly\/([^/]+)\/adjustments\/(\d+)$/.exec(path);
  if (method === "POST" && adj) return postAdjustment(user.id, adj[1], Number(adj[2]), raw);

  return json(404, { error: "not found" });
}

// ---- queries ----------------------------------------------------------------

async function getMe(user: UserRow, event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const conn = await queryOne<Pick<StravaConnectionRow, "strava_athlete_id" | "scope" | "expires_at">>(
    "select strava_athlete_id, scope, expires_at from strava_connections where user_id = $1",
    [user.id],
  );
  // Same host the request came in on, so a custom API domain carries through.
  const base = `https://${event.requestContext.domainName}`;
  return json<MeResponse>(200, {
    user: { id: user.id, display_name: user.display_name, email: user.email },
    strava: conn
      ? { athlete_id: conn.strava_athlete_id, scope: conn.scope, expires_at: new Date(conn.expires_at).toISOString() }
      : null,
    strava_connect_url: `${base}/strava/oauth/start?user=${user.id}`,
  });
}

const ACTIVITY_SELECT = `
  a.id, a.user_id, a.strava_activity_id, a.session_id, a.sport_type, a.start_time, a.distance_m, a.moving_time_sec,
  a.avg_pace_sec_km, a.avg_hr, a.max_hr, a.avg_watts, a.kcal, a.description, a.device_name, a.gear_id,
  a.gear_name, a.weather, a.memo, a.rpe, a.memo_updated_at, a.splits, a.match_status,
  r.verdict as r_verdict, r.comment as r_comment, r.reminders as r_reminders,
  r.source as r_source, r.model as r_model, r.adjust_hint as r_adjust_hint, r.created_at as r_created_at`;

type ActivityJoined = Omit<ActivityRow, "raw"> & {
  r_verdict: ReviewRow["verdict"];
  r_comment: string | null;
  r_reminders: string[] | null;
  r_source: ReviewRow["source"] | null;
  r_model: string | null;
  r_adjust_hint: string | null;
  r_created_at: Date | null;
};

function toApiReview(r: Pick<ReviewRow, "verdict" | "comment" | "reminders" | "source" | "model" | "adjust_hint" | "created_at">): ApiReview {
  const failed = r.source === "claude" && r.verdict === null;
  return {
    verdict: r.verdict,
    comment: failed ? null : r.comment,
    reminders: r.reminders ?? [],
    source: r.source,
    model: r.model,
    adjust_hint: r.adjust_hint ?? null,
    failed,
    error: failed ? (r.comment ?? "").replace(/^分析失敗：/, "") || "unknown" : null,
    created_at: new Date(r.created_at).toISOString(),
  };
}

function toApiActivity(a: ActivityJoined): ApiActivity {
  const { r_verdict, r_comment, r_reminders, r_source, r_model, r_adjust_hint, r_created_at, ...rest } = a;
  return {
    ...rest,
    start_time: new Date(a.start_time).toISOString(),
    memo_updated_at: a.memo_updated_at ? new Date(a.memo_updated_at).toISOString() : null,
    splits: (a.splits as ApiActivity["splits"]) ?? null,
    review: r_created_at
      ? toApiReview({
          verdict: r_verdict, comment: r_comment, reminders: r_reminders,
          source: r_source ?? "manual", model: r_model, adjust_hint: r_adjust_hint, created_at: r_created_at,
        })
      : null,
  };
}

async function deleteStrava(user: UserRow) {
  const conn = await queryOne<Pick<StravaConnectionRow, "access_token">>(
    "select access_token from strava_connections where user_id = $1",
    [user.id],
  );
  if (conn) {
    try {
      await deauthorize(conn.access_token);
    } catch (err) {
      // Strava may already have revoked it; we still drop our side.
      console.warn(`strava deauthorize failed for user ${user.id}`, err);
    }
    await query("delete from strava_connections where user_id = $1", [user.id]);
  }
  return json<DeleteStravaResponse>(200, { ok: true });
}

async function getPlan(userId: string) {
  const plan = await queryOne<PlanRow>(
    `select *, to_char(race_date, 'YYYY-MM-DD') as race_date
       from plans where user_id = $1 and status = 'active'
      order by plans.race_date limit 1`,
    [userId],
  );
  if (!plan) return json(404, { error: "no active plan" });

  const weeks = await query<PlanWeekRow>(
    `select week_no, to_char(week_start, 'YYYY-MM-DD') as week_start, to_char(week_end, 'YYYY-MM-DD') as week_end,
            phase, focus
       from plan_weeks where plan_id = $1 order by week_no`,
    [plan.id],
  );

  const sessions = await query<PlannedSessionRow>(
    `select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date
       from planned_sessions
      where plan_id = $1 and superseded = false
      order by planned_sessions.scheduled_date`,
    [plan.id],
  );

  const activities = await query<ActivityJoined>(
    `select ${ACTIVITY_SELECT}
       from activities a
       join planned_sessions ps on ps.id = a.session_id
       left join reviews r on r.activity_id = a.id
      where a.user_id = $1 and ps.plan_id = $2
      order by a.start_time`,
    [userId, plan.id],
  );

  // Waiting for the athlete to say which session they were (any sport).
  const unassigned = await query<ActivityJoined>(
    `select ${ACTIVITY_SELECT}
       from activities a
       left join reviews r on r.activity_id = a.id
      where a.user_id = $1 and a.session_id is null and a.match_status = 'unplanned'
        and a.start_time > now() - interval '45 days'
      order by a.start_time desc`,
    [userId],
  );

  const unread = await queryOne<{ n: string }>(
    `select count(*) as n from coach_messages m
      where m.user_id = $1 and m.role = 'coach'
        and m.created_at > coalesce((select coach_seen_at from users where id = $1), '-infinity')`,
    [userId],
  );

  const openCheckin = await queryOne<{ id: string }>(
    `select id from coach_messages where user_id = $1 and meta->>'state' = 'open' and kind in ('checkin', 'ask') limit 1`,
    [userId],
  );

  return json<PlanResponse>(200, {
    coach_unread: Number(unread?.n ?? 0),
    coach_checkin_open: Boolean(openCheckin),
    plan,
    weeks: weeks.map(({ week_no, week_start, week_end, phase, focus }) => ({ week_no, week_start, week_end, phase, focus })),
    sessions,
    activities: activities.map(toApiActivity),
    unassigned: unassigned.map(toApiActivity),
  });
}

async function getActivities(userId: string, status?: string) {
  if (status !== undefined && !STATUSES.has(status)) return json(400, { error: "invalid status" });

  const activities = await query<ActivityJoined>(
    `select ${ACTIVITY_SELECT}
       from activities a
       left join reviews r on r.activity_id = a.id
      where a.user_id = $1 and ($2::text is null or a.match_status = $2)
      order by a.start_time desc
      limit 200`,
    [userId, status ?? null],
  );
  return json<ActivitiesResponse>(200, { activities: activities.map(toApiActivity) });
}

async function putReview(userId: string, activityId: string, raw: string) {
  if (!UUID_RE.test(activityId)) return json(400, { error: "invalid activity id" });
  let body: PutReviewRequest;
  try {
    body = JSON.parse(raw) as PutReviewRequest;
  } catch {
    return json(400, { error: "invalid json" });
  }
  if (body.verdict !== null && !VERDICTS.has(body.verdict)) return json(400, { error: "invalid verdict" });
  const reminders = (body.reminders ?? []).filter((r): r is string => typeof r === "string" && r.trim() !== "");

  const owned = await queryOne<{ id: string }>("select id from activities where id = $1 and user_id = $2", [activityId, userId]);
  if (!owned) return json(404, { error: "activity not found" });

  const [review] = await query<ReviewRow>(
    `insert into reviews (id, activity_id, verdict, comment, reminders, source, model, adjust_hint)
     values ($1, $2, $3, $4, $5, 'manual', null, null)
     on conflict (activity_id) do update set
       verdict = excluded.verdict, comment = excluded.comment, reminders = excluded.reminders,
       source = 'manual', model = null, adjust_hint = null, created_at = now()
     returning *`,
    [randomUUID(), activityId, body.verdict, body.comment ?? null, JSON.stringify(reminders)],
  );
  return json<PutReviewResponse>(200, { review: toApiReview(review) });
}

type MemoFields = { memo: string | null; rpe: number | null };

/** Shared by PUT …/memo and PUT …/session: a string error, or the cleaned values. */
function parseMemo(body: { memo?: unknown; rpe?: unknown }): MemoFields | string {
  const memo = typeof body.memo === "string" && body.memo.trim() !== "" ? body.memo.trim() : null;
  if (memo && memo.length > 4000) return "memo too long (4000 chars)";
  const rpe = body.rpe ?? null;
  if (rpe !== null && (typeof rpe !== "number" || !Number.isInteger(rpe) || rpe < 1 || rpe > 10)) return "rpe must be 1-10";
  return { memo, rpe };
}

async function putSession(userId: string, activityId: string, raw: string) {
  if (!UUID_RE.test(activityId)) return json(400, { error: "invalid activity id" });
  let body: PutSessionRequest;
  try {
    body = JSON.parse(raw) as PutSessionRequest;
  } catch {
    return json(400, { error: "invalid json" });
  }

  const activity = await queryOne<{ id: string; strava_activity_id: string; match_status: MatchStatus }>(
    "select id, strava_activity_id, match_status from activities where id = $1 and user_id = $2",
    [activityId, userId],
  );
  if (!activity) return json(404, { error: "activity not found" });

  const withMemo = body.memo !== undefined || body.rpe !== undefined;
  const memoFields = withMemo ? parseMemo(body) : null;
  if (typeof memoFields === "string") return json(400, { error: memoFields });

  if (body.session_id === null || body.session_id === undefined) {
    const status = body.status ?? "unplanned";
    if (status !== "unplanned" && status !== "ignored") return json(400, { error: "status must be unplanned or ignored" });
    await query("update activities set session_id = null, match_status = $2 where id = $1", [activityId, status]);
    await query("delete from reviews where activity_id = $1 and source = 'claude'", [activityId]);
  } else {
    const err = await assignSession(userId, activityId, body.session_id, Boolean(body.replace));
    if (err) return json(err.status, { error: err.error });
    if (memoFields) {
      await query("update activities set memo = $2, rpe = $3, memo_updated_at = now() where id = $1", [activityId, memoFields.memo, memoFields.rpe]);
    }
    // The Claude verdict was about the old session: drop it and let the worker
    // regenerate one against the new session (manual reviews are kept).
    const dropped = await query<{ id: string }>(
      "delete from reviews where activity_id = $1 and source = 'claude' returning id",
      [activityId],
    );
    const hasManual = await queryOne<{ id: string }>("select id from reviews where activity_id = $1", [activityId]);
    if (dropped.length > 0 || !hasManual) await requeue(userId, activity.strava_activity_id, "session reassigned");
  }

  const [row] = await query<ActivityJoined>(
    `select ${ACTIVITY_SELECT} from activities a left join reviews r on r.activity_id = a.id where a.id = $1`,
    [activityId],
  );
  return json<PutSessionResponse>(200, { activity: toApiActivity(row) });
}

/**
 * Point `activityId` at `sessionId` (match_status confirmed), bumping an automatic
 * holder; a confirmed holder only with `replace`. No review is queued here.
 */
async function assignSession(userId: string, activityId: string, sessionId: string, replace: boolean): Promise<{ status: number; error: string } | null> {
  if (!UUID_RE.test(sessionId)) return { status: 400, error: "invalid session id" };
  const session = await queryOne<{ id: string }>(
    `select ps.id from planned_sessions ps join plans p on p.id = ps.plan_id
      where ps.id = $1 and p.user_id = $2 and ps.superseded = false`,
    [sessionId, userId],
  );
  if (!session) return { status: 404, error: "session not found" };
  const holder = await queryOne<{ id: string; match_status: MatchStatus }>(
    "select id, match_status from activities where session_id = $1 and id <> $2",
    [session.id, activityId],
  );
  if (holder?.match_status === "confirmed" && !replace) return { status: 409, error: "session already confirmed for another activity" };
  if (holder) {
    await query("update activities set session_id = null, match_status = 'unplanned' where id = $1", [holder.id]);
    await query("delete from reviews where activity_id = $1 and source = 'claude'", [holder.id]);
  }
  await query("update activities set session_id = $2, match_status = 'confirmed' where id = $1", [activityId, session.id]);
  return null;
}

/** Push the activity back through the worker so a Claude review is regenerated. */
async function requeue(userId: string, stravaActivityId: string, reason: string): Promise<void> {
  if (!process.env.QUEUE_URL) return;
  const conn = await queryOne<{ strava_athlete_id: string }>(
    "select strava_athlete_id from strava_connections where user_id = $1",
    [userId],
  );
  if (!conn) return;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MessageBody: JSON.stringify({
        object_type: "activity",
        aspect_type: "update",
        object_id: Number(stravaActivityId),
        owner_id: Number(conn.strava_athlete_id),
        updates: { reason },
      }),
    }),
  );
}

async function putMemo(userId: string, activityId: string, raw: string) {
  if (!UUID_RE.test(activityId)) return json(400, { error: "invalid activity id" });
  let body: PutMemoRequest;
  try {
    body = JSON.parse(raw) as PutMemoRequest;
  } catch {
    return json(400, { error: "invalid json" });
  }
  const parsed = parseMemo(body);
  if (typeof parsed === "string") return json(400, { error: parsed });
  const { memo, rpe } = parsed;

  const activity = await queryOne<{ id: string; strava_activity_id: string; session_id: string | null }>(
    "select id, strava_activity_id, session_id from activities where id = $1 and user_id = $2",
    [activityId, userId],
  );
  if (!activity) return json(404, { error: "activity not found" });

  await query("update activities set memo = $2, rpe = $3, memo_updated_at = now() where id = $1", [activityId, memo, rpe]);

  // Let Claude take the athlete's words into account: drop its review and requeue.
  if (activity.session_id) {
    const dropped = await query<{ id: string }>(
      "delete from reviews where activity_id = $1 and source = 'claude' returning id",
      [activityId],
    );
    const hasManual = await queryOne<{ id: string }>("select id from reviews where activity_id = $1", [activityId]);
    if (dropped.length > 0 || !hasManual) await requeue(userId, activity.strava_activity_id, "memo updated");
  }

  const [row] = await query<ActivityJoined>(
    `select ${ACTIVITY_SELECT} from activities a left join reviews r on r.activity_id = a.id where a.id = $1`,
    [activityId],
  );
  return json<PutMemoResponse>(200, { activity: toApiActivity(row) });
}

/** Drop the Claude review (failed, stale or just unwanted) and have the worker write a new one. */
async function rereview(userId: string, activityId: string) {
  if (!UUID_RE.test(activityId)) return json(400, { error: "invalid activity id" });
  const activity = await queryOne<{ id: string; strava_activity_id: string; session_id: string | null }>(
    "select id, strava_activity_id, session_id from activities where id = $1 and user_id = $2",
    [activityId, userId],
  );
  if (!activity) return json(404, { error: "activity not found" });
  if (!activity.session_id) return json(409, { error: "assign the activity to a session first" });
  const manual = await queryOne<{ id: string }>("select id from reviews where activity_id = $1 and source = 'manual'", [activityId]);
  if (manual) return json(409, { error: "a manual review is kept; remove it first" });

  await query("delete from reviews where activity_id = $1 and source = 'claude'", [activityId]);
  await requeue(userId, activity.strava_activity_id, "rereview requested");
  return json<RereviewResponse>(202, { queued: true });
}

// ---- weekly reviews & adjustment proposals -----------------------------------

function toApiWeekly(w: WeeklyReviewRow): ApiWeeklyReview {
  const stored = (w.adjustments ?? { model: null, items: [] }) as Partial<StoredAdjustments>;
  return {
    id: w.id,
    week_start: w.week_start,
    summary: w.summary,
    model: stored.model ?? null,
    adjustments: (stored.items ?? []).map((a, index) => ({
      index,
      session_id: a.session_id,
      field: a.field,
      old: a.old,
      new: a.new,
      reason: a.reason,
      status: a.status ?? "pending",
      decided_at: a.decided_at ?? null,
      applied_session_id: a.applied_session_id ?? null,
    })),
    created_at: new Date(w.created_at).toISOString(),
  };
}

async function getWeekly(userId: string) {
  const rows = await query<WeeklyReviewRow>(
    `select w.id, w.plan_id, to_char(w.week_start, 'YYYY-MM-DD') as week_start, w.summary, w.adjustments, w.created_at
       from weekly_reviews w join plans p on p.id = w.plan_id
      where p.user_id = $1 and p.status = 'active'
      order by w.week_start desc, w.created_at desc
      limit 20`,
    [userId],
  );
  return json<WeeklyResponse>(200, { reviews: rows.map(toApiWeekly) });
}

const ADJUST_FIELDS = new Set(["type", "target_distance_m", "target_pace_sec_km", "scheduled_date", "note"]);

/**
 * Apply or dismiss one proposal. Applying writes a new planned_sessions row (version+1),
 * marks the old one superseded, and moves any activity over, so the original plan stays
 * readable and the app's session ids keep working.
 */
async function postAdjustment(userId: string, weeklyId: string, index: number, raw: string) {
  if (!UUID_RE.test(weeklyId)) return json(400, { error: "invalid weekly review id" });
  let body: PostAdjustmentRequest;
  try {
    body = JSON.parse(raw) as PostAdjustmentRequest;
  } catch {
    return json(400, { error: "invalid json" });
  }
  if (body.action !== "apply" && body.action !== "dismiss") return json(400, { error: "action must be apply or dismiss" });

  const w = await queryOne<WeeklyReviewRow>(
    `select w.id, w.plan_id, to_char(w.week_start, 'YYYY-MM-DD') as week_start, w.summary, w.adjustments, w.created_at
       from weekly_reviews w join plans p on p.id = w.plan_id
      where w.id = $1 and p.user_id = $2`,
    [weeklyId, userId],
  );
  if (!w) return json(404, { error: "weekly review not found" });
  const stored = (w.adjustments ?? { model: null, items: [] }) as StoredAdjustments;
  const item = stored.items?.[index];
  if (!item) return json(404, { error: "adjustment not found" });
  if (item.status && item.status !== "pending") return json(409, { error: `already ${item.status}` });

  if (body.action === "apply") {
    if (!ADJUST_FIELDS.has(item.field)) return json(400, { error: "unsupported field" });
    const old = await queryOne<PlannedSessionRow>(
      `select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date
         from planned_sessions where id = $1 and plan_id = $2 and superseded = false`,
      [item.session_id, w.plan_id],
    );
    if (!old) return json(409, { error: "that session was already changed; dismiss this proposal" });

    const next: Record<string, unknown> = { ...old, id: randomUUID(), version: old.version + 1, superseded: false };
    next[item.field] = item.new;
    if (item.field === "target_pace_sec_km" && typeof item.new === "number" && old.target_pace_sec_km) {
      // Keep the allowed range the same width around the new midpoint.
      const d = item.new - old.target_pace_sec_km;
      if (old.target_pace_min_sec_km != null) next.target_pace_min_sec_km = old.target_pace_min_sec_km + d;
      if (old.target_pace_max_sec_km != null) next.target_pace_max_sec_km = old.target_pace_max_sec_km + d;
    }
    await query(
      `insert into planned_sessions
         (id, plan_id, scheduled_date, week_no, phase, label, type, content, note, target, target_distance_m,
          target_pace_sec_km, target_pace_min_sec_km, target_pace_max_sec_km, target_hr_min, target_hr_max, version, superseded)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, false)`,
      [
        next.id, old.plan_id, next.scheduled_date, old.week_no, old.phase, old.label, next.type, old.content, next.note,
        old.target, next.target_distance_m, next.target_pace_sec_km, next.target_pace_min_sec_km, next.target_pace_max_sec_km,
        old.target_hr_min, old.target_hr_max, next.version,
      ],
    );
    await query("update planned_sessions set superseded = true where id = $1", [old.id]);
    await query("update activities set session_id = $2 where session_id = $1", [old.id, next.id]);
    item.applied_session_id = next.id as string;
  }

  item.status = body.action === "apply" ? "applied" : "dismissed";
  item.decided_at = new Date().toISOString();
  await query("update weekly_reviews set adjustments = $2 where id = $1", [w.id, JSON.stringify(stored)]);

  const updated = await queryOne<WeeklyReviewRow>(
    `select id, plan_id, to_char(week_start, 'YYYY-MM-DD') as week_start, summary, adjustments, created_at from weekly_reviews where id = $1`,
    [w.id],
  );
  return json<PostAdjustmentResponse>(200, { review: toApiWeekly(updated!) });
}

// ---- the coach's thread ----------------------------------------------------------

function toApiCoachMessage(m: CoachMessageRow): ApiCoachMessage {
  const meta = (m.meta ?? {}) as Record<string, unknown>;
  return {
    id: m.id,
    role: m.role,
    kind: m.kind,
    text: m.text,
    activity_id: m.activity_id,
    weekly_review_id: m.weekly_review_id,
    status: m.status,
    review: m.kind === "review"
      ? { label: String(meta.label ?? ""), verdict: (meta.verdict as Verdict | undefined) ?? null, reminder: (meta.reminder as string | null) ?? null, date: (meta.date as string | undefined) ?? null }
      : null,
    quote: typeof meta.quote === "string" ? meta.quote : null,
    rpe: typeof meta.rpe === "number" ? meta.rpe : null,
    checkin: m.kind === "checkin" ? toApiCheckin(meta as unknown as CheckinMeta) : null,
    ask: m.kind === "ask" ? { state: meta.state === "answered" ? "answered" : "open", activity_id: String(meta.activity_id ?? ""), session_id: String(meta.session_id ?? "") } : null,
    error: typeof meta.error === "string" ? meta.error : null,
    created_at: new Date(m.created_at).toISOString(),
  };
}

function toApiCheckin(meta: CheckinMeta): ApiCheckin {
  return {
    state: meta.state ?? "open",
    mode: meta.mode ?? "activity",
    date: meta.date ?? "",
    session_id: meta.session_id ?? null,
    session_label: meta.session_label ?? null,
    candidates: Array.isArray(meta.candidates) ? meta.candidates : [],
  };
}

async function getCoach(userId: string) {
  // Weekly reviews written before the thread existed (or whose post failed) get
  // their message now, dated when the review was written so they sort in place.
  await query(
    `insert into coach_messages (id, user_id, role, kind, text, meta, weekly_review_id, status, created_at)
     select gen_random_uuid(), p.user_id, 'coach', 'weekly', coalesce(w.summary, ''),
            jsonb_build_object('week_start', to_char(w.week_start, 'YYYY-MM-DD'), 'backfilled', true),
            w.id, 'sent', w.created_at
       from weekly_reviews w join plans p on p.id = w.plan_id
      where p.user_id = $1 and w.summary is not null
        and not exists (select 1 from coach_messages m where m.weekly_review_id = w.id)`,
    [userId],
  );
  const rows = await query<CoachMessageRow>(
    "select * from coach_messages where user_id = $1 order by created_at desc limit 100",
    [userId],
  );
  return json<CoachResponse>(200, { coach: { name: COACH_NAME }, messages: rows.reverse().map(toApiCoachMessage) });
}

/** The athlete opened the thread: everything posted so far counts as seen. */
async function putCoachSeen(userId: string) {
  const row = await queryOne<{ seen_at: Date }>("update users set coach_seen_at = now() where id = $1 returning coach_seen_at as seen_at", [userId]);
  return json<PutCoachSeenResponse>(200, { seen_at: new Date(row?.seen_at ?? Date.now()).toISOString() });
}

async function postCheckinPick(userId: string, checkinId: string, raw: string) {
  if (!UUID_RE.test(checkinId)) return json(400, { error: "invalid check-in id" });
  let body: PostCheckinPickRequest;
  try {
    body = JSON.parse(raw) as PostCheckinPickRequest;
  } catch {
    return json(400, { error: "invalid json" });
  }
  const checkin = await queryOne<CoachMessageRow>("select * from coach_messages where id = $1 and user_id = $2 and kind = 'checkin'", [checkinId, userId]);
  if (!checkin) return json(404, { error: "check-in not found" });
  const meta = (checkin.meta ?? {}) as unknown as CheckinMeta;
  if (meta.state !== "open") return json(409, { error: "check-in is no longer open" });

  const setMeta = (patch: Partial<CheckinMeta>) =>
    query("update coach_messages set meta = $2 where id = $1", [checkin.id, JSON.stringify({ ...meta, ...patch })]);

  if (body.none) {
    await setMeta({ state: "dismissed" });
    const pick = await postCoachMessage({ user_id: userId, role: "athlete", kind: "pick", text: "都不是", meta: { none: true } });
    await postCoachMessage({ user_id: userId, role: "coach", kind: "chat", text: "好，這趟不算。要記到別堂課的話，今天頁的表單可以選。" });
    const [c] = await query<CoachMessageRow>("select * from coach_messages where id = $1", [checkin.id]);
    return json<PostCheckinPickResponse>(200, { checkin: toApiCoachMessage(c), pick: toApiCoachMessage(pick) });
  }

  // activity mode: the chip is an activity, the session is today's; session mode: the reverse.
  const activityId = meta.mode === "activity" ? body.activity_id : checkin.activity_id;
  const sessionId = meta.mode === "activity" ? meta.session_id : body.session_id;
  if (!activityId || !sessionId || !UUID_RE.test(activityId)) return json(400, { error: meta.mode === "activity" ? "activity_id is required" : "session_id is required" });
  const candidate = meta.candidates.find((c) => (meta.mode === "activity" ? c.activity_id === activityId : c.session_id === sessionId));
  if (!candidate) return json(400, { error: "not one of the candidates" });

  const err = await assignSession(userId, activityId, sessionId, false);
  if (err) return json(err.status, { error: err.error });
  await setMeta({ state: "picked", picked: { activity_id: activityId, session_id: sessionId } });

  const pick = await postCoachMessage({
    user_id: userId, role: "athlete", kind: "pick", text: candidate.label, status: "pending", activity_id: activityId,
    meta: { activity_id: activityId, session_id: sessionId },
  });
  if (process.env.QUEUE_URL) {
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MessageBody: JSON.stringify({ type: "coach_ask", user_id: userId, message_id: pick.id } satisfies CoachAskJob),
    }));
  } else {
    await query("update coach_messages set status = 'sent' where id = $1", [pick.id]);
  }
  const [c] = await query<CoachMessageRow>("select * from coach_messages where id = $1", [checkin.id]);
  return json<PostCheckinPickResponse>(200, { checkin: toApiCoachMessage(c), pick: toApiCoachMessage(pick) });
}

async function postCoach(userId: string, raw: string) {
  let body: PostCoachMessageRequest;
  try {
    body = JSON.parse(raw) as PostCoachMessageRequest;
  } catch {
    return json(400, { error: "invalid json" });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json(400, { error: "text is required" });
  if (text.length > MAX_MESSAGE_CHARS) return json(400, { error: `text too long (${MAX_MESSAGE_CHARS} chars)` });

  // Daily cap, off by default (COACH_DAILY_LIMIT=0). For when this opens to other people.
  const limit = Number(process.env.COACH_DAILY_LIMIT ?? 0);
  if (limit > 0) {
    const { n } = (await queryOne<{ n: string }>(
      `select count(*) as n from coach_messages
        where user_id = $1 and role = 'athlete'
          and (created_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date`,
      [userId],
    ))!;
    if (Number(n) >= limit) return json(429, { error: "daily limit reached" });
  }

  // Answering Woo's question after a check-in: the words become the memo, the
  // review runs with them, and its verdict is the reply.
  if (body.answer_to) {
    if (!UUID_RE.test(body.answer_to)) return json(400, { error: "invalid answer_to" });
    const ask = await queryOne<CoachMessageRow>("select * from coach_messages where id = $1 and user_id = $2 and kind = 'ask'", [body.answer_to, userId]);
    if (!ask) return json(404, { error: "question not found" });
    const am = (ask.meta ?? {}) as { activity_id?: string; state?: string };
    if (am.state === "answered") return json(409, { error: "already answered" });
    const parsed = parseMemo({ memo: text, rpe: body.rpe ?? null });
    if (typeof parsed === "string") return json(400, { error: parsed });
    const activity = await queryOne<{ id: string; strava_activity_id: string; session_id: string | null }>(
      "select id, strava_activity_id, session_id from activities where id = $1 and user_id = $2",
      [am.activity_id ?? "", userId],
    );
    if (!activity) return json(404, { error: "activity not found" });
    await query("update activities set memo = $2, rpe = $3, memo_updated_at = now() where id = $1", [activity.id, parsed.memo, parsed.rpe]);
    await query("update coach_messages set meta = coalesce(meta, '{}'::jsonb) || '{\"state\":\"answered\"}'::jsonb where id = $1", [ask.id]);
    const m = await postCoachMessage({
      user_id: userId, role: "athlete", kind: "chat", text, status: "pending", activity_id: activity.id,
      meta: { answer_to: ask.id, rpe: parsed.rpe },
    });
    await query("delete from reviews where activity_id = $1 and source = 'claude'", [activity.id]);
    if (activity.session_id) await requeue(userId, activity.strava_activity_id, "check-in answered");
    else await query("update coach_messages set status = 'sent' where id = $1", [m.id]);
    return json<PostCoachMessageResponse>(202, { message: toApiCoachMessage(m) });
  }

  let quote: string | null = null;
  if (body.activity_id) {
    if (!UUID_RE.test(body.activity_id)) return json(400, { error: "invalid activity id" });
    const a = await queryOne<{ date: string; label: string | null; distance_m: number; avg_pace_sec_km: number | null; avg_hr: number | null; max_hr: number | null; verdict: string | null }>(
      `select to_char(a.start_time at time zone 'Asia/Tokyo', 'MM/DD') as date, ps.label, a.distance_m, a.avg_pace_sec_km, a.avg_hr, a.max_hr, r.verdict
         from activities a left join planned_sessions ps on ps.id = a.session_id left join reviews r on r.activity_id = a.id
        where a.id = $1 and a.user_id = $2`,
      [body.activity_id, userId],
    );
    if (!a) return json(404, { error: "activity not found" });
    const p = a.avg_pace_sec_km ? `${Math.floor(a.avg_pace_sec_km / 60)}:${String(a.avg_pace_sec_km % 60).padStart(2, "0")}/km` : null;
    quote = [`${a.date} ${a.label ?? "未排課"} ${(a.distance_m / 1000).toFixed(2)} km`, p, a.avg_hr != null ? `心拍 ${a.avg_hr}${a.max_hr != null ? `（最高 ${a.max_hr}）` : ""}` : null, a.verdict].filter(Boolean).join(" · ");
  }

  const m = await postCoachMessage({
    user_id: userId, role: "athlete", kind: "chat", text, status: "pending",
    activity_id: body.activity_id ?? null, meta: quote ? { quote } : null,
  });
  if (process.env.QUEUE_URL) {
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MessageBody: JSON.stringify({ type: "coach_reply", user_id: userId, message_id: m.id } satisfies CoachReplyJob),
    }));
  }
  return json<PostCoachMessageResponse>(202, { message: toApiCoachMessage(m) });
}
