import { randomUUID } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { isDbWaking, query, queryOne, withTransaction } from "../lib/db";
import { type CheckinMeta, type MismatchAskMeta, mismatchReason, postMismatchAsk, resetCheckin, undoPick } from "../lib/checkin";
import { COACH_NAME, MAX_MESSAGE_CHARS, postCoachMessage, REPLY_FAILED } from "../lib/coach";
import { constraintsByIds, loadActiveConstraints } from "../lib/constraints";
import { shortDate, sportName, weeklyAskQuestion } from "../lib/labels";
import { applyChange, applyProposal, changeConflict, postProposalApplied } from "../lib/proposals";
import { deauthorize } from "../lib/strava";
import { postRoutineDone } from "../lib/strength";
import { requestWeeklyRerun, reviewMissingActivity, WEEKLY_REVIEW_SELECT } from "../lib/weekly";
import type { ActivityRow, BriefsJob, CoachAskJob, CoachMessageRow, CoachReplyJob, ConstraintRow, PlanRow, PlanWeekRow, PlannedSessionRow, ProposalRow, ReviewRow, RoutineJob, SessionRoutineRow, StoredAdjustments, StravaConnectionRow, UserRow, WeeklyMessageMeta, WeeklyReviewRow } from "../types";
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
  PostCheckinResetResponse,
  ApiRoutine,
  PostRoutineRequest,
  PostRoutineResponse,
  PutRoutineRequest,
  PutRoutineResponse,
  ApiConstraint,
  ApiProposal,
  ApiSession,
  PlanChangedResponse,
  PostConstraintResponse,
  PostProposalResponse,
  PostWeeklyAskRequest,
  PostWeeklyAskResponse,
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
//   PUT /activities/{id}/session     the athlete's pick: which planned session this activity was (+ memo/RPE), or ignore it;
//                                    a pick that looks wrong gets Woo's 真的是這趟嗎 in the thread instead of a verdict
//   PUT /activities/{id}/memo        athlete's own note + RPE (re-triggers the Claude review)
//   POST /activities/{id}/rereview   drop the Claude review (failed or stale) and queue a new one
//   GET /weekly                      weekly coach reviews with their adjustment proposals
//   POST /weekly/{id}/adjustments/{index}   apply or dismiss one proposal
//   POST /weekly/{id}/asks/{session_id}     answer the review's question about a session without a record (synced / skipped)
//   POST /proposals/{id}/apply|dismiss      a proposal card (chat or weekly review): apply all of it at once (409 plan_changed when a session moved under it), or dismiss
//   POST /constraints/{id}/accept|dismiss   Woo's 記下來 card: remember it / not; dismiss also deletes an active one (settings)
//   GET /coach                       the coach's thread (weekly reviews, verdicts, chat)
//   POST /coach/messages             say something to the coach; the worker answers (answer_to / confirm_match for Woo's questions)
//   PUT /coach/seen                  the thread was opened; clears coach_unread on GET /plan
//   POST /coach/checkins/{id}/pick   which activity was today's session (Woo's check-in chips)
//   POST /coach/checkins/{id}/reset  選錯了: unassign and ask again
//   POST /sessions/{id}/routine      肌力 day: { place } → Woo's checklist (worker fills it; poll /plan)
//   PUT /sessions/{id}/routine       tick items, RPE / note, complete

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set<string>(["auto", "confirmed", "unplanned", "ignored"] satisfies MatchStatus[]);
const VERDICTS = new Set<string>(["達成", "達成但有提醒", "未達成"]);

const sqs = new SQSClient({});

const json = <T extends MeResponse | DeleteStravaResponse | PlanResponse | ActivitiesResponse | PutReviewResponse | PutSessionResponse | PutMemoResponse | RereviewResponse | WeeklyResponse | PostAdjustmentResponse | CoachResponse | PostCoachMessageResponse | PutCoachSeenResponse | PostCheckinPickResponse | PostCheckinResetResponse | PostRoutineResponse | PutRoutineResponse | PostWeeklyAskResponse | PostProposalResponse | PostConstraintResponse | PlanChangedResponse | ErrorResponse>(
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
    // Anything else: a fixed message (pg / SDK wording stays in CloudWatch, not in the app),
    // as JSON so the app can tell it apart from API Gateway's bare "Internal Server Error".
    console.error("api error:", err);
    return json(500, { error: "伺服器錯誤" });
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
  const reset = /^\/coach\/checkins\/([^/]+)\/reset$/.exec(path);
  if (method === "POST" && reset) return postCheckinReset(user.id, reset[1]);
  const routine = /^\/sessions\/([^/]+)\/routine$/.exec(path);
  if (method === "POST" && routine) return postRoutine(user.id, routine[1], raw);
  if (method === "PUT" && routine) return putRoutine(user.id, routine[1], raw);
  if (method === "POST" && path === "/coach/messages") return postCoach(user.id, raw);
  const adj = /^\/weekly\/([^/]+)\/adjustments\/(\d+)$/.exec(path);
  if (method === "POST" && adj) return postAdjustment(user.id, adj[1], Number(adj[2]), raw);
  const askRoute = /^\/weekly\/([^/]+)\/asks\/([^/]+)$/.exec(path);
  if (method === "POST" && askRoute) return postWeeklyAsk(user.id, askRoute[1], askRoute[2], raw);
  const proposal = /^\/proposals\/([^/]+)\/(apply|dismiss)$/.exec(path);
  if (method === "POST" && proposal) return postProposalDecision(user.id, proposal[1], proposal[2] as "apply" | "dismiss");
  const constraint = /^\/constraints\/([^/]+)\/(accept|dismiss)$/.exec(path);
  if (method === "POST" && constraint) return postConstraintDecision(user.id, constraint[1], constraint[2] as "accept" | "dismiss");

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
    error: failed ? REPLY_FAILED : null, // one fixed line for every failed model call; the provider's wording stays in the logs / the row
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

  // Is Woo waiting on the athlete (an open check-in or question)? One query: open asks
  // sort first, newest first, so the row is the newest open ask when there is one (its
  // kind decides the waiting line's wording: feel vs mismatch) and a check-in otherwise (kind null).
  const waiting = await queryOne<{ kind: "checkin" | "ask"; ask_kind: string | null }>(
    `select kind, meta->>'kind' as ask_kind from coach_messages
      where user_id = $1 and meta->>'state' = 'open' and kind in ('checkin', 'ask')
      order by (kind = 'ask') desc, created_at desc limit 1`,
    [userId],
  );
  const openAsk = waiting?.kind === "ask" ? waiting : undefined;

  const routines = await query<SessionRoutineRow>(
    `select r.* from session_routines r join planned_sessions ps on ps.id = r.session_id
      where r.user_id = $1 and ps.plan_id = $2 order by ps.scheduled_date`,
    [userId, plan.id],
  );
  const constraints = await loadActiveConstraints(userId);

  // Woo's one line per upcoming session: ask the worker for the missing ones (next 14 days).
  const today = todayJst();
  const to = addDays(today, 14);
  if (sessions.some((s) => s.brief == null && s.scheduled_date >= today && s.scheduled_date <= to)) await requestBriefs(userId, today, to);

  return json<PlanResponse>(200, {
    coach_unread: Number(unread?.n ?? 0),
    coach_checkin_open: Boolean(waiting),
    coach_ask_kind: openAsk ? (openAsk.ask_kind === "mismatch" ? "mismatch" : "feel") : null,
    plan,
    weeks: weeks.map(({ week_no, week_start, week_end, phase, focus }) => ({ week_no, week_start, week_end, phase, focus })),
    sessions: sessions.map(toApiSession),
    activities: activities.map(toApiActivity),
    unassigned: unassigned.map(toApiActivity),
    routines: routines.map(toApiRoutine),
    constraints: constraints.map(toApiConstraint),
  });
}

const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const toApiSession = (s: PlannedSessionRow): ApiSession => ({ ...s, skipped_at: s.skipped_at ? new Date(s.skipped_at).toISOString() : null });

// One briefs job per user per 10 minutes from this container; the worker skips sessions that got one meanwhile.
const briefsAsked = new Map<string, number>();
async function requestBriefs(userId: string, from: string, to: string): Promise<void> {
  if (!process.env.QUEUE_URL) return;
  const last = briefsAsked.get(userId) ?? 0;
  if (Date.now() - last < 10 * 60_000) return;
  briefsAsked.set(userId, Date.now());
  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.QUEUE_URL,
    MessageBody: JSON.stringify({ type: "briefs", user_id: userId, from, to } satisfies BriefsJob),
  }));
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
    // Same doubt check as after a check-in chip: a walk on a long-run day, a run far
    // shorter than the session. Then Woo asks 真的是這趟嗎 (POST /coach/messages
    // { answer_to, confirm_match }) and the verdict waits for the answer.
    const full = await queryOne<ActivityRow>("select * from activities where id = $1 and user_id = $2", [activityId, userId]);
    const session = await queryOne<PlannedSessionRow>(
      `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions ps join plans p on p.id = ps.plan_id
        where ps.id = $1 and p.user_id = $2`,
      [body.session_id, userId],
    );
    // Woo's check-in for this session (or, on a rest day, for this activity) is answered by
    // this pick: close it like a chip pick would, so /plan stops saying Woo is waiting.
    // The check-in's "selected" record lets 選錯了 (reset) undo this pick the same way.
    if (session) await closeCheckinFor(userId, activityId, session);
    const reason = full && session ? mismatchReason(full, session) : null;
    if (reason && session) {
      // An earlier open question about this activity (a feel question, an older doubt) is about the old pick.
      await query(
        `update coach_messages set meta = coalesce(meta, '{}'::jsonb) || '{"state":"closed"}'::jsonb
          where user_id = $1 and kind = 'ask' and activity_id = $2 and meta->>'state' = 'open'`,
        [userId, activityId],
      );
      await postMismatchAsk(userId, { from: "report", activity_id: activityId, session_id: session.id, reason, checkin_id: null, pick_id: null }, session.scheduled_date, session);
    } else if (dropped.length > 0 || !hasManual) {
      await requeue(userId, activity.strava_activity_id, "session reassigned");
    }
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
    "select id, match_status from activities where session_id = $1 and id <> $2 and user_id = $3",
    [session.id, activityId, userId],
  );
  if (holder?.match_status === "confirmed" && !replace) return { status: 409, error: "session already confirmed for another activity" };
  // The bumped holder is unassigned exactly like 選錯了 does it: its Claude review dropped,
  // Woo's open question about it (a feel question after a chip) closed — otherwise that
  // question stays open forever and /plan keeps saying Woo is waiting for an answer.
  if (holder) await undoPick(userId, holder.id, session.id);
  await query("update activities set session_id = $2, match_status = 'confirmed' where id = $1", [activityId, session.id]);
  return null;
}

/**
 * The report page assigned `activityId` to `session`: the check-in that this answers —
 * the one for that session's day (activity mode: "today's session is X, which
 * activity?") or, on a rest day, the one about this activity (session mode: "which
 * session should it count for?") — goes to `picked`, as a chip pick would, so /plan
 * stops saying Woo is waiting. A check-in already picked for this session (the chip
 * chose another activity, the report page replaces it) is re-pointed, so 選錯了 undoes
 * the activity that holds the session now. Another day's check-in is left alone.
 */
async function closeCheckinFor(userId: string, activityId: string, session: Pick<PlannedSessionRow, "id" | "scheduled_date">): Promise<void> {
  const checkin = await queryOne<CoachMessageRow>(
    `select * from coach_messages where user_id = $1 and kind = 'checkin' and meta->>'state' in ('open', 'picked')
        and ((meta->>'mode' = 'activity' and meta->>'session_id' = $2)
          or (meta->>'mode' = 'session' and activity_id = $3)
          or meta->'picked'->>'session_id' = $2)
      order by created_at desc limit 1`,
    [userId, session.id, activityId],
  );
  if (!checkin) return;
  const meta = (checkin.meta ?? {}) as unknown as CheckinMeta;
  await query("update coach_messages set meta = $2 where id = $1", [checkin.id, JSON.stringify({ ...meta, state: "picked", picked: { activity_id: activityId, session_id: session.id } } satisfies CheckinMeta)]);
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
    updated_at: w.updated_at ? new Date(w.updated_at).toISOString() : null,
    update_reason: w.update_reason ?? null,
  };
}

async function getWeekly(userId: string) {
  const rows = await query<WeeklyReviewRow>(
    `${WEEKLY_REVIEW_SELECT}
      where plan_id in (select id from plans where user_id = $1 and status = 'active')
      order by week_start desc, created_at desc
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
    `${WEEKLY_REVIEW_SELECT} where id = $1 and plan_id in (select id from plans where user_id = $2)`,
    [weeklyId, userId],
  );
  if (!w) return json(404, { error: "weekly review not found" });
  const stored = (w.adjustments ?? { model: null, items: [] }) as StoredAdjustments;
  const item = stored.items?.[index];
  if (!item) return json(404, { error: "adjustment not found" });
  if (item.status && item.status !== "pending") return json(409, { error: `already ${item.status}` });

  if (body.action === "apply") {
    if (!ADJUST_FIELDS.has(item.field)) return json(400, { error: "unsupported field" });
    const old = await queryOne<PlannedSessionRow & { race_date: string }>(
      `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date, to_char(p.race_date, 'YYYY-MM-DD') as race_date
         from planned_sessions ps join plans p on p.id = ps.plan_id
        where ps.id = $1 and ps.plan_id = $2 and ps.superseded = false`,
      [item.session_id, w.plan_id],
    );
    if (!old) return json(409, { error: "that session was already changed; dismiss this proposal" });
    // The stored value is the model's: the same checks as a chat card before it touches the plan
    // (value fits the field, the race day is neither changed nor made, nothing moves onto it).
    const conflict = changeConflict(old, item.field, item.new);
    if (conflict) return json(409, { error: `${conflict}; dismiss this proposal` });
    const { race_date: _raceDate, ...oldRow } = old;
    item.applied_session_id = await withTransaction((q) => applyChange(q, oldRow, item.field, item.new));
  }

  item.status = body.action === "apply" ? "applied" : "dismissed";
  item.decided_at = new Date().toISOString();
  await query("update weekly_reviews set adjustments = $2 where id = $1", [w.id, JSON.stringify(stored)]);

  const updated = await queryOne<WeeklyReviewRow>(`${WEEKLY_REVIEW_SELECT} where id = $1`, [w.id]);
  return json<PostAdjustmentResponse>(200, { review: toApiWeekly(updated!) });
}

/**
 * The athlete answers the weekly review's question about a key session without a
 * record. synced: just noted. skipped: the session gets skipped_at and the weekly
 * Lambda regenerates the review ("你說 10/25 沒跑").
 */
async function postWeeklyAsk(userId: string, weeklyId: string, sessionId: string, raw: string) {
  if (!UUID_RE.test(weeklyId) || !UUID_RE.test(sessionId)) return json(400, { error: "invalid id" });
  let body: PostWeeklyAskRequest;
  try {
    body = JSON.parse(raw) as PostWeeklyAskRequest;
  } catch {
    return json(400, { error: "invalid json" });
  }
  if (body.answer !== "synced" && body.answer !== "skipped") return json(400, { error: "answer must be synced or skipped" });

  const m = await queryOne<CoachMessageRow>(
    `select m.* from coach_messages m join weekly_reviews w on w.id = m.weekly_review_id join plans p on p.id = w.plan_id
      where m.weekly_review_id = $1 and m.user_id = $2 and p.user_id = $2 and m.kind = 'weekly' order by m.created_at limit 1`,
    [weeklyId, userId],
  );
  if (!m) return json(404, { error: "weekly review not found" });
  const meta = (m.meta ?? {}) as unknown as WeeklyMessageMeta;
  const ask = (meta.asks ?? []).find((a) => a.session_id === sessionId);
  if (!ask) return json(404, { error: "no question about that session" });
  if (ask.state === "skipped") return json(409, { error: "already answered" });

  ask.state = body.answer;
  await query("update coach_messages set meta = $2 where id = $1", [m.id, JSON.stringify(meta)]);
  if (body.answer === "skipped") {
    await query(
      "update planned_sessions set skipped_at = coalesce(skipped_at, now()) where id = $1 and plan_id in (select id from plans where user_id = $2)",
      [sessionId, userId],
    );
    await requestWeeklyRerun({ user_id: userId, weekly_review_id: weeklyId, reason: `你說 ${shortDate(ask.date)} 沒跑` });
  }
  const [fresh] = await query<CoachMessageRow>("select * from coach_messages where id = $1", [m.id]);
  return json<PostWeeklyAskResponse>(200, { message: toApiCoachMessage(fresh, await cardsFor(userId, [fresh])) });
}

// ---- proposal cards ---------------------------------------------------------------

const iso = (d: Date | string) => new Date(d).toISOString();

function toApiProposal(p: ProposalRow): ApiProposal {
  return {
    id: p.id,
    source: p.source,
    message_id: p.message_id,
    changes: (Array.isArray(p.items) ? p.items : []).map((i) => ({
      op: i.op ?? "change",
      session_id: i.session_id ?? null,
      ...(i.field ? { field: i.field } : {}),
      old: i.old ?? null,
      new: i.new ?? null,
      label: i.label ?? null,
      date: i.date ?? null,
      ...(i.new_session ? { new_session: i.new_session } : {}),
      reason: i.reason ?? null,
      flags: Array.isArray(i.flags) ? i.flags : [],
      applied_session_id: i.applied_session_id ?? null,
    })),
    weeks: Array.isArray(p.weeks) ? p.weeks : [],
    why: p.why,
    basis: Array.isArray(p.basis) ? p.basis : [],
    basis_text: p.basis_text ?? "",
    impact: p.impact ?? { keep: "", change: "", risk: "" },
    flags: Array.isArray(p.flags) ? p.flags : [],
    group_id: p.group_id ?? null,
    option: p.option ?? null,
    status: p.status,
    stale_reason: p.stale_reason ?? null,
    created_at: iso(p.created_at),
    decided_at: p.decided_at ? iso(p.decided_at) : null,
  };
}

/** Apply every row of the card in one transaction (Woo confirms in the thread), or dismiss it. */
async function postProposalDecision(userId: string, proposalId: string, action: "apply" | "dismiss") {
  if (!UUID_RE.test(proposalId)) return json(400, { error: "invalid proposal id" });
  const p = await queryOne<ProposalRow>("select * from proposals where id = $1 and user_id = $2", [proposalId, userId]);
  if (!p) return json(404, { error: "proposal not found" });
  // A stale card can still be dismissed (算了); nothing else leaves a decided card.
  if (p.status !== "pending" && !(action === "dismiss" && p.status === "stale")) return json(409, { error: `already ${p.status}` });

  let superseded: string[] = [];
  if (action === "apply") {
    const result = await applyProposal(p, todayJst());
    if (!result.ok) {
      return result.changed
        ? json<PlanChangedResponse>(result.status, { error: "plan_changed", changed: result.changed })
        : json(result.status, { error: result.error });
    }
    superseded = result.superseded;
    await postProposalApplied(userId, result.items, p.weeks ?? []);
  } else {
    await query("update proposals set status = 'dismissed', decided_at = now() where id = $1 and user_id = $2 and status in ('pending', 'stale')", [p.id, userId]);
  }
  const [fresh] = await query<ProposalRow>("select * from proposals where id = $1", [p.id]);
  return json<PostProposalResponse>(200, { proposal: toApiProposal(fresh), superseded });
}

// ---- constraints (what Woo remembers) -------------------------------------------------

function toApiConstraint(c: ConstraintRow): ApiConstraint {
  return {
    id: c.id, text: c.text, start_date: c.start_date, end_date: c.end_date, kind: c.kind, weekday: c.weekday,
    source_message_id: c.source_message_id, status: c.status, created_at: iso(c.created_at),
  };
}

/** accept: proposed → active. dismiss: proposed or active → dismissed (the settings page's 刪除 is the second). */
async function postConstraintDecision(userId: string, id: string, action: "accept" | "dismiss") {
  if (!UUID_RE.test(id)) return json(400, { error: "invalid constraint id" });
  const [mine] = await constraintsByIds(userId, [id]);
  if (!mine) return json(404, { error: "constraint not found" });
  const [row] = action === "accept"
    ? await query<{ id: string }>("update constraints set status = 'active', decided_at = now() where id = $1 and user_id = $2 and status = 'proposed' returning id", [id, userId])
    : await query<{ id: string }>("update constraints set status = 'dismissed', decided_at = now() where id = $1 and user_id = $2 and status in ('proposed', 'active') returning id", [id, userId]);
  if (!row) return json(409, { error: `already ${mine.status}` });
  const [fresh] = await constraintsByIds(userId, [id]);
  return json<PostConstraintResponse>(200, { constraint: toApiConstraint(fresh) });
}

// ---- the coach's thread ----------------------------------------------------------

/** The cards a message points at, loaded together (see cardsFor). */
interface Cards { proposals: Map<string, ProposalRow>; constraints: Map<string, ConstraintRow> }

/** proposal_ids (A/B, weekly), or the single proposal_id of messages written before coach-replan. */
function proposalIds(meta: Record<string, unknown>): string[] {
  if (Array.isArray(meta.proposal_ids)) return meta.proposal_ids.filter((id): id is string => typeof id === "string");
  return typeof meta.proposal_id === "string" ? [meta.proposal_id] : [];
}

function toApiCoachMessage(m: CoachMessageRow, cards?: Cards): ApiCoachMessage {
  const meta = (m.meta ?? {}) as Record<string, unknown>;
  const proposals = proposalIds(meta).map((id) => cards?.proposals.get(id)).filter((p): p is ProposalRow => !!p).map(toApiProposal);
  const constraint = typeof meta.constraint_id === "string" ? cards?.constraints.get(meta.constraint_id) : undefined;
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
    ask: m.kind === "ask"
      ? {
          state: meta.state === "open" ? "open" : "answered",
          kind: meta.kind === "mismatch" ? "mismatch" : "feel",
          from: askFrom(meta),
          activity_id: String(meta.activity_id ?? ""),
          session_id: String(meta.session_id ?? ""),
          reason: typeof meta.reason === "string" ? meta.reason : null,
        }
      : null,
    weekly: m.kind === "weekly" ? toApiWeeklyMeta(meta as unknown as Partial<WeeklyMessageMeta>) : null,
    proposal: proposals[0] ?? null,
    proposals,
    constraint: constraint ? toApiConstraint(constraint) : null,
    proposal_rejected: meta.proposal_rejected === true,
    // Rows written before the worker stored the fixed line still hold the provider's wording: never shown.
    error: typeof meta.error === "string" && meta.error ? REPLY_FAILED : null,
    created_at: new Date(m.created_at).toISOString(),
  };
}

/**
 * Where an ask's pick came from. A feel question only follows a check-in chip; a
 * mismatch question says so in `from` — older ones (before the field) came from a
 * chip when they carry a checkin_id, from the report page otherwise.
 */
function askFrom(meta: Record<string, unknown>): "checkin" | "report" {
  if (meta.kind !== "mismatch") return "checkin";
  if (meta.from === "checkin" || meta.from === "report") return meta.from;
  return meta.checkin_id ? "checkin" : "report";
}

function toApiWeeklyMeta(meta: Partial<WeeklyMessageMeta>): ApiCoachMessage["weekly"] {
  return {
    week_start: meta.week_start ?? "",
    asks: Array.isArray(meta.asks)
      ? meta.asks.map((a) => ({ session_id: a.session_id, label: a.label, date: a.date, question: weeklyAskQuestion(a.date, a.label), state: a.state ?? "open" }))
      : [],
    updated: meta.updated && typeof meta.updated.at === "string" ? { at: meta.updated.at, reason: meta.updated.reason ?? "" } : null,
    cancelled: Array.isArray(meta.cancelled) ? meta.cancelled : [],
  };
}

/** The proposal cards and the 記下來 constraints attached to these messages, keyed by id. */
async function cardsFor(userId: string, messages: CoachMessageRow[]): Promise<Cards> {
  const ids = messages.flatMap((m) => proposalIds((m.meta ?? {}) as Record<string, unknown>)).filter((id) => UUID_RE.test(id));
  const cids = messages.map((m) => (m.meta as { constraint_id?: unknown } | null)?.constraint_id).filter((id): id is string => typeof id === "string" && UUID_RE.test(id));
  const rows = ids.length ? await query<ProposalRow>("select * from proposals where user_id = $1 and id = any($2::uuid[])", [userId, ids]) : [];
  const cs = await constraintsByIds(userId, cids);
  return { proposals: new Map(rows.map((p) => [p.id, p])), constraints: new Map(cs.map((c) => [c.id, c])) };
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
  const cards = await cardsFor(userId, rows);
  return json<CoachResponse>(200, { coach: { name: COACH_NAME }, messages: rows.reverse().map((m) => toApiCoachMessage(m, cards)) });
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
    await postCoachMessage({ user_id: userId, role: "coach", kind: "chat", text: "好，這趟不算。改變主意的話按「重新選」。" });
    // The activity stays unplanned, but the week's review (if already written without it) should list it.
    if (checkin.activity_id) {
      const a = await queryOne<{ date: string; sport_type: string | null }>(
        "select to_char(start_time at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as date, sport_type from activities where id = $1 and user_id = $2",
        [checkin.activity_id, userId],
      );
      const w = a ? await reviewMissingActivity(userId, checkin.activity_id, a.date) : undefined;
      if (a && w) await requestWeeklyRerun({ user_id: userId, weekly_review_id: w.id, reason: `${shortDate(a.date)} 的 ${sportName(a.sport_type)} 進來了`, activity_id: checkin.activity_id });
    }
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

  // Does the pick look right? A walk on a long-run day, a run far shorter than the
  // session: Woo asks "真的是這趟嗎？" instead of the feel question (POST /coach/messages
  // { answer_to, confirm_match } settles it).
  const activity = await queryOne<ActivityRow>("select * from activities where id = $1 and user_id = $2", [activityId, userId]);
  const session = await queryOne<PlannedSessionRow>(
    `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions ps join plans p on p.id = ps.plan_id
      where ps.id = $1 and p.user_id = $2`,
    [sessionId, userId],
  );
  const reason = activity && session ? mismatchReason(activity, session) : null;
  if (reason && session) {
    await postMismatchAsk(userId, { from: "checkin", activity_id: activityId, session_id: sessionId, reason, checkin_id: checkin.id, pick_id: pick.id }, session.scheduled_date, session);
    await query("update coach_messages set status = 'sent' where id = $1", [pick.id]);
  } else {
    await queueCoachAsk(userId, pick.id);
  }
  const [c] = await query<CoachMessageRow>("select * from coach_messages where id = $1", [checkin.id]);
  return json<PostCheckinPickResponse>(200, { checkin: toApiCoachMessage(c), pick: toApiCoachMessage(pick) });
}

/** Woo's feel question follows the pick (worker); without a queue the pick is just settled. */
async function queueCoachAsk(userId: string, pickId: string): Promise<void> {
  if (process.env.QUEUE_URL) {
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MessageBody: JSON.stringify({ type: "coach_ask", user_id: userId, message_id: pickId } satisfies CoachAskJob),
    }));
  } else {
    await query("update coach_messages set status = 'sent' where id = $1", [pickId]);
  }
}

/** 選錯了 / 重新選: undo the pick (or the dismissal) and ask the same question again. */
async function postCheckinReset(userId: string, checkinId: string) {
  if (!UUID_RE.test(checkinId)) return json(400, { error: "invalid check-in id" });
  const checkin = await queryOne<CoachMessageRow>("select * from coach_messages where id = $1 and user_id = $2 and kind = 'checkin'", [checkinId, userId]);
  if (!checkin) return json(404, { error: "check-in not found" });
  const m = await resetCheckin(userId, checkin);
  if (typeof m === "string") return json(409, { error: m });
  return json<PostCheckinResetResponse>(200, { checkin: toApiCoachMessage(m) });
}

// ---- 肌力 day: Woo's checklist ----------------------------------------------------

function toApiRoutine(r: SessionRoutineRow): ApiRoutine {
  return {
    id: r.id, session_id: r.session_id, place: r.place, status: r.status, minutes: r.minutes, rules: r.rules,
    items: Array.isArray(r.items) ? r.items.map((i) => ({ name: i.name, how: i.how ?? null, done: !!i.done })) : [],
    error: r.error, rpe: r.rpe, note: r.note,
    completed_at: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    created_at: new Date(r.created_at).toISOString(),
  };
}

async function ownSession(userId: string, sessionId: string): Promise<PlannedSessionRow | undefined> {
  if (!UUID_RE.test(sessionId)) return undefined;
  return queryOne<PlannedSessionRow>(
    `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions ps join plans p on p.id = ps.plan_id
      where ps.id = $1 and p.user_id = $2 and ps.superseded = false`,
    [sessionId, userId],
  );
}

async function postRoutine(userId: string, sessionId: string, raw: string) {
  let body: PostRoutineRequest;
  try {
    body = JSON.parse(raw) as PostRoutineRequest;
  } catch {
    return json(400, { error: "invalid json" });
  }
  if (body.place !== "home" && body.place !== "gym") return json(400, { error: "place must be home or gym" });
  const session = await ownSession(userId, sessionId);
  if (!session) return json(404, { error: "session not found" });

  const existing = await queryOne<SessionRoutineRow>("select * from session_routines where session_id = $1", [session.id]);
  if (existing && !body.regenerate) return json<PostRoutineResponse>(200, { routine: toApiRoutine(existing) });
  if (existing?.completed_at) return json(409, { error: "routine already completed" });
  if (existing) await query("delete from session_routines where id = $1", [existing.id]);

  const [r] = await query<SessionRoutineRow>(
    `insert into session_routines (id, session_id, user_id, place, status) values ($1, $2, $3, $4, 'pending') returning *`,
    [randomUUID(), session.id, userId, body.place],
  );
  if (process.env.QUEUE_URL) {
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MessageBody: JSON.stringify({ type: "routine", user_id: userId, routine_id: r.id } satisfies RoutineJob),
    }));
  }
  return json<PostRoutineResponse>(202, { routine: toApiRoutine(r) });
}

async function putRoutine(userId: string, sessionId: string, raw: string) {
  let body: PutRoutineRequest;
  try {
    body = JSON.parse(raw) as PutRoutineRequest;
  } catch {
    return json(400, { error: "invalid json" });
  }
  const session = await ownSession(userId, sessionId);
  if (!session) return json(404, { error: "session not found" });
  const r = await queryOne<SessionRoutineRow>("select * from session_routines where session_id = $1 and user_id = $2", [session.id, userId]);
  if (!r) return json(404, { error: "no routine yet" });
  if (r.status !== "ready") return json(409, { error: "routine is not ready" });

  let items = r.items;
  if (body.done !== undefined) {
    if (!Array.isArray(body.done) || body.done.length !== items.length || body.done.some((d) => typeof d !== "boolean")) return json(400, { error: "done must be one boolean per item" });
    items = items.map((i, idx) => ({ ...i, done: body.done![idx] }));
  }
  let rpe = r.rpe;
  if (body.rpe !== undefined) {
    if (body.rpe !== null && (!Number.isInteger(body.rpe) || body.rpe < 1 || body.rpe > 10)) return json(400, { error: "rpe must be 1-10" });
    rpe = body.rpe;
  }
  let note = r.note;
  if (body.note !== undefined) {
    if (body.note !== null && typeof body.note !== "string") return json(400, { error: "note must be a string" });
    note = body.note ? body.note.trim().slice(0, 500) || null : null;
  }
  const completing = body.complete === true && !r.completed_at;
  const [updated] = await query<SessionRoutineRow>(
    `update session_routines set items = $2, rpe = $3, note = $4, completed_at = case when $5 then now() else completed_at end where id = $1 returning *`,
    [r.id, JSON.stringify(items), rpe, note, completing],
  );
  if (completing) await postRoutineDone(userId, updated, session);
  return json<PutRoutineResponse>(200, { routine: toApiRoutine(updated) });
}

/**
 * "是，就是這趟" (confirm_match true): the pick stands — after a check-in chip Woo's feel
 * question follows; after a report-page pick (no check-in, no pick message) the verdict
 * that PUT …/session held back is queued now.
 * "不是，重選" (false): after a chip the check-in is reset (activity unassigned, fresh
 * chips); after a report-page pick the activity is just unassigned again (the report
 * page is where to pick next; no new check-in). The athlete's words are kept as a
 * plain line; no model reply.
 */
async function answerMismatch(userId: string, ask: CoachMessageRow, text: string, confirm: boolean | undefined) {
  if (typeof confirm !== "boolean") return json(400, { error: "confirm_match is required for this question" });
  const am = (ask.meta ?? {}) as unknown as MismatchAskMeta;
  const m = await postCoachMessage({ user_id: userId, role: "athlete", kind: "chat", text, status: "sent", activity_id: ask.activity_id, meta: { answer_to: ask.id, confirm_match: confirm } });
  if (confirm) {
    await query("update coach_messages set meta = coalesce(meta, '{}'::jsonb) || '{\"state\":\"answered\"}'::jsonb where id = $1", [ask.id]);
    if (am.pick_id) {
      // The pick goes back to pending so the worker's feel question runs for it (its redelivery guard is the status).
      await query("update coach_messages set status = 'pending' where id = $1 and user_id = $2 and kind = 'pick'", [am.pick_id, userId]);
      await queueCoachAsk(userId, am.pick_id);
    } else {
      const activity = await queryOne<{ strava_activity_id: string }>("select strava_activity_id from activities where id = $1 and user_id = $2", [am.activity_id, userId]);
      if (activity) await requeue(userId, activity.strava_activity_id, "match confirmed");
    }
  } else if (am.checkin_id) {
    const checkin = await queryOne<CoachMessageRow>("select * from coach_messages where id = $1 and user_id = $2 and kind = 'checkin'", [am.checkin_id, userId]);
    if (!checkin) return json(404, { error: "check-in not found" });
    const r = await resetCheckin(userId, checkin); // closes this ask too
    if (typeof r === "string") return json(409, { error: r });
  } else {
    await undoPick(userId, am.activity_id, am.session_id); // closes this ask too
  }
  return json<PostCoachMessageResponse>(200, { message: toApiCoachMessage(m) });
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
    const am = (ask.meta ?? {}) as { activity_id?: string; state?: string; kind?: string };
    if (am.state !== "open") return json(409, { error: "already answered" });
    if (am.kind === "mismatch") return answerMismatch(userId, ask, text, body.confirm_match);
    if (body.confirm_match !== undefined) return json(400, { error: "confirm_match only answers a mismatch question" });
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

  // 請 Woo 重看: the stale card goes into Woo's briefing (the worker reads it from the message's meta).
  let reProposeId: string | null = null;
  if (body.re_propose !== undefined && body.re_propose !== null) {
    if (typeof body.re_propose !== "string" || !UUID_RE.test(body.re_propose)) return json(400, { error: "invalid re_propose" });
    const stale = await queryOne<{ status: string }>("select status from proposals where id = $1 and user_id = $2", [body.re_propose, userId]);
    if (!stale) return json(404, { error: "proposal not found" });
    if (stale.status !== "stale") return json(409, { error: `proposal is ${stale.status}, not stale` });
    reProposeId = body.re_propose;
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
    activity_id: body.activity_id ?? null, meta: quote || reProposeId ? { ...(quote ? { quote } : {}), ...(reProposeId ? { re_propose: reProposeId } : {}) } : null,
  });
  if (process.env.QUEUE_URL) {
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MessageBody: JSON.stringify({ type: "coach_reply", user_id: userId, message_id: m.id } satisfies CoachReplyJob),
    }));
  }
  return json<PostCoachMessageResponse>(202, { message: toApiCoachMessage(m) });
}
