import { type Querier, query } from "./db";
import { GROUP_DATE_JOIN, REVIEW_DAILY_LIMIT, reviewLimitReached } from "./session-group";
import { sessionLabel, shortDate } from "./labels";
import type { PlannedSessionRow } from "../types";

// The athlete tells Woo in the thread that a verdict is wrong ("課表是 7:10 啊"). Woo checks the plan; when he agrees he
// says so in the reply's `correction` object and the verdict is redone by the same worker path as every other re-judge.
// Nothing here writes a verdict: this file picks which session may be re-judged (api side, from the user's own rows),
// checks what the model said against that list, and keeps the record of the correction in coach_messages.meta:
//   athlete chat   meta.correction = { activity_id, note, at }                  (what he corrected, Woo's one-line fact)
//   Woo's reply    meta.correction = { activity_id, label, date, state }        (queued | done | failed | rejected)
//                  meta.correction_rejected = why the api refused (state rejected)
//   review message meta.corrected = { reason } (the verdict redone after a correction) / meta.superseded = true (replaced)
// Every query carries user_id; the activity id the model gives is compared with the list this file built, never used in SQL.

/** One session may be re-judged by a correction this many times per JST day. */
export const CORRECTIONS_PER_DAY = 2;
/** Woo is offered the sessions of this many days back (and the one the athlete quoted). */
export const CORRECTION_WINDOW_DAYS = 14;
/** At most this many sessions in Woo's list (newest first). */
export const CORRECTION_CANDIDATES = 5;
/** The athlete's message as it goes into a review prompt: at most this many characters (the same limit as the thread's input). */
export const CORRECTION_TEXT_MAX = 500;
/** Woo's one-line fact is stored at most this long. */
export const CORRECTION_NOTE_MAX = 200;
/** A review prompt carries the latest this many corrections of the session (the athlete's words are ≤ 500 characters each). */
export const CORRECTION_NOTES_IN_PROMPT = 3;
/** A correction still `queued` after this many minutes is shown as failed (the worker died between the review and the settle). */
export const CORRECTION_QUEUED_STALE_MIN = 10;
/** The capsule on the new review message shows the fact cut to this many characters. */
export const CORRECTION_REASON_MAX = 40;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The paragraph of Woo's system prompt about correcting a verdict. */
export const CORRECTION_RULES = `更正判定（correction）：「## 可更正的判定」列的是最近幾堂系統已經給過的判定（報告頁與這個對話串裡那則「跑完的判定」）。他指出判定裡的事實錯誤（課表的配速或距離被讀錯、數據有情況：停錶、上廁所、繞路、錶壞）、或明確要你更新報告／重判時：先對照 briefing 逐日課表或「已過的課」裡那堂的配速／距離。他說的對（或他說的情況屬實而且會改變判定的理由），就在 correction 填 action: "rejudge"、activity_id（清單裡那堂的 id）、note（一句話寫清楚更正後的事實，120 字內，純文字），text 裡承認錯在哪、說「我重判一次，報告頁和這裡都會更新」；text 裡不要自己寫新的判定或新的理由，新判定由系統重判後貼出來。他說的跟課表不符、或只是覺得判太嚴而沒有新的事實：action 給 "none"，用課表和他的數字說明你為什麼維持判定。他講的是哪一堂不清楚（清單裡有兩堂都像）：先問是哪一堂，action 給 "none"。一則回覆最多更正一堂。清單裡標「不能重判」的那堂不要填 rejudge，照它旁邊的原因回他（報告頁的「重新分析」他自己能按）。你不能說「報告頁的判定我改不了」。沒有要更正時 action 給 "none"、另外兩個欄位給空字串。`;

export type CorrectionWhy = "limit" | "daily" | "manual" | "queued";

export interface CorrectionCandidate {
  /** The session's primary activity (the review is on it). */
  activity_id: string;
  session_id: string;
  /** JST date of the session, 'YYYY-MM-DD'. */
  date: string;
  /** "Long 18 km". */
  label: string;
  verdict: string;
  reviewed_at: Date;
  eligible: boolean;
  /** Why it cannot be re-judged now; null when eligible. */
  why: CorrectionWhy | null;
}

interface CandidateRow {
  activity_id: string;
  session_id: string;
  label: string | null;
  type: PlannedSessionRow["type"];
  target_distance_m: number | null;
  date: string;
  verdict: string;
  source: "manual" | "claude";
  reviewed_at: Date;
  today_n: number;
  queued: boolean;
}

/**
 * The sessions Woo may re-judge: the user's own, not ignored, the primary activity of their session, with a finished
 * verdict, from the last CORRECTION_WINDOW_DAYS days or the one the message quotes or the one the thread's latest verdict
 * message is about; at most CORRECTION_CANDIDATES, the quoted one first, then the latest verdict's, then the rest newest first
 * (so neither can be pushed out of the list by the limit). The ones that cannot be re-judged now are listed too, with the reason (Woo must know why).
 */
export async function loadCorrectionCandidates(userId: string, _today: string, quotedActivityId: string | null): Promise<CorrectionCandidate[]> {
  const quoted = quotedActivityId && UUID_RE.test(quotedActivityId) ? quotedActivityId : null;
  // The session the thread's latest verdict message is about: what "這堂" most likely means when nothing is quoted.
  const lastVerdict = (await query<{ activity_id: string }>(
    "select activity_id from coach_messages where user_id = $1 and role = 'coach' and kind = 'review' and activity_id is not null order by created_at desc, id desc limit 1",
    [userId],
  ))[0]?.activity_id ?? null;
  const rows = await query<CandidateRow>(
    `select a.id as activity_id, a.session_id, ps.label, ps.type, ps.target_distance_m,
            to_char(coalesce(g.t0, a.start_time) at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as date,
            r.verdict, r.source, r.created_at as reviewed_at,
            (select count(*)::int from coach_messages m where m.user_id = a.user_id and m.role = 'athlete'
               and m.meta->'correction'->>'activity_id' = a.id::text
               and (m.created_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date) as today_n,
            exists (select 1 from coach_messages m where m.user_id = a.user_id and m.role = 'coach' and m.kind = 'chat'
               and m.meta->'correction'->>'activity_id' = a.id::text and m.meta->'correction'->>'state' = 'queued'
               and m.created_at > now() - ($5::int * interval '1 minute')) as queued
       from activities a${GROUP_DATE_JOIN}
       join planned_sessions ps on ps.id = a.session_id
       join reviews r on r.activity_id = a.id
      where a.user_id = $1 and a.match_status <> 'ignored' and r.verdict is not null
        and not exists (select 1 from activities x where x.session_id = a.session_id and x.user_id = a.user_id
                          and x.match_status <> 'ignored' and (x.start_time, x.id) < (a.start_time, a.id))
        and (a.start_time > now() - ($3::int * interval '1 day') or a.id = $2::uuid or a.id = $6::uuid)
      order by coalesce(a.id = $2::uuid, false) desc, coalesce(a.id = $6::uuid, false) desc, a.start_time desc limit $4`,
    [userId, quoted, CORRECTION_WINDOW_DAYS, CORRECTION_CANDIDATES, CORRECTION_QUEUED_STALE_MIN, lastVerdict],
  );
  const daily = await reviewLimitReached(userId); // the day's quota for every re-judge is used up: none of them can be
  return rows.map((r) => {
    const why: CorrectionWhy | null = daily ? "daily" : r.source !== "claude" ? "manual" : r.today_n >= CORRECTIONS_PER_DAY ? "limit" : r.queued ? "queued" : null;
    return {
      activity_id: r.activity_id, session_id: r.session_id, date: r.date,
      label: sessionLabel({ label: r.label, type: r.type, target_distance_m: r.target_distance_m }),
      verdict: r.verdict, reviewed_at: r.reviewed_at, eligible: why === null, why,
    };
  });
}

/** A time in JST: md "11/1" (no padding, for Woo's list), mmdd "11/01" (for the prompt's quote), hm "20:12". */
const jstStamp = (d: Date) => {
  const j = new Date(new Date(d).getTime() + 9 * 3600 * 1000).toISOString();
  return { md: `${Number(j.slice(5, 7))}/${Number(j.slice(8, 10))}`, mmdd: j.slice(5, 10).replace("-", "/"), hm: j.slice(11, 16) };
};

const WHY_TEXT: Record<CorrectionWhy, string> = {
  limit: `今天已更正 ${CORRECTIONS_PER_DAY} 次（請他到報告頁按「重新分析」或明天再說）`,
  daily: `今天重新分析的次數用完了（每天 ${REVIEW_DAILY_LIMIT} 次），明天再說`,
  manual: "手動判定（請他到報告頁改）",
  queued: "正在重判中（請他等一下）",
};

/** The "## 可更正的判定" block of Woo's per-message context (after the cache breakpoint). */
export function correctionSection(cands: CorrectionCandidate[]): string[] {
  return [
    `## 可更正的判定（最近 ${CORRECTION_WINDOW_DAYS} 天；他指出判定有錯時用這裡的 id）`,
    ...(cands.length
      ? cands.map((c) => {
          const t = jstStamp(c.reviewed_at);
          return `- id=${c.activity_id} ${shortDate(c.date)} ${c.label} → ${c.verdict}（${t.md} ${t.hm} 判定）${c.why ? `｜不能重判：${WHY_TEXT[c.why]}` : ""}`;
        })
      : ["（沒有）"]),
  ];
}

/** What the model put in `correction` (anything: it is checked before use). */
export interface RawCorrection { action?: unknown; activity_id?: unknown; note?: unknown }

export type CorrectionCheck =
  | { ok: true; activity_id: string; session_id: string; label: string; date: string; note: string }
  | { ok: false; reason: string; why: CorrectionWhy | "unknown" };

/**
 * Woo's one-line fact as stored: a single line of plain text, at most CORRECTION_NOTE_MAX characters (it goes into a
 * later prompt as "Woo 當時確認的事實", so no markdown, no control or invisible characters, no line that looks like a heading or quote).
 */
export function cleanNote(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[*`]/g, "")
    .trim()
    .replace(/^(?:[#>]\s*)+/, "")
    .trim()
    .slice(0, CORRECTION_NOTE_MAX)
    .trim();
}

/**
 * Check the model's `correction` against the list built from the user's own rows. The id is only looked up in that list.
 * action other than "rejudge" is `{ ok: false, reason: "action none" }` (the caller records a refusal only for "rejudge").
 */
export function validateCorrection(raw: RawCorrection, cands: CorrectionCandidate[]): CorrectionCheck {
  if (raw.action !== "rejudge") return { ok: false, reason: "action none", why: "unknown" };
  const id = typeof raw.activity_id === "string" ? raw.activity_id.trim() : "";
  if (!UUID_RE.test(id)) return { ok: false, reason: "invalid id", why: "unknown" };
  const cand = cands.find((c) => c.activity_id.toLowerCase() === id.toLowerCase());
  if (!cand) return { ok: false, reason: "not a candidate", why: "unknown" };
  if (!cand.eligible) return { ok: false, reason: cand.why ?? "queued", why: cand.why ?? "queued" };
  return { ok: true, activity_id: cand.activity_id, session_id: cand.session_id, label: cand.label, date: cand.date, note: cleanNote(raw.note) };
}

export interface CorrectionNote { at: string; text: string; note: string }

/** The latest CORRECTION_NOTES_IN_PROMPT corrections of the session (`activityIds` = its whole group, so a change of primary loses none), oldest first. */
export async function loadCorrectionNotes(userId: string, activityIds: string[], q: Querier = query): Promise<CorrectionNote[]> {
  if (!activityIds.length) return [];
  const rows = await q<{ text: string; note: string | null; created_at: Date }>(
    `select text, meta->'correction'->>'note' as note, created_at from coach_messages
      where user_id = $1 and role = 'athlete' and meta->'correction'->>'activity_id' = any($2::text[])
      order by created_at desc limit $3`,
    [userId, activityIds, CORRECTION_NOTES_IN_PROMPT],
  );
  return rows.reverse().map((r) => {
    const t = jstStamp(r.created_at);
    return { at: `${t.mmdd} ${t.hm}`, text: r.text, note: cleanNote(r.note) };
  });
}

/**
 * The verdict a correction waited for was written (done) or failed: Woo's reply that is still `queued` for these activities
 * gets the new state and loses its stage. n = how many replies were settled; note = the fact of the latest correction
 * (only looked up when n > 0), for the capsule of the new review message.
 */
export async function settleCorrection(userId: string, activityIds: string[], state: "done" | "failed", q: Querier = query): Promise<{ n: number; note: string | null }> {
  if (!activityIds.length) return { n: 0, note: null };
  const rows = await q<{ activity_id: string }>(
    `update coach_messages
        set meta = (meta - 'stage') || jsonb_build_object('correction', (meta->'correction') || jsonb_build_object('state', $3::text))
      where user_id = $1 and role = 'coach' and kind = 'chat'
        and meta->'correction'->>'activity_id' = any($2::text[]) and meta->'correction'->>'state' = 'queued'
      returning meta->'correction'->>'activity_id' as activity_id`,
    [userId, activityIds, state],
  );
  if (!rows.length) return { n: 0, note: null };
  const notes = await loadCorrectionNotes(userId, activityIds, q);
  return { n: rows.length, note: notes.length ? notes[notes.length - 1].note || null : null };
}

/** The review message `keepId` replaced the earlier ones of the same session: mark them (every re-judge, not only a correction). */
export async function supersedeReviewMessages(userId: string, activityIds: string[], keepId: string, q: Querier = query): Promise<void> {
  if (!activityIds.length) return;
  await q(
    `update coach_messages set meta = coalesce(meta, '{}'::jsonb) || '{"superseded":true}'::jsonb
      where user_id = $1 and kind = 'review' and activity_id = any($2::uuid[]) and id <> $3 and not (coalesce(meta, '{}'::jsonb) ? 'superseded')`,
    [userId, activityIds, keepId],
  );
}
