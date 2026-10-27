import type { HistoryItem, ReviewContext } from "./claude";
import { loadLiveConstraints } from "./constraints";
import { query, queryOne } from "./db";
import type { PlanRow, PlanWeekRow, PlannedSessionRow, Verdict } from "../types";

// What the coach knows beyond today's session: the athlete's goal, the plan's
// phases, this week, the last two weeks of training, and the same session type's
// history. Read-only queries; nothing here changes state.

interface HistoryRow {
  date: string;
  label: string | null;
  sport_type: string | null;
  distance_m: number;
  moving_time_sec: number;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  verdict: Verdict | null;
  reminders: string[] | null;
  rpe: number | null;
  memo: string | null;
  description: string | null;
}

const HISTORY_SELECT = `
  select to_char(a.start_time at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as date,
         ps.label, a.sport_type, a.distance_m, a.moving_time_sec, a.avg_pace_sec_km, a.avg_hr,
         r.verdict, r.reminders, a.rpe, a.memo, a.description
    from activities a
    left join planned_sessions ps on ps.id = a.session_id
    left join reviews r on r.activity_id = a.id`;

const toItem = (h: HistoryRow): HistoryItem => ({
  date: h.date,
  label: h.label,
  sport_type: h.sport_type,
  distance_m: h.distance_m,
  moving_time_sec: h.moving_time_sec,
  avg_pace_sec_km: h.avg_pace_sec_km,
  avg_hr: h.avg_hr,
  verdict: h.verdict,
  reminders: h.reminders ?? [],
  rpe: h.rpe,
  memo: h.memo ?? h.description,
});

/** Activities of one user between two JST dates (inclusive), oldest first, ignored ones left out. */
export async function historyBetween(userId: string, from: string, to: string): Promise<HistoryItem[]> {
  const rows = await query<HistoryRow>(
    `${HISTORY_SELECT}
      where a.user_id = $1 and a.match_status <> 'ignored'
        and (a.start_time at time zone 'Asia/Tokyo')::date between $2 and $3
      order by a.start_time`,
    [userId, from, to],
  );
  return rows.map(toItem);
}

export async function loadPlanWeeks(planId: string): Promise<PlanWeekRow[]> {
  return query<PlanWeekRow>(
    `select id, plan_id, week_no, to_char(week_start, 'YYYY-MM-DD') as week_start, to_char(week_end, 'YYYY-MM-DD') as week_end, phase, focus
       from plan_weeks where plan_id = $1 order by week_no`,
    [planId],
  );
}

/**
 * The context for reviewing `session` run on `date` by `userId`. `activityId` is
 * the activity being reviewed, so it is left out of the history it is compared to.
 */
export async function loadReviewContext(
  userId: string,
  session: PlannedSessionRow,
  date: string,
  activityId: string,
): Promise<ReviewContext | undefined> {
  const plan = await queryOne<PlanRow & { display_name: string }>(
    `select p.*, to_char(p.race_date, 'YYYY-MM-DD') as race_date, u.display_name
       from plans p join users u on u.id = p.user_id
      where p.id = $1`,
    [session.plan_id],
  );
  if (!plan) return undefined;

  const weeks = await loadPlanWeeks(plan.id);
  const week = weeks.find((w) => session.scheduled_date >= w.week_start && session.scheduled_date <= w.week_end);

  const thisWeek: ReviewContext["thisWeek"] = [];
  if (week) {
    const sessions = await query<PlannedSessionRow & { done: boolean }>(
      `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
              exists (select 1 from activities a where a.session_id = ps.id and a.match_status <> 'ignored') as done
         from planned_sessions ps
        where ps.plan_id = $1 and ps.superseded = false and ps.scheduled_date between $2 and $3
        order by ps.scheduled_date`,
      [plan.id, week.week_start, week.week_end],
    );
    for (const s of sessions) {
      const { done, ...row } = s;
      const status = s.id === session.id ? "today" : done ? "done" : s.scheduled_date < date && s.type !== "rest" ? "skipped" : "upcoming";
      thisWeek.push({ session: row, status });
    }
  }

  const since = new Date(Date.parse(`${date}T00:00:00Z`) - 14 * 86_400_000).toISOString().slice(0, 10);
  const recent = (await query<HistoryRow & { id: string }>(
    `${HISTORY_SELECT.replace("select ", "select a.id, ")}
      where a.user_id = $1 and a.match_status <> 'ignored' and a.id <> $4
        and (a.start_time at time zone 'Asia/Tokyo')::date between $2 and $3
      order by a.start_time`,
    [userId, since, date, activityId],
  )).map(toItem);

  const sameType = session.label
    ? (await query<HistoryRow>(
        `${HISTORY_SELECT}
          where a.user_id = $1 and a.match_status <> 'ignored' and a.id <> $3 and ps.label = $2
            and a.start_time < (select start_time from activities where id = $3)
          order by a.start_time desc limit 5`,
        [userId, session.label, activityId],
      )).reverse().map(toItem)
    : [];

  const prev = await queryOne<{ reminders: string[] | null }>(
    `select r.reminders from reviews r join activities a on a.id = r.activity_id
      where a.user_id = $1 and a.id <> $2 and r.verdict is not null
        and a.start_time < (select start_time from activities where id = $2)
      order by a.start_time desc limit 1`,
    [userId, activityId],
  );

  const constraints = await loadLiveConstraints(userId, date);

  return { plan, weeks, thisWeek, recent, sameType, prevReminders: prev?.reminders ?? [], constraints };
}
