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
  /** Woo's one line about this session ("第 1 趟當熱身，從第 2 趟才用力"), written by the worker; null until then. */
  brief: string | null;
  /** The athlete answered the weekly review's question with 沒跑: the session counts as skipped (not deleted). */
  skipped_at: string | null;
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
 * `error` is a fixed line to show ("這次分析沒成功，再試一次"; the provider's wording
 * stays in the logs); POST …/rereview tries again. Nothing at all (activity.review
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
  /**
   * What the newest open `ask` is about, for the waiting line: `feel` = how did it feel
   * (today page "Woo 在等你回感受"), `mismatch` = is this really that session (report page
   * "Woo 在問這趟是不是"). null when no ask is open — including when only a check-in is
   * open (`coach_checkin_open` still true).
   */
  coach_ask_kind: "feel" | "mismatch" | null;
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
  /** 肌力 checklists Woo wrote for sessions of this plan (see POST /sessions/{id}/routine). */
  routines: ApiRoutine[];
}

// ---- 肌力 day: Woo's checklist ---------------------------------------------------
// POST /sessions/{id}/routine { place } creates the routine (status pending) and the
// worker fills it in a few seconds (poll GET /plan). With `regenerate: true` an
// existing routine is replaced. PUT /sessions/{id}/routine ticks items, sets RPE /
// note, and with `complete: true` closes it: Woo posts one line in the thread.

export interface ApiRoutineItem {
  name: string;       // '平板支撐 3 × 40 秒'
  how: string | null; // one line on how to do it, behind the "?" button
  done: boolean;
}

export interface ApiRoutine {
  id: string;
  session_id: string;
  place: "home" | "gym";
  status: "pending" | "ready" | "failed";
  minutes: number | null;
  rules: string | null;  // '組間休息 45 秒 · 動作之間 1 分鐘 · 全程 RPE 6〜7'
  items: ApiRoutineItem[];
  error: string | null;
  rpe: number | null;
  note: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface PostRoutineRequest {
  place: "home" | "gym";
  regenerate?: boolean;
}

export interface PostRoutineResponse {
  routine: ApiRoutine;
}

export interface PutRoutineRequest {
  done?: boolean[];      // one per item, same length as items
  rpe?: number | null;   // 1-10
  note?: string | null;
  complete?: boolean;    // close it (completed_at); Woo posts one line
}

export interface PutRoutineResponse {
  routine: ApiRoutine;
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
//           activity is regenerated (arrives a few seconds later; poll /plan) —
//           unless the pick looks wrong (a walk on a long-run day, a run far
//           shorter than the session): then Woo posts a `mismatch` ask in the
//           thread instead and the review waits for the answer (see ApiCoachMessage.ask).
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
  /** superseded: the review was regenerated (an activity arrived later) while this was still pending; it no longer applies. */
  status: "pending" | "applied" | "dismissed" | "superseded";
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
  /** Set when the review was regenerated in place (see ApiWeeklyMeta.updated on the thread message). */
  updated_at: string | null;
  update_reason: string | null; // "10/25 的長跑進來了" / "你說 10/25 沒跑"
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
  /**
   * kind ask. `feel`: Woo's "how did it feel?" after a pick (answer with POST /coach/messages
   * { answer_to }). `mismatch`: the pick (a check-in chip or PUT /activities/{id}/session)
   * looked wrong (a walk on a long-run day, a run far shorter than the session); `reason` is
   * Woo's sentence, the chips are 是／不是 (POST /coach/messages { answer_to, confirm_match }).
   * 不是 after a chip resets the check-in; after a report-page pick it only unassigns the
   * activity (no new check-in). state `answered` covers both answered and closed.
   * `from`: where the pick came from — `checkin` (a chip in the thread; 不是 → a fresh
   * check-in follows, chip text "不是，重選") or `report` (PUT /activities/{id}/session;
   * 不是 → only unassigned, the athlete picks again on the report page, chip text
   * "不是這堂"). A `feel` ask is always `checkin`.
   */
  ask: { state: "open" | "answered"; kind: "feel" | "mismatch"; from: "checkin" | "report"; activity_id: string; session_id: string; reason: string | null } | null;
  /** kind weekly: the review's open questions, the "updated" line and the cancelled proposals. */
  weekly: ApiWeeklyMeta | null;
  /** A proposal card attached to a coach chat reply (see POST /proposals/{id}/apply). */
  proposal: ApiProposal | null;
  error: string | null;              // failed: a fixed line to show (the provider's wording stays in the logs)
  created_at: string;
}

/** Extra state on a weekly-review message. */
export interface ApiWeeklyMeta {
  week_start: string;
  /**
   * Key sessions (Long / MP / 坡跑) of that week without a record when the review was
   * written: the review asks instead of concluding, and makes no proposals until
   * they are settled. open → chips 還沒同步／沒跑 (POST /weekly/{id}/asks/{session_id}).
   */
  asks: ApiWeeklyAsk[];
  /** The review was regenerated in place: "⟳ 已更新 · 10/25 的長跑進來了". */
  updated: { at: string; reason: string } | null;
  /** Pending proposals that the regeneration cancelled, one line each: "11/1 距離 18 → 16 km". */
  cancelled: string[];
}

export interface ApiWeeklyAsk {
  session_id: string;
  label: string;   // "Long 16 km"
  date: string;    // 'YYYY-MM-DD'
  /**
   * Woo's question for the quote block, built by the api from date + label:
   * "10/25 的 Long 16 km 我沒看到紀錄，是沒跑，還是還沒同步？". The review text itself
   * does not repeat it (the prompt tells Woo to only write what he can see).
   */
  question: string;
  state: "open" | "synced" | "skipped";
}

export interface ApiCheckin {
  /** reset: the athlete asked to pick again; a new open check-in follows it in the thread. */
  state: "open" | "picked" | "dismissed" | "reset";
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
  /**
   * Answering a `mismatch` ask (answer_to = that ask): true = "是，就是這趟" — the
   * pick stands and Woo's feel question follows; false = "不是，重選" — same as
   * POST /coach/checkins/{id}/reset (the activity is unassigned, a fresh check-in
   * is posted). `text` is stored as the athlete's line; no model reply.
   */
  confirm_match?: boolean;
}

// ---- POST <ApiUrl>/weekly/{id}/asks/{session_id} -----------------------------------
// The athlete answers the weekly review's question about a key session without a record.
// synced: nothing changes (the review regenerates by itself when the activity arrives).
// skipped: the session gets skipped_at and the review is regenerated (updated line
// "你說 10/25 沒跑"; arrives a few seconds later, poll GET /coach). 409 when already answered.

export interface PostWeeklyAskRequest {
  answer: "synced" | "skipped";
}

export interface PostWeeklyAskResponse {
  message: ApiCoachMessage; // the weekly message with the ask's new state
}

// ---- proposals (Woo's cards in chat) ------------------------------------------------
// A coach chat reply may carry one card with one or more changes that are applied
// together. Only sessions of this week and next; no adding/removing sessions, no race day.

export type ProposalField = "type" | "target_distance_m" | "target_pace_sec_km" | "scheduled_date" | "note" | "skip";

export interface ApiProposalChange {
  session_id: string;         // the planned session as it was when proposed
  field: ProposalField;       // skip: the whole session becomes a rest day (old/new unused)
  old: string | number | null;
  new: string | number | null;
  label: string | null;       // "長跑 16 km" — for the card's header line
  date: string | null;        // the session's date when proposed, 'YYYY-MM-DD'
  applied_session_id: string | null; // after apply: the new session row
}

export interface ApiProposal {
  id: string;
  source: "weekly" | "chat";
  message_id: string | null;
  changes: ApiProposalChange[];
  why: string | null;         // one sentence
  basis: string[];            // "本週已跑 12.1 / 36 km" … the numbers Woo looked at
  flags: string[];            // computed by the api, shown in amber: "比目前最長多 3.7 km"
  status: "pending" | "applied" | "dismissed";
  created_at: string;
  decided_at: string | null;
}

// ---- POST <ApiUrl>/proposals/{id}/apply | /dismiss -----------------------------------
// apply: every change of the card in one transaction (new session versions, old ones
// superseded, activities moved; a date swap of two sessions is one commit). Woo posts a
// one-line confirmation in the thread. 409 when already decided or a session changed since.

export interface PostProposalResponse {
  proposal: ApiProposal;
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

// ---- POST <ApiUrl>/coach/checkins/{id}/reset ---------------------------------------
// "選錯了" / "重新選": a picked check-in's activity is unassigned again (its review
// dropped, Woo's open question closed), a dismissed one is reopened. The old
// check-in goes to state `reset`; a new open one (`checkin`) with the same chips is
// posted after it. 409 when the check-in is still open.

export interface PostCheckinResetResponse {
  checkin: ApiCoachMessage;
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
 * 500  `error` is the fixed line "伺服器錯誤" (details only in the api's logs).
 */
export interface ErrorResponse {
  error: string;
}
