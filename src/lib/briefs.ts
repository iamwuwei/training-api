import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient, coachModel } from "./claude";
import { COACH_NAME } from "./coach";
import { query } from "./db";
import type { PlannedSessionRow } from "../types";

// Woo's one line per upcoming session ("第 1 趟當熱身，從第 2 趟才用力"): the note
// boiled down to what to remember, stored on planned_sessions.brief. Written by the
// worker for the next two weeks when GET /plan finds sessions without one, and
// rewritten after each weekly review.

const BRIEF_SYSTEM = `你是 ${COACH_NAME}，一位務實的馬拉松教練。替接下來兩週的每一堂課寫一句話，跑者出門前看的那一句。

- 一句繁體中文，25 字以內，只講這堂課最重要的一件事：怎麼跑、要留意什麼、或為什麼這樣排。備註有內容就從備註濃縮；備註空的就從課表內容和階段來寫。
- 休息日寫為什麼要休（例如「明天長跑，今天腿要完全放鬆」）；肌力日寫要留腿給哪堂課。
- 不要重複課表已經寫的數字（距離、配速）；不要問候；不要「加油」。
- 每一堂都要有，回傳 session_id 與 brief。`;

const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    briefs: {
      type: "array",
      items: {
        type: "object",
        properties: { session_id: { type: "string" }, brief: { type: "string" } },
        required: ["session_id", "brief"],
        additionalProperties: false,
      },
    },
  },
  required: ["briefs"],
  additionalProperties: false,
} as const;

/** Write briefs for the active plan's sessions between `from` and `to`; existing ones are kept unless `force`. */
export async function writeBriefs(userId: string, from: string, to: string, force = false): Promise<number> {
  const sessions = await query<PlannedSessionRow & { phase_focus: string | null }>(
    `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date, w.focus as phase_focus
       from planned_sessions ps join plans p on p.id = ps.plan_id
       left join plan_weeks w on w.plan_id = ps.plan_id and ps.scheduled_date between w.week_start and w.week_end
      where p.user_id = $1 and p.status = 'active' and ps.superseded = false and ps.scheduled_date between $2 and $3
        ${force ? "" : "and ps.brief is null"}
      order by ps.scheduled_date`,
    [userId, from, to],
  );
  if (!sessions.length) return 0;
  const user = sessions.map((s) =>
    `- ${s.scheduled_date} id=${s.id} [${s.label ?? s.type}] ${s.content ?? ""}${s.target ? `，目標 ${s.target}` : ""}${s.phase ? `，${s.phase}` : ""}${s.phase_focus ? `（本週重點：${s.phase_focus}）` : ""}${s.note ? `\n  備註：${s.note}` : ""}`,
  ).join("\n");
  const client = anthropicClient();
  const res = await client.messages.create({
    model: coachModel(), max_tokens: 2000, system: BRIEF_SYSTEM,
    output_config: { effort: "low" as const, format: { type: "json_schema", schema: BRIEF_SCHEMA } },
    messages: [{ role: "user", content: user }],
  });
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { briefs?: { session_id: string; brief: string }[] };
  const allowed = new Set(sessions.map((s) => s.id));
  let n = 0;
  for (const b of data.briefs ?? []) {
    if (!allowed.has(b.session_id) || typeof b.brief !== "string" || !b.brief.trim()) continue;
    await query("update planned_sessions set brief = $2 where id = $1", [b.session_id, b.brief.trim().slice(0, 60)]);
    n++;
  }
  console.log(`briefs: wrote ${n}/${sessions.length} for user ${userId} (${from}〜${to})`);
  return n;
}
