// Wire types for the `api` Lambda behind the API Gateway HTTP API. Self-contained so
// the front-end can copy this file as-is. Dates are ISO strings on the wire.
//
// Auth: every call sends `Authorization: Bearer <Cognito ID token>`. API
// Gateway verifies the JWT; the api maps its `sub` (first time: `email`) to a
// users row. 401 = bad/missing token (from API Gateway), 403 = not registered.

export type SessionType = "easy" | "long" | "tempo" | "interval" | "rest" | "race";
export type MatchStatus = "auto" | "confirmed" | "unplanned" | "ignored";
export type Verdict = "達成" | "達成但有提醒" | "未達成";

// ---- GET <ApiUrl>/me -----------------------------------------------------------

export interface ApiUser {
  id: string;           // users.id (the uuid used by seed / Strava links)
  display_name: string;
  email: string | null;
}

export interface ApiStravaConnection {
  athlete_id: string;   // bigint → string
  scope: string;
  expires_at: string;   // ISO; tokens refresh automatically, informational only
}

export interface MeResponse {
  user: ApiUser;
  strava: ApiStravaConnection | null; // null = not linked yet
  /** Open in a browser to (re)link Strava: <ApiUrl>/strava/oauth/start?user=<id> */
  strava_connect_url: string;
}

/** DELETE <ApiUrl>/me/strava — unlink (revokes on Strava too); activities already imported stay. */
export interface DeleteStravaResponse {
  ok: true;
}

// ---- GET <ApiUrl>/plan ---------------------------------------------------------

export interface ApiPlan {
  id: string;
  user_id: string;
  race_name: string;
  race_date: string; // 'YYYY-MM-DD'
  goal_time_sec: number | null;
  days_per_week: number | null;
  status: string;
}

export interface ApiWeek {
  week_no: number;
  week_start: string; // 'YYYY-MM-DD'
  week_end: string;
  phase: string | null;  // 第一階段｜重建跑量
  focus: string | null;  // 本週重點
}

export interface ApiSession {
  id: string;
  plan_id: string;
  scheduled_date: string; // 'YYYY-MM-DD'
  week_no: number | null;
  phase: string | null;
  label: string | null;   // original 類型: Easy / Recovery / Long / Peak Long / MP / 坡跑 / 坡跑+MP / 快步 / 休息 / 完全休息 / 肌力 / 比賽
  type: SessionType;
  content: string | null; // 內容: "2 km Easy + 3 km @ MP + 2 km Easy"
  note: string | null;    // 備註
  target: string | null;  // verbatim: "7:15〜7:45 / 心拍 140〜150"
  target_distance_m: number | null;
  target_pace_sec_km: number | null;     // midpoint
  target_pace_min_sec_km: number | null; // fastest allowed
  target_pace_max_sec_km: number | null; // slowest allowed
  target_hr_min: number | null;
  target_hr_max: number | null;
  version: number;
  superseded: boolean;
}

export interface ApiSplit {
  distance: number;
  elapsed_time: number;
  moving_time: number;
  elevation_difference: number;
  split: number;
  average_speed: number;
  average_heartrate?: number;
}

/**
 * Coach side (Claude or manual): the verdict on this activity.
 * `failed` = Claude could not review it (API error, refusal …): verdict is null,
 * `error` says why; POST …/rereview tries again. Nothing at all (activity.review
 * null) with a session assigned = still being analysed.
 */
export interface ApiReview {
  verdict: Verdict | null;
  comment: string | null;     // coach comment paragraph
  reminders: string[];        // 提醒 bullets, most important first
  source: "manual" | "claude";
  model: string | null;
  adjust_hint: string | null; // one-line plan-adjustment suggestion for the weekly review
  failed: boolean;
  error: string | null;
  created_at: string;
}

export interface ApiActivity {
  id: string;
  user_id: string;
  strava_activity_id: string; // bigint → string
  session_id: string | null;
  sport_type: string | null; // Strava sport_type: "Run" | "TrailRun" | "Ride" | "WeightTraining" | … ; only runs are auto-matched
  start_time: string; // ISO 8601, UTC
  distance_m: number;
  moving_time_sec: number;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_watts: number | null;
  kcal: number | null;
  description: string | null; // Strava description (synced; fallback when memo is null)
  memo: string | null;        // athlete's own note, PUT …/memo
  rpe: number | null;         // athlete's RPE 1-10, PUT …/memo
  memo_updated_at: string | null;
  device_name: string | null;
  gear_name: string | null;   // shoes
  weather: string | null;     // free text, may be null
  splits: ApiSplit[] | null;
  match_status: MatchStatus;
  review: ApiReview | null;
}

export interface PlanResponse {
  /** Coach messages posted since the athlete last opened the thread (PUT /coach/seen). Drives the tab badge. */
  coach_unread: number;
  /** Woo is waiting on the athlete: an open check-in (which activity?) or an open question (how did it feel?). The today page points to /coach. */
  coach_checkin_open: boolean;
  plan: ApiPlan;
  weeks: ApiWeek[];
  sessions: ApiSession[];    // not superseded, ordered by date
  activities: ApiActivity[]; // assigned to one of `sessions`, ordered by start_time
  /**
   * Strava activities (any sport) of the last 45 days that are not assigned to a
   * session yet, newest first. Today's activities and the candidates for the
   * "which activity was this session?" picker come from here.
   */
  unassigned: ApiActivity[];
}

// ---- GET <ApiUrl>/activities?status=<MatchStatus> --------------------------------
// Every activity Strava sent, runs and non-runs alike. Nothing is matched
// automatically: `unplanned` ones wait for the athlete to pick a session.

export interface ActivitiesQuery {
  status?: MatchStatus; // omit for all
}

export interface ActivitiesResponse {
  activities: ApiActivity[]; // newest first, max 200
}

// ---- PUT <ApiUrl>/activities/{id}/session --------------------------------------
// The athlete says which planned session this activity fulfils, optionally with
// their memo/RPE in the same call (one Claude review afterwards, not two).
//   { session_id: "<uuid>", memo?, rpe?, replace? }
//        -> match_status "confirmed". If another activity already holds the
//           session: an `auto` one is bumped back to "unplanned"; a "confirmed"
//           one is a 409 unless `replace: true`. The Claude review of this
//           activity is regenerated (arrives a few seconds later; poll /plan).
//   { session_id: null, status: "ignored" } -> not a training activity (kept out of lists)
//   { session_id: null }                    -> back to "unplanned"

export interface PutSessionRequest {
  session_id: string | null;
  status?: "unplanned" | "ignored"; // only when session_id is null; default "unplanned"
  memo?: string | null;  // only with a session_id; omitted = leave the stored memo alone
  rpe?: number | null;   // 1-10, same rule as memo
  replace?: boolean;     // take the session over from a "confirmed" holder
}

export interface PutSessionResponse {
  activity: ApiActivity;
}

// ---- PUT <ApiUrl>/activities/{id}/review ---------------------------------------

/** Manual verdict; replaces any existing (manual or claude) review. */
export interface PutReviewRequest {
  verdict: Verdict | null;
  comment?: string | null;
  reminders?: string[];
}

export interface PutReviewResponse {
  review: ApiReview;
}

// ---- PUT <ApiUrl>/activities/{id}/memo -----------------------------------------
// The athlete's own note after a session. If the activity's review was written
// by Claude it is regenerated with the memo as input (arrives a few seconds
// later); a manual review is left alone.

export interface PutMemoRequest {
  memo: string | null;  // null / "" clears
  rpe?: number | null;  // 1-10
}

export interface PutMemoResponse {
  activity: ApiActivity;
}

// ---- POST <ApiUrl>/activities/{id}/rereview ------------------------------------
// Drops the Claude review (failed or stale) and queues a new one; the result arrives
// a few seconds to a minute later on /plan and /activities. 409 when the activity has no
// session yet, or carries a manual review.

export interface RereviewResponse {
  queued: true;
}

// ---- GET <ApiUrl>/weekly -------------------------------------------------------
// The coach's weekly reviews (newest first) with their adjustment proposals. A
// proposal changes nothing until the athlete applies it.

export interface ApiAdjustment {
  index: number;              // position inside the review; the key for POST
  session_id: string;         // the planned session (as it was when proposed)
  field: "type" | "target_distance_m" | "target_pace_sec_km" | "scheduled_date" | "note";
  old: string | number | null;
  new: string | number | null;
  reason: string;
  status: "pending" | "applied" | "dismissed";
  decided_at: string | null;
  applied_session_id: string | null; // after apply: the new session row (the old one is superseded)
}

export interface ApiWeeklyReview {
  id: string;
  week_start: string; // 'YYYY-MM-DD' (Monday)
  summary: string | null;
  model: string | null;
  adjustments: ApiAdjustment[];
  created_at: string;
}

export interface WeeklyResponse {
  reviews: ApiWeeklyReview[];
}

// ---- POST <ApiUrl>/weekly/{id}/adjustments/{index} -----------------------------
// apply: a new version of that planned session is written and the old one superseded
// (activities move with it; /plan reflects it immediately). dismiss: just recorded.
// 409 when the proposal was already decided, or the session changed since.

export interface PostAdjustmentRequest {
  action: "apply" | "dismiss";
}

export interface PostAdjustmentResponse {
  review: ApiWeeklyReview;
}

// ---- GET <ApiUrl>/coach ---------------------------------------------------------
// The coach's thread, oldest first (last 100). Coach messages are posted by the
// system (weekly review, each run's verdict) or written in reply; athlete messages
// are `pending` until the coach answers, `failed` if the answer could not be made.

/**
 * Kinds: weekly (coach, Sunday review), review (coach, a run's verdict), chat
 * (either side), and the post-run check-in trio — checkin (coach: "which
 * activity was today's session?" with chips), pick (athlete: the chip they
 * chose; pending until Woo's question arrives), ask (coach: the follow-up
 * question; answered with POST /coach/messages { answer_to }).
 */
export interface ApiCoachMessage {
  id: string;
  role: "coach" | "athlete";
  kind: "weekly" | "review" | "chat" | "checkin" | "pick" | "ask";
  text: string;
  activity_id: string | null;        // review/ask/pick: that run; athlete chat: the quoted run
  weekly_review_id: string | null;   // weekly: look its proposals up in GET /weekly
  status: "pending" | "sent" | "failed";
  review: { label: string; verdict: Verdict | null; reminder: string | null; date: string | null } | null;
  quote: string | null;              // athlete chat sent from a report: one line about that run
  rpe: number | null;                // athlete answer to an ask: the RPE they picked
  checkin: ApiCheckin | null;        // kind checkin
  ask: { state: "open" | "answered"; activity_id: string; session_id: string } | null; // kind ask
  error: string | null;              // failed: why
  created_at: string;
}

export interface ApiCheckin {
  state: "open" | "picked" | "dismissed";
  /** activity: today's session is known, chips are the day's activities; session: rest day, chips are this week's open sessions. */
  mode: "activity" | "session";
  date: string;
  session_id: string | null;
  session_label: string | null;
  /** First candidate is Woo's guess. */
  candidates: { activity_id?: string; session_id?: string; label: string }[];
}

export interface CoachResponse {
  coach: { name: string };
  messages: ApiCoachMessage[];
}

// ---- POST <ApiUrl>/coach/messages ----------------------------------------------
// 202: the message is stored (status pending) and the worker will answer; poll
// GET /coach until the athlete message is `sent` (the reply follows it) or `failed`.
// 400 over 500 chars; 429 when a daily limit is set and reached.

export interface PostCoachMessageRequest {
  text: string;          // ≤ 500 chars
  activity_id?: string;  // quote this run (from the report page's 問教練)
  /**
   * Answering Woo's `ask` after a check-in: the text becomes the activity's
   * memo (rpe too), the review is queued and its verdict is the reply. No chat
   * reply is generated for an answer.
   */
  answer_to?: string;
  rpe?: number;          // 1-10, only with answer_to
}

// ---- POST <ApiUrl>/coach/checkins/{id}/pick ---------------------------------------
// The athlete tapped a chip on a `checkin`. activity mode: { activity_id };
// session mode: { session_id }; "都不是": { none: true }. Assigns the activity
// (no review yet), posts the athlete's `pick` (pending) and queues Woo's `ask`.
// 409 when the check-in is no longer open.

export interface PostCheckinPickRequest {
  activity_id?: string;
  session_id?: string;
  none?: boolean;
}

export interface PostCheckinPickResponse {
  checkin: ApiCoachMessage;
  pick: ApiCoachMessage | null;
}

/** PUT /coach/seen: the thread was opened; `coach_unread` on GET /plan drops to 0. */
export interface PutCoachSeenResponse {
  seen_at: string;
}

export interface PostCoachMessageResponse {
  message: ApiCoachMessage;
}

// ---- errors (any non-2xx) ----------------------------------------------------

/**
 * 401  bad/missing token (from API Gateway, body is API Gateway's)
 * 403  token valid but no users row for it
 * 503  Aurora is resuming from 0 ACU (first request after ~5 min idle);
 *      `Retry-After` header is set — wait and retry once or twice.
 */
export interface ErrorResponse {
  error: string;
}
