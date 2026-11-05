import { isRunSport } from "./labels";
import type { ApiGroupProgress, SessionType } from "../../types/api";

// group-race dashboard numbers: pure functions, no DB, no clock (`today` is passed in). The numbers a member shows the
// others in 群組 → 詳細頁 (01 N). Two kinds:
//   - `runs`  needs no plan: this week's km / runs (JST calendar week, Monday..Sunday), the longest single run of the last
//             84 days. Always there.
//   - `plan`  needs his active plan AND the group's race date inside that plan's span (planRange). Outside it the api
//             answers a state (out_of_range / no_plan) and never the numbers of another race.
//
// The plan part mirrors training-web app/lib/plan.ts `buildPlanView` (origin/develop 5f048fa), rule by rule:
//   rows       plan.ts 85-100 days      every planned_sessions row of the plan the api sends (not superseded, plus the moved
//                                       rows); an activity counts for its session unless it is `ignored` (combine.ts groupBySession)
//   week       plan.ts 110-125 weeks    `counted` = rows whose counts_in_week_no is the week's number; plan_m = their
//                                       target_distance_m, actual_m = the activities on them, 堂數 as plan.ts weekSubline:
//                                       counted rows that are not rest (plan_count) and those with an activity (done_count)
//                                       the week is the one holding `today` (plan.ts currentWeek, isCurrent)
//   total      plan.ts 128-137          actual_m = every activity of the plan; plan_to_date_m = target of the counting rows
//                                       (counts_in_week_no not null) dated <= today; pct = round(actual / plan_to_date * 100), 0 when no plan to date
// One difference on purpose: total.done_count is sessions with an activity (as the 堂 in plan_count_to_date), buildPlanView's
// totals.done_count is the number of recordings, which is bigger when a session has two segments.

export interface ProgressSession {
  id: string;
  scheduled_date: string; // 'YYYY-MM-DD'
  type: SessionType;
  target_distance_m: number | null;
  /** As GET /plan sends it (labels.ts countsWeekNo): null = in no week's numbers (a moved row the make-up replaced). */
  counts_in_week_no: number | null;
}
export interface ProgressWeek { week_no: number; week_start: string; week_end: string }
/** An activity bound to one of the plan's sessions. */
export interface ProgressActivity { session_id: string; distance_m: number; match_status: string }
export interface ProgressRun { start_time: Date; distance_m: number; sport_type: string | null }

export interface MemberData {
  plan: { race_date: string; weeks: ProgressWeek[]; sessions: ProgressSession[]; activities: ProgressActivity[] } | null;
  /** Run activities of the last 84 days, not ignored (any session or none). */
  runs: ProgressRun[];
}

const DAY = 86_400_000;
export const RUNS_WINDOW_DAYS = 84;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** JST calendar date of an instant. */
export const jstDate = (d: Date | string) => new Date(new Date(d).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
/** The Monday on or before `iso`. */
const mondayOf = (iso: string) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));

/**
 * The span of his active plan: first week's start .. the plan's race day, both included; null when there is nothing to span.
 * `plan_start` is the first plan week's start (the first session's date when the plan has no week rows).
 */
export function planRange(plan: MemberData["plan"]): { start: string; end: string } | null {
  if (!plan) return null;
  const starts = plan.weeks.length ? plan.weeks.map((w) => w.week_start) : plan.sessions.map((s) => s.scheduled_date);
  if (!starts.length) return null;
  return { start: starts.reduce((a, b) => (b < a ? b : a)), end: plan.race_date };
}

/** The plan-independent part: this JST week and the longest single run. */
export function runStats(runs: ProgressRun[], today: string): ApiGroupProgress["runs"] {
  const week_start = mondayOf(today);
  const week_end = addDays(week_start, 6);
  const mine = runs.filter((r) => isRunSport(r.sport_type));
  const inWeek = mine.filter((r) => {
    const d = jstDate(r.start_time);
    return d >= week_start && d <= week_end;
  });
  let longest: ProgressRun | null = null;
  // oldest first, `>=`: on a tie the most recent one is shown
  for (const r of [...mine].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())) {
    if (!longest || r.distance_m >= longest.distance_m) longest = r;
  }
  return {
    week_start,
    week_actual_m: inWeek.reduce((s, r) => s + r.distance_m, 0),
    week_runs: inWeek.length,
    longest_m: longest && longest.distance_m > 0 ? longest.distance_m : null,
    longest_date: longest && longest.distance_m > 0 ? jstDate(longest.start_time) : null,
  };
}

export function memberProgress(d: MemberData, groupRaceDate: string, today: string): ApiGroupProgress {
  const runs = runStats(d.runs, today);
  const plan = d.plan;
  const range = planRange(plan);
  if (!plan || !range) return { runs, plan_state: "no_plan", plan: null };
  if (groupRaceDate < range.start || groupRaceDate > range.end) return { runs, plan_state: "out_of_range", plan: null };

  // distance and recordings per session, `ignored` ones left out (groupBySession)
  const meters = new Map<string, number>();
  for (const a of plan.activities) {
    if (a.match_status === "ignored") continue;
    meters.set(a.session_id, (meters.get(a.session_id) ?? 0) + a.distance_m);
  }
  const done = (s: ProgressSession) => meters.has(s.id);

  const cur = plan.weeks.find((w) => today >= w.week_start && today <= w.week_end);
  let week: NonNullable<ApiGroupProgress["plan"]>["week"] = null;
  if (cur) {
    const counted = plan.sessions.filter((s) => s.counts_in_week_no === cur.week_no);
    const planned = counted.filter((s) => s.type !== "rest");
    week = {
      week_no: cur.week_no,
      plan_m: counted.reduce((t, s) => t + (s.target_distance_m ?? 0), 0),
      actual_m: counted.reduce((t, s) => t + (meters.get(s.id) ?? 0), 0),
      done_count: planned.filter(done).length,
      plan_count: planned.length,
    };
  }

  const actual_m = plan.activities.reduce((t, a) => t + a.distance_m, 0);
  const counting = plan.sessions.filter((s) => s.counts_in_week_no != null);
  const toDate = counting.filter((s) => s.scheduled_date <= today);
  const plan_to_date_m = toDate.reduce((t, s) => t + (s.target_distance_m ?? 0), 0);
  return {
    runs,
    plan_state: "in_range",
    plan: {
      race_date: plan.race_date,
      week,
      total: {
        actual_m,
        plan_to_date_m,
        pct: plan_to_date_m ? Math.round((actual_m / plan_to_date_m) * 100) : 0,
        done_count: plan.sessions.filter(done).length,
        plan_count_to_date: toDate.filter((s) => s.type !== "rest").length,
      },
    },
  };
}
