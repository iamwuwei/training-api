import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { isDbWaking, query, queryOne } from "../lib/db";
import type { ActivityRow, PlanRow, PlanWeekRow, PlannedSessionRow, ReviewRow, UserRow } from "../types";
import type {
  ActivitiesResponse,
  ApiActivity,
  ApiReview,
  ErrorResponse,
  MatchStatus,
  PlanResponse,
  PutReviewRequest,
  PutReviewResponse,
} from "../../types/api";

// Lambda training-api-prod. Behind API Gateway (HTTP API) with a Cognito JWT authorizer: by the time we
// run, the ID token is already verified and its claims are on the event.
// CORS is handled by the HTTP API (infra/lib/stack.ts).
//
//   GET /plan                        active plan + weeks + sessions + matched activities (with reviews)
//   GET /activities?status=<status>  all activities (with reviews), newest first
//   PUT /activities/{id}/review      set a manual verdict

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set<string>(["auto", "confirmed", "unplanned", "ignored"] satisfies MatchStatus[]);
const VERDICTS = new Set<string>(["達成", "達成但有提醒", "未達成"]);

const json = <T extends PlanResponse | ActivitiesResponse | PutReviewResponse | ErrorResponse>(
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

  if (method === "GET" && path === "/plan") return getPlan(user.id);
  if (method === "GET" && path === "/activities") return getActivities(user.id, q.status);

  const review = /^\/activities\/([^/]+)\/review$/.exec(path);
  if (method === "PUT" && review) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
    return putReview(user.id, review[1], raw);
  }

  return json(404, { error: "not found" });
}

// ---- queries ----------------------------------------------------------------

const ACTIVITY_SELECT = `
  a.id, a.user_id, a.strava_activity_id, a.session_id, a.start_time, a.distance_m, a.moving_time_sec,
  a.avg_pace_sec_km, a.avg_hr, a.max_hr, a.avg_watts, a.kcal, a.description, a.device_name, a.gear_id,
  a.gear_name, a.weather, a.splits, a.match_status,
  r.verdict as r_verdict, r.comment as r_comment, r.reminders as r_reminders, r.rpe as r_rpe,
  r.source as r_source, r.model as r_model, r.created_at as r_created_at`;

type ActivityJoined = Omit<ActivityRow, "raw"> & {
  r_verdict: ReviewRow["verdict"];
  r_comment: string | null;
  r_reminders: string[] | null;
  r_rpe: number | null;
  r_source: ReviewRow["source"] | null;
  r_model: string | null;
  r_created_at: Date | null;
};

function toApiReview(r: Pick<ReviewRow, "verdict" | "comment" | "reminders" | "rpe" | "source" | "model" | "created_at">): ApiReview {
  return {
    verdict: r.verdict,
    comment: r.comment,
    reminders: r.reminders ?? [],
    rpe: r.rpe,
    source: r.source,
    model: r.model,
    created_at: new Date(r.created_at).toISOString(),
  };
}

function toApiActivity(a: ActivityJoined): ApiActivity {
  const { r_verdict, r_comment, r_reminders, r_rpe, r_source, r_model, r_created_at, ...rest } = a;
  return {
    ...rest,
    start_time: new Date(a.start_time).toISOString(),
    splits: (a.splits as ApiActivity["splits"]) ?? null,
    review: r_created_at
      ? toApiReview({
          verdict: r_verdict, comment: r_comment, reminders: r_reminders, rpe: r_rpe,
          source: r_source ?? "manual", model: r_model, created_at: r_created_at,
        })
      : null,
  };
}

async function getPlan(userId: string) {
  const plan = await queryOne<PlanRow>(
    `select *, to_char(race_date, 'YYYY-MM-DD') as race_date
       from plans where user_id = $1 and status = 'active'
      order by race_date limit 1`,
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
      order by scheduled_date`,
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

  return json<PlanResponse>(200, {
    plan,
    weeks: weeks.map(({ week_no, week_start, week_end, phase, focus }) => ({ week_no, week_start, week_end, phase, focus })),
    sessions,
    activities: activities.map(toApiActivity),
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
  if (body.rpe != null && (!Number.isInteger(body.rpe) || body.rpe < 1 || body.rpe > 10)) {
    return json(400, { error: "rpe must be 1-10" });
  }

  const owned = await queryOne<{ id: string }>("select id from activities where id = $1 and user_id = $2", [activityId, userId]);
  if (!owned) return json(404, { error: "activity not found" });

  const [review] = await query<ReviewRow>(
    `insert into reviews (id, activity_id, verdict, comment, reminders, rpe, source, model)
     values ($1, $2, $3, $4, $5, $6, 'manual', null)
     on conflict (activity_id) do update set
       verdict = excluded.verdict, comment = excluded.comment, reminders = excluded.reminders,
       rpe = excluded.rpe, source = 'manual', model = null, created_at = now()
     returning *`,
    [randomUUID(), activityId, body.verdict, body.comment ?? null, JSON.stringify(reminders), body.rpe ?? null],
  );
  return json<PutReviewResponse>(200, { review: toApiReview(review) });
}
