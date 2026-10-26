import type { PlannedSessionRow } from "../types";

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
