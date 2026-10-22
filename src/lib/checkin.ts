import Anthropic from "@anthropic-ai/sdk";
import { coachModel } from "./claude";
import { COACH_NAME, postCoachMessage } from "./coach";
import { query, queryOne } from "./db";
import type { ActivityRow, CoachMessageRow, PlannedSessionRow } from "../types";

// Woo comes to the athlete after a run. When a Strava activity lands, he posts a
// `checkin` ("today's session is X — which activity was it?") with the day's
// activities as chips. The pick (POST /coach/checkins/{id}/pick) assigns the
// activity, posts the athlete's `pick`, and queues `coach_ask`: Woo's one-line
// follow-up question about how it felt. The athlete's answer (POST /coach/messages
// with answer_to) becomes the memo and triggers the review, whose verdict is the
// reply. Templates here, the model only for the question.

export const RUN_SPORTS = new Set(["Run", "TrailRun", "VirtualRun"]);
export const isRunSport = (sport: string | null | undefined) => !sport || RUN_SPORTS.has(sport);

const SPORT_NAMES: Record<string, string> = {
  Run: "跑步", TrailRun: "越野跑", VirtualRun: "跑步機", Walk: "走路", Hike: "健行", Ride: "騎車",
  VirtualRide: "騎車", Swim: "游泳", WeightTraining: "重訓", Workout: "運動", Crossfit: "Crossfit",
  HighIntensityIntervalTraining: "HIIT", Yoga: "瑜伽", Elliptical: "橢圓機", StairStepper: "爬梯機",
};
export const sportName = (sport: string | null | undefined) => (sport ? SPORT_NAMES[sport] ?? sport : "跑步");

function pace(sec: number | null | undefined): string | null {
  if (!sec) return null;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}/km`;
}
const timeJst = (d: Date) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(11, 16);

export type ActivityLite = Pick<ActivityRow, "id" | "sport_type" | "start_time" | "distance_m" | "moving_time_sec" | "avg_pace_sec_km" | "avg_hr" | "max_hr">;

/** "跑步 06:40 · 7.02 km · 7:25/km" / "重訓 18:30 · 58 分 · 心拍 152" — the chip text. */
export function activityLabel(a: ActivityLite): string {
  const run = isRunSport(a.sport_type);
  const parts = [`${sportName(a.sport_type)} ${timeJst(new Date(a.start_time))}`];
  if (run || a.distance_m > 0) parts.push(`${(a.distance_m / 1000).toFixed(2)} km`);
  else parts.push(`${Math.round(a.moving_time_sec / 60)} 分`);
  if (run && a.avg_pace_sec_km) parts.push(pace(a.avg_pace_sec_km)!);
  else if (a.avg_hr != null) parts.push(`心拍 ${a.avg_hr}`);
  return parts.join(" · ");
}

export function sessionLabel(s: PlannedSessionRow): string {
  const km = s.target_distance_m ? ` ${Math.round(s.target_distance_m / 100) / 10} km` : "";
  return `${s.label ?? s.type}${km}`;
}

const isStrength = (s: PlannedSessionRow) => s.type === "rest" && /肌力|重訓|Hyrox/i.test(s.label ?? "");
const isRestDay = (s: PlannedSessionRow) => s.type === "rest" && !isStrength(s);
/** A run fulfils a running session; a gym session only a 肌力 day. */
function kindMatches(a: ActivityLite, s: PlannedSessionRow): boolean {
  return isRunSport(a.sport_type) ? s.type !== "rest" : isStrength(s);
}

export interface CheckinMeta {
  state: "open" | "picked" | "dismissed";
  mode: "activity" | "session";            // chips are activities (today's session known) or sessions (rest day)
  date: string;
  session_id: string | null;
  session_label: string | null;
  candidates: { activity_id?: string; session_id?: string; label: string }[];
  picked?: { activity_id: string; session_id: string } | null;
}

/**
 * Called by the worker for a newly inserted, unassigned activity. Posts (or
 * refreshes) Woo's check-in for that day; silent when nothing on the plan fits.
 */
export async function maybeCheckin(userId: string, a: ActivityLite, localDate: string): Promise<void> {
  const today = await queryOne<PlannedSessionRow & { done: boolean }>(
    `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
            exists (select 1 from activities x where x.session_id = ps.id and x.match_status <> 'ignored') as done
       from planned_sessions ps join plans p on p.id = ps.plan_id
      where p.user_id = $1 and p.status = 'active' and ps.superseded = false and ps.scheduled_date = $2
      limit 1`,
    [userId, localDate],
  );
  if (!today) return;

  let meta: CheckinMeta;
  let text: string;

  if (!isRestDay(today)) {
    if (today.done || !kindMatches(a, today)) return;
    // Every unassigned activity of the day of the right kind is a candidate; the
    // newest is Woo's guess (first chip).
    const rows = await query<ActivityLite>(
      `select id, sport_type, start_time, distance_m, moving_time_sec, avg_pace_sec_km, avg_hr, max_hr
         from activities where user_id = $1 and session_id is null and match_status <> 'ignored'
          and (start_time at time zone 'Asia/Tokyo')::date = $2 order by start_time desc`,
      [userId, localDate],
    );
    const acts = rows.filter((x) => kindMatches(x, today));
    if (!acts.length) return;
    const label = sessionLabel(today);
    const content = today.content && today.content !== label ? `：${today.content}` : "";
    text = acts.length === 1
      ? `今天的課是 ${label}${content}。Strava 剛進來一個活動，是這趟嗎？`
      : `今天的課是 ${label}${content}。Strava 剛進來 ${acts.length} 個活動，哪一個是這堂？`;
    meta = { state: "open", mode: "activity", date: localDate, session_id: today.id, session_label: label,
      candidates: acts.map((x) => ({ activity_id: x.id, label: activityLabel(x) })) };
  } else {
    // Rest day with an activity: which of this week's open sessions should it count for?
    const week = await queryOne<{ week_start: string; week_end: string }>(
      `select to_char(week_start, 'YYYY-MM-DD') as week_start, to_char(week_end, 'YYYY-MM-DD') as week_end
         from plan_weeks where plan_id = $1 and $2 between week_start and week_end`,
      [today.plan_id, localDate],
    );
    if (!week) return;
    const open = (await query<PlannedSessionRow>(
      `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date
         from planned_sessions ps
        where ps.plan_id = $1 and ps.superseded = false and ps.scheduled_date between $2 and $3
          and not exists (select 1 from activities x where x.session_id = ps.id and x.match_status <> 'ignored')
        order by abs(ps.scheduled_date - $4::date), ps.scheduled_date`,
      [today.plan_id, week.week_start, week.week_end, localDate],
    )).filter((s) => kindMatches(a, s));
    if (!open.length) return;
    text = `今天是休息日，Strava 剛進來 ${activityLabel(a)}。要算這週的哪一堂，還是不算？`;
    meta = { state: "open", mode: "session", date: localDate, session_id: null, session_label: null,
      candidates: open.map((s) => ({ session_id: s.id, label: `${s.scheduled_date.slice(5).replace("-", "/")} ${sessionLabel(s)}` })) };
  }

  // One open check-in per day: refresh it rather than stacking a second one.
  const existing = await queryOne<CoachMessageRow>(
    `select * from coach_messages where user_id = $1 and kind = 'checkin' and meta->>'state' = 'open' and meta->>'date' = $2
      order by created_at desc limit 1`,
    [userId, localDate],
  );
  if (existing) {
    await query("update coach_messages set text = $2, meta = $3, created_at = now() where id = $1", [existing.id, text, JSON.stringify(meta)]);
    return;
  }
  await postCoachMessage({ user_id: userId, role: "coach", kind: "checkin", text, meta: meta as unknown as Record<string, unknown>, activity_id: a.id });
}

// ---- the follow-up question --------------------------------------------------

const ASK_SYSTEM = `你是 ${COACH_NAME}，一位務實的馬拉松教練。跑者剛把一趟活動配到今天課表的這堂課，你要接著問他感受。

寫 1〜2 句繁體中文：先用半句確認收到（可以提一個最值得注意的數字，例如 MP 段配速或最高心拍），再問一個跟這堂課型有關、他只能憑身體感受回答的問題。MP 問心拍撐不撐得住、長跑問後半腿、Easy／恢復跑問有沒有真的放鬆、坡跑問上坡的腿和下坡有沒有慢、肌力問哪裡最痠。

不要判定好壞、不要給建議、不要問候、不要條列。像教練在對話。`;

function fallbackQuestion(s: PlannedSessionRow): string {
  const l = s.label ?? "";
  if (/MP|節奏|tempo/i.test(l) || s.type === "tempo") return "收到。MP 段心拍撐得住嗎？腿現在怎麼樣？";
  if (/Long|長跑/i.test(l) || s.type === "long") return "收到。後半段腿還有力嗎，有沒有想停？";
  if (/坡|interval|快步/i.test(l) || s.type === "interval") return "收到。上坡的腿還好嗎？下坡有真的放慢嗎？";
  if (isStrength(s)) return "收到。哪裡最痠？明天跑步腿會不會有影響？";
  return "收到。今天有真的放鬆嗎？腿感覺怎麼樣？";
}

/**
 * Worker: answer a `pick` with Woo's question (`ask`). Never fails the flow: on a
 * model error the type's stock question is posted instead.
 */
export async function askAboutActivity(userId: string, pickMessageId: string): Promise<void> {
  const pick = await queryOne<CoachMessageRow>("select * from coach_messages where id = $1 and user_id = $2 and kind = 'pick'", [pickMessageId, userId]);
  if (!pick || pick.status === "sent") return; // unknown, or already asked (SQS redelivery)
  const meta = (pick.meta ?? {}) as { activity_id?: string; session_id?: string };
  const session = meta.session_id ? await queryOne<PlannedSessionRow>("select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions where id = $1", [meta.session_id]) : undefined;
  const activity = meta.activity_id ? await queryOne<ActivityRow>("select * from activities where id = $1", [meta.activity_id]) : undefined;
  if (!session || !activity) { await query("update coach_messages set status = 'sent' where id = $1", [pick.id]); return; }

  let text = fallbackQuestion(session);
  try {
    const splits = (Array.isArray(activity.splits) ? (activity.splits as { split: number; distance: number; moving_time: number; average_heartrate?: number; elevation_difference?: number }[]) : [])
      .map((sp) => `${sp.split}: ${pace(Math.round(sp.moving_time / (sp.distance / 1000))) ?? "-"}${sp.average_heartrate ? ` HR ${Math.round(sp.average_heartrate)}` : ""}${sp.elevation_difference ? ` ${sp.elevation_difference > 0 ? "+" : ""}${Math.round(sp.elevation_difference)}m` : ""}`)
      .join("\n");
    const user = [
      `課表：${sessionLabel(session)}${session.content ? `：${session.content}` : ""}${session.target ? `，目標 ${session.target}` : ""}${session.note ? `，備註：${session.note}` : ""}`,
      `活動：${activityLabel(activity)}${activity.avg_hr != null ? `，平均心拍 ${activity.avg_hr}` : ""}${activity.max_hr != null ? `，最高 ${activity.max_hr}` : ""}`,
      splits ? `每公里：\n${splits}` : "",
    ].filter(Boolean).join("\n");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: coachModel(), max_tokens: 300, system: ASK_SYSTEM,
      output_config: { effort: "low" as const },
      messages: [{ role: "user", content: user }],
    });
    const out = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
    if (out) text = out;
  } catch (err) {
    console.warn(`ask question failed for pick ${pick.id}, using the stock question`, err);
  }
  await postCoachMessage({
    user_id: userId, role: "coach", kind: "ask", text, activity_id: activity.id,
    meta: { state: "open", activity_id: activity.id, session_id: session.id },
  });
  await query("update coach_messages set status = 'sent' where id = $1", [pick.id]);
}

/** After the review (or its failure) the athlete's pending answer about that activity is settled. */
export async function settleAthleteMessages(userId: string, activityId: string): Promise<void> {
  await query(
    "update coach_messages set status = 'sent' where user_id = $1 and role = 'athlete' and status = 'pending' and activity_id = $2",
    [userId, activityId],
  );
}
