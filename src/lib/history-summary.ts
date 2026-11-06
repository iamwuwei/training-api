import { loadPlanBriefing, trendRuns, type Plan } from "./briefing";
import { type ImportResult, hasStravaConnection, importStravaHistory } from "./history-import-strava";
import { query, queryOne, type Querier } from "./db";
import { isRunSport, shortDate } from "./labels";
import { combineGroup, GROUP_ACTIVITY_SELECT, GROUP_DATE_JOIN, overlaps, type GroupActivity } from "./session-group";
import { trendLines } from "./trend";
import type { AthleteProfile } from "../types";

// The ONE way the plan generator learns what the athlete has been running (ai-plan-generation 01b §2.5, Wei 2026-11-04):
// every place that needs his history — the skeleton prompt, the chunks, the flags, GET /plan-drafts' `profile` — calls
// loadHistorySummary(). It first asks syncHistory() to make sure the table is fresh (today: importStravaHistory, one file that
// talks to Strava), then computes the summary from `activities` with plain SQL + TS: 0 model calls. plan-gen*.ts and this file
// never name a Strava table, column or call (reviewer: grep strava_activity_id|strava_connections|getActivities).
//
// Future work, NOT done here (01b §2.6): a second source (Apple Health) means `activities` gets a source + external id, the
// connection table becomes per-source, history-import-health.ts joins history-import-strava.ts and syncHistory() dispatches on
// the connection's source. Nothing below the sync would change.

export type { ImportResult };

const DAY = 86_400_000;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
/** Monday of the week a date is in. */
const mondayOf = (iso: string) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const r1 = (n: number) => Math.round(n * 10) / 10;
const km1 = (m: number) => r1(m / 1000);
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec) % 60).padStart(2, "0")}`;
const md = (iso: string) => shortDate(iso);

/** Weeks the summary covers, Monday to Sunday, the last one the week of today. */
export const SUMMARY_WEEKS = 12;
const SYNC_EVERY_HOURS = 24;

/** Has this user a history source at all? (Today: a Strava connection.) */
export async function hasHistorySource(q: Querier, userId: string): Promise<boolean> {
  return hasStravaConnection(q, userId);
}

/** Make `activities` fresh. An import within the last 24 hours is not repeated (one Strava import per athlete per day). */
export async function syncHistory(userId: string, today: string): Promise<ImportResult> {
  const u = await queryOne<{ recent: boolean }>(
    `select (history_imported_at is not null and history_imported_at > now() - interval '${SYNC_EVERY_HOURS} hours') as recent from users where id = $1`,
    [userId],
  );
  if (u?.recent) return { imported: 0, skipped: true, error: false };
  return importStravaHistory(userId, today);
}

// ---- trips ---------------------------------------------------------------------------------------------------------------

interface Trip {
  date: string;            // JST, of the first recording
  distance_m: number;
  moving_time_sec: number;
  pace: number | null;     // s/km
  hr: number | null;
  label: string | null;    // the planned session's label when bound
  start: number;           // epoch ms, for ordering
}

type Row = GroupActivity & { session_label: string | null };

/**
 * Recordings -> trips. A session can hold several recordings (the watch was stopped by mistake): those with the same session_id are one
 * trip (combineGroup: distances and times add, pace is distance over time, heart rate is time-weighted); two recordings of the same
 * stretch of time (overlaps) are one run recorded twice, so only the longer counts. A recording with no session is a trip of its own.
 */
export function toTrips(rows: Row[]): Trip[] {
  const bySession = new Map<string, Row[]>();
  const trips: Trip[] = [];
  const single = (r: Row) => trips.push({ date: r.date, distance_m: r.distance_m, moving_time_sec: r.moving_time_sec, pace: r.avg_pace_sec_km, hr: r.avg_hr, label: r.session_label, start: new Date(r.start_time).getTime() });
  for (const r of rows) {
    if (r.session_id == null) { single(r); continue; }
    const g = bySession.get(r.session_id);
    if (g) g.push(r); else bySession.set(r.session_id, [r]);
  }
  for (const group of bySession.values()) {
    const kept: Row[] = [];
    for (const r of [...group].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime() || a.id.localeCompare(b.id))) {
      const clash = kept.findIndex((k) => overlaps(k, r));
      if (clash < 0) kept.push(r);
      else if (r.distance_m > kept[clash].distance_m) kept[clash] = r;
      kept.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime() || a.id.localeCompare(b.id));
    }
    const c = combineGroup(kept);
    trips.push({ date: c.date, distance_m: c.distance_m, moving_time_sec: c.moving_time_sec, pace: c.avg_pace_sec_km, hr: c.avg_hr, label: group[0].session_label, start: new Date(c.start_time).getTime() });
  }
  return trips.sort((a, b) => a.start - b.start);
}

// ---- the summary ---------------------------------------------------------------------------------------------------------

/**
 * Pure part: trips -> the profile numbers. `weekStarts` are the 12 Mondays, oldest first. Kept separate so a test (and any
 * future second source) can feed it trips directly.
 */
export function summarize(trips: Trip[], weekStarts: string[]): Pick<AthleteProfile, "weeks" | "last4" | "prev8" | "change_pct" | "longest" | "avg_pace_sec_km" | "avg_hr" | "recent" | "total_runs" | "hr_zones" | "pace_bands"> {
  const from = weekStarts[0], to = addDays(weekStarts[weekStarts.length - 1], 6);
  const inRange = trips.filter((t) => t.date >= from && t.date <= to);
  const weeks = weekStarts.map((ws) => {
    const mine = inRange.filter((t) => t.date >= ws && t.date <= addDays(ws, 6));
    return { week_start: ws, runs: mine.length, km: km1(mine.reduce((s, t) => s + t.distance_m, 0)), longest_km: km1(Math.max(0, ...mine.map((t) => t.distance_m))) };
  });
  const avg = (ws: typeof weeks) => ({ runs_per_week: r1(ws.reduce((s, w) => s + w.runs, 0) / ws.length), km_per_week: r1(ws.reduce((s, w) => s + w.km, 0) / ws.length) });
  const exact = (ws: typeof weeks) => ws.reduce((s, w) => s + w.km, 0) / ws.length;
  const last4 = weeks.slice(-4), prev8 = weeks.slice(0, -4);
  const prevKm = exact(prev8);
  const change_pct = prevKm > 0 ? Math.round(((exact(last4) - prevKm) / prevKm) * 100) : null;

  const longestTrip = inRange.reduce<Trip | null>((m, t) => (!m || t.distance_m > m.distance_m ? t : m), null);
  const withPace = inRange.filter((t) => t.pace != null && t.distance_m > 0);
  const paceDist = withPace.reduce((s, t) => s + t.distance_m, 0);
  const paceTime = withPace.reduce((s, t) => s + t.moving_time_sec, 0);
  const withHr = inRange.filter((t) => t.hr != null && t.moving_time_sec > 0);
  const hrTime = withHr.reduce((s, t) => s + t.moving_time_sec, 0);

  const share = <K extends string>(items: { w: number; k: K }[], keys: K[]): Record<K, number> => {
    const total = items.reduce((s, i) => s + i.w, 0);
    return Object.fromEntries(keys.map((k) => [k, total > 0 ? Math.round((items.filter((i) => i.k === k).reduce((s, i) => s + i.w, 0) / total) * 100) : 0])) as Record<K, number>;
  };
  const hr_zones = withHr.length
    ? share(withHr.map((t) => ({ w: t.moving_time_sec, k: (t.hr! < 140 ? "lt140" : t.hr! < 155 ? "z140_155" : t.hr! < 170 ? "z155_170" : "gte170") as "lt140" | "z140_155" | "z155_170" | "gte170" })), ["lt140", "z140_155", "z155_170", "gte170"])
    : null;
  const pace_bands = withPace.length
    ? share(withPace.map((t) => ({ w: t.distance_m, k: (t.pace! < 360 ? "lt6" : t.pace! < 420 ? "p6_7" : t.pace! < 480 ? "p7_8" : "gte8") as "lt6" | "p6_7" | "p7_8" | "gte8" })), ["lt6", "p6_7", "p7_8", "gte8"])
    : null;

  return {
    weeks,
    last4: avg(last4),
    prev8: avg(prev8),
    change_pct,
    longest: longestTrip ? { date: longestTrip.date, km: km1(longestTrip.distance_m), pace_sec_km: longestTrip.pace, avg_hr: longestTrip.hr } : null,
    avg_pace_sec_km: paceDist > 0 ? Math.round(paceTime / (paceDist / 1000)) : null,
    avg_hr: hrTime > 0 ? Math.round(withHr.reduce((s, t) => s + t.hr! * t.moving_time_sec, 0) / hrTime) : null,
    recent: [...inRange].sort((a, b) => b.start - a.start).slice(0, 10).map((t) => ({ date: t.date, km: km1(t.distance_m), pace_sec_km: t.pace, avg_hr: t.hr, label: t.label })),
    total_runs: inRange.length,
    hr_zones,
    pace_bands,
  };
}

const RECOVERY_LOOKBACK_DAYS = 28;

/** The most recent plan race day in the last 28 days (plans active or finished), with the run of that day if there is one. */
async function lastRace(userId: string, today: string, trips: Trip[]): Promise<AthleteProfile["last_race"]> {
  const p = await queryOne<{ id: string; race_name: string; race_date: string; dist: number | null }>(
    `select p.id, p.race_name, to_char(p.race_date, 'YYYY-MM-DD') as race_date,
            (select s.target_distance_m from planned_sessions s where s.plan_id = p.id and s.type = 'race' and s.superseded = false order by s.scheduled_date desc limit 1) as dist
       from plans p
      where p.user_id = $1 and p.status in ('active', 'finished') and p.race_date between $2 and $3
      order by p.race_date desc limit 1`,
    [userId, addDays(today, -RECOVERY_LOOKBACK_DAYS), addDays(today, -1)],
  );
  if (!p) return null;
  const that = trips.filter((t) => t.date === p.race_date).sort((a, b) => b.distance_m - a.distance_m)[0];
  return { name: p.race_name, date: p.race_date, distance_m: p.dist ?? 42195, actual_time_sec: that ? that.moving_time_sec : null, days_ago: daysBetween(p.race_date, today) };
}

/** The user's latest finished-or-over plan: how it went (verdict counts, missed sessions, trend lines). Null when there is none or it cannot be read. */
async function previousPlan(userId: string, today: string): Promise<AthleteProfile["previous_plan"]> {
  try {
    const plan = await queryOne<Plan>(
      `select p.*, to_char(p.race_date, 'YYYY-MM-DD') as race_date, u.display_name
         from plans p join users u on u.id = p.user_id
        where p.user_id = $1 and p.status in ('active', 'finished') and p.race_date < $2
        order by p.race_date desc limit 1`,
      [userId, today],
    );
    if (!plan) return null;
    const b = await loadPlanBriefing(plan, today);
    const verdicts = { ok: 0, warn: 0, bad: 0 };
    for (const a of b.activities) {
      if (!a.session || !a.verdict) continue;
      if (a.verdict === "達成") verdicts.ok++;
      else if (a.verdict === "達成但有提醒") verdicts.warn++;
      else verdicts.bad++;
    }
    const missed = b.sessions.filter((s) => s.scheduled_date < today && s.type !== "rest" && s.type !== "race" && !s.done).length;
    const trend = trendLines(trendRuns(b), b.sessions, today).map((l) => l.replace(/^- /, ""));
    return { race_name: plan.race_name, race_date: plan.race_date, verdicts, missed, trend };
  } catch (err) {
    console.warn("history summary: previous plan unreadable:", err instanceof Error ? err.message.slice(0, 200) : "unknown error");
    return null;
  }
}

export async function loadHistorySummary(userId: string, today: string, opts: { sync?: boolean } = {}): Promise<AthleteProfile> {
  const sync = opts.sync === false ? { imported: 0, skipped: true, error: false } : await syncHistory(userId, today);
  const first = addDays(mondayOf(today), -7 * (SUMMARY_WEEKS - 1));
  const weekStarts = Array.from({ length: SUMMARY_WEEKS }, (_, i) => addDays(first, 7 * i));
  const from = first, to = today;

  const rows = await query<Row>(
    `select ${GROUP_ACTIVITY_SELECT}, ps.label as session_label
       from activities a${GROUP_DATE_JOIN}
       left join planned_sessions ps on ps.id = a.session_id
      where a.user_id = $1 and a.match_status <> 'ignored'
        and (coalesce(g.t0, a.start_time) at time zone 'Asia/Tokyo')::date between $2 and $3
      order by a.start_time, a.id`,
    [userId, from, to],
  );
  const trips = toTrips(rows.filter((r) => isRunSport(r.sport_type)));
  const [last_race, previous_plan] = await Promise.all([lastRace(userId, today, trips), previousPlan(userId, today)]);
  return { from, to: today, ...summarize(trips, weekStarts), previous_plan, import_error: sync.error, last_race };
}

// ---- text for the prompt -------------------------------------------------------------------------------------------------

const paceText = (sec: number | null) => (sec != null ? `${mmss(sec)}/km` : "-");
const hrText = (hr: number | null) => (hr != null ? String(hr) : "-");
const hms = (sec: number) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

/** "上一場比賽" / "上一份課表" lines, shared by the with-runs and the no-runs text. */
function lastLines(p: AthleteProfile): string[] {
  const out: string[] = [];
  if (p.last_race) {
    const r = p.last_race;
    out.push(`- 上一場比賽：${r.name} ${md(r.date)} ${km1(r.distance_m)} km${r.actual_time_sec != null ? `，實跑 ${hms(r.actual_time_sec)}` : ""}，${r.days_ago} 天前`);
  }
  if (p.previous_plan) {
    const q = p.previous_plan;
    const aero = q.trend.find((l) => l.startsWith("有氧效率"));
    const rest = q.trend.filter((l) => l !== aero);
    out.push(`- 上一份課表：${q.race_name} ${q.race_date}，判定 達成 ${q.verdicts.ok}／提醒 ${q.verdicts.warn}／未達成 ${q.verdicts.bad}，漏跑 ${q.missed}；趨勢：${rest.length ? rest.join("；") : "無"}`);
    out.push(`- 有氧效率：${aero ? aero.replace(/^有氧效率[^：]*：/, "") : "無"}`);
  }
  return out;
}

/** The "跑者現況" section of the prompts (system-computed numbers; every line one sentence). */
export function profileText(p: AthleteProfile): string {
  if (p.total_runs === 0) {
    return ["## 跑者現況：最近 12 週沒有跑步紀錄（Strava 連了但沒有跑步，或剛連）。從零開始排，以表單的經驗為準。", ...lastLines(p)].join("\n");
  }
  const change = p.change_pct == null ? "沒有前 8 週的資料" : `${p.change_pct >= 0 ? "+" : "−"}${Math.abs(p.change_pct)}%`;
  const pct = (a: number) => `${a}%`;
  const lines = [
    `## 跑者現況（Strava 最近 12 週，${p.from}〜${p.to}；系統算好的）`,
    `- 總共 ${p.total_runs} 趟跑步；最近 4 週平均每週 ${p.last4.runs_per_week} 次、${p.last4.km_per_week} km；前 8 週平均每週 ${p.prev8.runs_per_week} 次、${p.prev8.km_per_week} km（${change}）`,
    `- 每週：${p.weeks.map((w) => `${md(w.week_start)} ${w.runs} 次 ${w.km} km（最長 ${w.longest_km}）`).join("、")}`,
    `- 最長一次：${p.longest ? `${md(p.longest.date)} ${p.longest.km} km ${paceText(p.longest.pace_sec_km)} 心拍 ${hrText(p.longest.avg_hr)}` : "沒有"}`,
    `- 平均配速 ${paceText(p.avg_pace_sec_km)}（距離加權）、平均心拍 ${hrText(p.avg_hr)}`,
    `- 最近 10 趟：${p.recent.map((r) => `${md(r.date)} ${r.km} km ${r.pace_sec_km != null ? mmss(r.pace_sec_km) : "-"} 心拍 ${hrText(r.avg_hr)}${r.label ? ` [${r.label}]` : ""}`).join("、")}`,
  ];
  const z = p.hr_zones, b = p.pace_bands;
  if (z || b) {
    lines.push(`- 心拍分布（跑步時間比例）：${z ? `<140 ${pct(z.lt140)}、140〜155 ${pct(z.z140_155)}、155〜170 ${pct(z.z155_170)}、≥170 ${pct(z.gte170)}` : "沒有心拍資料"}；配速分布（距離比例）：${b ? `<6:00 ${pct(b.lt6)}、6〜7 ${pct(b.p6_7)}、7〜8 ${pct(b.p7_8)}、≥8:00 ${pct(b.gte8)}` : "沒有"}`);
  }
  lines.push(...lastLines(p));
  return lines.join("\n");
}
