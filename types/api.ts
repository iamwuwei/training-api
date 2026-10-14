// Wire types for the `api` Lambda (Function URL). Self-contained so the
// front-end can copy this file as-is. Dates are ISO strings on the wire.

export type SessionType = "easy" | "long" | "tempo" | "interval" | "rest" | "race";
export type MatchStatus = "auto" | "confirmed" | "unplanned" | "ignored";

// ---- GET /plan?user=<uuid> ------------------------------------------------

export interface PlanQuery {
  user: string; // user uuid (v1: acts as the bearer)
}

export interface ApiPlan {
  id: string;
  user_id: string;
  race_name: string;
  race_date: string; // 'YYYY-MM-DD'
  goal_time_sec: number | null;
  days_per_week: number | null;
  status: string;
}

export interface ApiSession {
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

export interface ApiSplit {
  distance: number;
  elapsed_time: number;
  moving_time: number;
  elevation_difference: number;
  split: number;
  average_speed: number;
  average_heartrate?: number;
}

export interface ApiActivity {
  id: string;
  user_id: string;
  strava_activity_id: string; // bigint → string
  session_id: string | null;
  start_time: string; // ISO 8601, UTC
  distance_m: number;
  moving_time_sec: number;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  splits: ApiSplit[] | null;
  match_status: MatchStatus;
}

export interface PlanResponse {
  plan: ApiPlan;
  sessions: ApiSession[];   // not superseded, ordered by date
  activities: ApiActivity[]; // matched to one of `sessions`, ordered by start_time
}

// ---- GET /activities?user=<uuid>&status=<MatchStatus> ----------------------

export interface ActivitiesQuery {
  user: string;
  status?: MatchStatus; // omit for all
}

export interface ActivitiesResponse {
  activities: ApiActivity[]; // newest first, max 200
}

// ---- errors (any non-2xx) ----------------------------------------------------

export interface ErrorResponse {
  error: string;
}
