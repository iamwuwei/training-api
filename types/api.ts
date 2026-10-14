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

export interface ApiReview {
  verdict: Verdict | null;
  comment: string | null;     // 心得 paragraph
  reminders: string[];        // 提醒 bullets
  rpe: number | null;
  source: "manual" | "claude";
  model: string | null;
  created_at: string;
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
  max_hr: number | null;
  avg_watts: number | null;
  kcal: number | null;
  description: string | null; // Strava description
  device_name: string | null;
  gear_name: string | null;   // shoes
  weather: string | null;     // free text, may be null
  splits: ApiSplit[] | null;
  match_status: MatchStatus;
  review: ApiReview | null;
}

export interface PlanResponse {
  plan: ApiPlan;
  weeks: ApiWeek[];
  sessions: ApiSession[];    // not superseded, ordered by date
  activities: ApiActivity[]; // matched to one of `sessions`, ordered by start_time
}

// ---- GET <ApiUrl>/activities?status=<MatchStatus> --------------------------------

export interface ActivitiesQuery {
  status?: MatchStatus; // omit for all
}

export interface ActivitiesResponse {
  activities: ApiActivity[]; // newest first, max 200
}

// ---- PUT <ApiUrl>/activities/{id}/review ---------------------------------------

/** Manual verdict; replaces any existing (manual or claude) review. */
export interface PutReviewRequest {
  verdict: Verdict | null;
  comment?: string | null;
  reminders?: string[];
  rpe?: number | null;
}

export interface PutReviewResponse {
  review: ApiReview;
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
