// Shared row + API types. Keep in sync with sql/schema.sql.

export type SessionType = "easy" | "long" | "tempo" | "interval" | "rest" | "race";
export type MatchStatus = "auto" | "confirmed" | "unplanned" | "ignored";

export interface UserRow {
  id: string;
  email: string | null;
  display_name: string;
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

export interface PlannedSessionRow {
  id: string;
  plan_id: string;
  scheduled_date: string; // 'YYYY-MM-DD'
  type: SessionType;
  target_distance_m: number | null;
  target_pace_sec_km: number | null;
  note: string | null;
  version: number;
  superseded: boolean;
}

export interface ActivityRow {
  id: string;
  user_id: string;
  strava_activity_id: string;
  session_id: string | null;
  start_time: Date;
  distance_m: number;
  moving_time_sec: number;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  splits: unknown;
  match_status: MatchStatus;
  raw?: unknown;
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
  splits_metric?: StravaSplit[];
  [key: string]: unknown;
}

// ---- weekly review --------------------------------------------------------

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
