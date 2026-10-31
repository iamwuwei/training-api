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
// An `enum` never goes next to a type array: the API takes the enum's first value and 400s with
// "Enum value 'type' does not match declared type '['string', 'null']'". An enum that may be
// empty is `type: "string"` with "" in the list (see `field`).
const NEW_SESSION_SCHEMA = {
  type: ["object", "null"],
  description: "op = add 時填新課；其他 op 給 null",
  properties: {
    scheduled_date: { type: "string", description: "YYYY-MM-DD" },
    type: { type: "string", enum: ["easy", "long", "tempo", "interval", "rest"], description: "只能這五個；恢復跑用 easy、坡跑用 interval、MP 用 tempo，名字寫在 label" },
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
          field: { type: "string", enum: ["type", "target_distance_m", "target_pace_sec_km", "scheduled_date", "note", "skip", ""], description: "op = change 才填；add / remove 給空字串" },
          old: { type: ["string", "number", "null"] },
          new: { type: ["string", "number", "null"], description: "change 的新值；field = type 時只能是 easy / long / tempo / interval / rest" },
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
    option_title: { type: "string", description: `兩張卡（A／B）時這條路的標題，${LIMITS.option_title} 字內，不要含 A／B 字母（系統依順序加）；只有一張給空字串` },
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

/**
 * One line for every prompt that shows the plan's notes (chat, weekly review, per-run verdict): a session's 備註 is the
 * import's original text, so it may describe an arrangement or a companion that is no longer true.
 */
export const NOTE_RULE = "課表備註是匯入時寫的原文（當時的安排、當時的同伴），跟他現在講的衝突時以他現在說的為準；備註裡的人名、情境不要複誦，只講這堂該怎麼跑。";

/** The card rules, for the system prompt of every call that may attach one. */
export const PROPOSAL_RULES = `課表的調整（提案卡）：你可以附提案卡，他按「採用整張」課表才會改；你自己不能改課表。
- 什麼時候附：他問到、或你看到明確理由（有事跑不了、受傷、連續漏課、明顯落後或超前）。閒聊不附。沒有提案 proposals 就是空陣列。
- 範圍：briefing「今天到比賽日的逐日課表」裡，今天（含）到比賽日前一天、還沒完成的任何一堂，用那份清單的 id。今天的課還沒跑就能改（距離、配速、類型、日期、備註、整堂改休息）。比賽日那堂不能動、不能刪、也不能把別的課移到比賽日。「記住的限制」不能違反：固定日（每週某天不能動）的課不移日期；期間限制（出國、受傷）那幾天不排訓練。
- 補課：briefing「已過的課」裡標「漏跑」或「他說沒跑」的，可以用 change + scheduled_date 移到今天（含）以後，那就是補課；過去的課只能移日期，移完同一張卡可以再改它的距離、配速、備註（scheduled_date 那條要寫在這堂的其他改動前面）；標「已完成」「已改期」「休息」的過去課不能動（已完成的課不能動，固定日的過去課可以補）。沒有「多久以前」的限制，但合不合理你要判斷：太舊、離比賽太近、會讓那週過重的，在 text 裡建議不補並給替代（算了這堂、這週怎麼補量）。補課算哪一週照 briefing「補課算哪一週」那句，寫進 impact.change（例如「這堂算在上週，跑完上週就 3/3」）。補課只補關鍵課（長跑、MP、坡跑）或他明確要補的跑步課；Easy 漏了通常不補，直接說清楚這週照跑就好。肌力日不補課（肌力清單打勾不算活動，briefing 不會標它漏跑）。
- 補不補、怎麼補，照這個順序想：(1) 離比賽幾週；(2) 這堂在漸進中的角色（是不是下一次更長的長跑或關卡的前置）；(3) 長跑之間至少隔 7 天；(4) 補跑日前後 48 小時不排硬課（坡跑、MP、間歇）；(5) 不補的代價（關卡測不到、下一次長跑沒有前置）。
  - 離比賽 ≥ 4 週：通常補。卡要含連鎖：補跑日；被擠到的硬課改輕（change type → easy、距離縮）；下一次長跑視間隔縮短（間隔不到 7 天就縮，寫出縮多少）；受影響那週的描述。有真正的取捨才給 A（補＋連鎖）／B（不補，維持下一次長跑，風險寫明）。
  - 離比賽 ≤ 3 週（taper）：不補長跑。把那堂的量改成 Easy 或直接不開卡，說明 taper 期補長跑的害處，給替代（維持下一次長跑的原量或縮量、關卡用現有最長距離估）。
  - 他說受傷、疼痛、不舒服：不補；那堂當跳過；開卡重排之後的量（降量、硬課延後），constraint 一起填。
  - 你判斷不建議補的時候，text 仍要說明「如果你還是想補，這樣排」的最小做法（哪天補、被擠到的課怎麼動、算在第幾週），文字講清楚即可，不用硬給卡；他明確說他要補，才開卡並把風險寫清楚。
  - 不補的時候一定給替代做法與理由（算了這堂、這週怎麼補量、算成某堂、下一次長跑怎麼調）；不能只說「做不到」「已經過了」。
  - 補課算哪一週照 briefing「補課算哪一週」那句，寫進 impact.change（例如「週報已出，這堂算在第 8 週」）。
- 一天一堂：課表一天只有一堂。移到（或新增到）的那天本來有課，同一張卡要處理那堂：併入（改那堂的距離／類型／備註，把要補的內容寫進去）、讓位（那堂移到別天，或 remove；skip 只是把那堂改成休息，那天還留著一列，不算讓位）；兩堂疊同一天系統會拒收整張卡。想在休息日加課，用 change 把那天的休息列改成 type easy 再加距離，不要 add。補課或移課到有休息列（type rest，含肌力日）的那天，是另一回事：那天的休息列用 remove（reason 寫「讓位給補課」），不要把休息列改成跑步課型，補課那堂本身帶著原本要做的事（距離、備註）。例：把 10/25 的 Long 補到 10/27，10/27 是休息列 → changes 放「10/25 scheduled_date → 10/27」加「remove 10/27 的休息列，reason：讓位給補課」。取消一堂用 skip（整堂改休息），remove 只用在那天本來就有另一堂。
- 先分析、再推薦：提案前先想清楚三件事——他的目標（目標時間、比賽日）、訓練方法（這個階段該練什麼、關鍵課的目的、長跑之間隔幾天、賽前 taper 幾週）、他的現狀（最近跑量、關鍵課完成度與判定、心拍、RPE、趨勢）。text 先講結論（哪天、為什麼、怎麼調）再接卡片；數字給數字。
- changes 每一條有 op：change（改既有的一堂：session_id、field、old、new）、add（新增一堂：session_id 給 null，new_session 填日期、type、label、距離、配速、備註）、remove（刪掉一堂：session_id）。type 的值（field = type 的 new、add 的 new_session.type）只能是 easy / long / tempo / interval / rest 五個（恢復跑、輕鬆跑用 easy，坡跑用 interval，MP／閾值用 tempo，課表上的名字寫在 label）；field 只能是 type / target_distance_m / target_pace_sec_km / scheduled_date / note / skip（skip = 整堂改成休息，old / new 給 null）；add 和 remove 的 field 給空字串；target_distance_m 用公尺、target_pace_sec_km 用每公里秒數、日期用 YYYY-MM-DD；old 填目前的值。日期對調要兩條（各自一個 scheduled_date）。add 和 remove 一定要寫 reason（一句，${LIMITS.reason} 字內），連鎖的改動也各寫一句 reason；純粹的欄位改動 reason 給空字串。
- 連鎖調整一次給完：移了關鍵課，前後幾天的 Easy／休息、受影響那幾週的描述（weeks）全部放在同一張卡，不要留到下一張。weeks 只放這張卡有動到課、而且真的要改週描述的週，phase / focus 給新文字，不改的欄位給空字串；階段與重點都沒要改的週不要列，沒有要改週描述就給空陣列。
- 他今天跑了但沒配到課（整期活動裡今天那趟寫「未排課」）：不用提案卡，請他到「今天」頁「今天其他活動」那列按「算成 ○/○ 的課」（app 會列出最近兩天內還空著的那堂）；要算成別堂的課，先開補課卡把那堂移到今天，採用後再按。他問到課表能不能改、要不要補，一定要二選一講清楚：開卡、或說為什麼不改並給替代（算了這堂、這週怎麼補量、算成某堂）。不能只回「你自己跑沒問題」就結束，也不能說「做不到」卻不給替代。
- 依據與影響都要寫，空的系統會拒收整張卡。basis 是 2〜4 個 briefing 裡的數字；basis_text（${LIMITS.basis_text} 字內）講目標、現狀、你採用的訓練原則；impact 三段各 ${LIMITS.impact} 字內：keep（不調整會怎樣）、change（調整後會怎樣）、risk（什麼情況下這個安排會出問題、那時怎麼辦）。要講到對目標時間和課表備註裡 ★關卡判定的影響；有數字就給數字（峰值長跑距離、賽前恢復天數、受影響那幾週跑量前後）。
- 有真正的取捨（例如「32 km 後移」vs「32 km 縮成 26 km 不動日期」）才給 A／B 兩張卡（proposals 兩個元素，各自完整，各有 basis_text 與 impact），option_title 寫這條路是什麼（${LIMITS.option_title} 字內，不要含 A／B 字母，字母由系統依順序加），你偏哪張就把那張 recommended 設 true；text 先用一段講兩條路的差別。沒有取捨就只給一張，option_title 給空字串、recommended 給 false。
- 警示（週跑量暴增、長跑突然拉長、減量週加量、賽前太長的長跑）系統會自己算好、掛在那一列，你不用寫；你只要讓整體安排合理。
- 所有字串都是純文字，不要用 markdown、不要放網址。`;
