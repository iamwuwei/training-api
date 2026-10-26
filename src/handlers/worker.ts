import { randomUUID } from "node:crypto";
import type { SQSHandler } from "aws-lambda";
import { reviewActivity } from "../lib/claude";
import { writeBriefs } from "../lib/briefs";
import { askAboutActivity, maybeCheckin, settleAthleteMessages, sportName } from "../lib/checkin";
import { writeRoutine } from "../lib/strength";
import { answerCoachMessage, postCoachMessage } from "../lib/coach";
import { loadReviewContext } from "../lib/context";
import { isDbWaking, query, queryOne } from "../lib/db";
import { getActivity, refreshToken, StravaError } from "../lib/strava";
import { maybeRerunWeeklyReview, runWeeklyReview, WEEKLY_REVIEW_SELECT } from "../lib/weekly";
import type { BriefsJob, CoachAskJob, CoachReplyJob, PlanRow, PlannedSessionRow, RoutineJob, StravaConnectionRow, StravaWebhookEvent, WeeklyRerunJob, WeeklyReviewRow } from "../types";

// Any thrown error => SQS redelivers (visibility 90 s, 3 tries, then DLQ).
// Aurora resuming from 0 ACU is the usual first failure: wait inside this run
// and try once more (the Lambda has 90 s) before leaving it to SQS.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

type Job = StravaWebhookEvent | CoachReplyJob | CoachAskJob | RoutineJob | BriefsJob | WeeklyRerunJob;

async function handleJob(body: Job): Promise<void> {
  if ("type" in body && body.type === "coach_reply") {
    await answerCoachMessage(body.user_id, body.message_id, todayJst());
    return;
  }
  if ("type" in body && body.type === "weekly_rerun") {
    await rerunWeekly(body);
    return;
  }
  if ("type" in body && body.type === "coach_ask") {
    await askAboutActivity(body.user_id, body.message_id);
    return;
  }
  if ("type" in body && body.type === "routine") {
    await writeRoutine(body.user_id, body.routine_id);
    return;
  }
  if ("type" in body && body.type === "briefs") {
    try {
      await writeBriefs(body.user_id, body.from, body.to, body.force);
    } catch (err) {
      console.error(`briefs failed for user ${body.user_id}`, err); // not requeued; GET /plan asks again later
    }
    return;
  }
  await processEvent(body as StravaWebhookEvent);
}

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const body = JSON.parse(record.body) as Job;
    try {
      await handleJob(body);
    } catch (err) {
      if (!isDbWaking(err)) throw err;
      console.warn("database waking up, retrying in 8 s:", err instanceof Error ? err.message : err);
      await sleep(8_000);
      await handleJob(body);
    }
  }
};

/** The athlete answered 沒跑 to a weekly question: regenerate that review. A redelivery after it ran is skipped. */
async function rerunWeekly(job: WeeklyRerunJob): Promise<void> {
  const w = await queryOne<WeeklyReviewRow & { user_id: string }>(
    `${WEEKLY_REVIEW_SELECT.replace("from weekly_reviews", ", (select user_id from plans where id = plan_id) as user_id from weekly_reviews")} where id = $1`,
    [job.weekly_review_id],
  );
  if (!w || w.user_id !== job.user_id) return;
  if (w.updated_at && new Date(w.updated_at).getTime() >= Date.parse(job.requested_at)) return; // already done
  const plan = await queryOne<PlanRow & { display_name: string }>(
    `select p.*, to_char(p.race_date, 'YYYY-MM-DD') as race_date, u.display_name from plans p join users u on u.id = p.user_id where p.id = $1`,
    [w.plan_id],
  );
  if (!plan) return;
  const { user_id, ...row } = w;
  void user_id;
  try {
    const r = await runWeeklyReview(plan, w.week_start, row, job.reason);
    console.log(`weekly review ${r.review_id} regenerated (${job.reason}): ${r.adjustments} adjustments, ${r.asks} asks`);
  } catch (err) {
    console.error(`weekly rerun failed for review ${job.weekly_review_id}`, err); // not requeued (same failure again); the next activity tries again
  }
}

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

  // Every sport is stored as-is. Nothing is matched to a planned session here:
  // the athlete picks which activity fulfils a session (PUT /activities/{id}/session).
  const isRun = activity.type === "Run";
  const distance_m = Math.round(activity.distance ?? 0);
  const moving_time_sec = Math.round(activity.moving_time ?? 0);
  const avg_pace_sec_km = isRun && distance_m > 0 ? Math.round(moving_time_sec / (distance_m / 1000)) : null;
  const round = (v: number | undefined | null) => (v != null ? Math.round(v) : null);
  const localDate = activity.start_date_local.slice(0, 10);

  const activityId = randomUUID();

  // On update events the athlete's choice (session_id / match_status) is never touched.
  const [row] = await query<{ id: string; session_id: string | null; memo: string | null; rpe: number | null; inserted: boolean }>(
    `insert into activities
       (id, user_id, strava_activity_id, session_id, start_time, distance_m, moving_time_sec,
        avg_pace_sec_km, avg_hr, max_hr, avg_watts, kcal, description, device_name, gear_id, gear_name,
        splits, match_status, raw, sport_type)
     values ($1, $2, $3, null, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'unplanned', $17, $18)
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
       raw             = excluded.raw
     returning id, session_id, memo, rpe, (xmax = 0) as inserted`,
    [
      activityId,
      conn.user_id,
      activity.id,
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
      JSON.stringify(activity),
      activity.sport_type ?? activity.type,
    ],
  );

  console.log(
    `activity ${activity.id} (${localDate}, ${activity.sport_type}, ${(distance_m / 1000).toFixed(2)} km) -> ` +
      (row.session_id ? `session ${row.session_id}` : "waiting for the athlete to pick a session"),
  );

  // A new, unassigned activity: Woo asks which session it was (if any fits today).
  const day = localDate.slice(5).replace("-", "/");
  if (row.inserted && !row.session_id) {
    let asked = false;
    try {
      asked = await maybeCheckin(conn.user_id, {
        id: row.id, sport_type: activity.sport_type ?? activity.type, start_time: new Date(activity.start_date),
        distance_m, moving_time_sec, avg_pace_sec_km, avg_hr: round(activity.average_heartrate), max_hr: round(activity.max_heartrate),
      }, localDate);
    } catch (err) {
      console.error(`check-in failed for activity ${activity.id}`, err); // the athlete can still log it from the today page
    }
    // Nothing to pick: the week's review (if already written) learns about it now.
    // With a check-in open, the regeneration waits for the pick and its verdict below.
    if (!asked) await maybeRerunWeeklyReview(conn.user_id, row.id, localDate, `${day} 的${sportName(activity.sport_type ?? activity.type)}進來了`);
  }

  // Claude verdict (AUTO_REVIEW=true): only once the athlete has assigned the
  // activity to a session (the api requeues it then), once per activity, never over
  // a manual review. Any sport counts (e.g. Hyrox on a 肌力 day). A Claude
  // failure must not requeue.
  if (process.env.AUTO_REVIEW === "true" && row.session_id) {
    const existing = await queryOne<{ id: string }>(
      "select id from reviews where activity_id = $1 and not (source = 'claude' and verdict is null)",
      [row.id],
    );
    if (!existing) {
      const session = await queryOne<PlannedSessionRow>(
        "select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions where id = $1",
        [row.session_id],
      );
      if (session) {
        try {
          const context = await loadReviewContext(conn.user_id, session, localDate, row.id);
          const r = await reviewActivity({
            session,
            activity: {
              sport_type: activity.sport_type ?? activity.type,
              start_date: localDate,
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
            context,
          });
          // A failed attempt (verdict null) from an earlier delivery is replaced; a real review is kept.
          await query(
            `insert into reviews (id, activity_id, verdict, comment, reminders, source, model, adjust_hint)
             values ($1, $2, $3, $4, $5, 'claude', $6, $7)
             on conflict (activity_id) do update set
               verdict = excluded.verdict, comment = excluded.comment, reminders = excluded.reminders,
               model = excluded.model, adjust_hint = excluded.adjust_hint, created_at = now()
             where reviews.source = 'claude' and reviews.verdict is null`,
            [randomUUID(), row.id, r.verdict, r.comment, JSON.stringify(r.reminders), r.model, r.adjust_hint],
          );
          console.log(`review for activity ${activity.id}: ${r.verdict} (${r.reminders.length} reminders)${r.adjust_hint ? ` hint: ${r.adjust_hint}` : ""}`);
          // The verdict also shows up in the coach's thread.
          const label = `${session.label ?? session.type}${session.target_distance_m ? ` ${Math.round(session.target_distance_m / 100) / 10} km` : ""}`;
          await postCoachMessage({
            user_id: conn.user_id, role: "coach", kind: "review", text: r.comment, activity_id: row.id,
            meta: { label, verdict: r.verdict, reminder: r.reminders[0] ?? null, date: localDate },
          });
          await settleAthleteMessages(conn.user_id, row.id); // the answer that triggered this review is replied to
          // The week's review was written without this activity (late sync): regenerate it in place.
          await maybeRerunWeeklyReview(conn.user_id, row.id, localDate, `${day} 的${session.label ?? session.type}進來了`);
        } catch (err) {
          // Not requeued (SQS would only retry the same failure). Recorded so the
          // app can show "分析失敗" with a retry instead of waiting forever.
          console.error(`auto review failed for activity ${activity.id}`, err);
          const reason = err instanceof Error ? err.message.slice(0, 300) : String(err);
          await query(
            `insert into reviews (id, activity_id, verdict, comment, reminders, source, model)
             values ($1, $2, null, $3, '[]', 'claude', null)
             on conflict (activity_id) do nothing`,
            [randomUUID(), row.id, `分析失敗：${reason}`],
          );
          await settleAthleteMessages(conn.user_id, row.id);
          await postCoachMessage({ user_id: conn.user_id, role: "coach", kind: "chat", text: "這次分析沒成功，報告頁可以按「重新分析」。", activity_id: row.id });
        }
      }
    }
  }
}
