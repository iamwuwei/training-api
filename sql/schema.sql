-- training-api schema (PostgreSQL 17 / Aurora Serverless v2)
-- Idempotent: safe to run repeatedly via `npm run migrate`.
-- New columns are added with `alter table … add column if not exists` so an
-- existing database upgrades in place.

create table if not exists users (
  id uuid primary key,
  email text unique,
  display_name text not null,
  created_at timestamptz not null default now()
);
alter table users drop column if exists apple_sub;
alter table users add column if not exists cognito_sub text unique;  -- Cognito user `sub`

create table if not exists strava_connections (
  user_id uuid primary key references users(id),
  strava_athlete_id bigint unique not null,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text not null
);

create table if not exists plans (
  id uuid primary key,
  user_id uuid not null references users(id),
  race_name text not null,
  race_date date not null,
  goal_time_sec int,
  days_per_week int,
  status text not null default 'active'
);

-- One row per training week (from the 週總覽 sheet): phase + weekly focus.
create table if not exists plan_weeks (
  id uuid primary key,
  plan_id uuid not null references plans(id),
  week_no int not null,
  week_start date not null,
  week_end date not null,
  phase text,
  focus text,
  unique (plan_id, week_no)
);

create table if not exists planned_sessions (
  id uuid primary key,
  plan_id uuid not null references plans(id),
  scheduled_date date not null,
  type text not null,            -- easy | long | tempo | interval | rest | race
  target_distance_m int,
  target_pace_sec_km int,        -- midpoint of the pace range (matcher / Claude)
  note text,                     -- 備註 (column I)
  version int not null default 1,
  superseded boolean not null default false
);
alter table planned_sessions add column if not exists week_no int;
alter table planned_sessions add column if not exists phase text;                  -- 第一階段｜重建跑量
alter table planned_sessions add column if not exists label text;                  -- original 類型: Easy / Recovery / MP / 坡跑 / 肌力 …
alter table planned_sessions add column if not exists content text;                -- 內容 (column H): "2 km Easy + 3 km @ MP + 2 km Easy"
alter table planned_sessions add column if not exists target text;                 -- 配速/心拍 verbatim (column G)
alter table planned_sessions add column if not exists target_pace_min_sec_km int;  -- fastest allowed
alter table planned_sessions add column if not exists target_pace_max_sec_km int;  -- slowest allowed
alter table planned_sessions add column if not exists target_hr_min int;
alter table planned_sessions add column if not exists target_hr_max int;
create index if not exists planned_sessions_plan_id_scheduled_date_idx
  on planned_sessions (plan_id, scheduled_date);

create table if not exists activities (
  id uuid primary key,
  user_id uuid not null references users(id),
  strava_activity_id bigint unique not null,
  session_id uuid references planned_sessions(id),
  start_time timestamptz not null,
  distance_m int not null,
  moving_time_sec int not null,
  avg_pace_sec_km int,
  avg_hr int,
  splits jsonb,
  match_status text not null default 'auto',   -- auto | confirmed | unplanned | ignored
  raw jsonb
);
alter table activities add column if not exists sport_type text;    -- Strava sport_type: Run / TrailRun / Ride / WeightTraining …
alter table activities add column if not exists description text;   -- Strava description (memo)
alter table activities add column if not exists max_hr int;
alter table activities add column if not exists avg_watts int;
alter table activities add column if not exists kcal int;
alter table activities add column if not exists device_name text;
alter table activities add column if not exists gear_id text;
alter table activities add column if not exists gear_name text;      -- shoes
alter table activities add column if not exists weather text;        -- free text; no automatic source yet
alter table activities add column if not exists memo text;           -- athlete's own note, written in the app
alter table activities add column if not exists rpe int;             -- athlete's RPE 1-10
alter table activities add column if not exists memo_updated_at timestamptz;

create table if not exists reviews (
  id uuid primary key,
  activity_id uuid unique not null references activities(id),
  verdict text,                  -- 達成 | 達成但有提醒 | 未達成
  comment text,                  -- 心得 paragraph
  rpe int,
  model text,
  created_at timestamptz not null default now()
);
alter table reviews add column if not exists reminders jsonb;                        -- string[]
alter table reviews add column if not exists source text not null default 'manual'; -- manual | claude
alter table reviews add column if not exists adjust_hint text;                      -- Claude's one-line plan-adjustment suggestion (weekly review input)

create table if not exists weekly_reviews (
  id uuid primary key,
  plan_id uuid not null references plans(id),
  week_start date not null,
  summary text,
  adjustments jsonb,
  created_at timestamptz not null default now()
);
