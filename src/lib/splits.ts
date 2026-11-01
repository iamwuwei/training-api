import type { PlannedSessionRow, StravaSplit } from "../types";

// Per-km splits, pre-digested before they reach the model. The plan's own text says
// which kilometres carry which pace target; the numbers that matter (the MP block,
// the fast finish, the uphill kms) are averaged here so the review judges the right
// segment instead of the whole-run average. Noise is marked rather than left for
// the model to notice: the first km's HR (watch lag), a km whose HR jumps 25+ over
// both neighbours while the pace did not move, and indoor runs (pace unreliable).
//
// planFor / fullSplits / focusStats / sessionBand are the same algorithm as
// training-web/app/lib/segments.ts (copied; keep the two in sync).
//
//   "2 km Easy + 3 km @ MP + 2 km Easy"   → km 3–5 carry the session's MP band
//   "3 km Easy + 5 km @ 6:40 + 1 km Easy" → km 4–8 carry the session's band
//   "長跑 18 km，最後 4 km @ 6:45"         → km 1–14 the session band, km 15–18 6:40–6:50
//   "輕鬆跑 6 km"                          → every km the session band (a single-pace session)
//
// Anything else (seconds-based reps, three-part long runs, the race) is "unknown".

export type SessionLike = Pick<PlannedSessionRow, "label" | "type" | "content" | "target" | "target_distance_m" | "target_pace_min_sec_km" | "target_pace_max_sec_km">;

export interface Band { lo: number; hi: number }

export interface KmTarget {
  band: Band | null;
  /** The part the session is about (the MP block, the fast finish; every km of a single-pace run). */
  focus: boolean;
}

export interface SessionPlan {
  /** One entry per planned km, or null when the text can't be read. */
  kms: KmTarget[] | null;
  /** One pace for the whole run: compare the whole-run averages. */
  single: boolean;
}

const toSec = (mmss: string) => {
  const [m, s] = mmss.split(":").map(Number);
  return m * 60 + s;
};

/** '6:45' → 6:40–6:50, '6:40〜7:00' → as written. */
function bandFromText(text: string): Band | null {
  const m = /(\d{1,2}:\d{2})\s*(?:[〜~\-–]\s*(\d{1,2}:\d{2}))?/.exec(text);
  if (!m) return null;
  const a = toSec(m[1]);
  if (!m[2]) return { lo: a - 5, hi: a + 5 };
  const b = toSec(m[2]);
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

/** The session's own pace range. '7:45+' (min only) means "this or slower". */
export function sessionBand(s: Pick<SessionLike, "target_pace_min_sec_km" | "target_pace_max_sec_km">): Band | null {
  const lo = s.target_pace_min_sec_km, hi = s.target_pace_max_sec_km;
  if (lo && hi) return { lo, hi };
  if (lo) return { lo, hi: lo + 60 };
  if (hi) return { lo: hi - 60, hi };
  return null;
}

function expand(segs: { n: number; band: Band | null; focus: boolean }[]): KmTarget[] {
  const out: KmTarget[] = [];
  for (const seg of segs) for (let i = 0; i < Math.round(seg.n); i++) out.push({ band: seg.band, focus: seg.focus });
  return out;
}

export function planFor(s: SessionLike): SessionPlan {
  const content = s.content ?? "";
  const target = s.target ?? "";
  const main = sessionBand(s);
  const total = s.target_distance_m ? Math.round(s.target_distance_m / 1000) : 0;

  // "2 km Easy + 3 km @ MP + 2 km Easy"
  if (content.includes("+")) {
    const segs: { n: number; band: Band | null; focus: boolean }[] = [];
    for (const part of content.split("+").map((p) => p.trim())) {
      const m = /^(\d+(?:\.\d+)?)\s*km\s*(.*)$/i.exec(part);
      if (!m) return { kms: null, single: false };
      const rest = m[2];
      if (/easy/i.test(rest)) segs.push({ n: Number(m[1]), band: null, focus: false });
      else if (rest.includes("@")) segs.push({ n: Number(m[1]), band: main ?? bandFromText(rest), focus: true });
      else return { kms: null, single: false };
    }
    return { kms: expand(segs), single: false };
  }

  // "長跑 18 km，最後 4 km @ 6:45" — but not the three-part peak long run / race targets.
  const last = /最後\s*(\d+)\s*km\s*@\s*([^，,（(★]+)/.exec(content);
  if (last) {
    const parts = target.split("/").filter((p) => /km/.test(p));
    if (parts.length >= 3 || !total) return { kms: null, single: false };
    const n = Number(last[1]);
    return { kms: expand([{ n: total - n, band: main, focus: false }, { n, band: bandFromText(last[2]), focus: true }]), single: false };
  }

  if (/最後|前\s*\d+\s*km|×|秒/.test(content + target) || !total) return { kms: null, single: false };
  return { kms: expand([{ n: total, band: main, focus: true }]), single: true };
}

/** Whole kilometres only; a trailing 30 m stub has no meaningful pace. */
export function fullSplits(splits: StravaSplit[] | null): StravaSplit[] {
  return (splits ?? []).filter((sp) => sp.distance >= 500 && sp.average_speed > 0);
}

export const splitPace = (sp: StravaSplit) => Math.round(1000 / sp.average_speed);

/**
 * The per-km splits of a session's recordings, in time order, as one list: each recording's whole kilometres
 * (fullSplits) one after the other, `split` renumbered 1..n (an approximation: the kilometres of the second
 * recording do not start on a round distance). `boundaries` = the new number of the first split of every
 * recording after the first that has any (where the report draws a divider). Same algorithm as
 * training-web/app/lib/segments.ts mergeSplits (copied; keep the two in sync).
 */
export function mergeSplits(parts: (StravaSplit[] | null)[]): { splits: StravaSplit[]; boundaries: number[] } {
  const splits: StravaSplit[] = [];
  const boundaries: number[] = [];
  parts.forEach((part, i) => {
    const whole = fullSplits(part);
    if (!whole.length) return;
    if (i > 0) boundaries.push(splits.length + 1);
    for (const sp of whole) splits.push({ ...sp, split: splits.length + 1 });
  });
  return { splits, boundaries };
}

export interface FocusStats {
  from: number; // 1-based km
  to: number;
  pace: number; // sec/km over those km
  hrTop: number | null; // highest per-km average HR in those km
}

/** Average pace over the focus kilometres (the MP block, the fast finish), from the splits. */
export function focusStats(plan: SessionPlan, splits: StravaSplit[] | null): FocusStats | null {
  if (!plan.kms) return null;
  const sps = fullSplits(splits);
  const picked = sps.filter((sp) => plan.kms![sp.split - 1]?.focus);
  if (!picked.length) return null;
  const dist = picked.reduce((t, sp) => t + sp.distance, 0);
  const time = picked.reduce((t, sp) => t + sp.moving_time, 0);
  const hrs = picked.map((sp) => sp.average_heartrate).filter((h): h is number => h != null);
  return {
    from: picked[0].split,
    to: picked[picked.length - 1].split,
    pace: Math.round(time / (dist / 1000)),
    hrTop: hrs.length ? Math.round(Math.max(...hrs)) : null,
  };
}

/** What to call the focus block: 'MP 段' for MP work, '最後 4 km' for a fast finish. */
export function focusLabel(s: SessionLike): string {
  const content = s.content ?? "";
  const last = /最後\s*(\d+)\s*km/.exec(content);
  if (last && !content.includes("+")) return `最後 ${last[1]} km`;
  return /MP/.test(`${s.label ?? ""} ${content} ${s.target ?? ""}`) ? "MP 段" : "重點段";
}

// ---- noise -------------------------------------------------------------------------

const HR_JUMP = 25;      // bpm over both neighbours
const PACE_SAME = 15;    // sec/km: "the pace did not move"
const UPHILL_M = 8;      // elevation gain per km that counts as an uphill km

/**
 * Kilometres whose HR looks like a sensor jump: 25+ bpm above both neighbouring kms
 * while the pace stayed within 15 s/km of them. The first km is never a suspect (its
 * HR is simply not counted); a km with only one neighbour (the last one, or next to a
 * km without HR) is not judged — a real finishing kick must not be called noise.
 */
export function hrSuspects(sps: StravaSplit[]): { split: number; hr: number }[] {
  const out: { split: number; hr: number }[] = [];
  for (let i = 1; i < sps.length; i++) {
    const cur = sps[i];
    if (cur.average_heartrate == null) continue;
    const neighbours = [sps[i - 1], sps[i + 1]].filter((n): n is StravaSplit => n != null && n.average_heartrate != null);
    if (neighbours.length < 2) continue;
    const hrHigh = neighbours.every((n) => cur.average_heartrate! - n.average_heartrate! >= HR_JUMP);
    const paceSame = neighbours.every((n) => Math.abs(splitPace(cur) - splitPace(n)) <= PACE_SAME);
    if (hrHigh && paceSame) out.push({ split: cur.split, hr: Math.round(cur.average_heartrate) });
  }
  return out;
}

export const isIndoor = (a: { sport_type?: string | null; memo?: string | null; description?: string | null }) =>
  a.sport_type === "VirtualRun" || /跑步機|室內|treadmill|健身房/i.test(`${a.memo ?? ""} ${a.description ?? ""}`);

// ---- the text for the prompt ----------------------------------------------------------

function pace(sec: number | null | undefined): string {
  if (!sec) return "-";
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}/km`;
}
const bandText = (b: Band | null) => (b ? `${pace(b.lo).replace("/km", "")}〜${pace(b.hi)}` : null);

export interface SplitsActivity {
  sport_type?: string | null;
  distance_m: number;
  moving_time_sec: number;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  splits: StravaSplit[] | null;
  memo?: string | null;
  description?: string | null;
}

/** Time-weighted average HR over `sps`, or null. */
function avgHr(sps: StravaSplit[]): number | null {
  const withHr = sps.filter((sp) => sp.average_heartrate != null);
  if (!withHr.length) return null;
  const t = withHr.reduce((s, sp) => s + sp.moving_time, 0);
  if (!(t > 0)) return null; // no moving time to weight by: no NaN into the prompt
  return Math.round(withHr.reduce((s, sp) => s + sp.average_heartrate! * sp.moving_time, 0) / t);
}

/**
 * "## 算好的重點" for the review prompt: the segment that matters with its average
 * pace and highest HR, the whole run, and the noise to ignore. Empty string when
 * there is nothing to compute (no splits, not a run).
 */
export function splitsSummary(session: SessionLike, a: SplitsActivity): string {
  const sps = fullSplits(a.splits);
  const lines: string[] = [];
  const indoor = isIndoor(a);
  const suspects = hrSuspects(sps);
  const suspectSet = new Set(suspects.map((s) => s.split));
  // HR that counts: not km 1, not a suspect.
  const trusted = sps.filter((sp) => sp.split !== 1 && !suspectSet.has(sp.split));

  if (!sps.length) {
    if (indoor) lines.push("- 室內／跑步機：配速不可信，以心拍、時間和自述為主");
    return lines.join("\n");
  }

  const plan = planFor(session);
  if (plan.kms && !plan.single) {
    const f = focusStats(plan, a.splits);
    if (f) {
      const focusSps = trusted.filter((sp) => plan.kms![sp.split - 1]?.focus);
      const top = focusSps.length ? Math.max(...focusSps.map((sp) => sp.average_heartrate ?? 0)) : f.hrTop;
      const band = bandText(plan.kms[f.from - 1]?.band ?? null);
      lines.push(`- ${focusLabel(session)}（第 ${f.from}〜${f.to} km）：平均 ${pace(f.pace)}，最高心拍 ${top || "-"}${band ? `（目標 ${band}）` : ""}${indoor ? "，但室內配速不可信" : ""}`);
    }
    const warm = trusted.filter((sp) => plan.kms![sp.split - 1] && !plan.kms![sp.split - 1].focus);
    const easyPlanned = sps.filter((sp) => plan.kms![sp.split - 1] && !plan.kms![sp.split - 1].focus);
    if (easyPlanned.length) {
      const dist = easyPlanned.reduce((t, sp) => t + sp.distance, 0);
      const time = easyPlanned.reduce((t, sp) => t + sp.moving_time, 0);
      lines.push(`- 其餘 Easy 段：平均 ${pace(Math.round(time / (dist / 1000)))}，平均心拍 ${avgHr(warm) ?? "-"}`);
    }
  } else if (!plan.kms && /坡/.test(session.label ?? "")) {
    const up = sps.filter((sp) => sp.elevation_difference >= UPHILL_M);
    if (up.length) {
      const dist = up.reduce((t, sp) => t + sp.distance, 0);
      const time = up.reduce((t, sp) => t + sp.moving_time, 0);
      const upTrusted = up.filter((sp) => !suspectSet.has(sp.split) && sp.split !== 1 && sp.average_heartrate != null);
      const top = upTrusted.length ? Math.max(...upTrusted.map((sp) => sp.average_heartrate!)) : null;
      lines.push(`- 上坡的 km（第 ${up.map((sp) => sp.split).join("、")} km，爬升 ${up.map((sp) => `+${Math.round(sp.elevation_difference)}m`).join("/")}）：平均 ${pace(Math.round(time / (dist / 1000)))}，最高心拍 ${top != null ? Math.round(top) : "-"}`);
    }
  }

  const skippedNote = trusted.length < sps.length ? `（${suspects.length ? "第 1 km 與疑似跳動的 km" : "第 1 km"} 不計）` : "";
  const whole = `- 整趟：${(a.distance_m / 1000).toFixed(2)} km，平均 ${pace(a.avg_pace_sec_km)}，平均心拍 ${avgHr(trusted) ?? a.avg_hr ?? "-"}${skippedNote}，最高 ${a.max_hr ?? "-"}`;
  if (plan.single) {
    const band = bandText(sessionBand(session));
    lines.push(`${whole}${band ? `（單一配速課，目標 ${band}，拿整趟平均比）` : "（單一配速課，拿整趟平均比）"}`);
  } else {
    lines.push(whole + (plan.kms ? "（只當參考，判定看上面的重點段）" : "（這堂課的分段對不上課表文字，趟數和上坡看原始分段）"));
  }

  const first = sps.find((sp) => sp.split === 1);
  if (first?.average_heartrate != null) lines.push(`- 第 1 km 心拍 ${Math.round(first.average_heartrate)} 不計（錶延遲），不要拿它講起跑`);
  for (const s of suspects) lines.push(`- 第 ${s.split} km 心拍 ${s.hr} 疑似跳動（配速沒變、比前後高 ${HR_JUMP} 以上），當雜訊`);
  if (indoor) lines.push("- 室內／跑步機：配速不可信，以心拍、時間和自述為主");
  return lines.join("\n");
}
