import Anthropic from "@anthropic-ai/sdk";
import { coachModel } from "./claude";
import { COACH_NAME, postCoachMessage } from "./coach";
import { query, queryOne } from "./db";
import type { PlannedSessionRow, RoutineItem, SessionRoutineRow } from "../types";

// A 肌力 day. The athlete says where (home / gym); the worker asks Woo for a 6〜8
// item checklist that fits the session's note (what to spare for the next runs),
// the place, and what the last routine was. Ticking and completing are plain
// updates; completion posts one line from Woo in the thread, no review.

const ROUTINE_SYSTEM = `你是 ${COACH_NAME}，一位務實的馬拉松教練，替跑者開今天的肌力菜單。

規則：
- 6〜8 個動作，依序做。每個動作一行名稱含組數次數（例如「平板支撐 3 × 40 秒」「單腳硬舉（徒手）每邊 2 × 10」），以及一行 25 字內的做法（姿勢、重點、常見錯誤），給沒練過的人看得懂。
- 以跑者為對象：核心、臀、單腳穩定、小腿為主，不練到大腿力竭。課表備註說要留腿給哪幾堂課，就避開會讓腿痠超過一天的動作和重量。
- 在家只用徒手或椅子、牆、毛巾；健身房可以用啞鈴、壺鈴、滑輪、器械，但重量保守。
- 總時間照課表（通常 15〜20 分），rules 寫一行總則：組間休息幾秒、動作之間幾秒、全程 RPE 範圍。
- 上一次的菜單給了的話，換 2〜3 個動作，不要整份一樣；跑者上次 RPE 太高或說哪裡痠，就把那一類減量。
- 繁體中文，不要前言、不要解釋。`;

const ROUTINE_SCHEMA = {
  type: "object",
  properties: {
    minutes: { type: "integer" },
    rules: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, how: { type: "string" } },
        required: ["name", "how"],
        additionalProperties: false,
      },
    },
  },
  required: ["minutes", "rules", "items"],
  additionalProperties: false,
} as const;

/** When the model is unavailable: a sensible 15-minute list so the day still works. */
export function stockRoutine(place: "home" | "gym"): { minutes: number; rules: string; items: RoutineItem[] } {
  const items: RoutineItem[] = place === "home"
    ? [
        { name: "平板支撐 3 × 40 秒", how: "手肘在肩膀下，臀部夾緊，身體一直線，不要塌腰。", done: false },
        { name: "側棒式 每邊 2 × 30 秒", how: "手肘撐地，骨盆抬高不下沉，眼睛看前方。", done: false },
        { name: "臀橋 3 × 15", how: "仰躺屈膝，腳跟推地把臀部抬到跟身體一直線，頂端停 1 秒。", done: false },
        { name: "單腳硬舉（徒手）每邊 2 × 10", how: "單腳站，上身往前傾、另一腳往後伸，背打直，感覺後側臀腿。", done: false },
        { name: "死蟲式 3 × 10", how: "仰躺手腳朝天，對側手腳慢慢伸長到接近地面，腰貼地，再換邊。", done: false },
        { name: "小腿提踵 2 × 20", how: "站台階邊緣，慢慢踮起再放到比台階低，全程控制。", done: false },
      ]
    : [
        { name: "平板支撐 3 × 40 秒", how: "手肘在肩膀下，臀部夾緊，身體一直線，不要塌腰。", done: false },
        { name: "滑輪抗旋轉推 每邊 2 × 10", how: "側身對滑輪，雙手持把手往前推直，身體不被拉轉。", done: false },
        { name: "壺鈴臀橋 3 × 12", how: "壺鈴放在骨盆上，腳跟推地抬臀，頂端夾緊臀部。", done: false },
        { name: "啞鈴單腳硬舉 每邊 2 × 8", how: "輕啞鈴，單腳站、上身前傾、背打直，慢下快上。", done: false },
        { name: "分腿蹲（輕負重）每邊 2 × 8", how: "前後腳站開，後膝往地面降，前膝不超過腳尖，重量保守。", done: false },
        { name: "站姿提踵（器械或啞鈴）2 × 15", how: "腳跟慢慢降低再踮高，頂端停 1 秒。", done: false },
        { name: "鳥狗式 2 × 10", how: "四足跪，對側手腳伸直，腰不轉、不拱。", done: false },
      ];
  return { minutes: 15, rules: "組間休息 45 秒 · 動作之間 1 分鐘 · 全程 RPE 6〜7", items };
}

/** Worker: fill one pending routine. Never fails the flow: on a model error the stock list is written. */
export async function writeRoutine(userId: string, routineId: string): Promise<void> {
  const r = await queryOne<SessionRoutineRow>("select * from session_routines where id = $1 and user_id = $2", [routineId, userId]);
  if (!r || r.status !== "pending") return; // gone, or already written (SQS redelivery)
  const session = await queryOne<PlannedSessionRow>("select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions where id = $1", [r.session_id]);
  if (!session) { await query("update session_routines set status = 'failed', error = 'session not found' where id = $1", [r.id]); return; }

  try {
    const around = await query<PlannedSessionRow>(
      `select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions
        where plan_id = $1 and superseded = false and scheduled_date between $2::date + 1 and $2::date + 3 order by scheduled_date`,
      [session.plan_id, session.scheduled_date],
    );
    const last = await queryOne<SessionRoutineRow>(
      `select * from session_routines where user_id = $1 and id <> $2 and status = 'ready' order by created_at desc limit 1`,
      [userId, r.id],
    );
    const user = [
      `今天 ${session.scheduled_date}，${r.place === "home" ? "在家" : "健身房"}。`,
      `課表：${session.content ?? session.label ?? "肌力"}${session.note ? `，備註：${session.note}` : ""}`,
      around.length ? `接下來幾天：${around.map((s) => `${s.scheduled_date.slice(5)} ${s.label ?? s.type} ${s.content ?? ""}`).join("；")}` : "",
      last ? `上一次（${new Date(last.created_at).toISOString().slice(0, 10)}，${last.place === "home" ? "在家" : "健身房"}）：${last.items.map((i) => `${i.name}${i.done ? "" : "（沒做）"}`).join("、")}${last.rpe ? `，RPE ${last.rpe}` : ""}${last.note ? `，他說：${last.note}` : ""}` : "上一次：沒有紀錄，這是第一份。",
    ].filter(Boolean).join("\n");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: coachModel(), max_tokens: 1500, system: ROUTINE_SYSTEM,
      output_config: { effort: "low" as const, format: { type: "json_schema", schema: ROUTINE_SCHEMA } },
      messages: [{ role: "user", content: user }],
    });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { minutes?: number; rules?: string; items?: { name: string; how: string }[] };
    const items: RoutineItem[] = (data.items ?? []).filter((i) => typeof i.name === "string" && i.name.trim()).slice(0, 8)
      .map((i) => ({ name: i.name.trim(), how: typeof i.how === "string" && i.how.trim() ? i.how.trim() : null, done: false }));
    if (items.length < 4) throw new Error(`too few items (${items.length})`);
    await query(
      `update session_routines set status = 'ready', minutes = $2, rules = $3, items = $4, model = $5, error = null where id = $1`,
      [r.id, Number.isFinite(data.minutes) ? Math.round(data.minutes!) : null, typeof data.rules === "string" ? data.rules : null, JSON.stringify(items), res.model],
    );
  } catch (err) {
    console.warn(`routine ${r.id}: model failed, using the stock list`, err);
    const stock = stockRoutine(r.place);
    await query(
      `update session_routines set status = 'ready', minutes = $2, rules = $3, items = $4, model = null, error = $5 where id = $1`,
      [r.id, stock.minutes, stock.rules, JSON.stringify(stock.items), (err instanceof Error ? err.message : String(err)).slice(0, 300)],
    );
  }
}

/** Woo's one line after the athlete completes the checklist (template; no model, no review). */
export async function postRoutineDone(userId: string, r: SessionRoutineRow, session: PlannedSessionRow): Promise<void> {
  const done = r.items.filter((i) => i.done).length;
  const next = await queryOne<PlannedSessionRow>(
    `select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions
      where plan_id = $1 and superseded = false and scheduled_date > $2 and type <> 'rest' order by scheduled_date limit 1`,
    [session.plan_id, session.scheduled_date],
  );
  const km = next?.target_distance_m ? ` ${Math.round(next.target_distance_m / 100) / 10} km` : "";
  const when = next ? (next.scheduled_date === addDays(session.scheduled_date, 1) ? "明天" : next.scheduled_date.slice(5).replace("-", "/")) : null;
  const tail = next && when
    ? `${when}${next.label ?? next.type}${km}，${r.rpe && r.rpe >= 8 ? "腿要是還痠就放慢，不用追配速。" : "腿留一點給它。"}`
    : "明天如果腿痠超過一天，下次我減量。";
  const text = `肌力 ${done}/${r.items.length} 項做完${r.rpe ? `，RPE ${r.rpe}` : ""}${r.note ? `，${r.note.replace(/[。.]$/, "")}` : ""}。${tail}`;
  await postCoachMessage({ user_id: userId, role: "coach", kind: "chat", text, meta: { routine_id: r.id } });
}

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
