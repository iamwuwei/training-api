import type { PlanWeekRow, PlannedSessionRow } from "../types";

// Words shared by the prompts, the templates and the thread: which Strava sports
// count as a run, a session's short label, the Chinese name of a proposal field.
// One copy here so checkin / claude / coach / proposals / weekly agree.

export const RUN_SPORTS = new Set(["Run", "TrailRun", "VirtualRun"]);
export const isRunSport = (sport: string | null | undefined) => !sport || RUN_SPORTS.has(sport);

const SPORT_NAMES: Record<string, string> = {
  Run: "跑步", TrailRun: "越野跑", VirtualRun: "跑步機", Walk: "走路", Hike: "健行", Ride: "騎車",
  VirtualRide: "騎車", Swim: "游泳", WeightTraining: "重訓", Workout: "運動", Crossfit: "Crossfit",
  HighIntensityIntervalTraining: "HIIT", Yoga: "瑜伽", Elliptical: "橢圓機", StairStepper: "爬梯機",
};
/** "走路" / "重訓"; an unknown sport keeps Strava's word. */
export const sportName = (sport: string | null | undefined) => (sport ? SPORT_NAMES[sport] ?? sport : "跑步");

/** "長跑 16 km" / "肌力" — the session as one short label. */
export function sessionLabel(s: Pick<PlannedSessionRow, "label" | "type" | "target_distance_m">): string {
  const km = s.target_distance_m ? ` ${Math.round(s.target_distance_m / 100) / 10} km` : "";
  return `${s.label ?? s.type}${km}`;
}

/** "10/25" from 'YYYY-MM-DD'. */
export const shortDate = (iso: string) => iso.slice(5).replace("-", "/");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date as 'YYYY-MM-DD' ("2026-02-30" and "2026-13-01" are not), so bad input never reaches Postgres. */
export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Woo's question about a key session with no record, for the weekly message's quote
 * block: "10/25 的 Long 16 km 我沒看到紀錄，是沒跑，還是還沒同步？". A space between
 * Chinese and a Latin label ("的 Long"), none before a Chinese one ("的長跑 16 km").
 */
export function weeklyAskQuestion(date: string, label: string): string {
  const gap = /^[A-Za-z0-9]/.test(label) ? " " : "";
  return `${shortDate(date)} 的${gap}${label} 我沒看到紀錄，是沒跑，還是還沒同步？`;
}

export const FIELD_NAMES: Record<string, string> = { type: "類型", target_distance_m: "距離", target_pace_sec_km: "配速", scheduled_date: "日期", note: "備註", skip: "改休息" };

/** A strength day: typed 肌力 / Hyrox, or a rest day whose note opens with 肌力日. */
export const isStrength = (s: Pick<PlannedSessionRow, "label" | "type" | "content" | "note">) =>
  /肌力|重訓|Hyrox/i.test(`${s.label ?? ""} ${s.content ?? ""}`) || (s.type === "rest" && /^肌力/.test((s.note ?? "").trim()));

/** The plan week a date falls in. */
export const weekOf = (weeks: PlanWeekRow[], date: string) => weeks.find((w) => date >= w.week_start && date <= w.week_end);

/**
 * Which week a session row is booked in (its planned km, its count, the activities attached to it); the date it is drawn on
 * is always scheduled_date. The one rule the api and the app share:
 *  - a make-up row (moved_from_session_id set): counts_in_week_no, decided when the card was applied;
 *  - a moved row (superseded, with a make-up row): its own week when the make-up row is booked in another week (it counts as
 *    not run), null when the make-up row replaces it in the same week;
 *  - any other row: the week its date is in.
 * null = in no week's numbers. `moved_to_counts` is the make-up row's counts_in_week_no (moved rows only).
 */
export function countsWeekNo(
  row: Pick<PlannedSessionRow, "scheduled_date" | "superseded" | "moved_to_session_id" | "moved_from_session_id" | "counts_in_week_no"> & { moved_to_counts?: number | null },
  weeks: PlanWeekRow[],
): number | null {
  if (row.moved_from_session_id) return row.counts_in_week_no ?? null;
  const own = weekOf(weeks, row.scheduled_date)?.week_no ?? null;
  if (row.superseded && row.moved_to_session_id) {
    const there = row.moved_to_counts ?? null;
    return own != null && there != null && there !== own ? own : null;
  }
  return own;
}
