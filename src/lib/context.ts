import type { HistoryItem, ReviewContext } from "./claude";
import { loadLiveConstraints } from "./constraints";
import { query, queryOne } from "./db";
import { GROUP_DATE_JOIN, sumGroup } from "./session-group";
import type { PlanRow, PlanWeekRow, PlannedSessionRow, Verdict } from "../types";

// What the coach knows beyond today's session: the athlete's goal, the plan's
// phases, this week, the last two weeks of training, and the same session type's
// history. Read-only queries; nothing here changes state.

interface HistoryRow {
  id: string;
  session_id: string | null;
  start_time: Date;
  date: string;
  label: string | null;
  sport_type: string | null;
  distance_m: number;
  moving_time_sec: number;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_watts: number | null;
  kcal: number | null;
  verdict: Verdict | null;
  reminders: string[] | null;
  rpe: number | null;
  memo: string | null;
  description: string | null;
}

// `date` is the GROUP's date (the primary's: a second segment after midnight stays on the first one's day); the
// queries that use this select filter and order by it too. `$1` is always the user id (GROUP_DATE_JOIN).
const HISTORY_SELECT = `
  select a.id, a.session_id, a.start_time, to_char(coalesce(g.t0, a.start_time) at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as date,
         ps.label, a.sport_type, a.distance_m, a.moving_time_sec, a.avg_pace_sec_km, a.avg_hr, a.max_hr, a.avg_watts, a.kcal,
         r.verdict, r.reminders, a.rpe, a.memo, a.description
    from activities a${GROUP_DATE_JOIN}
    left join planned_sessions ps on ps.id = a.session_id
    left join reviews r on r.activity_id = a.id`;
const GROUP_DAY = "(coalesce(g.t0, a.start_time) at time zone 'Asia/Tokyo')::date";

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
  segments: 1,
});

/**
 * One item per session: the recordings of a session (same session_id, in the rows given) become one line with the
 * combined numbers (sumGroup, the same rule as the report page), the primary's (= earliest) verdict and reminders,
 * every recording's memo joined with "／" and the number of recordings. Rows without a session, and a session with
 * one recording, come out exactly as before. Order follows the first row of each session.
 */
export function groupHistory(rows: HistoryRow[]): HistoryItem[] {
  const bySession = new Map<string, HistoryRow[]>();
  const units: (HistoryRow | string)[] = []; // a row without a session, or a session key at the place of its first row
  for (const r of rows) {
    if (r.session_id == null) { units.push(r); continue; }
    const have = bySession.get(r.session_id);
    if (have) have.push(r);
    else { bySession.set(r.session_id, [r]); units.push(r.session_id); }
  }
  return units.map((u) => {
    if (typeof u !== "string") return toItem(u);
    const members = bySession.get(u)!.sort((x, y) => new Date(x.start_time).getTime() - new Date(y.start_time).getTime() || (x.id < y.id ? -1 : 1));
    if (members.length === 1) return toItem(members[0]);
    const primary = members[0];
    const memos = members.map((m) => m.memo ?? m.description).filter((m): m is string => !!m);
    return {
      ...toItem(primary),
      ...sumGroup(members),
      rpe: primary.rpe ?? members.find((m) => m.rpe != null)?.rpe ?? null,
      memo: memos.length ? memos.join("／") : null,
      segments: members.length,
    };
  });
}

/** Activities of one user between two JST dates (inclusive; a session by its first recording's date), oldest first, ignored ones left out; one item per session. */
export async function historyBetween(userId: string, from: string, to: string): Promise<HistoryItem[]> {
  const rows = await query<HistoryRow>(
    `${HISTORY_SELECT}
      where a.user_id = $1 and a.match_status <> 'ignored'
        and ${GROUP_DAY} between $2 and $3
      order by coalesce(g.t0, a.start_time), a.start_time, a.id`,
    [userId, from, to],
  );
  return groupHistory(rows);
}

export async function loadPlanWeeks(planId: string): Promise<PlanWeekRow[]> {
  return query<PlanWeekRow>(
    `select id, plan_id, week_no, to_char(week_start, 'YYYY-MM-DD') as week_start, to_char(week_end, 'YYYY-MM-DD') as week_end, phase, focus
       from plan_weeks where plan_id = $1 order by week_no`,
    [planId],
  );
}

/**
 * The context for reviewing `session` run on `date` (the primary's date) by `userId`. `activityIds` are the
 * recordings of the session being reviewed (its whole group), so none of them is in the history it is compared to.
 */
export async function loadReviewContext(
  userId: string,
  session: PlannedSessionRow,
  date: string,
  activityIds: string[],
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
  const recent = groupHistory(await query<HistoryRow>(
    `${HISTORY_SELECT}
      where a.user_id = $1 and a.match_status <> 'ignored' and a.id <> all($4::uuid[])
        and ${GROUP_DAY} between $2 and $3
      order by coalesce(g.t0, a.start_time), a.start_time, a.id`,
    [userId, since, date, activityIds],
  ));

  // The last five sessions of this kind (a session of several recordings is one): read ten rows, then group.
  const sameType = session.label
    ? groupHistory(await query<HistoryRow>(
        `${HISTORY_SELECT}
          where a.user_id = $1 and a.match_status <> 'ignored' and a.id <> all($3::uuid[]) and ps.label = $2
            and coalesce(g.t0, a.start_time) < (select min(start_time) from activities where id = any($3::uuid[]) and user_id = $1)
          order by coalesce(g.t0, a.start_time) desc, a.start_time desc, a.id desc limit 10`,
        [userId, session.label, activityIds],
      )).reverse().slice(-5)
    : [];

  const prev = await queryOne<{ reminders: string[] | null }>(
    `select r.reminders from reviews r join activities a on a.id = r.activity_id
      where a.user_id = $1 and a.id <> all($2::uuid[]) and r.verdict is not null
        and a.start_time < (select min(start_time) from activities where id = any($2::uuid[]) and user_id = $1)
      order by a.start_time desc limit 1`,
    [userId, activityIds],
  );

  const constraints = await loadLiveConstraints(userId, date);

  return { plan, weeks, thisWeek, recent, sameType, prevReminders: prev?.reminders ?? [], constraints };
}
