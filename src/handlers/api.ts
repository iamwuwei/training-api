import { randomUUID } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { isDbWaking, type Querier, query, queryOne, withTransaction } from "../lib/db";
import { appendDone, type CheckinMeta, type MismatchAskMeta, mismatchReason, postMismatchAsk, resetCheckin, undoPick } from "../lib/checkin";
import { COACH_NAME, MAX_MESSAGE_CHARS, postCoachMessage, REPLY_FAILED } from "../lib/coach";
import { constraintsByIds, loadActiveConstraints } from "../lib/constraints";
import { countsWeekNo, shortDate, sportName, weeklyAskQuestion } from "../lib/labels";
import { applyChange, applyProposal, changeConflict, postProposalApplied } from "../lib/proposals";
import { deauthorize } from "../lib/strava";
import { elapsedSql, loadGroup, combineGroup, MAX_PER_SESSION, overlaps, regroupReview, requeueReview, SEGMENT_SELECT, sameKind } from "../lib/session-group";
import { postRoutineDone } from "../lib/strength";
import { COACH_STAGES } from "../lib/stage";
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
  PutDetailsRequest,
  PutDetailsResponse,
  DetailOptionsResponse,
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
//   PUT /activities/{id}/details     the athlete's own shoe / device / weather (shown over Strava's; no review, no job)
//   GET /activities/detail-options   shoe / device names this athlete used before, for the editor's suggestions
//   POST /activities/{id}/rereview   drop the Claude review (failed or stale) and queue a new one
//   GET /weekly                      weekly coach reviews with their adjustment proposals
//   POST /weekly/{id}/adjustments/{index}   apply or dismiss one proposal
//   POST /weekly/{id}/asks/{session_id}     answer the review's question about a session without a record (synced / skipped)
//   POST /proposals/{id}/apply|dismiss      a proposal card (chat or weekly review): apply all of it at once (409 plan_changed when a session moved under it), or dismiss
//   POST /constraints/{id}/accept|dismiss   Woo's 記下來 card: remember it / not; dismiss also deletes an active one (settings)
//   GET /coach?limit&before          the coach's thread (weekly reviews, verdicts, chat), newest `limit` (default 10), or the ones before message `before`; has_more
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

const json = <T extends MeResponse | DeleteStravaResponse | PlanResponse | ActivitiesResponse | PutReviewResponse | PutSessionResponse | PutMemoResponse | PutDetailsResponse | DetailOptionsResponse | RereviewResponse | WeeklyResponse | PostAdjustmentResponse | CoachResponse | PostCoachMessageResponse | PutCoachSeenResponse | PostCheckinPickResponse | PostCheckinResetResponse | PostRoutineResponse | PutRoutineResponse | PostWeeklyAskResponse | PostProposalResponse | PostConstraintResponse | PlanChangedResponse | ErrorResponse>(
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
  if (method === "GET" && path === "/activities/detail-options") return getDetailOptions(user.id);

  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
  const sub = /^\/activities\/([^/]+)\/(review|session|memo|details)$/.exec(path);
  if (method === "PUT" && sub) {
    if (sub[2] === "review") return putReview(user.id, sub[1], raw);
    if (sub[2] === "session") return putSession(user.id, sub[1], raw);
    if (sub[2] === "details") return putDetails(user.id, sub[1], raw);
    return putMemo(user.id, sub[1], raw);
  }
  const re = /^\/activities\/([^/]+)\/rereview$/.exec(path);
  if (method === "POST" && re) return rereview(user.id, re[1]);

  if (method === "GET" && path === "/weekly") return getWeekly(user.id);
  if (method === "GET" && path === "/coach") return getCoach(user.id, q);
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
  a.gear_name, a.weather, a.gear_name_user, a.device_name_user, a.weather_user, a.details_updated_at, a.memo, a.rpe, a.memo_updated_at, a.splits, a.match_status,
  r.verdict as r_verdict, r.comment as r_comment, r.reminders as r_reminders,
  r.source as r_source, r.model as r_model, r.adjust_hint as r_adjust_hint, r.created_at as r_created_at,
  ${elapsedSql("a")} as elapsed_time_sec, ${SEGMENT_SELECT}`;

type ActivityJoined = Omit<ActivityRow, "raw"> & {
  elapsed_time_sec: number | null;
  seg_count: number | null;
  seg_index: number | null;
  seg_primary: string | null;
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

/** Shoe / device / weather: the athlete's value over Strava's, and where the shown one came from. */
function detailOf(user: string | null, strava: string | null): ApiActivity["details"]["gear_name"] {
  return { source: user != null ? "user" : strava != null ? "strava" : null, strava };
}

function toApiActivity(a: ActivityJoined): ApiActivity {
  const {
    r_verdict, r_comment, r_reminders, r_source, r_model, r_adjust_hint, r_created_at,
    gear_name_user, device_name_user, weather_user, details_updated_at,
    seg_count, seg_index, seg_primary,
    ...rest
  } = a;
  return {
    ...rest,
    segment: seg_count != null && seg_index != null && seg_primary != null ? { primary_activity_id: seg_primary, index: seg_index, count: seg_count } : null,
    gear_name: gear_name_user ?? a.gear_name,
    device_name: device_name_user ?? a.device_name,
    weather: weather_user ?? a.weather,
    details: {
      gear_name: detailOf(gear_name_user, a.gear_name),
      device_name: detailOf(device_name_user, a.device_name),
      weather: detailOf(weather_user, a.weather),
    },
    details_updated_at: details_updated_at ? new Date(details_updated_at).toISOString() : null,
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

  // Not superseded, plus the moved rows (superseded, with a make-up row): `mt` is the make-up row, `mf` the row this one replaced.
  const sessions = await query<PlannedSessionRow & { moved_to_date: string | null; moved_from_date: string | null; moved_to_counts: number | null }>(
    `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
            to_char(mt.scheduled_date, 'YYYY-MM-DD') as moved_to_date, mt.counts_in_week_no as moved_to_counts,
            to_char(mf.scheduled_date, 'YYYY-MM-DD') as moved_from_date
       from planned_sessions ps
       left join planned_sessions mt on mt.id = ps.moved_to_session_id
       left join planned_sessions mf on mf.id = ps.moved_from_session_id
      where ps.plan_id = $1 and (ps.superseded = false or ps.moved_to_session_id is not null)
      order by ps.scheduled_date, ps.superseded desc`,
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
    sessions: sessions.map((s) => toApiSession(s, weeks)),
    activities: activities.map(toApiActivity),
    unassigned: unassigned.map(toApiActivity),
    routines: routines.map(toApiRoutine),
    constraints: constraints.map(toApiConstraint),
  });
}

const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** `counts_in_week_no` is computed here (labels.ts countsWeekNo) so the app does not re-derive it; the extra join columns do not leave. */
const toApiSession = (s: PlannedSessionRow & { moved_to_date?: string | null; moved_from_date?: string | null; moved_to_counts?: number | null }, weeks: PlanWeekRow[]): ApiSession => {
  const { moved_to_counts, ...row } = s;
  return {
    ...row,
    skipped_at: s.skipped_at ? new Date(s.skipped_at).toISOString() : null,
    moved_to_session_id: s.moved_to_session_id ?? null,
    moved_to_date: s.moved_to_date ?? null,
    moved_from_session_id: s.moved_from_session_id ?? null,
    moved_from_date: s.moved_from_date ?? null,
    counts_in_week_no: countsWeekNo({ ...s, moved_to_counts }, weeks),
  };
};

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
  const append = body.append === true; // anything but a real boolean true is "not append"
  if (append && body.replace === true) return json(400, { error: "append and replace are exclusive" });

  const activity = await queryOne<{ id: string; match_status: MatchStatus; session_id: string | null }>(
    "select id, match_status, session_id from activities where id = $1 and user_id = $2",
    [activityId, userId],
  );
  if (!activity) return json(404, { error: "activity not found" });

  const withMemo = body.memo !== undefined || body.rpe !== undefined;
  const memoFields = withMemo ? parseMemo(body) : null;
  if (typeof memoFields === "string") return json(400, { error: memoFields });

  if (body.session_id === null || body.session_id === undefined) {
    const status = body.status ?? "unplanned";
    if (status !== "unplanned" && status !== "ignored") return json(400, { error: "status must be unplanned or ignored" });
    await query("update activities set session_id = null, match_status = $2 where id = $1 and user_id = $3", [activityId, status, userId]);
    await query("delete from reviews where activity_id = $1 and source = 'claude'", [activityId]);
    // One segment left the session (unplanned or ignored): the others keep it, and Woo looks at what is left.
    if (activity.session_id) await regroupReview(userId, activity.session_id, "segment removed");
  } else {
    const assigned = await assignSession(userId, activityId, body.session_id, { replace: body.replace === true, append });
    if (assigned && "status" in assigned) return json(assigned.status, { error: assigned.error });
    // Appending an activity that is already one of this session's segments (a retried request, a double tap, a second
    // tab): nothing to add. No second fixed line, no second review; a memo that came along is still saved.
    const alreadyHere = assigned !== null;
    if (memoFields) {
      await query("update activities set memo = $2, rpe = $3, memo_updated_at = now() where id = $1 and user_id = $4", [activityId, memoFields.memo, memoFields.rpe, userId]);
    }
    if (alreadyHere) {
      if (memoFields) await regroupReview(userId, body.session_id, "memo updated");
      const [cur] = await query<ActivityJoined>(
        `select ${ACTIVITY_SELECT} from activities a left join reviews r on r.activity_id = a.id where a.id = $1 and a.user_id = $2`,
        [activityId, userId],
      );
      return json<PutSessionResponse>(200, { activity: toApiActivity(cur) });
    }
    const session = await queryOne<PlannedSessionRow>(
      `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions ps join plans p on p.id = ps.plan_id
        where ps.id = $1 and p.user_id = $2`,
      [body.session_id, userId],
    );
    // Woo's check-in for this session (or, on a rest day, for this activity) is answered by
    // this pick: close it like a chip pick would, so /plan stops saying Woo is waiting.
    // The check-in's "selected" record lets 選錯了 (reset) undo this pick the same way.
    const group = await loadGroup(userId, body.session_id); // this activity is in it now
    // One more segment: only a check-in still waiting (open) is answered by it. A check-in already picked keeps the
    // activity it was picked with, so 選錯了 on it still takes back that one, not the segment added later.
    if (session) await closeCheckinFor(userId, activityId, session, { openOnly: append && group.length > 1 });
    if (append && group.length > 1) {
      // One more segment: Woo's fixed line, the session's Claude review dropped and written again over the whole group.
      await appendDone(userId, body.session_id);
    } else if (group.length) {
      // The Claude verdict was about the old session / group: drop it and let the worker regenerate one against
      // the new one (manual reviews are kept).
      const primary = group[0];
      const dropped = await query<{ id: string }>(
        "delete from reviews where activity_id = any($1::uuid[]) and source = 'claude' returning id",
        [group.map((g) => g.id)],
      );
      const hasManual = await queryOne<{ id: string }>("select id from reviews where activity_id = $1", [primary.id]);
      // Same doubt check as after a check-in chip: a walk on a long-run day, a run far shorter than the
      // session (the whole session, not this segment). Then Woo asks 真的是這趟嗎 (POST /coach/messages
      // { answer_to, confirm_match }) and the verdict waits for the answer.
      const reason = session ? mismatchReason(combineGroup(group), session) : null;
      if (reason && session) {
        // An earlier open question about this activity (a feel question, an older doubt) is about the old pick.
        await query(
          `update coach_messages set meta = coalesce(meta, '{}'::jsonb) || '{"state":"closed"}'::jsonb
            where user_id = $1 and kind = 'ask' and activity_id = $2 and meta->>'state' = 'open'`,
          [userId, activityId],
        );
        await postMismatchAsk(userId, { from: "report", activity_id: activityId, session_id: session.id, reason, checkin_id: null, pick_id: null }, session.scheduled_date, session);
      } else if (dropped.length > 0 || !hasManual) {
        await requeueReview(userId, primary.id, "session reassigned");
      }
    }
  }

  const [row] = await query<ActivityJoined>(
    `select ${ACTIVITY_SELECT} from activities a left join reviews r on r.activity_id = a.id where a.id = $1 and a.user_id = $2`,
    [activityId, userId],
  );
  return json<PutSessionResponse>(200, { activity: toApiActivity(row) });
}

type AssignOpts = { replace: boolean; append: boolean };

/**
 * Point `activityId` at `sessionId` (match_status confirmed). Nothing held yet: just assign. `append`: next to the
 * activities already there (they stay), refused when the session is full (MAX_PER_SESSION), the kinds differ
 * (a walk next to runs) or two recordings overlap in time; the activity already being one of them is a no-op.
 * Otherwise a confirmed holder is a 409 unless `replace`, and every holder is bumped (all of them, not only one).
 * An activity that sits in ANOTHER session together with other segments is not moved (409, SOURCE_HAS_SEGMENTS): that
 * session's review would be left about a group that no longer exists, so the athlete removes it there first
 * (regroupReview re-judges what is left); alone in its source session it moves as it always did.
 * No review is queued here.
 */
async function assignSession(userId: string, activityId: string, sessionId: string, opts: AssignOpts): Promise<{ status: number; error: string } | { alreadyHere: true } | null> {
  if (!UUID_RE.test(sessionId)) return { status: 400, error: "invalid session id" };
  const session = await queryOne<{ id: string }>(
    `select ps.id from planned_sessions ps join plans p on p.id = ps.plan_id
      where ps.id = $1 and p.user_id = $2 and ps.superseded = false`,
    [sessionId, userId],
  );
  if (!session) return { status: 404, error: "session not found" };
  const me = await queryOne<AssignRow & { session_id: string | null }>(
    `select a.id, a.session_id, a.match_status, a.sport_type, a.start_time, coalesce(${elapsedSql("a")}, a.moving_time_sec) as elapsed_sec from activities a where a.id = $1 and a.user_id = $2`,
    [activityId, userId],
  );
  if (!me) return { status: 404, error: "activity not found" };
  // Moving a segment out of a session that has other segments would leave that session with a review about a different
  // group (or none at all, when it was the primary that moved) and no job to fix it. Not allowed: remove it there first
  // (PUT …/session { session_id: null }, which re-judges what is left), then bind it here. Nothing is changed.
  const movedFrom = me.session_id && me.session_id !== session.id && me.match_status !== "ignored" ? me.session_id : null;
  if (movedFrom && (await hasOtherSegments(query, userId, movedFrom, activityId))) return { status: 409, error: SOURCE_HAS_SEGMENTS };

  if (opts.append) {
    // The count / kind / overlap checks and the write are one step per session: two appends to the same session at the
    // same time (two tabs, the check-in and the today page) must not both pass the cap. The lock is per user and session
    // and lives only as long as this transaction.
    return withTransaction(async (q) => {
      await q("select pg_advisory_xact_lock(hashtext($1))", [`${userId}:${session.id}`]);
      // Read under the lock: a request that waited for the lock finds the activity already added by the one before it.
      const [now] = await q<{ session_id: string | null; match_status: MatchStatus }>("select session_id, match_status from activities where id = $1 and user_id = $2", [activityId, userId]);
      if (now?.session_id === session.id && now.match_status !== "ignored") return { alreadyHere: true as const };
      const holders = await q<AssignRow>(HOLDERS_SQL, [session.id, activityId, userId]);
      if (holders.length) {
        if (holders.length + 1 > MAX_PER_SESSION) return { status: 409, error: `too many activities for one session (${MAX_PER_SESSION})` };
        if (holders.some((h) => !sameKind(me, h))) return { status: 409, error: "segments must be the same kind of activity" };
        if (holders.some((h) => overlaps(me, h))) return { status: 409, error: "activities overlap in time" };
      }
      await q("update activities set session_id = $2, match_status = 'confirmed' where id = $1 and user_id = $3", [activityId, session.id, userId]);
      return null;
    });
  }

  const holders = await query<AssignRow>(HOLDERS_SQL, [session.id, activityId, userId]);
  if (holders.length) {
    if (holders.some((h) => h.match_status === "confirmed") && !opts.replace) return { status: 409, error: "session already confirmed for another activity" };
    // The bumped holders are unassigned exactly like 選錯了 does it: Claude review dropped, Woo's open
    // question about them (a feel question after a chip) closed — otherwise that question stays open
    // forever and /plan keeps saying Woo is waiting for an answer. The new activity's pick re-judges the session.
    for (const h of holders) await undoPick(userId, h.id, session.id, { regroup: false });
  }
  await query("update activities set session_id = $2, match_status = 'confirmed' where id = $1 and user_id = $3", [activityId, session.id, userId]);
  return null;
}

const SOURCE_HAS_SEGMENTS = "source session has other segments, remove it there first";

/** Does `sessionId` (the session an activity is being moved out of) hold any activity besides `activityId`? */
async function hasOtherSegments(q: Querier, userId: string, sessionId: string, activityId: string): Promise<boolean> {
  const [x] = await q<{ n: number }>(
    "select count(*)::int as n from activities where session_id = $1 and id <> $2 and user_id = $3 and match_status <> 'ignored'",
    [sessionId, activityId, userId],
  );
  return (x?.n ?? 0) > 0;
}

/** The session's other activities (not ignored), in group order. */
const HOLDERS_SQL = `select a.id, a.match_status, a.sport_type, a.start_time, coalesce(${elapsedSql("a")}, a.moving_time_sec) as elapsed_sec
       from activities a where a.session_id = $1 and a.id <> $2 and a.user_id = $3 and a.match_status <> 'ignored'
      order by a.start_time, a.id`;

type AssignRow = { id: string; match_status: MatchStatus; sport_type: string | null; start_time: Date; elapsed_sec: number };

/**
 * The report page assigned `activityId` to `session`: the check-in that this answers —
 * the one for that session's day (activity mode: "today's session is X, which
 * activity?") or, on a rest day, the one about this activity (session mode: "which
 * session should it count for?") — goes to `picked`, as a chip pick would, so /plan
 * stops saying Woo is waiting. A check-in already picked for this session (the chip
 * chose another activity, the report page replaces it) is re-pointed, so 選錯了 undoes
 * the activity that holds the session now. Another day's check-in is left alone.
 */
async function closeCheckinFor(userId: string, activityId: string, session: Pick<PlannedSessionRow, "id" | "scheduled_date">, opts: { openOnly: boolean } = { openOnly: false }): Promise<void> {
  const checkin = await queryOne<CoachMessageRow>(
    `select * from coach_messages where user_id = $1 and kind = 'checkin' and meta->>'state' = any($4::text[])
        and ((meta->>'mode' in ('activity', 'append') and meta->>'session_id' = $2)
          or (meta->>'mode' = 'session' and activity_id = $3)
          or meta->'picked'->>'session_id' = $2)
      order by created_at desc limit 1`,
    [userId, session.id, activityId, opts.openOnly ? ["open"] : ["open", "picked"]],
  );
  if (!checkin) return;
  const meta = (checkin.meta ?? {}) as unknown as CheckinMeta;
  await query("update coach_messages set meta = $2 where id = $1", [checkin.id, JSON.stringify({ ...meta, state: "picked", picked: { activity_id: activityId, session_id: session.id } } satisfies CheckinMeta)]);
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

  const activity = await queryOne<{ id: string; session_id: string | null }>(
    "select id, session_id from activities where id = $1 and user_id = $2",
    [activityId, userId],
  );
  if (!activity) return json(404, { error: "activity not found" });

  await query("update activities set memo = $2, rpe = $3, memo_updated_at = now() where id = $1 and user_id = $4", [activityId, memo, rpe, userId]);

  // Let Claude take the athlete's words into account: drop the session's Claude review and requeue
  // (the review is the session's, on its primary activity, whichever segment the memo is on).
  if (activity.session_id) await regroupReview(userId, activity.session_id, "memo updated");

  const [row] = await query<ActivityJoined>(
    `select ${ACTIVITY_SELECT} from activities a left join reviews r on r.activity_id = a.id where a.id = $1`,
    [activityId],
  );
  return json<PutMemoResponse>(200, { activity: toApiActivity(row) });
}

const DETAIL_MAX_CHARS = 40;
/** C0 and C1 controls, zero-width / direction marks (U+200B-200F, 202A-202E, 2066-2069) and the BOM: shown as nothing, so they become a space. */
const DETAIL_INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const DETAIL_FIELDS = ["gear_name", "device_name", "weather"] as const;

/**
 * One value of PUT …/details: a string becomes single-line text (control characters and runs of
 * whitespace -> one space, trimmed); "" / null / nothing left means clear (value null). `error` is the 400 text.
 */
function cleanDetail(v: unknown, field: string): { value: string | null } | { error: string } {
  if (v === null) return { value: null };
  if (typeof v !== "string") return { error: `${field} must be a string` };
  const clean = v.replace(DETAIL_INVISIBLE, " ").replace(/\s+/g, " ").trim();
  if (clean.length > DETAIL_MAX_CHARS) return { error: `${field} too long (${DETAIL_MAX_CHARS} chars)` };
  return { value: clean || null };
}

/**
 * The athlete's own shoe / device / weather. Writes only the *_user columns (Strava's sync never
 * touches them), so a later sync cannot overwrite them. A value equal to Strava's own is stored as
 * null: the athlete "set" what Strava already says, which must not read as a manual edit.
 * No review is dropped and no job is queued: these fields do not go into any prompt.
 */
async function putDetails(userId: string, activityId: string, raw: string) {
  if (!UUID_RE.test(activityId)) return json(400, { error: "invalid activity id" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid json" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "body must be an object" });
  const req = body as PutDetailsRequest;
  const sets: string[] = [];
  const params: unknown[] = [activityId, userId];
  for (const field of DETAIL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(req, field)) continue; // absent: left alone
    const cleaned = cleanDetail(req[field], field);
    if ("error" in cleaned) return json(400, { error: cleaned.error });
    params.push(cleaned.value);
    const column = field; // a fixed name from DETAIL_FIELDS, never from the request
    sets.push(`${column}_user = case when $${params.length}::text = ${column} then null else $${params.length}::text end`);
  }
  if (!sets.length) return json(400, { error: "nothing to update" });

  const hit = await query<{ id: string }>(
    `update activities set ${sets.join(", ")}, details_updated_at = now() where id = $1 and user_id = $2 returning id`,
    params,
  );
  if (!hit.length) return json(404, { error: "activity not found" });

  const [row] = await query<ActivityJoined>(
    `select ${ACTIVITY_SELECT} from activities a left join reviews r on r.activity_id = a.id where a.id = $1 and a.user_id = $2`,
    [activityId, userId],
  );
  return json<PutDetailsResponse>(200, { activity: toApiActivity(row) });
}

/** Shoe / device names this athlete had before (their own and Strava's), most recently used first. */
async function getDetailOptions(userId: string) {
  const names = async (column: "gear_name" | "device_name"): Promise<string[]> =>
    (await query<{ v: string }>(
      `select v from (
         select ${column}_user as v, coalesce(details_updated_at, start_time) as t from activities where user_id = $1 and ${column}_user is not null
         union all
         select ${column} as v, start_time as t from activities where user_id = $1 and ${column} is not null and ${column} <> ''
       ) s group by v order by max(t) desc, v limit 8`,
      [userId],
    )).map((r) => r.v);
  return json<DetailOptionsResponse>(200, { gear_name: await names("gear_name"), device_name: await names("device_name") });
}

/** Drop the Claude review (failed, stale or just unwanted) and have the worker write a new one. */
async function rereview(userId: string, activityId: string) {
  if (!UUID_RE.test(activityId)) return json(400, { error: "invalid activity id" });
  const activity = await queryOne<{ id: string; session_id: string | null }>(
    "select id, session_id from activities where id = $1 and user_id = $2",
    [activityId, userId],
  );
  if (!activity) return json(404, { error: "activity not found" });
  if (!activity.session_id) return json(409, { error: "assign the activity to a session first" });
  // The review is the session's: it sits on the group's primary activity, whichever segment's report asked.
  const primary = (await loadGroup(userId, activity.session_id))[0];
  if (!primary) return json(409, { error: "assign the activity to a session first" });
  const manual = await queryOne<{ id: string }>("select id from reviews where activity_id = $1 and source = 'manual'", [primary.id]);
  if (manual) return json(409, { error: "a manual review is kept; remove it first" });

  await query("delete from reviews where activity_id = $1 and source = 'claude'", [primary.id]);
  await requeueReview(userId, primary.id, "rereview requested");
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
      makeup: i.makeup === true,
      counts_in_week_no: i.counts_in_week_no ?? null,
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
  const proposal = proposalIds(meta).map((id) => cards?.proposals.get(id)).find((p): p is ProposalRow => !!p);
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
    proposal: proposal ? toApiProposal(proposal) : null,
    constraint: constraint ? toApiConstraint(constraint) : null,
    proposal_rejected: meta.proposal_rejected === true,
    // Progress while Woo works on it: a white-listed value, only for a message that is waiting (or a weekly review being rewritten).
    stage: typeof meta.stage === "string" && COACH_STAGES.has(meta.stage) && (m.status === "pending" || m.kind === "weekly") ? meta.stage : null,
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
    makeups: Array.isArray(meta.makeups) ? meta.makeups : [],
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

const COACH_PAGE_DEFAULT = 10;
const COACH_PAGE_MAX = 100;

/**
 * The thread, oldest first within the page: the newest `limit` messages, or with `before` the
 * `limit` messages older than that one. Keyset on (created_at, id) — created_at alone can tie
 * (rows of one transaction) — compared inside SQL against the `before` row itself, so the
 * microseconds Postgres keeps (a JS Date would cut them to milliseconds) are not lost.
 */
async function getCoach(userId: string, params: Record<string, string | undefined>) {
  let limit = COACH_PAGE_DEFAULT;
  if (params.limit !== undefined) {
    limit = /^\d{1,3}$/.test(params.limit) ? Number(params.limit) : 0;
    if (limit < 1 || limit > COACH_PAGE_MAX) return json(400, { error: "invalid limit" });
  }
  const before = params.before;
  if (before !== undefined) {
    if (!UUID_RE.test(before)) return json(400, { error: "invalid before" });
    // 400, not 404, for another user's message too: the answer must not tell whether an id exists.
    const known = await queryOne<{ id: string }>("select id from coach_messages where id = $1 and user_id = $2", [before, userId]);
    if (!known) return json(400, { error: "unknown before" });
  }

  // Weekly reviews written before the thread existed (or whose post failed) get
  // their message now, dated when the review was written so they sort in place.
  // Only for the newest page: an older page does not write.
  if (before === undefined) await query(
    `insert into coach_messages (id, user_id, role, kind, text, meta, weekly_review_id, status, created_at)
     select gen_random_uuid(), p.user_id, 'coach', 'weekly', coalesce(w.summary, ''),
            jsonb_build_object('week_start', to_char(w.week_start, 'YYYY-MM-DD'), 'backfilled', true),
            w.id, 'sent', w.created_at
       from weekly_reviews w join plans p on p.id = w.plan_id
      where p.user_id = $1 and w.summary is not null
        and not exists (select 1 from coach_messages m where m.weekly_review_id = w.id)`,
    [userId],
  );
  const found = before === undefined
    ? await query<CoachMessageRow>(
        "select * from coach_messages where user_id = $1 order by created_at desc, id desc limit $2",
        [userId, limit + 1],
      )
    : await query<CoachMessageRow>(
        `select * from coach_messages
          where user_id = $1 and (created_at, id) < (select created_at, id from coach_messages where id = $3 and user_id = $1)
          order by created_at desc, id desc limit $2`,
        [userId, limit + 1, before],
      );
  const rows = found.slice(0, limit); // the +1 row only says there is more
  const cards = await cardsFor(userId, rows);
  return json<CoachResponse>(200, {
    coach: { name: COACH_NAME },
    messages: rows.reverse().map((m) => toApiCoachMessage(m, cards)),
    has_more: found.length > limit,
  });
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
    // append mode: the new recording is not another segment of today's session; it stays in 其他活動 (the report page can still add it).
    const appendMode = meta.mode === "append";
    const pick = await postCoachMessage({ user_id: userId, role: "athlete", kind: "pick", text: appendMode ? "不是，另外算" : "都不是", meta: { none: true } });
    await postCoachMessage({ user_id: userId, role: "coach", kind: "chat", text: appendMode ? "好，這趟另外算，留在「其他活動」。要併進去的話到報告頁按「這堂的活動」。" : "好，這趟不算。改變主意的話按「重新選」。" });
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

  // activity / append mode: the chip is an activity, the session is today's; session mode: the reverse.
  const byActivity = meta.mode !== "session";
  const activityId = byActivity ? body.activity_id : checkin.activity_id;
  const sessionId = byActivity ? meta.session_id : body.session_id;
  if (!activityId || !sessionId || !UUID_RE.test(activityId)) return json(400, { error: byActivity ? "activity_id is required" : "session_id is required" });
  const candidate = meta.candidates.find((c) => (byActivity ? c.activity_id === activityId : c.session_id === sessionId));
  if (!candidate) return json(400, { error: "not one of the candidates" });

  if (meta.mode === "append") {
    // One more segment of today's session. A 409 (the session was changed elsewhere meanwhile) goes back as it is.
    const err = await assignSession(userId, activityId, sessionId, { replace: false, append: true });
    if (err && "status" in err) return json(err.status, { error: err.error });
    await setMeta({ state: "picked", picked: { activity_id: activityId, session_id: sessionId } });
    // Already answered about how it felt for the first segment: no feel question, no doubt check; Woo's fixed line and one new review of the whole session.
    const pick = await postCoachMessage({
      user_id: userId, role: "athlete", kind: "pick", text: candidate.label, status: "sent", activity_id: activityId,
      meta: { activity_id: activityId, session_id: sessionId, append: true },
    });
    if (!err) await appendDone(userId, sessionId); // (already a segment of it, e.g. added from the report page meanwhile: nothing more to do)
    const [c] = await query<CoachMessageRow>("select * from coach_messages where id = $1", [checkin.id]);
    return json<PostCheckinPickResponse>(200, { checkin: toApiCoachMessage(c), pick: toApiCoachMessage(pick) });
  }

  const err = await assignSession(userId, activityId, sessionId, { replace: false, append: false });
  if (err && "status" in err) return json(err.status, { error: err.error });
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
      await requeueReview(userId, am.activity_id, "match confirmed");
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
    const activity = await queryOne<{ id: string; session_id: string | null }>(
      "select id, session_id from activities where id = $1 and user_id = $2",
      [am.activity_id ?? "", userId],
    );
    if (!activity) return json(404, { error: "activity not found" });
    await query("update activities set memo = $2, rpe = $3, memo_updated_at = now() where id = $1 and user_id = $4", [activity.id, parsed.memo, parsed.rpe, userId]);
    await query("update coach_messages set meta = coalesce(meta, '{}'::jsonb) || '{\"state\":\"answered\"}'::jsonb where id = $1", [ask.id]);
    const m = await postCoachMessage({
      user_id: userId, role: "athlete", kind: "chat", text, status: "pending", activity_id: activity.id,
      meta: { answer_to: ask.id, rpe: parsed.rpe, stage: "reading" },
    });
    // The review is the session's: every segment's Claude review goes (the one on the primary is the one that matters).
    const groupIds = activity.session_id ? (await loadGroup(userId, activity.session_id)).map((g) => g.id) : [];
    await query("delete from reviews where activity_id = any($1::uuid[]) and source = 'claude'", [[activity.id, ...groupIds]]);
    if (activity.session_id) await requeueReview(userId, activity.id, "check-in answered");
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
    activity_id: body.activity_id ?? null,
    meta: { stage: "preparing", ...(quote ? { quote } : {}), ...(reProposeId ? { re_propose: reProposeId } : {}) }, // the first stage is written here so the app never shows a stage-less wait
  });
  if (process.env.QUEUE_URL) {
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MessageBody: JSON.stringify({ type: "coach_reply", user_id: userId, message_id: m.id } satisfies CoachReplyJob),
    }));
  }
  return json<PostCoachMessageResponse>(202, { message: toApiCoachMessage(m) });
}
