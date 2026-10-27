import { query } from "./db";
import { isValidDate, shortDate } from "./labels";
import type { ConstraintRow, RawConstraint } from "../types";

// What the athlete told Woo that later plans must respect. Woo proposes one in his
// reply (status proposed); the athlete accepts it (active) or says no (dismissed).
// Only active ones that have not expired go into the prompts.

export const CONSTRAINT_TEXT_MAX = 60;
const KINDS = new Set<string>(["period", "fixed_day", "note"]);

const CONSTRAINT_SELECT = `select id, user_id, text, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date,
  kind, weekday, source_message_id, status, created_at, decided_at from constraints`;

/** 0 = Sunday … 6 = Saturday, the same numbering as Date#getUTCDay and Postgres' dow. */
export const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];
export const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** Active and not expired at `today`: what the prompts see. */
export const isLive = (c: Pick<ConstraintRow, "status" | "end_date">, today: string) => c.status === "active" && (c.end_date == null || c.end_date >= today);

export async function loadLiveConstraints(userId: string, today: string): Promise<ConstraintRow[]> {
  return query<ConstraintRow>(
    `${CONSTRAINT_SELECT} where user_id = $1 and status = 'active' and (end_date is null or end_date >= $2) order by created_at`,
    [userId, today],
  );
}

/** Every active one, expired included (the settings page marks those 已過期 itself). */
export async function loadActiveConstraints(userId: string): Promise<ConstraintRow[]> {
  return query<ConstraintRow>(`${CONSTRAINT_SELECT} where user_id = $1 and status = 'active' order by created_at`, [userId]);
}

export async function constraintsByIds(userId: string, ids: string[]): Promise<ConstraintRow[]> {
  if (!ids.length) return [];
  return query<ConstraintRow>(`${CONSTRAINT_SELECT} where user_id = $1 and id = any($2::uuid[])`, [userId, ids]);
}

/** Weekdays (0–6) the athlete said cannot move: a session on one of them keeps its date. */
export function fixedWeekdays(cs: Pick<ConstraintRow, "kind" | "weekday">[]): Set<number> {
  return new Set(cs.filter((c) => c.kind === "fixed_day" && c.weekday != null).map((c) => c.weekday as number));
}

/** "11/21〜11/23" / "到 11/23 為止" / "11/21 起" / "長期". */
export function periodText(c: Pick<ConstraintRow, "start_date" | "end_date">): string {
  if (c.start_date && c.end_date) return c.start_date === c.end_date ? shortDate(c.start_date) : `${shortDate(c.start_date)}〜${shortDate(c.end_date)}`;
  if (c.end_date) return `到 ${shortDate(c.end_date)} 為止`;
  if (c.start_date) return `${shortDate(c.start_date)} 起`;
  return "長期";
}

/** One line of the briefing. */
export function constraintLine(c: Pick<ConstraintRow, "text" | "start_date" | "end_date" | "kind" | "weekday">): string {
  const fixed = c.kind === "fixed_day" && c.weekday != null ? `（固定日：每週${WEEKDAY_ZH[c.weekday]}，這天的課不能移到別天）` : "";
  return `- ${periodText(c)}｜${c.text}${fixed}`;
}

/**
 * The model's "記下來" object as a row to store, or a string saying why it is dropped.
 * Dropping it never touches the reply text.
 */
export function validateConstraint(raw: RawConstraint | null | undefined, today: string): Pick<ConstraintRow, "text" | "start_date" | "end_date" | "kind" | "weekday"> | string {
  if (!raw || typeof raw !== "object") return "no constraint";
  const text = typeof raw.text === "string" ? raw.text.trim().replace(/\s+/g, " ") : "";
  if (!text) return "empty text";
  if (text.length > CONSTRAINT_TEXT_MAX) return `text longer than ${CONSTRAINT_TEXT_MAX}`;
  const kind = typeof raw.kind === "string" && KINDS.has(raw.kind) ? (raw.kind as ConstraintRow["kind"]) : null;
  if (!kind) return `kind ${String(raw.kind)}`;
  const date = (v: unknown): string | null | undefined => (v == null || v === "" ? null : typeof v === "string" && isValidDate(v) ? v : undefined);
  const start = date(raw.start_date), end = date(raw.end_date);
  if (start === undefined || end === undefined) return "bad date";
  if (start && end && start > end) return "start after end";
  if (end && end < today) return "already over";
  let weekday: number | null = null;
  if (kind === "fixed_day") {
    if (typeof raw.weekday !== "number" || !Number.isInteger(raw.weekday) || raw.weekday < 0 || raw.weekday > 6) return "fixed_day needs weekday 0-6";
    weekday = raw.weekday;
  }
  if (kind === "period" && !start && !end) return "period needs a date";
  return { text, start_date: start, end_date: end, kind, weekday };
}
