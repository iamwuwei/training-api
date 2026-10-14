import type { LambdaFunctionURLHandler } from "aws-lambda";
import { query, queryOne } from "../lib/db";
import type { ActivityRow, PlanRow, PlannedSessionRow } from "../types";
import type {
  ActivitiesResponse,
  ApiActivity,
  ErrorResponse,
  MatchStatus,
  PlanResponse,
} from "../../types/api";

// Read-only API for the GitHub Pages front-end. CORS is configured on the
// Function URL itself (see infra/lib/stack.ts). v1: no auth, user uuid as bearer.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set<string>(["auto", "confirmed", "unplanned", "ignored"] satisfies MatchStatus[]);

const json = <T extends PlanResponse | ActivitiesResponse | ErrorResponse>(statusCode: number, body: T) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

export const handler: LambdaFunctionURLHandler = async (event) => {
  if (event.requestContext.http.method !== "GET") return json(405, { error: "method not allowed" });

  const q = event.queryStringParameters ?? {};
  const user = q.user ?? "";
  if (!UUID_RE.test(user)) return json(400, { error: "missing or invalid user" });

  switch (event.rawPath) {
    case "/plan":
      return getPlan(user);
    case "/activities":
      return getActivities(user, q.status);
    default:
      return json(404, { error: "not found" });
  }
};

async function getPlan(userId: string) {
  const plan = await queryOne<PlanRow>(
    `select *, to_char(race_date, 'YYYY-MM-DD') as race_date
       from plans where user_id = $1 and status = 'active'
      order by race_date limit 1`,
    [userId],
  );
  if (!plan) return json(404, { error: "no active plan" });

  const sessions = await query<PlannedSessionRow>(
    `select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date
       from planned_sessions
      where plan_id = $1 and superseded = false
      order by scheduled_date`,
    [plan.id],
  );

  const activities = await query<Omit<ActivityRow, "raw">>(
    `select a.id, a.user_id, a.strava_activity_id, a.session_id, a.start_time, a.distance_m,
            a.moving_time_sec, a.avg_pace_sec_km, a.avg_hr, a.splits, a.match_status
       from activities a
       join planned_sessions ps on ps.id = a.session_id
      where a.user_id = $1 and ps.plan_id = $2
      order by a.start_time`,
    [userId, plan.id],
  );

  return json<PlanResponse>(200, { plan, sessions, activities: activities.map(toApiActivity) });
}

function toApiActivity(a: Omit<ActivityRow, "raw">): ApiActivity {
  return {
    ...a,
    start_time: new Date(a.start_time).toISOString(),
    splits: (a.splits as ApiActivity["splits"]) ?? null,
  };
}

async function getActivities(userId: string, status?: string) {
  if (status !== undefined && !STATUSES.has(status)) return json(400, { error: "invalid status" });

  const activities = await query<Omit<ActivityRow, "raw">>(
    `select id, user_id, strava_activity_id, session_id, start_time, distance_m,
            moving_time_sec, avg_pace_sec_km, avg_hr, splits, match_status
       from activities
      where user_id = $1 and ($2::text is null or match_status = $2)
      order by start_time desc
      limit 200`,
    [userId, status ?? null],
  );
  return json<ActivitiesResponse>(200, { activities: activities.map(toApiActivity) });
}
