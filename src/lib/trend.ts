import type { PlannedSessionRow, StravaSplit } from "../types";
import { isStrength as isStrengthDay } from "./labels";
import { type Band, fullSplits, focusStats, planFor, sessionBand } from "./splits";

// The three trend numbers the today page shows under 進步 — aerobic pace at the same
// heart rate, the longest run so far, the MP block pace — computed here so the model
// quotes the same figures the athlete sees instead of re-deriving them from a list.
//
// aerobicTrend / longTrend / mpTrend (and paceInBand, aerobicPace, comparablePace,
// the label names) are the same algorithm as training-web/app/lib/trend.ts and
// labels.ts (copied; keep the two in sync). They take plain lists instead of the
// web's PlanView: `runs` = the run activities assigned to a session, up to today.
//
// Pace is seconds per km: smaller is faster, a negative delta is good news.

export interface TrendActivity {
  id: string;
  date: string; // 'YYYY-MM-DD' (JST)
  distance_m: number;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  splits: StravaSplit[] | null;
}

export type TrendSession = Pick<PlannedSessionRow, "label" | "type" | "content" | "note" | "target" | "target_distance_m" | "target_pace_min_sec_km" | "target_pace_max_sec_km" | "target_hr_min" | "target_hr_max" | "scheduled_date">;

export interface TrendRun { a: TrendActivity; s: TrendSession }
export interface TrendPoint { a: TrendActivity; v: number }

const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// ---- label names (training-web/app/lib/labels.ts labelStyle().name) ----------------------

const NAME_BY_LABEL: Record<string, string> = {
  Easy: "Easy", Recovery: "Recovery", Long: "Long", "Peak Long": "Peak Long", MP: "MP", 坡跑: "坡跑", "坡跑+MP": "坡跑+MP",
  快步: "快步", 走跑Easy: "走跑", 走跑Recovery: "走跑", 走跑Long: "走跑 Long", 走跑: "走跑", 比賽: "比賽", 休息: "休息", 完全休息: "完全休息", 肌力: "肌力",
};
const NAME_BY_TYPE: Record<string, string> = { easy: "Easy", long: "Long", tempo: "Tempo", interval: "Interval", race: "比賽", rest: "休息" };

/** The session's kind name: Easy / Recovery / Long / MP / 坡跑 … */
export function kindName(s: Pick<TrendSession, "label" | "type" | "content" | "note">): string {
  if (s.type === "rest" && isStrengthDay(s)) return NAME_BY_LABEL.肌力;
  return (s.label && NAME_BY_LABEL[s.label]) || NAME_BY_TYPE[s.type] || NAME_BY_TYPE.easy;
}

// ---- series -----------------------------------------------------------------------------

/** Pace of the km splits run inside the session's HR band (aerobic efficiency); null without enough of them. */
export function paceInBand(a: Pick<TrendActivity, "splits">, lo: number, hi: number): number | null {
  const inBand = fullSplits(a.splits).filter((sp) => sp.average_heartrate != null && sp.average_heartrate >= lo && sp.average_heartrate <= hi && sp.distance > 500);
  if (inBand.length < 2) return null;
  const dist = inBand.reduce((n, sp) => n + sp.distance, 0);
  const time = inBand.reduce((n, sp) => n + sp.moving_time, 0);
  return Math.round(time / (dist / 1000));
}

/** The in-band pace of one run, falling back to the whole-run average only when the average HR itself sat in the band. */
function aerobicPace(a: TrendActivity, lo: number, hi: number): number | null {
  return paceInBand(a, lo, hi) ?? (a.avg_hr != null && a.avg_hr >= lo && a.avg_hr <= hi ? a.avg_pace_sec_km : null);
}

/** One pace for a single-pace session, the focus block's pace for a combined one. */
export function comparablePace(a: TrendActivity, s: TrendSession): { pace: number; hr: number | null } | null {
  const plan = planFor(s);
  if (plan.single) return a.avg_pace_sec_km ? { pace: a.avg_pace_sec_km, hr: a.avg_hr } : null;
  const f = focusStats(plan, a.splits);
  return f ? { pace: f.pace, hr: f.hrTop } : null;
}

const byTime = (x: TrendPoint, y: TrendPoint) => x.a.date.localeCompare(y.a.date);

const MAX_POINTS = 10;
const BASELINE_DAYS = 28;
const MARATHON_M = 42_195;
/** Easy / Recovery only — by name, so 走跑 (also an easy kind) never counts as aerobic efficiency. */
const AEROBIC = new Set(["Easy", "Recovery"]);
const isAerobic = (s: TrendSession) => AEROBIC.has(kindName(s)) && s.target_hr_min != null && s.target_hr_max != null;

export interface AerobicTrend {
  /** Last 10 points, oldest first. */
  points: TrendPoint[];
  /** The HR band the paces were measured in (from the latest Easy session that has one). */
  lo: number | null;
  hi: number | null;
  /** Latest − baseline, sec/km; null with fewer than two points. */
  delta: number | null;
  /** Weeks between baseline and latest (≥ 1). */
  weeks: number;
  latest: TrendPoint | null;
}

/** Easy / Recovery runs: pace while the heart rate sat in the session's band, against ~4 weeks ago (or the first one). */
export function aerobicTrend(runs: TrendRun[], sessions: TrendSession[], today: string): AerobicTrend {
  const aerobic = runs.filter(({ s }) => isAerobic(s));
  const series = aerobic
    .map(({ a, s }) => {
      const v = aerobicPace(a, s.target_hr_min as number, s.target_hr_max as number);
      return v ? { a, v } : null;
    })
    .filter((x): x is TrendPoint => !!x)
    .sort(byTime);
  const band = [...aerobic].sort((x, y) => y.s.scheduled_date.localeCompare(x.s.scheduled_date))[0]?.s
    ?? [...sessions].reverse().find(isAerobic);
  const lo = band?.target_hr_min ?? null, hi = band?.target_hr_max ?? null;
  const latest = series[series.length - 1] ?? null;
  if (series.length < 2 || !latest) return { points: series, lo, hi, delta: null, weeks: 0, latest };
  // Baseline: the newest point at least 28 days old, else the first point.
  const old = series.filter((p) => dayDiff(p.a.date, today) >= BASELINE_DAYS);
  const base = old[old.length - 1] ?? series[0];
  const weeks = Math.max(1, Math.round(dayDiff(base.a.date, latest.a.date) / 7));
  return { points: series.slice(-MAX_POINTS), lo, hi, delta: latest.v - base.v, weeks, latest };
}

export interface LongTrend {
  /** Last 10 long runs, oldest first; v = distance in metres. */
  points: TrendPoint[];
  /** Longest so far, metres; null without any. */
  max_m: number | null;
  /** 42.195 km − longest, metres. */
  remain_m: number | null;
}

/** Long runs (kind name contains Long): distance per run, the longest so far, and how far that is from the marathon. */
export function longTrend(runs: TrendRun[]): LongTrend {
  const series = runs
    .filter(({ s }) => /Long/.test(kindName(s)))
    .map(({ a }) => ({ a, v: a.distance_m }))
    .filter((p) => p.v > 0)
    .sort(byTime);
  if (!series.length) return { points: [], max_m: null, remain_m: null };
  const max_m = Math.max(...series.map((p) => p.v));
  return { points: series.slice(-MAX_POINTS), max_m, remain_m: Math.max(0, MARATHON_M - max_m) };
}

export interface MpTrend {
  /** Last 10 MP sessions, oldest first; v = MP-block pace. */
  points: TrendPoint[];
  latest: TrendPoint | null;
  /** Highest per-km average HR in the latest MP block. */
  hrTop: number | null;
  /** The latest session's MP band. */
  band: Band | null;
  /** Latest pace against the band: 0 inside, +N seconds slower than the top, −N faster than the bottom. */
  off: number | null;
}

/** MP sessions: the MP-block pace per run, and whether the latest one sat in its target band. */
export function mpTrend(runs: TrendRun[]): MpTrend {
  const mp = runs.filter(({ s }) => kindName(s) === "MP");
  const series = mp
    .map(({ a, s }) => {
      const v = comparablePace(a, s)?.pace ?? null;
      return v ? { a, v } : null;
    })
    .filter((x): x is TrendPoint => !!x)
    .sort(byTime);
  const latest = series[series.length - 1] ?? null;
  if (!latest) return { points: [], latest: null, hrTop: null, band: null, off: null };
  const s = mp.find((r) => r.a.id === latest.a.id)!.s;
  const band = sessionBand(s);
  const hrTop = focusStats(planFor(s), latest.a.splits)?.hrTop ?? latest.a.max_hr ?? null;
  const off = band ? (latest.v > band.hi ? latest.v - band.hi : latest.v < band.lo ? latest.v - band.lo : 0) : null;
  return { points: series.slice(-MAX_POINTS), latest, hrTop, band, off };
}

// ---- the text for the prompt ----------------------------------------------------------------

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
const md = (iso: string) => iso.slice(5).replace("-", "/");
const km1 = (m: number) => (Math.round(m / 100) / 10).toFixed(1);

/** "## 趨勢（系統算好的）" lines; empty array when there is nothing to say. */
export function trendLines(runs: TrendRun[], sessions: TrendSession[], today: string): string[] {
  const out: string[] = [];
  const aero = aerobicTrend(runs, sessions, today);
  if (aero.latest && aero.lo != null && aero.hi != null) {
    const head = `- 有氧效率（Easy／Recovery 心拍 ${aero.lo}〜${aero.hi} 時的配速）：最近一次 ${md(aero.latest.a.date)} ${mmss(aero.latest.v)}/km`;
    out.push(aero.delta == null
      ? `${head}（點數不夠，還看不出趨勢）`
      : `${head}，跟 ${aero.weeks} 週前比${aero.delta === 0 ? "沒變" : `${aero.delta < 0 ? "快" : "慢"} ${Math.abs(aero.delta)} 秒/km`}（${aero.delta < 0 ? "進步" : aero.delta > 0 ? "退步" : "持平"}）`);
  }
  const lg = longTrend(runs);
  if (lg.max_m != null) {
    out.push(`- 長跑：目前最遠 ${km1(lg.max_m)} km（離全馬還差 ${km1(lg.remain_m ?? 0)} km）；最近 ${lg.points.length} 次：${lg.points.map((p) => `${md(p.a.date)} ${km1(p.v)}`).join("、")} km`);
  }
  const mp = mpTrend(runs);
  if (mp.latest) {
    const band = mp.band ? `目標 ${mmss(mp.band.lo)}〜${mmss(mp.band.hi)}，${mp.off === 0 ? "在區間內" : mp.off != null && mp.off > 0 ? `慢 ${mp.off} 秒` : `快 ${Math.abs(mp.off ?? 0)} 秒`}` : "沒有目標區間";
    out.push(`- MP 段配速：最近一次 ${md(mp.latest.a.date)} ${mmss(mp.latest.v)}/km（${band}）${mp.hrTop ? `，最高心拍 ${mp.hrTop}` : ""}；最近 ${mp.points.length} 次：${mp.points.map((p) => `${md(p.a.date)} ${mmss(p.v)}`).join("、")}`);
  }
  return out;
}
