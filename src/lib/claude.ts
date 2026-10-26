import Anthropic from "@anthropic-ai/sdk";
import { splitsSummary } from "./splits";
import type {
  ActivityReviewResult,
  ActivityRow,
  PlanRow,
  PlanWeekRow,
  PlannedSessionRow,
  StoredAdjustment,
  StravaSplit,
  Verdict,
  WeeklyReviewResult,
} from "../types";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
/** The weekly review reads two weeks of data plus the whole plan: a stronger model, once a week. */
export const DEFAULT_WEEKLY_MODEL = "claude-sonnet-5-5";
/** The coach's chat replies: needs world knowledge (routes, terrain, the race) and web search. */
export const DEFAULT_COACH_MODEL = "claude-sonnet-5-5";

function client() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function model() {
  return process.env.CLAUDE_MODEL || DEFAULT_MODEL;
}

function weeklyModel() {
  return process.env.CLAUDE_MODEL_WEEKLY || DEFAULT_WEEKLY_MODEL;
}

export function coachModel(): string {
  return process.env.CLAUDE_MODEL_COACH || DEFAULT_COACH_MODEL;
}

function pace(sec: number | null | undefined): string {
  if (!sec) return "-";
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}/km`;
}

function extractJson<T>(text: string): T {
  const start = text.indexOf("{");
  const endIdx = text.lastIndexOf("}");
  if (start < 0 || endIdx < 0) throw new Error(`Claude returned no JSON: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, endIdx + 1)) as T;
}

async function ask<T>(modelId: string, system: string, user: string, schema: Record<string, unknown>): Promise<{ data: T; model: string }> {
  const response = await client().messages.create({
    model: modelId,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: { type: "json_schema", schema } },
  });
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude refused: ${JSON.stringify(response.stop_details)}`);
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { data: extractJson<T>(text), model: response.model };
}

const RUN_SPORTS = new Set(["Run", "TrailRun", "VirtualRun"]);
const isRunSport = (sport: string | null | undefined) => !sport || RUN_SPORTS.has(sport);

/**
 * What the app is, so the coach describes it the same way everywhere (chat, verdicts,
 * the weekly review) and never invents a page or sends the athlete to "someone else".
 */
export function appNotes(coachName: string): string {
  return `## 這個 app（你講到 app 時只能照這段說）
- 跑者有三個頁面：「今天」（今天的課、跑完的按鈕、最近的進步區塊）、「課表」（整份課表，點一堂看內容）、「教練」（就是你，${coachName}，一個對話串）。每趟活動還有一個報告頁（數據、分段、你的判定）。
- 週回顧就在教練這個對話串裡，每週一則，週一早上 04:00 發出；不是另一個頁面。
- 你的課表提案是訊息下方的一張卡，上面有「採用」「不採用」兩顆按鈕。跑者按「採用」，課表立刻改；按「不採用」就不改。你自己不能改課表，只能提案。
- 跑完的流程：Strava 同步進來後你先問「是哪一趟」（他點選）、再問感受（他回一句）、然後你給判定（達成／達成但有提醒／未達成）貼在對話串和報告頁。
- 規則：跟他個人有關的事（他跑了什麼、心拍多少、哪天跳過、課表內容）只能用 briefing 裡的資料；briefing 沒有的，只能說「這個我沒有資料，你跟我說」。不能叫他去問別人、去問負責的人、去看不存在的頁面或按鈕。`;
}

function goalText(plan: PlanRow): string {
  return plan.goal_time_sec
    ? `${Math.floor(plan.goal_time_sec / 3600)}h${String(Math.floor((plan.goal_time_sec % 3600) / 60)).padStart(2, "0")}`
    : "未設定";
}

function sessionLine(s: PlannedSessionRow): string {
  const km = s.target_distance_m ? `${(s.target_distance_m / 1000).toFixed(1)} km` : "-";
  return `- ${s.scheduled_date} [${s.label ?? s.type}] ${s.content ?? ""} ${km} 目標 ${s.target ?? "-"} id=${s.id}${s.note ? ` — ${s.note}` : ""}`;
}

/** One past activity as the coach sees it: numbers, verdict, and what the athlete wrote. */
export interface HistoryItem {
  date: string; // 'YYYY-MM-DD' (JST)
  label: string | null; // session label when assigned
  sport_type: string | null;
  distance_m: number;
  moving_time_sec: number;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  verdict: Verdict | null;
  reminders: string[];
  rpe: number | null;
  memo: string | null;
}

function historyLine(h: HistoryItem): string {
  const what = isRunSport(h.sport_type)
    ? `${(h.distance_m / 1000).toFixed(2)} km ${pace(h.avg_pace_sec_km)} HR ${h.avg_hr ?? "-"}`
    : `${h.sport_type ?? "運動"} ${Math.round(h.moving_time_sec / 60)} 分 HR ${h.avg_hr ?? "-"}`;
  const own = h.rpe || h.memo ? ` | 自述：${h.rpe ? `RPE ${h.rpe} ` : ""}${(h.memo ?? "").replace(/\s+/g, " ").slice(0, 80)}` : "";
  return `- ${h.date} [${h.label ?? "未排課"}] ${what} → ${h.verdict ?? "未評"}${own}`;
}

// ---- per-activity review (worker) ------------------------------------------

const REVIEW_SYSTEM = `你是 Woo，一位務實的馬拉松教練，長期帶同一位業餘跑者。你會拿到他的目標、整份課表、最近兩週的練習、同類型課的歷史，以及今天這堂課的數據和他自己寫的感受。

先把數據讀對：
- 「## 算好的重點」是系統先算好的數字：重點段（MP 段、最後幾公里、上坡趟）的平均配速與最高心拍、整趟平均、哪幾公里的心拍不算數。判定以這些算好的數字為準，原始的每公里分段只當參考，不要自己重算、也不要拿整趟平均去比重點段的目標。
- 配速是「每公里幾分幾秒」，數字越小越快：9:01 比 7:25 慢。說「太快」「太慢」之前先確認方向。
- 坡跑、間歇、快步這類以趟數和秒數為單位的課，課表上的距離只是估計值，不拿距離扣分；看趟數有沒有做到、上坡段的心拍、下坡或組間有沒有真的放慢。每公里分段裡的爬升欄（+m）能看出哪幾公里是上坡。
- 跑步機或室內（自述提到跑步機、健身房，或 Strava 類型是 VirtualRun）：手錶估的配速不可信，坡度也看不到，以心拍、時間和自述為主，不要拿配速下結論。
- 組合課（例如「2 km Easy + 3 km @ MP + 2 km Easy」或「最後 4 km @ 6:45」）：目標配速只適用在對應的那幾公里，用算好的重點段判斷，不要拿整趟平均配速去比目標。備註裡的心拍上限同樣只看那一段。
- 心拍雜訊：第 1 km 的心拍不看（錶延遲），標成「疑似跳動」的 km 當雜訊，不拿它們講「起跑偏快」或「心拍過高」。
- 心拍和跑者自述對不上（他說很輕鬆但心拍高、或他說很累但心拍低）：相信感受，評語裡先問一句（例如「心拍 165 但你說輕鬆，錶有戴緊嗎？」），不用心拍定生死。
- 非跑步的活動（重訓、騎車、Hyrox 等）沒有配速與距離可比：依課表內容、時間、心拍和自述判斷。

判定（verdict）只看數據：
- 達成：配速與心拍都在課表區間內、距離到位（或趟數做到）。
- 達成但有提醒：跑完了但配速或心拍明顯偏離，或有明確距離要求的課距離差 >15%。
- 未達成：有明確距離要求的課距離差 >30%，或完全跑錯類型。
- 跑者的自述不能把判定放寬：數據超標就是超標，即使他說很輕鬆。自述提到疼痛、不適或異常疲勞時，可以把判定往嚴的方向壓一級（達成 → 達成但有提醒），但不能往寬的方向放。
- Easy / Recovery 日「寧慢勿快」，跑太快是扣分不是加分。

評語（comment，2〜4 句繁體中文）：你手上有他的目標、現在的階段、同類型的歷史、最近兩週的負荷、他的自述和上一次的提醒。挑今天最值得講的一兩件事講清楚，引用具體日期和數字；其他的不用提，也不用每樣都交代。像教練在跟他說話，不要訓話、不要下結論式的大標籤。他自述裡有講到的，數據同意就說同意，不同意就指出數據看到什麼。

${appNotes("Woo")}

提醒（reminders，0〜3 條）：只寫下次要改的具體動作，依重要性排序（第一條會單獨顯示在 app 首頁），每條一句、20 字以內；沒有就空陣列，不要硬湊。

課表調整建議（adjust_hint）：一句話或 null。只在有明確理由時給（連續兩次同類型都超標、自述疼痛、連續漏課、明顯超前），寫「建議怎麼調、為什麼」。這只是給每週回顧參考，不會直接改課表，所以不要每次都填。`;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["達成", "達成但有提醒", "未達成"] },
    comment: { type: "string" },
    reminders: { type: "array", items: { type: "string" } },
    adjust_hint: { type: ["string", "null"] },
  },
  required: ["verdict", "comment", "reminders", "adjust_hint"],
  additionalProperties: false,
} as const;

/** Everything around today's session that a coach would know. */
export interface ReviewContext {
  plan: PlanRow & { display_name: string };
  weeks: PlanWeekRow[];
  /** Sessions of the week the reviewed session is in, with what happened to each. */
  thisWeek: { session: PlannedSessionRow; status: "done" | "skipped" | "upcoming" | "today" }[];
  /** Last 14 days of activities (any sport), oldest first. */
  recent: HistoryItem[];
  /** Earlier sessions with the same label, oldest first (up to 5). */
  sameType: HistoryItem[];
  /** Reminders from the athlete's previous reviewed run. */
  prevReminders: string[];
}

export interface ActivityReviewInput {
  session: PlannedSessionRow;
  activity: Pick<ActivityRow, "distance_m" | "moving_time_sec" | "avg_pace_sec_km" | "avg_hr" | "max_hr"> & {
    sport_type?: string | null;  // Strava sport_type; anything but a run is judged without pace/distance
    start_date?: string;         // 'YYYY-MM-DD' (JST), for "weeks to race"
    splits: StravaSplit[] | null;
    description?: string | null; // Strava description
    memo?: string | null;        // athlete's note in the app
    rpe?: number | null;         // athlete's RPE 1-10
  };
  context?: ReviewContext;
}

function weeksToRace(raceDate: string, today: string | undefined): string {
  if (!today) return "";
  const days = Math.round((Date.parse(`${raceDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return `，距離比賽 ${days} 天（約 ${Math.max(0, Math.round(days / 7))} 週）`;
}

export function buildReviewPrompt({ session: s, activity: a, context: c }: ActivityReviewInput): string {
  const splits = (a.splits ?? [])
    .map((sp) => {
      const km = sp.distance / 1000;
      const p = sp.moving_time / km;
      return `  ${sp.split}: ${km.toFixed(2)} km ${pace(Math.round(p))}${sp.average_heartrate ? ` HR ${Math.round(sp.average_heartrate)}` : ""}${sp.elevation_difference ? ` ${sp.elevation_difference > 0 ? "+" : ""}${Math.round(sp.elevation_difference)}m` : ""}`;
    })
    .join("\n");
  const computed = isRunSport(a.sport_type)
    ? splitsSummary(s, { sport_type: a.sport_type, distance_m: a.distance_m, moving_time_sec: a.moving_time_sec, avg_pace_sec_km: a.avg_pace_sec_km, avg_hr: a.avg_hr, max_hr: a.max_hr, splits: a.splits, memo: a.memo, description: a.description })
    : "";

  const parts: string[] = [];

  if (c) {
    const cur = c.weeks.find((w) => s.scheduled_date >= w.week_start && s.scheduled_date <= w.week_end);
    parts.push(
      "## 跑者與目標",
      `${c.plan.display_name}，目標 ${c.plan.race_name}（${c.plan.race_date}），目標完賽 ${goalText(c.plan)}${weeksToRace(c.plan.race_date, a.start_date)}`,
      "",
      "## 課表階段",
      ...c.weeks.map((w) => `- 第 ${w.week_no} 週 ${w.week_start}〜${w.week_end}${w.phase ? ` ${w.phase}` : ""}${w.focus ? `：${w.focus}` : ""}${cur?.week_no === w.week_no ? "　← 本週" : ""}`),
      "",
      "## 本週課表",
      ...c.thisWeek.map(({ session: ws, status }) => {
        const mark = status === "done" ? "✓" : status === "skipped" ? "✗ 跳過" : status === "today" ? "● 今天這堂" : "…";
        return `- ${ws.scheduled_date} [${ws.label ?? ws.type}] ${ws.content ?? ""} ${mark}`;
      }),
      "",
      "## 最近 14 天的練習",
      c.recent.length ? c.recent.map(historyLine).join("\n") : "（沒有紀錄）",
      "",
      `## 同類型（${s.label ?? s.type}）上幾次`,
      c.sameType.length ? c.sameType.map(historyLine).join("\n") : "（這是第一次）",
      "",
      "## 上一次的提醒",
      c.prevReminders.length ? c.prevReminders.map((r) => `- ${r}`).join("\n") : "（無）",
      "",
    );
  }

  parts.push(
    "## 今天的課表",
    `${s.scheduled_date} [${s.label ?? s.type}] ${s.content ?? ""}`,
    `目標距離 ${s.target_distance_m ? (s.target_distance_m / 1000).toFixed(1) : "-"} km；目標：${s.target ?? "-"}`,
    s.note ? `備註：${s.note}` : "",
    "",
    "## 實際",
    isRunSport(a.sport_type)
      ? `${(a.distance_m / 1000).toFixed(2)} km，${Math.round(a.moving_time_sec / 60)} 分，平均 ${pace(a.avg_pace_sec_km)}，平均心拍 ${a.avg_hr ?? "-"}，最高 ${a.max_hr ?? "-"}`
      : `${a.sport_type}，${Math.round(a.moving_time_sec / 60)} 分，平均心拍 ${a.avg_hr ?? "-"}，最高 ${a.max_hr ?? "-"}`,
    ...(computed ? ["", "## 算好的重點（判定以這裡為準）", computed] : []),
    splits ? `\n每公里（原始分段，只當參考）：\n${splits}` : "",
    a.memo || a.description || a.rpe
      ? ["", "## 跑者自述", a.rpe ? `RPE ${a.rpe}/10` : "", a.memo ? a.memo : "", !a.memo && a.description ? a.description : ""]
          .filter((l) => l !== "").join("\n")
      : "",
  );

  return parts.filter((l) => l !== "").join("\n");
}

export async function reviewActivity(input: ActivityReviewInput): Promise<ActivityReviewResult & { model: string }> {
  const { data, model: used } = await ask<Partial<ActivityReviewResult>>(model(), REVIEW_SYSTEM, buildReviewPrompt(input), REVIEW_SCHEMA);
  const verdict = data.verdict === "達成" || data.verdict === "達成但有提醒" || data.verdict === "未達成" ? data.verdict : "達成但有提醒";
  return {
    verdict,
    comment: typeof data.comment === "string" ? data.comment : "",
    reminders: Array.isArray(data.reminders) ? data.reminders.filter((r): r is string => typeof r === "string") : [],
    adjust_hint: typeof data.adjust_hint === "string" && data.adjust_hint.trim() ? data.adjust_hint.trim() : null,
    model: used,
  };
}

// ---- weekly review (scheduler) ----------------------------------------------

export interface WeeklyReviewInput {
  plan: PlanRow & { display_name: string };
  weeks: PlanWeekRow[];
  weekStart: string; // Monday
  weekEnd: string;   // Sunday
  sessions: PlannedSessionRow[];
  activities: HistoryItem[];
  /** adjust_hint lines the per-run reviews left this week. */
  hints: string[];
  /** Last week's summary, so the coach keeps a thread. */
  previousSummary: string | null;
  upcoming: PlannedSessionRow[]; // next 2–3 weeks (adjustment targets)
  /**
   * Key sessions (Long / MP / 坡跑) of the week with no record: the review asks
   * instead of concluding and makes no proposals. `synced` = the athlete already
   * said it is on its way.
   */
  asks?: { session: PlannedSessionRow; state: "open" | "synced" }[];
  /** Sessions the athlete said they did not run (skipped_at set). */
  skipped?: PlannedSessionRow[];
  /** Proposals of the earlier version of this review that the athlete already applied: facts now. */
  applied?: StoredAdjustment[];
  /** Why this is a regeneration ("10/25 的長跑進來了"), for the model's wording. */
  updateReason?: string | null;
}

const WEEKLY_SYSTEM = `你是 Woo，一位務實的馬拉松教練，長期帶同一位業餘跑者，替他做每週回顧。你會拿到目標、整份課表的階段、本週課表與實際、每次練習的判定與他的自述、以及接下來的課表。
原則：
- 用繁體中文，口吻直接、具體，不要客套。引用日期和數字。
- 評估「計畫 vs 實際」：完成率、配速是否守住區間、心率是否過高、長跑是否達標、是否有連續缺席。
- 放在目標裡看：離比賽還幾週、這個階段該練到什麼程度、目前是超前、剛好還是落後。
- 跑者自述（RPE、心得）要一併納入：反覆出現的問題要在總結點出；自述很累或有疼痛時，調整建議優先降量而不是加量。
- 接上週：上週總結講過的事這週有沒有改善。
- 「## 沒有紀錄的關鍵課」裡列的課：不要下「沒跑」「漏課」的結論，也不要據此評估完成率；總結只講看得到的，那一堂寫成一句問句（例如「10/25 的長跑 16 km 我沒看到紀錄，是沒跑，還是還沒同步？」），並說長跑確定之後再給下週的建議。這種情況 adjustments 回空陣列。
- 「## 跑者說沒跑的課」：當成跳過（他自己說的），可以據此評估，不用再問。
- 「## 已採用的調整（既成事實）」：跑者已經按了採用，課表已經改了，「接下來的課表」清單裡是改好之後的版本；當事實寫，不要再提一次同樣的建議。
- 調整建議只在有明確理由時提出（受傷風險、連續未達成、明顯超前、連續漏課），而且只調整「接下來的課表」清單裡的 session；不要重排整份計畫。每條建議都會先給跑者看，他按「採用」才會生效，所以要寫清楚理由。
- adjustments 的 session_id 必須來自「接下來的課表」清單；field 只能是 type / target_distance_m / target_pace_sec_km / scheduled_date / note；target_distance_m 用公尺、target_pace_sec_km 用每公里秒數、scheduled_date 用 YYYY-MM-DD。
- 沒有需要調整就回空陣列。

${appNotes("Woo")}`;

const WEEKLY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "本週總結，3〜6 句，繁體中文" },
    adjustments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          field: { type: "string", enum: ["type", "target_distance_m", "target_pace_sec_km", "scheduled_date", "note"] },
          old: { type: ["string", "number", "null"] },
          new: { type: ["string", "number", "null"] },
          reason: { type: "string" },
        },
        required: ["session_id", "field", "old", "new", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "adjustments"],
  additionalProperties: false,
} as const;

export function buildWeeklyPrompt(input: WeeklyReviewInput): string {
  const { plan } = input;
  const cur = input.weeks.find((w) => input.weekStart >= w.week_start && input.weekStart <= w.week_end);
  return [
    `跑者：${plan.display_name}`,
    `目標賽事：${plan.race_name}（${plan.race_date}），目標完賽時間 ${goalText(plan)}${weeksToRace(plan.race_date, input.weekEnd)}`,
    `本週：${input.weekStart} 〜 ${input.weekEnd}${cur ? `（第 ${cur.week_no} 週${cur.phase ? ` · ${cur.phase}` : ""}${cur.focus ? `：${cur.focus}` : ""}）` : ""}`,
    "",
    "## 課表階段",
    ...input.weeks.map((w) => `- 第 ${w.week_no} 週 ${w.week_start}〜${w.week_end}${w.phase ? ` ${w.phase}` : ""}${w.focus ? `：${w.focus}` : ""}`),
    "",
    "## 上週總結",
    input.previousSummary ?? "（第一週，沒有）",
    "",
    "## 本週課表",
    input.sessions.length ? input.sessions.map(sessionLine).join("\n") : "（無）",
    "",
    "## 本週實際活動（Strava；「自述」是跑者自己寫的 RPE 與心得）",
    input.activities.length ? input.activities.map(historyLine).join("\n") : "（本週沒有任何活動紀錄）",
    "",
    ...(input.asks?.length
      ? [
          "## 沒有紀錄的關鍵課（不要下結論，寫成問句，這次不出調整建議）",
          ...input.asks.map(({ session: s, state }) => `- ${s.scheduled_date} [${s.label ?? s.type}] ${s.content ?? ""}${state === "synced" ? "（他說還沒同步，等資料進來）" : ""}`),
          "",
        ]
      : []),
    ...(input.skipped?.length
      ? ["## 跑者說沒跑的課", ...input.skipped.map((s) => `- ${s.scheduled_date} [${s.label ?? s.type}] ${s.content ?? ""}`), ""]
      : []),
    ...(input.applied?.length
      ? ["## 已採用的調整（既成事實）", ...input.applied.map((a) => `- ${adjustmentLine(a)}`), ""]
      : []),
    "## 單次判定留下的調整提示",
    input.hints.length ? input.hints.map((h) => `- ${h}`).join("\n") : "（無）",
    "",
    "## 接下來的課表（可調整的對象）",
    input.upcoming.length ? input.upcoming.map(sessionLine).join("\n") : "（無）",
    "",
    input.updateReason
      ? `這是重新生成（原因：${input.updateReason}）。請重新給出本週總結與（如有必要的）調整建議。`
      : "請給出本週總結與（如有必要的）調整建議。",
  ].join("\n");
}

const FIELD_NAMES: Record<string, string> = { type: "類型", target_distance_m: "距離", target_pace_sec_km: "配速", scheduled_date: "日期", note: "備註", skip: "改休息" };
const fmtValue = (field: string, v: string | number | null): string => {
  if (v == null) return "-";
  if (field === "target_distance_m" && typeof v === "number") return `${Math.round(v / 100) / 10} km`;
  if (field === "target_pace_sec_km" && typeof v === "number") return pace(v).replace("/km", "");
  if (field === "scheduled_date" && typeof v === "string") return v.slice(5).replace("-", "/");
  return String(v);
};
/** "距離 18 km → 16 km（理由）" — one adjustment as text. */
export function adjustmentLine(a: { field: string; old: string | number | null; new: string | number | null; reason?: string }): string {
  return `${FIELD_NAMES[a.field] ?? a.field} ${fmtValue(a.field, a.old)} → ${fmtValue(a.field, a.new)}${a.reason ? `（${a.reason}）` : ""}`;
}
export { fmtValue as formatAdjustmentValue };

export async function weeklyReview(input: WeeklyReviewInput): Promise<WeeklyReviewResult & { model: string }> {
  const { data, model: used } = await ask<Partial<WeeklyReviewResult>>(weeklyModel(), WEEKLY_SYSTEM, buildWeeklyPrompt(input), WEEKLY_SCHEMA);
  const allowed = new Set(input.upcoming.map((s) => s.id));
  // A key session without a record: ask, do not propose (the proposals come once it is settled).
  const adjustments = input.asks?.length ? [] : Array.isArray(data.adjustments) ? data.adjustments.filter((a) => allowed.has(a.session_id)) : [];
  return {
    summary: typeof data.summary === "string" ? data.summary : "",
    adjustments,
    model: used,
  };
}
