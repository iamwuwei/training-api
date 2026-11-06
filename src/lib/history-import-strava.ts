import { randomUUID } from "node:crypto";
import { query, queryOne, type Querier } from "./db";
import { getActivities } from "./strava";
import type { StravaActivity } from "../types";

// The Strava half of "what has the athlete run lately" for the plan generator: the last HISTORY_DAYS days of his activities,
// stored in `activities` the way the live sync stores them (same columns), so the summary in history-summary.ts reads one table.
// This is the ONLY new file that talks to Strava; history-summary.ts calls it through syncHistory and the plan generator
// (plan-gen*.ts) never names a Strava table, column or call. Another source (Apple Health) would be a sibling file.
//
// What it does NOT do: it is not `processEvent` — no check-in, no verdict, no weekly-review rerun, no group event (a row with no
// session has none). Rows are `unplanned`, `session_id` null, and `on conflict do nothing`: what the live sync wrote, and what
// the athlete picked, is never overwritten.

export const HISTORY_DAYS = 84;
export const HISTORY_MAX_PAGES = 5;
const PER_PAGE = 100;
/** Each Strava request (and the token refresh before it) may take this long; a slow Strava is skipped, never waited for. */
export const IMPORT_TIMEOUT_MS = 20_000;
const BATCH = 100;

export interface ImportResult {
  imported: number;
  /** nothing was asked of Strava (no connection; or syncHistory found a recent import) */
  skipped: boolean;
  /** Strava could not be read (4xx / 5xx / timeout): the summary falls back to what the app already has */
  error: boolean;
}

/** Does this user have a history source we can read? (POST /plan-drafts: 409 "strava not connected" when not.) */
export async function hasStravaConnection(q: Querier, userId: string): Promise<boolean> {
  const rows = await q("select 1 from strava_connections where user_id = $1", [userId]);
  return rows.length > 0;
}

/** Epoch seconds of 00:00 JST, `days` days before `today` ('YYYY-MM-DD'). */
export const historyAfter = (today: string, days = HISTORY_DAYS): number =>
  Math.floor(new Date(`${today}T00:00:00+09:00`).getTime() / 1000) - days * 86_400;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("strava timeout")), ms); });
  p.catch(() => undefined); // a request that loses the race must not become an unhandled rejection
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

const round = (v: number | undefined | null) => (v != null ? Math.round(v) : null);

/** Insert up to BATCH summaries in one statement; returns how many rows were new. */
async function insertBatch(userId: string, batch: StravaActivity[]): Promise<number> {
  if (!batch.length) return 0;
  const PARAMS = 16;
  const params: unknown[] = [];
  const values = batch.map((a, i) => {
    const isRun = a.type === "Run";
    const distance_m = Math.round(a.distance ?? 0);
    const moving = Math.round(a.moving_time ?? 0);
    params.push(
      randomUUID(), userId, a.id, new Date(a.start_date), distance_m, moving,
      isRun && distance_m > 0 ? Math.round(moving / (distance_m / 1000)) : null,
      round(a.average_heartrate), round(a.max_heartrate), round(a.average_watts), round(a.calories),
      a.device_name ?? null, a.gear_id ?? a.gear?.id ?? null, a.gear?.name ?? null,
      JSON.stringify(a), a.sport_type ?? a.type,
    );
    const p = (n: number) => `$${i * PARAMS + n}`;
    // session_id, description and splits are null on purpose: a summary has no splits, and nothing is bound to a session.
    return `(${p(1)}, ${p(2)}, ${p(3)}, null, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, null, ${p(12)}, ${p(13)}, ${p(14)}, null, 'unplanned', ${p(15)}, ${p(16)})`;
  });
  const rows = await query<{ id: string }>(
    `insert into activities
       (id, user_id, strava_activity_id, session_id, start_time, distance_m, moving_time_sec,
        avg_pace_sec_km, avg_hr, max_hr, avg_watts, kcal, description, device_name, gear_id, gear_name,
        splits, match_status, raw, sport_type)
     values ${values.join(", ")}
     on conflict (strava_activity_id) do nothing
     returning id`,
    params,
  );
  return rows.length;
}

/**
 * Pull the last HISTORY_DAYS days from Strava into `activities`. Never throws for a Strava problem (an unreadable Strava is
 * `error: true`, the caller goes on with what the table has); a database error still throws (the SQS retry handles it).
 * Does not look at users.history_imported_at — syncHistory decides whether to call; this stamps it on success.
 */
export async function importStravaHistory(userId: string, today: string): Promise<ImportResult> {
  const conn = await queryOne<{ strava_athlete_id: string }>("select strava_athlete_id from strava_connections where user_id = $1", [userId]);
  if (!conn) return { imported: 0, skipped: true, error: false };

  let activities: StravaActivity[] = [];
  try {
    // Lazy: the worker module is the one that owns the token refresh; importing it at the top would make a cycle (worker -> plan-gen-run -> here).
    const { getFreshConnection } = await import("../handlers/worker");
    const fresh = await withTimeout(getFreshConnection(Number(conn.strava_athlete_id)), IMPORT_TIMEOUT_MS);
    if (!fresh) return { imported: 0, skipped: true, error: false };
    const after = historyAfter(today);
    for (let page = 1; page <= HISTORY_MAX_PAGES; page++) {
      const batch = await getActivities(fresh.access_token, { after, page, per_page: PER_PAGE }, AbortSignal.timeout(IMPORT_TIMEOUT_MS));
      activities.push(...batch);
      if (batch.length < PER_PAGE) break;
      if (page === HISTORY_MAX_PAGES) console.log(`history import: ${activities.length} activities in ${HISTORY_DAYS} days, stopped after ${HISTORY_MAX_PAGES} pages`);
    }
  } catch (err) {
    // 4xx / 5xx / timeout / token refresh failure: skip the import, no retry. Wording stays in the log (no token is in it).
    console.warn("history import skipped:", err instanceof Error ? err.message.slice(0, 200) : "unknown error");
    return { imported: 0, skipped: false, error: true };
  }

  const seen = new Set<number>();
  activities = activities.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  let imported = 0;
  for (let i = 0; i < activities.length; i += BATCH) imported += await insertBatch(userId, activities.slice(i, i + BATCH));
  await query("update users set history_imported_at = now() where id = $1", [userId]);
  return { imported, skipped: false, error: false };
}
