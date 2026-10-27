import { loadLiveConstraints, constraintLine, WEEKDAY_ZH, weekdayOf } from "./constraints";
import { query } from "./db";
import { isRunSport, shortDate, sportName } from "./labels";
import { fullSplits, splitPace } from "./splits";
import { trendLines, type TrendRun } from "./trend";
import { loadPlanWeeks } from "./context";
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
export type SessionWithDone = PlannedSessionRow & { done: boolean };

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
}

/** Days of per-km splits in the briefing. */
export const SPLIT_DAYS = 14;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface ActivityRow {
  id: string; date: string; sport_type: string | null; distance_m: number; moving_time_sec: number;
  avg_pace_sec_km: number | null; avg_hr: number | null; max_hr: number | null; rpe: number | null;
  memo: string | null; description: string | null; session_id: string | null; splits: StravaSplit[] | null;
  verdict: Verdict | null; reminders: string[] | null;
}

export async function loadPlanBriefing(plan: Plan, today: string): Promise<PlanBriefing> {
  const weeks = await loadPlanWeeks(plan.id);
  const sessions = await query<SessionWithDone>(
    `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
            exists (select 1 from activities a where a.session_id = ps.id and a.match_status <> 'ignored') as done
       from planned_sessions ps
      where ps.plan_id = $1 and ps.superseded = false
      order by ps.scheduled_date, ps.label`,
    [plan.id],
  );
  const from = weeks[0]?.week_start ?? addDays(today, -120);
  const rows = await query<ActivityRow>(
    `select a.id, to_char(a.start_time at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as date, a.sport_type, a.distance_m, a.moving_time_sec,
            a.avg_pace_sec_km, a.avg_hr, a.max_hr, a.rpe, a.memo, a.description, a.session_id, a.splits, r.verdict, r.reminders
       from activities a left join reviews r on r.activity_id = a.id
      where a.user_id = $1 and a.match_status <> 'ignored'
        and (a.start_time at time zone 'Asia/Tokyo')::date between $2 and $3
      order by a.start_time`,
    [plan.user_id, from, today],
  );
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const activities = rows.map((r): BriefActivity => {
    const s = r.session_id ? byId.get(r.session_id) : undefined;
    const { done: _done, ...session } = s ?? ({} as SessionWithDone);
    return {
      id: r.id, date: r.date, sport_type: r.sport_type, distance_m: r.distance_m, moving_time_sec: r.moving_time_sec,
      avg_pace_sec_km: r.avg_pace_sec_km, avg_hr: r.avg_hr, max_hr: r.max_hr, rpe: r.rpe, memo: r.memo ?? r.description,
      splits: r.splits, session: s ? session : null, verdict: r.verdict, reminders: r.reminders ?? [],
    };
  });
  const constraints = await loadLiveConstraints(plan.user_id, today);
  return { plan, weeks, sessions, activities, constraints };
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

function sessionLine(s: SessionWithDone, today: string, raceDate: string): string {
  const marks = [
    s.type === "race" || s.scheduled_date === raceDate ? "比賽日，不能動" : "",
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

function activityLine(a: BriefActivity, detail: boolean): string {
  const what = isRunSport(a.sport_type)
    ? `${(a.distance_m / 1000).toFixed(2)} km ${pace(a.avg_pace_sec_km)} 心拍 ${a.avg_hr ?? "-"}`
    : `${sportName(a.sport_type)} ${Math.round(a.moving_time_sec / 60)} 分 心拍 ${a.avg_hr ?? "-"}`;
  const to = a.session ? `${a.session.label ?? a.session.type}${a.session.scheduled_date !== a.date ? `（${shortDate(a.session.scheduled_date)} 的課）` : ""}` : "未排課";
  const own = a.rpe || (detail && a.memo) ? `｜自述：${a.rpe ? `RPE ${a.rpe} ` : ""}${detail ? (a.memo ?? "").replace(/\s+/g, " ").slice(0, 80) : ""}`.trimEnd() : "";
  const line = `- ${a.date} 配 ${to}｜${what}｜${verdictText(a)}${own}`;
  if (!detail) return line;
  const sps = fullSplits(a.splits);
  if (!sps.length || !isRunSport(a.sport_type)) return line;
  const km = sps.map((sp) => `${pace(splitPace(sp)).replace("/km", "")}${sp.average_heartrate ? `(${Math.round(sp.average_heartrate)})` : ""}`).join(" ");
  return `${line}\n    每公里 配速(心拍)：${km}`;
}

const KEY_SESSION = /MP|坡/;

/** One line for a week that is over: planned vs run, the long run, the key sessions, what was skipped, RPE. */
export function weekLine(w: PlanWeekRow, b: Pick<PlanBriefing, "sessions" | "activities">): string {
  const inWeek = (d: string) => d >= w.week_start && d <= w.week_end;
  const sessions = b.sessions.filter((s) => inWeek(s.scheduled_date));
  const acts = b.activities.filter((a) => inWeek(a.date));
  const planM = sessions.filter((s) => s.type !== "rest" && s.type !== "race").reduce((t, s) => t + (s.target_distance_m ?? 0), 0);
  const actualM = acts.filter((a) => isRunSport(a.sport_type)).reduce((t, a) => t + a.distance_m, 0);
  const parts = [`計畫 ${km1(planM)} km／實跑 ${km1(actualM)} km`];

  const longs = sessions.filter((s) => s.type === "long");
  for (const s of longs) {
    const a = acts.find((x) => x.session?.id === s.id);
    parts.push(a ? `長跑 ${km1(a.distance_m)} km ${pace(a.avg_pace_sec_km)} 心拍 ${a.avg_hr ?? "-"}` : `長跑 ${s.label ?? ""} ${s.skipped_at ? "他說沒跑" : "沒紀錄"}`);
  }
  const keys = sessions.filter((s) => s.type !== "rest" && s.type !== "race" && s.type !== "long" && KEY_SESSION.test(s.label ?? ""));
  if (keys.length) {
    parts.push(`關鍵課：${keys.map((s) => {
      const a = acts.find((x) => x.session?.id === s.id);
      return `${s.label} ${a ? a.verdict ?? "未評" : s.skipped_at ? "他說沒跑" : "沒紀錄"}`;
    }).join("、")}`);
  }
  const skipped = sessions.filter((s) => s.type !== "rest" && s.type !== "race" && s.type !== "long" && !KEY_SESSION.test(s.label ?? "") && (!s.done || s.skipped_at));
  if (skipped.length) parts.push(`跳過：${skipped.map((s) => `${weekday(s.scheduled_date)}${s.label ?? s.type}`).join("、")}`);
  const rpes = acts.map((a) => a.rpe).filter((r): r is number => r != null);
  if (rpes.length) parts.push(`平均 RPE ${(rpes.reduce((t, r) => t + r, 0) / rpes.length).toFixed(1)}`);
  return `- 第 ${w.week_no} 週 ${shortDate(w.week_start)}〜${shortDate(w.week_end)}：${parts.join("｜")}`;
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

  return [
    `今天 ${today}（${weekday(today)}）。跑者 ${plan.display_name}，目標 ${plan.race_name}（${plan.race_date}，${weekday(plan.race_date)}），目標完賽 ${goalText(plan)}，距離比賽 ${d} 天（約 ${Math.max(0, Math.round(d / 7))} 週）。`,
    "",
    "## 記住的限制（他說過的；排課不能違反）",
    ...(b.constraints.length ? b.constraints.map(constraintLine) : ["（沒有）"]),
    "",
    "## 每週階段",
    ...b.weeks.map((w) => `- 第 ${w.week_no} 週 ${w.week_start}〜${w.week_end}${w.phase ? ` ${w.phase}` : ""}${w.focus ? `：${w.focus}` : ""}${cur?.week_no === w.week_no ? "　← 本週" : w.week_end < today ? "　（已過）" : ""}`),
    "",
    "## 今天到比賽日的逐日課表（每一堂；id 在每行中間；提案只能動今天之後到比賽日前一天、還沒完成的課）",
    upcoming.length ? upcoming.map((s) => sessionLine(s, today, plan.race_date)).join("\n") : "（沒有了）",
    "",
    "## 過去每週（一週一行）",
    ...(overWeeks.length ? overWeeks.map((w) => weekLine(w, b)) : ["（還沒有結束的週）"]),
    "",
    "## 趨勢（系統算好的，跟今天頁的進步區塊同一套）",
    ...(trend.length ? trend : ["（資料還不夠）"]),
    "",
    `## 整期每一趟活動（從課表第 1 週到今天，一趟一行；最近 ${SPLIT_DAYS} 天附每公里分段，第 1 km 心拍不準）`,
    b.activities.length ? b.activities.map((a) => activityLine(a, a.date >= since)).join("\n") : "（沒有紀錄）",
  ].join("\n");
}
