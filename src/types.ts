// Internal row + Strava types. Keep in sync with sql/schema.sql.
// Public API request/response types live in ../types/api.ts.

import type { MatchStatus, SessionType, Verdict } from "../types/api";
export type { MatchStatus, SessionType, Verdict };

export interface UserRow {
  id: string;
  email: string | null;
  display_name: string;
  cognito_sub: string | null;
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
  created_at: Date;
}

export interface WeeklyReviewRow {
  id: string;
  plan_id: string;
  week_start: string;
  summary: string | null;
  adjustments: unknown;
  created_at: Date;
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
}

export interface WeeklyAdjustment {
  session_id: string;
  field: "type" | "target_distance_m" | "target_pace_sec_km" | "scheduled_date" | "note";
  old: string | number | null;
  new: string | number | null;
  reason: string;
}

export interface WeeklyReviewResult {
  summary: string;
  adjustments: WeeklyAdjustment[];
}
