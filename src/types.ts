// Internal row + Strava types. Keep in sync with sql/schema.sql.
// Public API request/response types live in ../types/api.ts.

import type { MatchStatus, ProposalField, SessionType, Verdict } from "../types/api";
export type { MatchStatus, ProposalField, SessionType, Verdict };

export interface UserRow {
  id: string;
  email: string | null;
  display_name: string;
  cognito_sub: string | null;
  coach_seen_at: Date | null;
  created_at: Date;
}

export interface StravaConnectionRow {
  user_id: string;
  strava_athlete_id: string; // bigint comes back from pg as string
  access_token: string;
  refresh_token: string;
  expires_at: Date;
  scope: string;
}

export interface PlanRow {
  id: string;
  user_id: string;
  race_name: string;
  race_date: string; // 'YYYY-MM-DD'
  goal_time_sec: number | null;
  days_per_week: number | null;
  status: string;
}

export interface PlanWeekRow {
  id: string;
  plan_id: string;
  week_no: number;
  week_start: string;
  week_end: string;
  phase: string | null;
  focus: string | null;
}

export interface PlannedSessionRow {
  id: string;
  plan_id: string;
  scheduled_date: string; // 'YYYY-MM-DD'
  week_no: number | null;
  phase: string | null;
  label: string | null;
  type: SessionType;
  content: string | null;
  note: string | null;
  target: string | null;
  target_distance_m: number | null;
  target_pace_sec_km: number | null;
  target_pace_min_sec_km: number | null;
  target_pace_max_sec_km: number | null;
  target_hr_min: number | null;
  target_hr_max: number | null;
  brief: string | null;
  skipped_at: Date | null;
  version: number;
  superseded: boolean;
}

export interface ActivityRow {
  id: string;
  user_id: string;
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
  device_name: string | null;
  gear_id: string | null;
  gear_name: string | null;
  weather: string | null;
  memo: string | null;
  rpe: number | null;
  memo_updated_at: Date | null;
  splits: unknown;
  match_status: MatchStatus;
  raw?: unknown;
}

export interface ReviewRow {
  id: string;
  activity_id: string;
  verdict: Verdict | null;
  comment: string | null;
  reminders: string[] | null;
  rpe: number | null;
  source: "manual" | "claude";
  model: string | null;
  adjust_hint: string | null;
  created_at: Date;
}

export interface CoachMessageRow {
  id: string;
  user_id: string;
  role: "coach" | "athlete";
  kind: "weekly" | "review" | "chat" | "checkin" | "pick" | "ask"; // checkin/ask: coach; pick: athlete
  text: string;
  meta: Record<string, unknown> | null;
  activity_id: string | null;
  weekly_review_id: string | null;
  status: "pending" | "sent" | "failed";
  created_at: Date;
}

/** SQS message asking the worker to answer an athlete's coach message. */
export interface CoachReplyJob {
  type: "coach_reply";
  user_id: string;
  message_id: string;
}

/** SQS message asking the worker to post Woo's follow-up question after a check-in pick. */
export interface CoachAskJob {
  type: "coach_ask";
  user_id: string;
  message_id: string; // the athlete's `pick` message
}

/** SQS message asking the worker to write a 肌力 checklist for a session_routines row. */
export interface RoutineJob {
  type: "routine";
  user_id: string;
  routine_id: string;
}

/** SQS message asking the worker to write Woo's one-line briefs for upcoming sessions. */
export interface BriefsJob {
  type: "briefs";
  user_id: string;
  from: string; // 'YYYY-MM-DD'
  to: string;
  force?: boolean; // rewrite existing briefs too (after a weekly review)
}

export interface RoutineItem {
  name: string;        // '平板支撐 3 × 40 秒'
  how: string | null;  // one line on how to do it
  done: boolean;
}

export interface SessionRoutineRow {
  id: string;
  session_id: string;
  user_id: string;
  place: "home" | "gym";
  status: "pending" | "ready" | "failed";
  minutes: number | null;
  rules: string | null;
  items: RoutineItem[];
  model: string | null;
  error: string | null;
  rpe: number | null;
  note: string | null;
  completed_at: Date | null;
  created_at: Date;
}

export interface WeeklyReviewRow {
  id: string;
  plan_id: string;
  week_start: string;
  summary: string | null;
  adjustments: unknown;
  created_at: Date;
  updated_at: Date | null;
  update_reason: string | null;
}

/** A proposal card (table proposals; Woo's chat reply or his weekly review). items/weeks/basis/flags/impact/option are jsonb. */
export interface ProposalRow {
  id: string;
  user_id: string;
  source: "weekly" | "chat";
  message_id: string | null;
  items: ProposalItem[];
  weeks: ProposalWeek[];
  why: string | null;
  basis: string[];
  basis_text: string | null; // null on cards from before coach-replan
  impact: ProposalImpact | null;
  flags: string[];           // card level: what could not be hung on one row
  group_id: string | null;
  option: ProposalOption | null;
  status: "pending" | "applied" | "dismissed" | "superseded" | "stale";
  stale_reason: string | null;
  created_at: Date;
  decided_at: Date | null;
}

export type ProposalOp = "change" | "add" | "remove";

/** A session Woo wants to add (op = add). */
export interface NewSession {
  scheduled_date: string; // 'YYYY-MM-DD'
  type: Exclude<SessionType, "race">;
  label: string;
  target_distance_m: number | null;
  target_pace_sec_km: number | null;
  note: string | null;
}

/** One row of a card. `op` missing = change (cards written before coach-replan). */
export interface ProposalItem {
  op?: ProposalOp;
  session_id: string | null; // null for add
  field?: ProposalField;     // change only
  old: string | number | null;
  new: string | number | null;
  label: string | null;
  date: string | null;
  new_session?: NewSession;  // add only
  reason?: string | null;
  flags?: string[];          // computed by the api, hung on this row
  applied_session_id?: string;
}

export interface ProposalWeek { week_no: number; phase: string | null; focus: string | null }
export interface ProposalImpact { keep: string; change: string; risk: string }
export interface ProposalOption { letter: "A" | "B"; title: string; recommended: boolean }

/** A constraint the athlete told Woo about (table constraints). Dates are 'YYYY-MM-DD'. */
export interface ConstraintRow {
  id: string;
  user_id: string;
  text: string;
  start_date: string | null;
  end_date: string | null;
  kind: "period" | "fixed_day" | "note";
  weekday: number | null; // fixed_day: 0 = Sunday … 6 = Saturday
  source_message_id: string | null;
  status: "proposed" | "active" | "dismissed";
  created_at: Date;
  decided_at: Date | null;
}

/**
 * Async invoke of the weekly Lambda (`{ rerun: … }`) asking it to regenerate one weekly
 * review in place: the athlete answered 沒跑, or an activity of that week arrived after
 * the review was written. The api and the worker send it (neither runs the model for
 * a review); a Lambda retry after the rerun already happened is skipped.
 */
export interface WeeklyRerunRequest {
  user_id: string;
  weekly_review_id: string;
  reason: string;        // "你說 10/25 沒跑" / "10/25 的 Long 進來了"
  requested_at: string;  // ISO; the review being updated at or after this means it is done
  activity_id?: string;  // the activity that arrived; skipped when the review already lists it
}

// ---- Strava ---------------------------------------------------------------

/** Body Strava POSTs to the webhook callback. */
export interface StravaWebhookEvent {
  object_type: "activity" | "athlete";
  object_id: number;
  aspect_type: "create" | "update" | "delete";
  updates?: Record<string, unknown>;
  owner_id: number;
  subscription_id: number;
  event_time: number;
}

export interface StravaTokenResponse {
  token_type: string;
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
  expires_in: number;
  athlete?: { id: number; firstname?: string; lastname?: string };
}

export interface StravaSplit {
  distance: number;
  elapsed_time: number;
  moving_time: number;
  elevation_difference: number;
  split: number;
  average_speed: number;
  average_heartrate?: number;
  pace_zone?: number;
}

/** Subset of DetailedActivity we care about. */
export interface StravaActivity {
  id: number;
  name: string;
  description?: string | null;
  type: string;       // legacy: "Run"
  sport_type: string; // "Run" | "TrailRun" | "VirtualRun" | ...
  start_date: string;       // UTC ISO
  start_date_local: string; // local ISO (no offset)
  timezone: string;
  distance: number;         // metres
  moving_time: number;      // seconds
  elapsed_time: number;
  average_speed: number;    // m/s
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  calories?: number;
  device_name?: string;
  gear_id?: string | null;
  gear?: { id: string; name: string; primary?: boolean; distance?: number } | null;
  splits_metric?: StravaSplit[];
  [key: string]: unknown;
}

// ---- Claude outputs -------------------------------------------------------

export interface ActivityReviewResult {
  verdict: Verdict;
  comment: string;
  reminders: string[];
  /** One-line plan-adjustment suggestion for the weekly review, or null. */
  adjust_hint: string | null;
}

export interface WeeklyAdjustment {
  session_id: string;
  field: "type" | "target_distance_m" | "target_pace_sec_km" | "scheduled_date" | "note";
  old: string | number | null;
  new: string | number | null;
  reason: string;
}

/** What the model returns for a card, before the api validates it (see lib/proposals.ts validateCards). */
export interface RawCard {
  changes: {
    op?: string;
    session_id?: string | null;
    field?: string | null;
    old?: string | number | null;
    new?: string | number | null;
    new_session?: Partial<NewSession> | null;
    reason?: string | null;
  }[];
  weeks?: { week_no?: number; phase?: string | null; focus?: string | null }[];
  why?: string;
  basis?: string[];
  basis_text?: string;
  impact?: Partial<ProposalImpact>;
  option_title?: string | null;
  recommended?: boolean;
}

/** What the model returns for a "記下來" card, before the api validates it. */
export interface RawConstraint {
  text?: string;
  start_date?: string | null;
  end_date?: string | null;
  kind?: string;
  weekday?: number | null;
}

export interface WeeklyReviewResult {
  summary: string;
  proposals: RawCard[];
}

/** What weekly_reviews.adjustments holds: the proposals plus what the athlete did with each. */
export interface StoredAdjustment extends WeeklyAdjustment {
  status: "pending" | "applied" | "dismissed" | "superseded"; // superseded: cancelled by a regeneration
  decided_at?: string;         // ISO
  applied_session_id?: string; // the new planned_sessions row after apply
}
export interface StoredAdjustments {
  model: string;
  hints?: string[];
  items: StoredAdjustment[];
  /** Activities (ids) the review saw; one arriving later triggers a regeneration. */
  activities?: string[];
}

/** coach_messages.meta of a weekly message. */
export interface WeeklyMessageMeta {
  week_start: string;
  proposals: number;
  /** The cards of this review (proposals.id), applied ones first; the thread shows these. */
  proposal_ids?: string[];
  /** The model's cards failed the format check: none were stored. */
  proposal_rejected?: boolean;
  asks?: { session_id: string; label: string; date: string; state: "open" | "synced" | "skipped" }[];
  updated?: { at: string; reason: string };
  cancelled?: string[];
  backfilled?: boolean;
}
