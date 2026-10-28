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
  device_name: string | null; // what to show: the athlete's value (PUT …/details) when set, else Strava's
  gear_name: string | null;   // shoes; same rule
  weather: string | null;     // free text; the athlete's value (no automatic source), may be null
  /** Where each of the three above comes from, and Strava's own value for the editor's "清除後回到：…". */
  details: Record<"gear_name" | "device_name" | "weather", { source: "user" | "strava" | null; strava: string | null }>;
  details_updated_at: string | null; // last PUT …/details
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
  /**
   * What the athlete told Woo to remember (出國, 週三肌力不能動 …): every `active` one, expired
   * ones included (mark those 已過期 from `end_date`; the api only leaves them out of Woo's
   * prompts). The settings page lists them; 刪除 = POST /constraints/{id}/dismiss.
   */
  constraints: ApiConstraint[];
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

// ---- PUT <ApiUrl>/activities/{id}/details --------------------------------------
// The athlete's own shoe / device / weather for one activity. A key that is present is
// set: a string (trimmed, single line, ≤ 40 chars) becomes the athlete's value and is
// shown over Strava's; "" or null clears it (back to Strava's value, or nothing for
// weather). A string equal to Strava's own value for that field is stored as "no
// override" (it shows as Strava's). Keys that are absent are left alone. 400: no known
// key, a non-string, over 40 chars. 404: not this user's activity. Does not touch
// memo / RPE / the review, and does not queue anything.

export interface PutDetailsRequest {
  gear_name?: string | null;
  device_name?: string | null;
  weather?: string | null;
}

export interface PutDetailsResponse {
  activity: ApiActivity;
}

// ---- GET <ApiUrl>/activities/detail-options ------------------------------------
// Names this athlete used before (own values and Strava's), distinct, most recently
// used first, at most 8 each. For the editor's suggestions.

export interface DetailOptionsResponse {
  gear_name: string[];
  device_name: string[];
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

// ---- GET <ApiUrl>/coach?limit=10&before=<message id> ----------------------------
// The coach's thread, oldest first within the page. The newest `limit` messages
// (default 10, max 100), or with `before` the `limit` messages older than that
// message (keyset on created_at + id). Coach messages are posted by the
// system (weekly review, each run's verdict) or written in reply; athlete messages
// are `pending` until the coach answers, `failed` if the answer could not be made.
// 400: limit not an integer 1..100, before not a uuid, or not this user's message.

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
  /**
   * The proposal card attached to this message (a coach chat reply, or a weekly review). An A/B
   * pair is two consecutive coach messages, each with its own card (same `group_id`, `option.letter`
   * A then B); the second one's `text` is "" — draw the pair as one reply. New weekly reviews carry
   * their card here too (their `adjustments` are empty; reviews from before keep theirs in GET /weekly).
   * See POST /proposals/{id}/apply.
   */
  proposal: ApiProposal | null;
  /**
   * Woo's "記下來：…" card for this message (a constraint with status `proposed`; the athlete
   * accepts or dismisses it separately from the proposal cards), or null. After the decision
   * it stays on the message with status `active` / `dismissed`.
   */
  constraint: ApiConstraint | null;
  /**
   * Woo 的提案沒過格式檢查: his cards failed the api's check (empty basis / impact, an add or remove
   * without a reason, a date out of range, ...) and none were stored. Show one grey line
   * "Woo 的提案沒過格式檢查，再問他一次"; the reply text itself is fine.
   */
  proposal_rejected: boolean;
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
  /** Older messages exist before `messages[0]`: ask again with before = messages[0].id. */
  has_more: boolean;
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
  /**
   * 請 Woo 重看: the id of a proposal in status `stale`. Woo gets that card (and why it went
   * stale) in his briefing and is asked to send a new one built on the plan as it is now.
   * `text` is the athlete's line (e.g. "課表變了，這張重看一次"). 404 not yours / not found,
   * 409 when the proposal is not stale.
   */
  re_propose?: string;
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

// ---- proposals (Woo's cards) -------------------------------------------------------------
// A card is what Woo proposes in a chat reply or a weekly review. It can reach any session
// from today to the day before the race, span several weeks, add or remove sessions, and
// rewrite the descriptions (phase / focus) of the weeks it touches. The athlete applies the
// whole card or none of it. The race day is never touched.

export type ProposalField = "type" | "target_distance_m" | "target_pace_sec_km" | "scheduled_date" | "note" | "skip";

/**
 * One row of a card.
 *  - change: `field` is set; `old` → `new` (skip: the whole session becomes a rest day, old / new null).
 *  - add:    a new session on `new_session.scheduled_date`; `session_id`, `old`, `new` are null. `reason` is always set.
 *  - remove: the session is taken out of the plan (superseded, not deleted); old / new null. `reason` is always set.
 * Cards stored before coach-replan come back as op "change" with `reason` null and `flags` [].
 */
export interface ApiProposalChange {
  op: "change" | "add" | "remove";
  session_id: string | null;  // the planned session as it was when proposed; null for add
  field?: ProposalField;      // op = change only
  old: string | number | null;
  new: string | number | null;
  label: string | null;       // "長跑 16 km" — for the row's header; for add the new session's label
  date: string | null;        // the session's date when proposed ('YYYY-MM-DD'); for add the new date. A date move: old date here, new date in `new`
  /** op = add only. */
  new_session?: {
    scheduled_date: string;
    type: ApiSession["type"];
    label: string;
    target_distance_m: number | null;
    target_pace_sec_km: number | null;
    note: string | null;
  };
  /** One line (≤ 80 chars), plain text. Required for add / remove, optional on a change. */
  reason: string | null;
  /** Computed by the api, hung on this row, shown in amber: "落到第 8 週：那週 42 → 58 km，比上週計畫 28 km 多 107%", "比目前最長多 3.7 km（16.2 → 19.9 km）", "減量週加量", "離比賽只剩 10 天，這天有 26 km 的長跑". */
  flags: string[];
  applied_session_id: string | null; // after apply: the new session row (change / add)
}

export interface ApiProposalWeek {
  week_no: number;
  /** The week's new description; null = leave that field as it is. Only weeks the card's rows touch appear. */
  phase: string | null;
  focus: string | null;
}

export interface ApiProposalImpact {
  keep: string;   // 不調整會怎樣 (≤ 300 chars)
  change: string; // 調整後會怎樣
  risk: string;   // 風險：什麼情況下會出問題、那時怎麼辦
}

export interface ApiProposal {
  id: string;
  source: "weekly" | "chat";
  message_id: string | null;
  changes: ApiProposalChange[];
  /** The week descriptions this card rewrites (applied with the changes). */
  weeks: ApiProposalWeek[];
  why: string | null;         // one sentence
  basis: string[];            // the folded 依據 line: 2–4 numbers, "本週已跑 12.1 / 36 km" …
  /** The unfolded 依據: goal, current state, the training principles used (≤ 400 chars). "" on cards from before coach-replan. */
  basis_text: string;
  /** Always set on new cards (the api refuses a card without them); all three "" on cards from before. */
  impact: ApiProposalImpact;
  /** Card level only: what no row owns (a row's own flags are on the row). */
  flags: string[];
  /** A/B: the cards of one reply share the id; null for a single card. */
  group_id: string | null;
  option: { letter: "A" | "B"; title: string; recommended: boolean } | null; // title ≤ 30 chars
  /**
   * pending → applied | dismissed.
   * superseded: the other card of its A/B group was applied (set by the api; the response of that
   *   apply lists the ids), it can no longer be applied.
   * stale: apply hit 409 plan_changed; kept so a reload shows 課表已變. Can still be dismissed.
   */
  status: "pending" | "applied" | "dismissed" | "superseded" | "stale";
  /** status stale: which session changed, e.g. "11/29 長跑 20 km 在這張卡之後被改過" / "11/25 輕鬆跑 已完成". */
  stale_reason: string | null;
  created_at: string;
  decided_at: string | null;
}

// ---- POST <ApiUrl>/proposals/{id}/apply | /dismiss -----------------------------------
// apply: one transaction — every row (a changed session gets a new version and the old one
// is superseded, activities move along; add inserts; remove supersedes the old row) and the
// week descriptions in `weeks`. Woo posts a short confirmation in the thread. The other
// pending cards of the same `group_id` become `superseded` (ids in `superseded`).
//   200  { proposal, superseded }
//   409  { error: "plan_changed", changed: [...] } — a session of the card was changed by another
//        proposal, completed, or its date has passed since the card was written. The card is now
//        `stale` (stale_reason says which); show 課表已變, offer 請 Woo 重看 (re_propose) / 算了 (dismiss).
//   409  { error: "already <status>" } — not pending any more (also a stale card).
//   400  { error } — the card breaks a hard rule: it touches the race day, a date is outside today …
//        the day before the race, a session moves off a day the athlete said is fixed, or a value is invalid.
// dismiss: records dismissed; allowed on pending and stale cards. 409 otherwise.

export interface PostProposalResponse {
  proposal: ApiProposal;
  /** apply only: ids of the other cards of the group that just became `superseded` (always [] for dismiss / a single card). */
  superseded: string[];
}

/** The 409 body of apply when the plan changed under the card. */
export interface PlanChangedResponse {
  error: "plan_changed";
  changed: {
    session_id: string;
    label: string | null;  // the session as the card knew it
    date: string | null;   // 'YYYY-MM-DD'
    why: "changed" | "completed"; // changed: another proposal changed it (or its date has passed); completed: an activity is attached
  }[];
}

// ---- constraints (what Woo remembers) ----------------------------------------------------
// Woo proposes one in a chat reply ("記下來：11/21〜23 出國"): the api stores it as `proposed` and
// the message carries it (ApiCoachMessage.constraint). The athlete accepts or dismisses it; an
// active one reaches every prompt of Woo (chat, weekly review, verdicts) until `end_date` has
// passed, and card checks refuse to move a session off a `fixed_day`. No endpoint creates one by
// hand: the athlete tells Woo.

export interface ApiConstraint {
  id: string;
  text: string;                 // ≤ 60 chars, plain text: "11/21〜23 出國"
  start_date: string | null;    // 'YYYY-MM-DD'
  end_date: string | null;      // null on both = 長期. Show: both "11/21–11/23", only end "到 10/31", neither "長期"
  kind: "period" | "fixed_day" | "note";
  weekday: number | null;       // kind fixed_day: 0 = Sunday … 6 = Saturday
  source_message_id: string | null; // the athlete's message it came from (its date: "來自 10/27 的對話")
  status: "proposed" | "active" | "dismissed";
  created_at: string;
}

// ---- POST <ApiUrl>/constraints/{id}/accept | /dismiss --------------------------------------
// accept: proposed → active (記下來). dismiss: proposed → dismissed (不用) or active → dismissed
// (設定頁的刪除). Only your own; 404 otherwise. 409 when it is already decided that way
// (accept on anything but proposed; dismiss on a dismissed one).

export interface PostConstraintResponse {
  constraint: ApiConstraint;
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
