import { randomUUID } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { isDbWaking, query, queryOne } from "../lib/db";
import { deauthorize } from "../lib/strava";
import type { ActivityRow, PlanRow, PlanWeekRow, PlannedSessionRow, ReviewRow, StravaConnectionRow, UserRow } from "../types";
import type {
  ActivitiesResponse,
  ApiActivity,
  DeleteStravaResponse,
  ApiReview,
  ErrorResponse,
  MatchStatus,
  MeResponse,
  PlanResponse,
  PutReviewRequest,
  PutReviewResponse,
  PutSessionRequest,
  PutSessionResponse,
  PutMemoRequest,
  PutMemoResponse,
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set<string>(["auto", "confirmed", "unplanned", "ignored"] satisfies MatchStatus[]);
const VERDICTS = new Set<string>(["達成", "達成但有提醒", "未達成"]);

const sqs = new SQSClient({});

const json = <T extends MeResponse | DeleteStravaResponse | PlanResponse | ActivitiesResponse | PutReviewResponse | PutSessionResponse | PutMemoResponse | ErrorResponse>(
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
    throw err;
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

  const sub = /^\/activities\/([^/]+)\/(review|session|memo)$/.exec(path);
  if (method === "PUT" && sub) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
    if (sub[2] === "review") return putReview(user.id, sub[1], raw);
    if (sub[2] === "session") return putSession(user.id, sub[1], raw);
    return putMemo(user.id, sub[1], raw);
  }

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
  r.source as r_source, r.model as r_model, r.created_at as r_created_at`;

type ActivityJoined = Omit<ActivityRow, "raw"> & {
  r_verdict: ReviewRow["verdict"];
  r_comment: string | null;
  r_reminders: string[] | null;
  r_source: ReviewRow["source"] | null;
  r_model: string | null;
  r_created_at: Date | null;
};

function toApiReview(r: Pick<ReviewRow, "verdict" | "comment" | "reminders" | "source" | "model" | "created_at">): ApiReview {
  return {
    verdict: r.verdict,
    comment: r.comment,
    reminders: r.reminders ?? [],
    source: r.source,
    model: r.model,
    created_at: new Date(r.created_at).toISOString(),
  };
}

function toApiActivity(a: ActivityJoined): ApiActivity {
  const { r_verdict, r_comment, r_reminders, r_source, r_model, r_created_at, ...rest } = a;
  return {
    ...rest,
    start_time: new Date(a.start_time).toISOString(),
    memo_updated_at: a.memo_updated_at ? new Date(a.memo_updated_at).toISOString() : null,
    splits: (a.splits as ApiActivity["splits"]) ?? null,
    review: r_created_at
      ? toApiReview({
          verdict: r_verdict, comment: r_comment, reminders: r_reminders,
          source: r_source ?? "manual", model: r_model, created_at: r_created_at,
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

  return json<PlanResponse>(200, {
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
    `insert into reviews (id, activity_id, verdict, comment, reminders, source, model)
     values ($1, $2, $3, $4, $5, 'manual', null)
     on conflict (activity_id) do update set
       verdict = excluded.verdict, comment = excluded.comment, reminders = excluded.reminders,
       source = 'manual', model = null, created_at = now()
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
    if (!UUID_RE.test(body.session_id)) return json(400, { error: "invalid session id" });
    const session = await queryOne<{ id: string }>(
      `select ps.id from planned_sessions ps join plans p on p.id = ps.plan_id
        where ps.id = $1 and p.user_id = $2 and ps.superseded = false`,
      [body.session_id, userId],
    );
    if (!session) return json(404, { error: "session not found" });

    // One activity per session: bump an automatic holder; a confirmed one only with `replace`.
    const holder = await queryOne<{ id: string; match_status: MatchStatus }>(
      "select id, match_status from activities where session_id = $1 and id <> $2",
      [session.id, activityId],
    );
    if (holder?.match_status === "confirmed" && !body.replace) {
      return json(409, { error: "session already confirmed for another activity" });
    }
    if (holder) {
      await query("update activities set session_id = null, match_status = 'unplanned' where id = $1", [holder.id]);
      await query("delete from reviews where activity_id = $1 and source = 'claude'", [holder.id]);
    }

    await query("update activities set session_id = $2, match_status = 'confirmed' where id = $1", [activityId, session.id]);
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
