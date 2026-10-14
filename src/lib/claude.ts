import Anthropic from "@anthropic-ai/sdk";
import type { ActivityRow, PlanRow, PlannedSessionRow, WeeklyReviewResult } from "../types";

export const DEFAULT_MODEL = "claude-haiku-4-5";

export interface WeeklyReviewInput {
  plan: PlanRow & { display_name: string };
  weekStart: string; // Monday
  weekEnd: string;   // Sunday
  sessions: PlannedSessionRow[];                 // this week's plan
  activities: (ActivityRow & { session_type?: string | null })[]; // this week's runs
  upcoming: PlannedSessionRow[];                 // next 2 weeks (adjustment targets)
}

const SYSTEM = `你是一位務實的馬拉松教練，替一位業餘跑者做每週回顧。
原則：
- 用繁體中文，口吻直接、具體，不要客套。
- 評估「計畫 vs 實際」：完成率、配速是否守住區間、心率是否過高、長跑是否達標、是否有連續缺席。
- 只有在有明確理由（受傷風險、連續未達成、明顯超前）時才提出調整，而且只調整「下兩週」的課表；不要重排整份計畫。
- adjustments 中 session_id 必須來自「接下來的課表」清單；field 只能是 type / target_distance_m / target_pace_sec_km / scheduled_date / note。
- 沒有需要調整就回空陣列。`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "本週總結，3〜6 句，繁體中文" },
    adjustments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          field: {
            type: "string",
            enum: ["type", "target_distance_m", "target_pace_sec_km", "scheduled_date", "note"],
          },
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

function pace(sec: number | null | undefined): string {
  if (!sec) return "-";
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}/km`;
}

function sessionLine(s: PlannedSessionRow): string {
  const km = s.target_distance_m ? `${(s.target_distance_m / 1000).toFixed(1)} km` : "-";
  return `- ${s.scheduled_date} [${s.type}] ${km} @ ${pace(s.target_pace_sec_km)} id=${s.id}${s.note ? ` — ${s.note}` : ""}`;
}

function activityLine(a: WeeklyReviewInput["activities"][number]): string {
  const d = new Date(a.start_time).toISOString().slice(0, 10);
  const km = (a.distance_m / 1000).toFixed(2);
  const matched = a.session_id ? `配對 session=${a.session_id}` : `未配對(${a.match_status})`;
  return `- ${d} ${km} km, ${Math.round(a.moving_time_sec / 60)} min, ${pace(a.avg_pace_sec_km)}, HR ${a.avg_hr ?? "-"}; ${matched}`;
}

export function buildPrompt(input: WeeklyReviewInput): string {
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
    "## 本週實際跑步（Strava）",
    input.activities.length ? input.activities.map(activityLine).join("\n") : "（本週沒有任何跑步紀錄）",
    "",
    "## 接下來的課表（可調整的對象）",
    input.upcoming.length ? input.upcoming.map(sessionLine).join("\n") : "（無）",
    "",
    "請給出本週總結與（如有必要的）調整建議。",
  ].join("\n");
}

function extractJson(text: string): WeeklyReviewResult {
  const start = text.indexOf("{");
  const endIdx = text.lastIndexOf("}");
  if (start < 0 || endIdx < 0) throw new Error(`Claude returned no JSON: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text.slice(start, endIdx + 1)) as Partial<WeeklyReviewResult>;
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    adjustments: Array.isArray(parsed.adjustments) ? parsed.adjustments : [],
  };
}

export async function weeklyReview(input: WeeklyReviewInput): Promise<WeeklyReviewResult & { model: string }> {
  const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: "user", content: buildPrompt(input) }],
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude refused: ${JSON.stringify(response.stop_details)}`);
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return { ...extractJson(text), model: response.model };
}
