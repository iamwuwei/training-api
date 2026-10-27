// The proposal card as the model writes it: the JSON schema (structured output) and
// the rules in words, shared by Woo's chat reply (coach.ts) and the weekly review
// (claude.ts). No imports: both of those files, and proposals.ts, can take it.

/** Length limits the api enforces on the model's strings (proposals.ts rejects a card over them). */
export const LIMITS = {
  reason: 80,
  basis_text: 400,
  impact: 300,
  option_title: 30,
  phase: 60,
  focus: 150,
  session_label: 30,
  session_note: 200,
  basis_item: 80,
  why: 300,
  changes: 16,
  weeks: 8,
} as const;

// Why plain strings, with "" for "none": the API's structured outputs allow at most 16
// union-typed parameters (type arrays / anyOf) in a schema, past that it answers 400
// "Schema is too complex for compilation". proposals.ts reads "" as nothing (text() || null).
const NEW_SESSION_SCHEMA = {
  type: ["object", "null"],
  description: "op = add 時填新課；其他 op 給 null",
  properties: {
    scheduled_date: { type: "string", description: "YYYY-MM-DD" },
    type: { type: "string", enum: ["easy", "long", "tempo", "interval", "rest"] },
    label: { type: "string", description: "課表上的類型名，例如 Easy / Long / MP / 休息" },
    target_distance_m: { type: ["number", "null"] },
    target_pace_sec_km: { type: ["number", "null"] },
    note: { type: "string", description: "沒有備註給空字串" },
  },
  required: ["scheduled_date", "type", "label", "target_distance_m", "target_pace_sec_km", "note"],
  additionalProperties: false,
} as const;

/** One card. The reply schema has an array of up to two (A/B); the weekly schema the same. */
export const CARD_SCHEMA = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["change", "add", "remove"] },
          session_id: { type: ["string", "null"], description: "change / remove：briefing 課表清單裡的 id；add 給 null" },
          field: { type: ["string", "null"], enum: ["type", "target_distance_m", "target_pace_sec_km", "scheduled_date", "note", "skip", null], description: "op = change 才填" },
          old: { type: ["string", "number", "null"] },
          new: { type: ["string", "number", "null"] },
          new_session: NEW_SESSION_SCHEMA,
          reason: { type: "string", description: `一句，${LIMITS.reason} 字內；add / remove 必填，純欄位改動沒有就給空字串` },
        },
        required: ["op", "session_id", "field", "old", "new", "new_session", "reason"],
        additionalProperties: false,
      },
    },
    weeks: {
      type: "array",
      description: "要改的週描述；只放這張卡有動到課的週，不改的欄位給空字串",
      items: {
        type: "object",
        properties: {
          week_no: { type: "integer" },
          phase: { type: "string", description: "不改給空字串" },
          focus: { type: "string", description: "不改給空字串" },
        },
        required: ["week_no", "phase", "focus"],
        additionalProperties: false,
      },
    },
    why: { type: "string", description: "一句話總結這張卡" },
    basis: { type: "array", items: { type: "string" }, description: "2〜4 個你看到的數字，只能是 briefing 裡有的" },
    basis_text: { type: "string", description: `依據一段：目標、現狀、採用的訓練原則，${LIMITS.basis_text} 字內` },
    impact: {
      type: "object",
      properties: {
        keep: { type: "string", description: `不調整會怎樣，${LIMITS.impact} 字內` },
        change: { type: "string", description: `調整後會怎樣，${LIMITS.impact} 字內` },
        risk: { type: "string", description: `什麼情況下會出問題、那時怎麼辦，${LIMITS.impact} 字內` },
      },
      required: ["keep", "change", "risk"],
      additionalProperties: false,
    },
    option_title: { type: "string", description: `兩張卡（A／B）時這條路的標題，${LIMITS.option_title} 字內；只有一張給空字串` },
    recommended: { type: "boolean", description: "兩張卡時你偏哪張；只有一張給 false" },
  },
  required: ["changes", "weeks", "why", "basis", "basis_text", "impact", "option_title", "recommended"],
  additionalProperties: false,
} as const;

/** The "記下來" object in a chat reply. */
export const CONSTRAINT_SCHEMA = {
  type: ["object", "null"],
  description: "他講到會影響之後排課的限制時才填，否則 null",
  properties: {
    text: { type: "string", description: "一句，60 字內，例如「11/21〜23 出國」" },
    start_date: { type: ["string", "null"], description: "YYYY-MM-DD；不知道或沒有給 null" },
    end_date: { type: ["string", "null"], description: "YYYY-MM-DD；沒有結束日（長期）給 null" },
    kind: { type: "string", enum: ["period", "fixed_day", "note"] },
    weekday: { type: ["integer", "null"], description: "kind = fixed_day 才填：0 = 週日 … 6 = 週六" },
  },
  required: ["text", "start_date", "end_date", "kind", "weekday"],
  additionalProperties: false,
} as const;

/** The card rules, for the system prompt of every call that may attach one. */
export const PROPOSAL_RULES = `課表的調整（提案卡）：你可以附提案卡，他按「採用整張」課表才會改；你自己不能改課表。
- 什麼時候附：他問到、或你看到明確理由（有事跑不了、受傷、連續漏課、明顯落後或超前）。閒聊不附。沒有提案 proposals 就是空陣列。
- 範圍：briefing「今天到比賽日的逐日課表」裡，今天之後到比賽日前一天的任何一堂，用那份清單的 id。比賽日那堂不能動、不能刪、也不能把別的課移到比賽日。「記住的限制」不能違反：固定日（每週某天不能動）的課不移日期；期間限制（出國、受傷）那幾天不排訓練。
- 先分析、再推薦：提案前先想清楚三件事——他的目標（目標時間、比賽日）、訓練方法（這個階段該練什麼、關鍵課的目的、長跑之間隔幾天、賽前 taper 幾週）、他的現狀（最近跑量、關鍵課完成度與判定、心拍、RPE、趨勢）。text 先講結論（哪天、為什麼、怎麼調）再接卡片；數字給數字。
- changes 每一條有 op：change（改既有的一堂：session_id、field、old、new）、add（新增一堂：session_id 給 null，new_session 填日期、type、label、距離、配速、備註）、remove（刪掉一堂：session_id）。field 只能是 type / target_distance_m / target_pace_sec_km / scheduled_date / note / skip（skip = 整堂改成休息，old / new 給 null）；target_distance_m 用公尺、target_pace_sec_km 用每公里秒數、日期用 YYYY-MM-DD；old 填目前的值。日期對調要兩條（各自一個 scheduled_date）。add 和 remove 一定要寫 reason（一句，${LIMITS.reason} 字內），連鎖的改動也各寫一句 reason；純粹的欄位改動 reason 給空字串。
- 連鎖調整一次給完：移了關鍵課，前後幾天的 Easy／休息、受影響那幾週的描述（weeks）全部放在同一張卡，不要留到下一張。weeks 只放這張卡有動到課的週，phase / focus 給新文字，不改的欄位給空字串。
- 依據與影響都要寫，空的系統會拒收整張卡。basis 是 2〜4 個 briefing 裡的數字；basis_text（${LIMITS.basis_text} 字內）講目標、現狀、你採用的訓練原則；impact 三段各 ${LIMITS.impact} 字內：keep（不調整會怎樣）、change（調整後會怎樣）、risk（什麼情況下這個安排會出問題、那時怎麼辦）。要講到對目標時間和課表備註裡 ★關卡判定的影響；有數字就給數字（峰值長跑距離、賽前恢復天數、受影響那幾週跑量前後）。
- 有真正的取捨（例如「32 km 後移」vs「32 km 縮成 26 km 不動日期」）才給 A／B 兩張卡（proposals 兩個元素，各自完整，各有 basis_text 與 impact），option_title 寫這條路是什麼（${LIMITS.option_title} 字內），你偏哪張就把那張 recommended 設 true；text 先用一段講兩條路的差別。沒有取捨就只給一張，option_title 給空字串、recommended 給 false。
- 警示（週跑量暴增、長跑突然拉長、減量週加量、賽前太長的長跑）系統會自己算好、掛在那一列，你不用寫；你只要讓整體安排合理。
- 所有字串都是純文字，不要用 markdown、不要放網址。`;
