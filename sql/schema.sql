-- training-backend schema (PostgreSQL 17 / Aurora Serverless v2)
-- Idempotent: safe to run repeatedly via `npm run migrate`.

create table if not exists users (
  id uuid primary key,
  email text unique,
  display_name text not null,
  created_at timestamptz not null default now()
);

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

create table if not exists planned_sessions (
  id uuid primary key,
  plan_id uuid not null references plans(id),
  scheduled_date date not null,
  type text not null,            -- easy | long | tempo | interval | rest | race
  target_distance_m int,
  target_pace_sec_km int,
  note text,
  version int not null default 1,
  superseded boolean not null default false
);
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

create table if not exists reviews (
  id uuid primary key,
  activity_id uuid unique not null references activities(id),
  verdict text,
  comment text,
  rpe int,
  model text,
  created_at timestamptz not null default now()
);

create table if not exists weekly_reviews (
  id uuid primary key,
  plan_id uuid not null references plans(id),
  week_start date not null,
  summary text,
  adjustments jsonb,
  created_at timestamptz not null default now()
);
