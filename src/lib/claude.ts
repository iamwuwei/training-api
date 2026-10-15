import Anthropic from "@anthropic-ai/sdk";
import type {
  ActivityReviewResult,
  ActivityRow,
  PlanRow,
  PlannedSessionRow,
  StravaSplit,
  WeeklyReviewResult,
} from "../types";

export const DEFAULT_MODEL = "claude-haiku-4-5";

function client() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function model() {
  return process.env.CLAUDE_MODEL || DEFAULT_MODEL;
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

async function ask<T>(system: string, user: string, schema: Record<string, unknown>): Promise<{ data: T; model: string }> {
  const response = await client().messages.create({
    model: model(),
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

// ---- per-activity review (worker) ------------------------------------------

const REVIEW_SYSTEM = `你是一位務實的馬拉松教練，替一位業餘跑者評一次練習。
看「課表要求 vs 實際數據」，再對照跑者自己寫的感受（RPE 與心得）。原則：
- verdict 三選一：達成（配速與心拍都在區間內、距離到位）／達成但有提醒（跑完了但配速或心拍明顯偏離，或距離差 >15%）／未達成（距離差 >30% 或完全跑錯類型）。
- comment：2〜4 句繁體中文，指出最值得注意的一件事（心拍漂移、起跑偏快、後段掉速、長跑末段加速…），引用具體公里數和數字。
- reminders：0〜3 條，只寫下次要改的具體動作，依重要性排序（第一條會單獨顯示在 app 首頁，要最值得做的那件事），每條一句、20 字以內；沒有就空陣列，不要硬湊。
- Easy / Recovery 日「寧慢勿快」，跑太快是扣分不是加分。
- 有「跑者自述」時它和數據同等重要：數據超標但自述輕鬆、RPE 低，可以放寬；數據正常但自述很累、RPE 高，要在 comment 提醒。comment 要直接回應跑者說的話（同意、補充或指出數據看到的不同），reminders 要涵蓋他自己提到的問題（例如「第一公里又衝太快」就給對應的具體做法）。不要只複述數據而忽略自述。
- 非跑步的活動（重訓、騎車、Hyrox 等）沒有配速與距離可比：依課表內容、時間、心拍和自述判斷，不要用配速或距離扣分。`;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["達成", "達成但有提醒", "未達成"] },
    comment: { type: "string" },
    reminders: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "comment", "reminders"],
  additionalProperties: false,
} as const;

const RUN_SPORTS = new Set(["Run", "TrailRun", "VirtualRun"]);
const isRunSport = (sport: string | null | undefined) => !sport || RUN_SPORTS.has(sport);

export interface ActivityReviewInput {
  session: PlannedSessionRow;
  activity: Pick<ActivityRow, "distance_m" | "moving_time_sec" | "avg_pace_sec_km" | "avg_hr" | "max_hr"> & {
    sport_type?: string | null;  // Strava sport_type; anything but a run is judged without pace/distance
    splits: StravaSplit[] | null;
    description?: string | null; // Strava description
    memo?: string | null;        // athlete's note in the app
    rpe?: number | null;         // athlete's RPE 1-10
  };
}

export function buildReviewPrompt({ session: s, activity: a }: ActivityReviewInput): string {
  const splits = (a.splits ?? [])
    .map((sp) => {
      const km = sp.distance / 1000;
      const p = sp.moving_time / km;
      return `  ${sp.split}: ${km.toFixed(2)} km ${pace(Math.round(p))}${sp.average_heartrate ? ` HR ${Math.round(sp.average_heartrate)}` : ""}${sp.elevation_difference ? ` ${sp.elevation_difference > 0 ? "+" : ""}${Math.round(sp.elevation_difference)}m` : ""}`;
    })
    .join("\n");
  return [
    "## 課表",
    `${s.scheduled_date} [${s.label ?? s.type}] ${s.content ?? ""}`,
    `目標距離 ${s.target_distance_m ? (s.target_distance_m / 1000).toFixed(1) : "-"} km；目標：${s.target ?? "-"}`,
    s.note ? `備註：${s.note}` : "",
    "",
    "## 實際",
    isRunSport(a.sport_type)
      ? `${(a.distance_m / 1000).toFixed(2)} km，${Math.round(a.moving_time_sec / 60)} 分，平均 ${pace(a.avg_pace_sec_km)}，平均心拍 ${a.avg_hr ?? "-"}，最高 ${a.max_hr ?? "-"}`
      : `${a.sport_type}，${Math.round(a.moving_time_sec / 60)} 分，平均心拍 ${a.avg_hr ?? "-"}，最高 ${a.max_hr ?? "-"}`,
    splits ? `每公里：\n${splits}` : "",
    a.memo || a.description || a.rpe
      ? ["", "## 跑者自述", a.rpe ? `RPE ${a.rpe}/10` : "", a.memo ? a.memo : "", !a.memo && a.description ? a.description : ""]
          .filter((l) => l !== "").join("\n")
      : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export async function reviewActivity(input: ActivityReviewInput): Promise<ActivityReviewResult & { model: string }> {
  const { data, model } = await ask<Partial<ActivityReviewResult>>(REVIEW_SYSTEM, buildReviewPrompt(input), REVIEW_SCHEMA);
  const verdict = data.verdict === "達成" || data.verdict === "達成但有提醒" || data.verdict === "未達成" ? data.verdict : "達成但有提醒";
  return {
    verdict,
    comment: typeof data.comment === "string" ? data.comment : "",
    reminders: Array.isArray(data.reminders) ? data.reminders.filter((r): r is string => typeof r === "string") : [],
    model,
  };
}

// ---- weekly review (scheduler) ----------------------------------------------

export interface WeeklyReviewInput {
  plan: PlanRow & { display_name: string };
  weekStart: string; // Monday
  weekEnd: string;   // Sunday
  sessions: PlannedSessionRow[];
  activities: ActivityRow[];
  upcoming: PlannedSessionRow[]; // next 2 weeks (adjustment targets)
}

const WEEKLY_SYSTEM = `你是一位務實的馬拉松教練，替一位業餘跑者做每週回顧。
原則：
- 用繁體中文，口吻直接、具體，不要客套。
- 評估「計畫 vs 實際」：完成率、配速是否守住區間、心率是否過高、長跑是否達標、是否有連續缺席。
- 跑者自述（RPE、心得）要一併納入：反覆出現的問題（例如連續幾次起跑太快、腿一直很累）要在總結點出；自述很累或有疼痛時，調整建議優先降量而不是加量。
- 只有在有明確理由（受傷風險、連續未達成、明顯超前）時才提出調整，而且只調整「下兩週」的課表；不要重排整份計畫。
- adjustments 中 session_id 必須來自「接下來的課表」清單；field 只能是 type / target_distance_m / target_pace_sec_km / scheduled_date / note。
- 沒有需要調整就回空陣列。`;

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

function sessionLine(s: PlannedSessionRow): string {
  const km = s.target_distance_m ? `${(s.target_distance_m / 1000).toFixed(1)} km` : "-";
  return `- ${s.scheduled_date} [${s.label ?? s.type}] ${s.content ?? ""} ${km} 目標 ${s.target ?? "-"} id=${s.id}${s.note ? ` — ${s.note}` : ""}`;
}

function activityLine(a: ActivityRow): string {
  const d = new Date(a.start_time).toISOString().slice(0, 10);
  const km = (a.distance_m / 1000).toFixed(2);
  const matched = a.session_id ? `對應 session=${a.session_id}` : `未對應(${a.match_status})`;
  const what = isRunSport(a.sport_type) ? `${km} km, ${Math.round(a.moving_time_sec / 60)} min, ${pace(a.avg_pace_sec_km)}` : `${a.sport_type}, ${Math.round(a.moving_time_sec / 60)} min`;
  const own = a.rpe || a.memo ? ` | 自述：${a.rpe ? `RPE ${a.rpe}/10 ` : ""}${a.memo ?? ""}`.replace(/\s+/g, " ") : "";
  return `- ${d} ${what}, HR ${a.avg_hr ?? "-"}; ${matched}${own}`;
}

export function buildWeeklyPrompt(input: WeeklyReviewInput): string {
  const { plan } = input;
  const goal = plan.goal_time_sec
    ? `${Math.floor(plan.goal_time_sec / 3600)}h${String(Math.floor((plan.goal_time_sec % 3600) / 60)).padStart(2, "0")}`
    : "未設定";
  return [
    `跑者：${plan.display_name}`,
    `目標賽事：${plan.race_name}（${plan.race_date}），目標完賽時間 ${goal}`,
    `本週：${input.weekStart} 〜 ${input.weekEnd}`,
    "",
    "## 本週課表",
    input.sessions.length ? input.sessions.map(sessionLine).join("\n") : "（無）",
    "",
    "## 本週實際活動（Strava；「自述」是跑者自己寫的 RPE 與心得）",
    input.activities.length ? input.activities.map(activityLine).join("\n") : "（本週沒有任何活動紀錄）",
    "",
    "## 接下來的課表（可調整的對象）",
    input.upcoming.length ? input.upcoming.map(sessionLine).join("\n") : "（無）",
    "",
    "請給出本週總結與（如有必要的）調整建議。",
  ].join("\n");
}

export async function weeklyReview(input: WeeklyReviewInput): Promise<WeeklyReviewResult & { model: string }> {
  const { data, model } = await ask<Partial<WeeklyReviewResult>>(WEEKLY_SYSTEM, buildWeeklyPrompt(input), WEEKLY_SCHEMA);
  return {
    summary: typeof data.summary === "string" ? data.summary : "",
    adjustments: Array.isArray(data.adjustments) ? data.adjustments : [],
    model,
  };
}
