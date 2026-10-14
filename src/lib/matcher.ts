import type { SessionType } from "../types";

export interface MatchCandidate {
  id: string;
  scheduled_date: string; // 'YYYY-MM-DD'
  type: SessionType;
  target_distance_m: number | null;
}

export interface MatchInput {
  /** Activity date in the athlete's local time, 'YYYY-MM-DD'. */
  localDate: string;
  distance_m: number;
}

/** Max relative distance difference to treat a nearby-day session as "the same workout moved". */
export const DISTANCE_TOLERANCE = 0.3;
/** Search window in days on either side of the activity date. */
export const DAY_WINDOW = 2;

function dayDiff(a: string, b: string): number {
  const ms = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))
    - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.abs(Math.round(ms / 86_400_000));
}

function distanceRatio(c: MatchCandidate, distance_m: number): number {
  if (!c.target_distance_m || c.target_distance_m <= 0) return Infinity;
  return Math.abs(distance_m - c.target_distance_m) / c.target_distance_m;
}

/**
 * Pick the planned session an activity most likely fulfils.
 *
 * Callers pass only candidates that are already eligible: same user's active
 * plan, not superseded, not already matched by another activity. This function
 * applies the ordering rules:
 *   1. same day wins (closest distance if several);
 *   2. otherwise within ±DAY_WINDOW days and distance within DISTANCE_TOLERANCE,
 *      nearest day first, then closest distance;
 *   3. otherwise null (caller stores match_status = 'unplanned').
 * Rest days are never matched to a run.
 */
export function matchSession(input: MatchInput, candidates: MatchCandidate[]): MatchCandidate | null {
  const runs = candidates.filter(
    (c) => c.type !== "rest" && dayDiff(c.scheduled_date, input.localDate) <= DAY_WINDOW,
  );

  const sameDay = runs.filter((c) => c.scheduled_date === input.localDate);
  if (sameDay.length > 0) {
    return sameDay.sort((a, b) => distanceRatio(a, input.distance_m) - distanceRatio(b, input.distance_m))[0];
  }

  const nearby = runs
    .filter((c) => distanceRatio(c, input.distance_m) < DISTANCE_TOLERANCE)
    .sort((a, b) => {
      const d = dayDiff(a.scheduled_date, input.localDate) - dayDiff(b.scheduled_date, input.localDate);
      return d !== 0 ? d : distanceRatio(a, input.distance_m) - distanceRatio(b, input.distance_m);
    });

  return nearby[0] ?? null;
}
