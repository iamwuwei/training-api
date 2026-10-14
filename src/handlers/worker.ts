import { randomUUID } from "node:crypto";
import type { SQSHandler } from "aws-lambda";
import { query, queryOne } from "../lib/db";
import { matchSession, type MatchCandidate } from "../lib/matcher";
import { getActivity, refreshToken, StravaError } from "../lib/strava";
import type { StravaConnectionRow, StravaWebhookEvent } from "../types";

// Any thrown error => SQS redelivers (visibility 90 s, 3 tries, then DLQ).
// That covers Aurora waking up from 0 ACU.

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const body = JSON.parse(record.body) as StravaWebhookEvent;
    await processEvent(body);
  }
};

async function getFreshConnection(athleteId: number): Promise<StravaConnectionRow | undefined> {
  const conn = await queryOne<StravaConnectionRow>(
    "select * from strava_connections where strava_athlete_id = $1",
    [athleteId],
  );
  if (!conn) return undefined;

  const expiresSoon = new Date(conn.expires_at).getTime() < Date.now() + 60_000;
  if (!expiresSoon) return conn;

  const t = await refreshToken(conn.refresh_token);
  await query(
    `update strava_connections
        set access_token = $2, refresh_token = $3, expires_at = to_timestamp($4)
      where user_id = $1`,
    [conn.user_id, t.access_token, t.refresh_token, t.expires_at],
  );
  return { ...conn, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: new Date(t.expires_at * 1000) };
}

export async function processEvent(ev: StravaWebhookEvent): Promise<void> {
  const conn = await getFreshConnection(ev.owner_id);
  if (!conn) {
    console.log(`no strava_connection for athlete ${ev.owner_id}, skipping activity ${ev.object_id}`);
    return;
  }

  let activity;
  try {
    activity = await getActivity(conn.access_token, ev.object_id);
  } catch (err) {
    if (err instanceof StravaError && err.status === 404) {
      console.log(`activity ${ev.object_id} not found (deleted?), skipping`);
      return;
    }
    throw err;
  }

  if (activity.type !== "Run") {
    console.log(`activity ${activity.id} is ${activity.type}/${activity.sport_type}, skipping`);
    return;
  }

  const distance_m = Math.round(activity.distance);
  const moving_time_sec = Math.round(activity.moving_time);
  const avg_pace_sec_km = distance_m > 0 ? Math.round(moving_time_sec / (distance_m / 1000)) : null;
  const avg_hr = activity.average_heartrate != null ? Math.round(activity.average_heartrate) : null;
  const localDate = activity.start_date_local.slice(0, 10);

  // Eligible sessions: this user's active plan(s), ±2 days, not superseded,
  // not already claimed by a *different* activity.
  const candidates = await query<MatchCandidate>(
    `select ps.id, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
            ps.type, ps.target_distance_m
       from planned_sessions ps
       join plans p on p.id = ps.plan_id
      where p.user_id = $1
        and p.status = 'active'
        and ps.superseded = false
        and ps.scheduled_date between ($2::date - 2) and ($2::date + 2)
        and not exists (
          select 1 from activities a
           where a.session_id = ps.id
             and a.strava_activity_id <> $3
             and a.match_status <> 'ignored')`,
    [conn.user_id, localDate, activity.id],
  );

  const matched = matchSession({ localDate, distance_m }, candidates);

  // On update events keep anything a human already decided (confirmed/ignored).
  await query(
    `insert into activities
       (id, user_id, strava_activity_id, session_id, start_time, distance_m, moving_time_sec,
        avg_pace_sec_km, avg_hr, splits, match_status, raw)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (strava_activity_id) do update set
       start_time      = excluded.start_time,
       distance_m      = excluded.distance_m,
       moving_time_sec = excluded.moving_time_sec,
       avg_pace_sec_km = excluded.avg_pace_sec_km,
       avg_hr          = excluded.avg_hr,
       splits          = excluded.splits,
       raw             = excluded.raw,
       session_id      = case when activities.match_status in ('confirmed', 'ignored')
                              then activities.session_id else excluded.session_id end,
       match_status    = case when activities.match_status in ('confirmed', 'ignored')
                              then activities.match_status else excluded.match_status end`,
    [
      randomUUID(),
      conn.user_id,
      activity.id,
      matched?.id ?? null,
      new Date(activity.start_date),
      distance_m,
      moving_time_sec,
      avg_pace_sec_km,
      avg_hr,
      JSON.stringify(activity.splits_metric ?? null),
      matched ? "auto" : "unplanned",
      JSON.stringify(activity),
    ],
  );

  console.log(
    `activity ${activity.id} (${localDate}, ${(distance_m / 1000).toFixed(2)} km) -> ` +
      (matched ? `session ${matched.id} (${matched.scheduled_date} ${matched.type})` : "unplanned"),
  );
}
