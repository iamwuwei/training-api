import { randomUUID } from "node:crypto";
import type { SQSHandler } from "aws-lambda";
import { reviewActivity } from "../lib/claude";
import { query, queryOne } from "../lib/db";
import { matchSession, type MatchCandidate } from "../lib/matcher";
import { getActivity, refreshToken, StravaError } from "../lib/strava";
import type { PlannedSessionRow, StravaConnectionRow, StravaWebhookEvent } from "../types";

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

export async function processEvent(ev: Pick<StravaWebhookEvent, "object_id" | "owner_id">): Promise<void> {
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

  // Every sport is stored (so a Hyrox or a ride can be assigned to a 肌力 day
  // by hand); only runs are auto-matched and reviewed.
  const isRun = activity.type === "Run";
  const distance_m = Math.round(activity.distance ?? 0);
  const moving_time_sec = Math.round(activity.moving_time ?? 0);
  const avg_pace_sec_km = isRun && distance_m > 0 ? Math.round(moving_time_sec / (distance_m / 1000)) : null;
  const round = (v: number | undefined | null) => (v != null ? Math.round(v) : null);
  const localDate = activity.start_date_local.slice(0, 10);

  // Eligible sessions: this user's active plan(s), ±2 days, not superseded,
  // not already claimed by a *different* activity.
  const candidates = !isRun ? [] : await query<MatchCandidate>(
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
  const activityId = randomUUID();

  // On update events keep anything a human already decided (confirmed/ignored).
  const [row] = await query<{ id: string; session_id: string | null; memo: string | null; rpe: number | null }>(
    `insert into activities
       (id, user_id, strava_activity_id, session_id, start_time, distance_m, moving_time_sec,
        avg_pace_sec_km, avg_hr, max_hr, avg_watts, kcal, description, device_name, gear_id, gear_name,
        splits, match_status, raw, sport_type)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     on conflict (strava_activity_id) do update set
       sport_type      = excluded.sport_type,
       start_time      = excluded.start_time,
       distance_m      = excluded.distance_m,
       moving_time_sec = excluded.moving_time_sec,
       avg_pace_sec_km = excluded.avg_pace_sec_km,
       avg_hr          = excluded.avg_hr,
       max_hr          = excluded.max_hr,
       avg_watts       = excluded.avg_watts,
       kcal            = excluded.kcal,
       description     = excluded.description,
       device_name     = coalesce(excluded.device_name, activities.device_name),
       gear_id         = excluded.gear_id,
       gear_name       = coalesce(excluded.gear_name, activities.gear_name),
       splits          = excluded.splits,
       raw             = excluded.raw,
       session_id      = case when activities.match_status in ('confirmed', 'ignored')
                              then activities.session_id else excluded.session_id end,
       match_status    = case when activities.match_status in ('confirmed', 'ignored')
                              then activities.match_status else excluded.match_status end
     returning id, session_id, memo, rpe`,
    [
      activityId,
      conn.user_id,
      activity.id,
      matched?.id ?? null,
      new Date(activity.start_date),
      distance_m,
      moving_time_sec,
      avg_pace_sec_km,
      round(activity.average_heartrate),
      round(activity.max_heartrate),
      round(activity.average_watts),
      round(activity.calories),
      activity.description || null,
      activity.device_name ?? null,
      activity.gear_id ?? activity.gear?.id ?? null,
      activity.gear?.name ?? null,
      JSON.stringify(activity.splits_metric ?? null),
      matched ? "auto" : "unplanned",
      JSON.stringify(activity),
      activity.sport_type ?? activity.type,
    ],
  );

  console.log(
    `activity ${activity.id} (${localDate}, ${activity.sport_type}, ${(distance_m / 1000).toFixed(2)} km) -> ` +
      (row.session_id ? `session ${row.session_id}` : "unplanned"),
  );

  // Automatic verdict (AUTO_REVIEW=true): runs only, once per activity, never
  // over a manual review. A Claude failure must not requeue the activity.
  if (process.env.AUTO_REVIEW === "true" && isRun && row.session_id) {
    const existing = await queryOne<{ id: string }>("select id from reviews where activity_id = $1", [row.id]);
    if (!existing) {
      const session = await queryOne<PlannedSessionRow>(
        "select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions where id = $1",
        [row.session_id],
      );
      if (session) {
        try {
          const r = await reviewActivity({
            session,
            activity: {
              distance_m,
              moving_time_sec,
              avg_pace_sec_km,
              avg_hr: round(activity.average_heartrate),
              max_hr: round(activity.max_heartrate),
              splits: activity.splits_metric ?? null,
              description: activity.description ?? null,
              memo: row.memo,
              rpe: row.rpe,
            },
          });
          await query(
            `insert into reviews (id, activity_id, verdict, comment, reminders, source, model)
             values ($1, $2, $3, $4, $5, 'claude', $6)
             on conflict (activity_id) do nothing`,
            [randomUUID(), row.id, r.verdict, r.comment, JSON.stringify(r.reminders), r.model],
          );
          console.log(`review for activity ${activity.id}: ${r.verdict} (${r.reminders.length} reminders)`);
        } catch (err) {
          console.error(`auto review failed for activity ${activity.id}`, err);
        }
      }
    }
  }
}
