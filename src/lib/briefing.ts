import { loadLiveConstraints, constraintLine, WEEKDAY_ZH, weekdayOf } from "./constraints";
import { query } from "./db";
import { countsWeekNo, isRunSport, isStrength, shortDate, sportName, weekOf } from "./labels";
import { fullSplits, splitPace } from "./splits";
import { trendLines, type TrendRun } from "./trend";
import { loadPlanWeeks } from "./context";
import { combineGroup, GROUP_ACTIVITY_SELECT, GROUP_DATE_JOIN, type GroupActivity, type SegmentInfo } from "./session-group";
import type { ConstraintRow, PlanRow, PlanWeekRow, PlannedSessionRow, StravaSplit, Verdict } from "../types";

// The coach's briefing: the whole plan from today to the race day (every session
// with its id), every activity of the plan so far one line each (per-km splits only
// for the last 14 days), the weeks that are over one line each, the trend numbers,
// the athlete's goal and the constraints he told Woo about. The weekly review and
// the chat get the same text, so Woo answers a question about any day from it.
//
// Everything here is a function of the data (buildPlanBriefing is pure) so the prompt
// can be cached: one text per user per day until something about the plan changes.

export type Plan = PlanRow & { display_name: string };
/** `moved_from_date`: the date a make-up row was moved from (null on any other row). */
export type SessionWithDone = PlannedSessionRow & { done: boolean; moved_from_date: string | null };

/** A "moved" history row (superseded, with a make-up row): the session that was not run and moved forward. */
export interface MovedSession {
  id: string;
  scheduled_date: string;
  week_no: number | null;
  label: string | null;
  type: PlannedSessionRow["type"];
  target_distance_m: number | null;
  /** The make-up row's date and the week its numbers are booked in. */
  moved_to_date: string;
  moved_to_counts_in_week_no: number | null;
}

/** One activity as the briefing and the flag computation see it. */
export interface BriefActivity {
  id: string;
  date: string; // 'YYYY-MM-DD' (JST)
  sport_type: string | null;
  distance_m: number;
  moving_time_sec: number;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  rpe: number | null;
  memo: string | null;
  splits: StravaSplit[] | null;
  session: PlannedSessionRow | null;
  verdict: Verdict | null;
  reminders: string[];
  /**
   * One entry per recording; a session with several recordings is ONE BriefActivity (id = the primary, numbers = the
   * combined ones, splits joined, verdict / reminders the primary's). Length 1 for an ordinary activity.
   */
  segments: Pick<SegmentInfo, "start_hm" | "distance_m" | "moving_time_sec" | "avg_pace_sec_km" | "gap_min">[];
}

/** Everything the briefing and the card validation need about one athlete's plan. */
export interface PlanBriefing {
  plan: Plan;
  weeks: PlanWeekRow[];
  /** Every current (not superseded) session of the plan, with whether an activity is attached. */
  sessions: SessionWithDone[];
  /** Activities from the plan's first week to today, oldest first, ignored ones left out. */
  activities: BriefActivity[];
  /** Active and not expired. */
  constraints: ConstraintRow[];
  /** The moved history rows (superseded, moved_to_session_id set), oldest first. */
  moved: MovedSession[];
  /** week_no of the weeks whose weekly review exists. */
  reviewedWeeks: Set<number>;
}

/** Days of per-km splits in the briefing. */
export const SPLIT_DAYS = 14;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

type ActivityRow = GroupActivity & { verdict: Verdict | null; reminders: string[] | null };

export async function loadPlanBriefing(plan: Plan, today: string): Promise<PlanBriefing> {
  const weeks = await loadPlanWeeks(plan.id);
  const sessions = await query<SessionWithDone>(
    `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
            exists (select 1 from activities a where a.session_id = ps.id and a.match_status <> 'ignored') as done,
            to_char(mf.scheduled_date, 'YYYY-MM-DD') as moved_from_date
       from planned_sessions ps
       left join planned_sessions mf on mf.id = ps.moved_from_session_id
      where ps.plan_id = $1 and ps.superseded = false
      order by ps.scheduled_date, ps.label`,
    [plan.id],
  );
  const movedRows = await query<Omit<MovedSession, "week_no" | "moved_to_counts_in_week_no"> & { moved_to_counts: number | null }>(
    `select ps.id, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date, ps.label, ps.type, ps.target_distance_m,
            to_char(nw.scheduled_date, 'YYYY-MM-DD') as moved_to_date, nw.counts_in_week_no as moved_to_counts
       from planned_sessions ps join planned_sessions nw on nw.id = ps.moved_to_session_id
      where ps.plan_id = $1 and ps.superseded = true
      order by ps.scheduled_date, ps.label`,
    [plan.id],
  );
  const moved = movedRows.map(({ moved_to_counts, ...m }): MovedSession => ({ ...m, week_no: weekOf(weeks, m.scheduled_date)?.week_no ?? null, moved_to_counts_in_week_no: moved_to_counts }));
  // A plan week is reviewed when a weekly_reviews row (Monday to Sunday) covers its first day; plan_weeks can be shorter than that (the first starts on a Thursday).
  const reviews = await query<{ week_start: string }>("select to_char(week_start, 'YYYY-MM-DD') as week_start from weekly_reviews where plan_id = $1", [plan.id]);
  const reviewedWeeks = new Set(weeks.filter((w) => reviews.some((r) => r.week_start <= w.week_start && addDays(r.week_start, 6) >= w.week_start)).map((w) => w.week_no));
  const from = weeks[0]?.week_start ?? addDays(today, -120);
  // A session of several recordings is one line: dated by its first recording (a second one after midnight stays on that day and week).
  const rows = await query<ActivityRow>(
    `select ${GROUP_ACTIVITY_SELECT}, r.verdict, r.reminders
       from activities a${GROUP_DATE_JOIN}
       left join reviews r on r.activity_id = a.id
      where a.user_id = $1 and a.match_status <> 'ignored'
        and (coalesce(g.t0, a.start_time) at time zone 'Asia/Tokyo')::date between $2 and $3
      order by coalesce(g.t0, a.start_time), a.start_time, a.id`,
    [plan.user_id, from, today],
  );
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const bySession = new Map<string, ActivityRow[]>();
  const units: (ActivityRow | string)[] = [];
  for (const r of rows) {
    if (r.session_id == null) { units.push(r); continue; }
    const have = bySession.get(r.session_id);
    if (have) have.push(r);
    else { bySession.set(r.session_id, [r]); units.push(r.session_id); }
  }
  const activities = units.map((u): BriefActivity => {
    const group = typeof u === "string" ? bySession.get(u)! : [u]; // already in (start_time, id) order
    const primary = group[0];
    const c = combineGroup(group);
    const s = primary.session_id ? byId.get(primary.session_id) : undefined;
    const { done: _done, moved_from_date: _from, ...session } = s ?? ({} as SessionWithDone);
    const memos = group.map((g) => g.memo ?? g.description).filter((m): m is string => !!m);
    return {
      id: primary.id, date: primary.date, sport_type: c.sport_type, distance_m: c.distance_m, moving_time_sec: c.moving_time_sec,
      avg_pace_sec_km: c.avg_pace_sec_km, avg_hr: c.avg_hr, max_hr: c.max_hr, rpe: c.rpe, memo: memos.length ? memos.join("／") : null,
      splits: c.splits, session: s ? session : null, verdict: primary.verdict, reminders: primary.reminders ?? [],
      segments: c.segments,
    };
  });
  const constraints = await loadLiveConstraints(plan.user_id, today);
  return { plan, weeks, sessions, activities, constraints, moved, reviewedWeeks };
}

// ---- text ----------------------------------------------------------------------------------

function goalText(plan: PlanRow): string {
  return plan.goal_time_sec
    ? `${Math.floor(plan.goal_time_sec / 3600)}h${String(Math.floor((plan.goal_time_sec % 3600) / 60)).padStart(2, "0")}`
    : "未設定";
}

const pace = (sec: number | null | undefined) => (sec ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}/km` : "-");
const km1 = (m: number) => (Math.round(m / 100) / 10).toFixed(1);
const weekday = (iso: string) => `週${WEEKDAY_ZH[weekdayOf(iso)]}`;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The sessions the athlete can still change: today up to the day before the race, not done, not the race. */
export function changeableSessions(b: Pick<PlanBriefing, "plan" | "sessions">, today: string): SessionWithDone[] {
  return b.sessions.filter((s) => s.scheduled_date >= today && s.scheduled_date < b.plan.race_date && !s.done && s.type !== "race");
}

/** A session that can be missed: a run (easy / long / tempo / interval). Rest days, strength days (a rest-typed session; the checklist is not an activity) and the race cannot. */
const isRunSession = (s: { type: string }) => s.type === "easy" || s.type === "long" || s.type === "tempo" || s.type === "interval";

/**
 * The past sessions a make-up can move forward: before today, no activity attached, a run. No limit on how long ago.
 * A strength day ticked off in the checklist has no Strava activity, so it would look missed: it is never offered.
 */
export function catchUpSessions(b: Pick<PlanBriefing, "sessions">, today: string): SessionWithDone[] {
  return b.sessions.filter((s) => s.scheduled_date < today && !s.done && isRunSession(s));
}

function sessionLine(s: SessionWithDone, today: string, raceDate: string): string {
  const marks = [
    s.type === "race" || s.scheduled_date === raceDate ? "比賽日，不能動" : "",
    s.moved_from_date ? `補 ${shortDate(s.moved_from_date)} 的課${s.counts_in_week_no != null ? `，算第 ${s.counts_in_week_no} 週` : ""}` : "",
    s.done ? "已完成" : "",
    s.skipped_at ? "他說沒跑" : "",
    s.scheduled_date === today ? "今天" : "",
  ].filter(Boolean);
  const parts = [
    `${s.content ?? ""}`.trim(),
    s.target_distance_m ? `${km1(s.target_distance_m)} km` : "",
    s.target ? `配速／心拍 ${s.target}` : s.target_pace_sec_km ? `配速 ${pace(s.target_pace_sec_km)}` : "",
    s.note ? `備註：${s.note.replace(/\s+/g, " ")}` : "",
    `id=${s.id}`,
    marks.join("、"),
  ].filter(Boolean);
  return `- ${s.scheduled_date} ${weekday(s.scheduled_date)} [${s.label ?? s.type}] ${parts.join("｜")}`;
}

function verdictText(a: BriefActivity): string {
  if (!a.verdict) return "未評";
  const r = a.reminders[0];
  return r ? `${a.verdict}：${r}` : a.verdict;
}

/** "（2 段：06:40 3.00 km 7:20 ＋ 07:10 5.00 km 7:28，隔 8 分）" for a session of several recordings, else "". */
function segmentsText(a: BriefActivity): string {
  if (a.segments.length < 2) return "";
  const run = isRunSport(a.sport_type);
  const one = (g: BriefActivity["segments"][number]) => `${g.start_hm} ${run ? `${(g.distance_m / 1000).toFixed(2)} km ${pace(g.avg_pace_sec_km).replace("/km", "")}` : `${Math.round(g.moving_time_sec / 60)} 分`}`;
  const gaps = a.segments.map((g) => g.gap_min).filter((m): m is number => m != null);
  return `（${a.segments.length} 段：${a.segments.map(one).join(" ＋ ")}${gaps.length ? `，隔 ${gaps.map((m) => `${m} 分`).join("、")}` : ""}）`;
}

function activityLine(a: BriefActivity, detail: boolean): string {
  const what = isRunSport(a.sport_type)
    ? `${(a.distance_m / 1000).toFixed(2)} km ${pace(a.avg_pace_sec_km)} 心拍 ${a.avg_hr ?? "-"}`
    : `${sportName(a.sport_type)} ${Math.round(a.moving_time_sec / 60)} 分 心拍 ${a.avg_hr ?? "-"}`;
  const to = a.session ? `${a.session.label ?? a.session.type}${a.session.scheduled_date !== a.date ? `（${shortDate(a.session.scheduled_date)} 的課）` : ""}` : "未排課";
  const own = a.rpe || (detail && a.memo) ? `｜自述：${a.rpe ? `RPE ${a.rpe} ` : ""}${detail ? (a.memo ?? "").replace(/\s+/g, " ").slice(0, 80) : ""}`.trimEnd() : "";
  const line = `- ${a.date} 配 ${to}｜${what}${segmentsText(a)}｜${verdictText(a)}${own}`;
  if (!detail) return line;
  const sps = fullSplits(a.splits);
  if (!sps.length || !isRunSport(a.sport_type)) return line;
  const km = sps.map((sp) => `${pace(splitPace(sp)).replace("/km", "")}${sp.average_heartrate ? `(${Math.round(sp.average_heartrate)})` : ""}`).join(" ");
  return `${line}\n    每公里 配速(心拍)：${km}`;
}

const KEY_SESSION = /MP|坡/;

/** The week an activity is booked in: a make-up session's week, else the week of its date. */
export function activityWeekNo(a: Pick<BriefActivity, "date" | "session">, weeks: PlanWeekRow[]): number | null {
  if (a.session?.moved_from_session_id) return a.session.counts_in_week_no ?? null;
  return weekOf(weeks, a.date)?.week_no ?? null;
}

/** A moved row that counts as not run in its own week (its make-up session is booked in another week). */
export const movedCountsHere = (m: MovedSession) => m.week_no != null && m.moved_to_counts_in_week_no != null && m.moved_to_counts_in_week_no !== m.week_no;

/** " 5 km" / " 16.2 km": the distance the way a card names a session (sessionLabel), no trailing .0. */
const sessionKm = (s: { target_distance_m: number | null }) => (s.target_distance_m ? ` ${Math.round(s.target_distance_m / 100) / 10} km` : "");

/**
 * One line for a week that is over: planned vs run, the long run, the key sessions, what was skipped, RPE. Every number
 * is the week the row is booked in (countsWeekNo), not the week of its date: a make-up session booked in this week counts
 * here wherever it is drawn, the session it replaced does not (or counts as not run when the make-up is booked elsewhere).
 */
export function weekLine(w: PlanWeekRow, b: Pick<PlanBriefing, "weeks" | "sessions" | "activities"> & Partial<Pick<PlanBriefing, "moved">>, today?: string): string {
  const moved = b.moved ?? [];
  const sessions = b.sessions.filter((s) => countsWeekNo(s, b.weeks) === w.week_no);
  const lost = moved.filter((m) => m.week_no === w.week_no && movedCountsHere(m));
  const acts = b.activities.filter((a) => activityWeekNo(a, b.weeks) === w.week_no);
  const isPlanned = (s: { type: string }) => s.type !== "rest" && s.type !== "race";
  const planM = [...sessions, ...lost].filter(isPlanned).reduce((t, s) => t + (s.target_distance_m ?? 0), 0);
  const actualM = acts.filter((a) => isRunSport(a.sport_type)).reduce((t, a) => t + a.distance_m, 0);
  const parts = [`計畫 ${km1(planM)} km／實跑 ${km1(actualM)} km`];

  // A make-up session drawn in another week that has not been run is told in its own segment, not as a miss or a skip.
  const comesLater = (s: SessionWithDone) => !!s.moved_from_session_id && !s.done && weekOf(b.weeks, s.scheduled_date)?.week_no !== w.week_no;
  const listed = sessions.filter((s) => !comesLater(s));

  const longs = listed.filter((s) => s.type === "long");
  for (const s of longs) {
    const a = acts.find((x) => x.session?.id === s.id);
    parts.push(a ? `長跑 ${km1(a.distance_m)} km ${pace(a.avg_pace_sec_km)} 心拍 ${a.avg_hr ?? "-"}` : `長跑 ${s.label ?? ""} ${s.skipped_at ? "他說沒跑" : "沒紀錄"}`);
  }
  const keys = listed.filter((s) => s.type !== "rest" && s.type !== "race" && s.type !== "long" && KEY_SESSION.test(s.label ?? ""));
  if (keys.length) {
    parts.push(`關鍵課：${keys.map((s) => {
      const a = acts.find((x) => x.session?.id === s.id);
      return `${s.label} ${a ? a.verdict ?? "未評" : s.skipped_at ? "他說沒跑" : "沒紀錄"}`;
    }).join("、")}`);
  }
  const skipped = listed.filter((s) => s.type !== "rest" && s.type !== "race" && s.type !== "long" && !KEY_SESSION.test(s.label ?? "") && (!s.done || s.skipped_at));
  if (skipped.length) parts.push(`跳過：${skipped.map((s) => `${weekday(s.scheduled_date)}${s.label ?? s.type}`).join("、")}`);
  const rpes = acts.map((a) => a.rpe).filter((r): r is number => r != null);
  if (rpes.length) parts.push(`平均 RPE ${(rpes.reduce((t, r) => t + r, 0) / rpes.length).toFixed(1)}`);

  const out = moved.filter((m) => m.week_no === w.week_no);
  if (out.length) {
    parts.push(`改期：${out.map((m) => `${weekday(m.scheduled_date)}${m.label ?? m.type}${sessionKm(m)} → ${shortDate(m.moved_to_date)}${m.moved_to_counts_in_week_no != null ? `（算在第 ${m.moved_to_counts_in_week_no} 週）` : ""}`).join("、")}`);
  }
  const inbound = sessions.filter((s) => !!s.moved_from_session_id && weekOf(b.weeks, s.scheduled_date)?.week_no !== w.week_no);
  if (inbound.length) {
    parts.push(`補課算這週：${inbound.map((s) => `${shortDate(s.scheduled_date)} ${s.label ?? s.type}${sessionKm(s)} ${s.done ? "已完成" : !today || s.scheduled_date >= today ? "待跑" : "沒跑"}`).join("、")}`);
  }
  return `- 第 ${w.week_no} 週 ${shortDate(w.week_start)}〜${shortDate(w.week_end)}：${parts.join("｜")}`;
}

const mondayOf = (iso: string) => addDays(iso, -((weekdayOf(iso) + 6) % 7));

/**
 * 已過的課: every session of this week and last week before today with its state and (when a make-up can use it) its id;
 * older ones only when they were missed. Newest first.
 */
export function pastSessionLines(b: Pick<PlanBriefing, "weeks" | "sessions" | "activities" | "moved">, today: string): string[] {
  const recentFrom = addDays(mondayOf(today), -7); // Monday of last week (the weekly reviews' weeks are Monday to Sunday)
  const rows: { date: string; label: string; line: string }[] = [];
  const head = (date: string, label: string | null, type: string, extra: string) => `- ${date} ${weekday(date)} [${label ?? type}] ${extra}`;
  for (const s of b.sessions) {
    if (s.scheduled_date >= today) continue;
    const recent = s.scheduled_date >= recentFrom;
    const rest = !isRunSession(s) && s.type !== "race"; // a rest day or a strength day: nothing to miss
    if (!recent && (s.done || rest || s.type === "race")) continue;
    const content = `${s.content ?? ""}`.replace(/\s+/g, " ").trim();
    const what = rest && !isStrength(s) ? "" : [content, /km/i.test(content) ? "" : sessionKm(s).trim()].filter(Boolean).join(" "); // the content often names the distance already
    let state: string;
    if (s.done) {
      const a = b.activities.find((x) => x.session?.id === s.id);
      state = `已完成${a ? `（配 ${shortDate(a.date)} 的 ${isRunSport(a.sport_type) ? `${(a.distance_m / 1000).toFixed(1)} km` : sportName(a.sport_type)}）` : ""}`;
    } else if (s.type === "race") state = "比賽日";
    else if (rest) state = isStrength(s) ? "肌力日（沒有活動紀錄，不補課）" : "休息";
    else if (s.skipped_at) state = `他說沒跑｜id=${s.id}`;
    else state = `漏跑（沒有紀錄）｜id=${s.id}`;
    rows.push({ date: s.scheduled_date, label: s.label ?? s.type, line: head(s.scheduled_date, s.label, s.type, [what, state].filter(Boolean).join("｜")) });
  }
  for (const m of b.moved) {
    if (m.scheduled_date >= today || m.scheduled_date < recentFrom) continue;
    const what = sessionKm(m).trim();
    const state = `已改期 → ${shortDate(m.moved_to_date)}${m.moved_to_counts_in_week_no != null ? `（算第 ${m.moved_to_counts_in_week_no} 週）` : ""}`;
    rows.push({ date: m.scheduled_date, label: m.label ?? m.type, line: head(m.scheduled_date, m.label, m.type, [what, state].filter(Boolean).join("｜")) });
  }
  rows.sort((x, y) => (x.date === y.date ? x.label.localeCompare(y.label) : x.date < y.date ? 1 : -1));
  return rows.map((r) => r.line);
}

/** The one sentence that tells Woo which week a make-up is booked in right now (the card's impact must say it). */
export function makeupRuleLine(b: Pick<PlanBriefing, "weeks" | "reviewedWeeks">, today: string): string {
  // Calendar weeks, Monday to Sunday, like the weekly reviews; plan_weeks can be shorter (the first starts on a Thursday).
  const thisStart = mondayOf(today);
  const lastStart = addDays(thisStart, -7), lastEnd = addDays(thisStart, -1);
  const cur = b.weeks.find((w) => w.week_end >= thisStart && w.week_start <= addDays(thisStart, 6));
  const last = b.weeks.find((w) => w.week_end >= lastStart && w.week_start <= lastEnd);
  const lastText = last ? `（${shortDate(lastStart)}〜${shortDate(lastEnd)}）的回顧${b.reviewedWeeks.has(last.week_no) ? "已產生" : "還沒產生"}` : `（${shortDate(lastStart)}〜${shortDate(lastEnd)}）不在課表裡`;
  const thisText = cur && b.reviewedWeeks.has(cur.week_no) ? "已產生" : "還沒";
  return `補課算哪一週：原週的週回顧已產生 → 算在補跑那天的那週；還沒產生（含沒有週回顧的週）→ 算在原週。每個已過的週有沒有週回顧，看「每週階段」的標記。現在：上週${lastText}；本週的${thisText}。`;
}

/** Runs assigned to a session, for the trend numbers. */
export function trendRuns(b: Pick<PlanBriefing, "activities">): TrendRun[] {
  return b.activities
    .filter((a) => isRunSport(a.sport_type) && a.session)
    .map((a) => ({
      a: { id: a.id, date: a.date, distance_m: a.distance_m, avg_pace_sec_km: a.avg_pace_sec_km, avg_hr: a.avg_hr, max_hr: a.max_hr, splits: a.splits },
      s: a.session!,
    }));
}

/** The briefing text. Pure: the same data gives the same text, so it can sit behind a cache breakpoint. */
export function buildPlanBriefing(b: PlanBriefing, today: string): string {
  const { plan } = b;
  const d = daysBetween(today, plan.race_date);
  const cur = b.weeks.find((w) => today >= w.week_start && today <= w.week_end);
  const upcoming = b.sessions.filter((s) => s.scheduled_date >= today);
  const since = addDays(today, -SPLIT_DAYS);
  const overWeeks = b.weeks.filter((w) => w.week_end < today);
  const trend = trendLines(trendRuns(b), b.sessions, today);
  const past = pastSessionLines(b, today);

  return [
    `今天 ${today}（${weekday(today)}）。跑者 ${plan.display_name}，目標 ${plan.race_name}（${plan.race_date}，${weekday(plan.race_date)}），目標完賽 ${goalText(plan)}，距離比賽 ${d} 天（約 ${Math.max(0, Math.round(d / 7))} 週）。`,
    makeupRuleLine(b, today),
    "",
    "## 記住的限制（他說過的；排課不能違反）",
    ...(b.constraints.length ? b.constraints.map(constraintLine) : ["（沒有）"]),
    "",
    "## 每週階段",
    ...b.weeks.map((w) => `- 第 ${w.week_no} 週 ${w.week_start}〜${w.week_end}${w.phase ? ` ${w.phase}` : ""}${w.focus ? `：${w.focus}` : ""}${cur?.week_no === w.week_no ? "　← 本週" : w.week_end < today ? `　（已過，${b.reviewedWeeks.has(w.week_no) ? "週回顧已產生" : "沒有週回顧"}）` : ""}`),
    "",
    "## 今天到比賽日的逐日課表（每一堂；id 在每行中間；提案只能動今天（含）到比賽日前一天、還沒完成的課）",
    upcoming.length ? upcoming.map((s) => sessionLine(s, today, plan.race_date)).join("\n") : "（沒有了）",
    "",
    "## 已過的課（本週與上週每一堂；更早只列漏跑的。補課只能用標「漏跑」「他說沒跑」的，用它的 id）",
    ...(past.length ? past : ["（沒有）"]),
    "",
    "## 過去每週（一週一行）",
    ...(overWeeks.length ? overWeeks.map((w) => weekLine(w, b, today)) : ["（還沒有結束的週）"]),
    "",
    "## 趨勢（系統算好的，跟今天頁的進步區塊同一套）",
    ...(trend.length ? trend : ["（資料還不夠）"]),
    "",
    `## 整期每一趟活動（從課表第 1 週到今天，一趟一行；最近 ${SPLIT_DAYS} 天附每公里分段，第 1 km 心拍不準）`,
    b.activities.length ? b.activities.map((a) => activityLine(a, a.date >= since)).join("\n") : "（沒有紀錄）",
  ].join("\n");
}
