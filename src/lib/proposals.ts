import { randomUUID } from "node:crypto";
import { formatAdjustmentValue } from "./claude";
import { postCoachMessage } from "./coach";
import { type Querier, query, withTransaction } from "./db";
import { FIELD_NAMES, isValidDate, RUN_SPORTS, sessionLabel, shortDate } from "./labels";
import type { PlanWeekRow, PlannedSessionRow, ProposalField, ProposalItem, ProposalRow } from "../types";

// Woo's proposals: one card = one or more changes applied together. The weekly
// review's proposals live in weekly_reviews.adjustments (one at a time, the old
// route); chat proposals live in `proposals`. Both apply through `applyChange`:
// a new version of the planned session is written and the old one superseded, so
// the original plan stays readable and activities move along.

export const PROPOSAL_FIELDS = new Set<string>(["type", "target_distance_m", "target_pace_sec_km", "scheduled_date", "note", "skip"] satisfies ProposalField[]);
/** What a session may be turned into: never `race` (the race day is not Woo's to make or move). */
const PROPOSAL_TYPES = new Set(["easy", "long", "tempo", "interval", "rest"]);

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const km = (m: number) => Math.round(m / 100) / 10;

/** "11/1 距離 18 km → 16 km" — a change as one line (the cancelled list, Woo's confirmation). */
export function describeChange(c: { field: string; old: string | number | null; new: string | number | null; date?: string | null }, dateFallback?: string | null): string {
  const d = c.date ?? dateFallback;
  const day = d ? `${shortDate(d)} ` : "";
  if (c.field === "skip") return `${day}改休息`;
  return `${day}${FIELD_NAMES[c.field] ?? c.field} ${formatAdjustmentValue(c.field, c.old)} → ${formatAdjustmentValue(c.field, c.new)}`;
}

/** A string error when the value does not fit the field, else null. */
export function validateChangeValue(field: string, value: string | number | null): string | null {
  switch (field) {
    case "type": return typeof value === "string" && PROPOSAL_TYPES.has(value) ? null : "type must be easy, long, tempo, interval or rest";
    case "target_distance_m": return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000 ? null : "target_distance_m must be metres";
    case "target_pace_sec_km": return typeof value === "number" && Number.isFinite(value) && value >= 120 && value <= 1200 ? null : "target_pace_sec_km must be seconds per km";
    case "scheduled_date": return typeof value === "string" && isValidDate(value) ? null : "scheduled_date must be YYYY-MM-DD";
    case "note": return value === null || (typeof value === "string" && value.length <= 500) ? null : "note too long";
    case "skip": return null;
    default: return "unsupported field";
  }
}

/**
 * Why `field = value` must not be applied to `old` (a string, 409 material), or null.
 * Both apply routes (a chat card, a weekly review's proposal) go through here: the
 * value fits the field, the race day is neither changed nor made, nothing lands on it.
 */
export function changeConflict(old: Pick<PlannedSessionRow, "type"> & { race_date: string | null }, field: string, value: string | number | null): string | null {
  if (old.type === "race") return "the race day cannot be changed";
  const bad = validateChangeValue(field, value);
  if (bad) return bad;
  if (field === "type" && value === "race") return "a session cannot become the race";
  if (field === "scheduled_date" && old.race_date && value === old.race_date) return "a session cannot be moved onto the race day";
  return null;
}

/**
 * Write the next version of `old` with one field changed (or the session turned into
 * a rest day for `skip`) and supersede `old`; activities follow. Returns the new row id.
 * Runs on the querier it is given so a card's changes share one transaction.
 */
export async function applyChange(q: Querier, old: PlannedSessionRow, field: ProposalField, value: string | number | null): Promise<string> {
  const next: Record<string, unknown> = { ...old, id: randomUUID(), version: old.version + 1, superseded: false };
  if (field === "skip") {
    next.type = "rest";
    next.label = "休息";
    next.content = `休息（原 ${sessionLabel(old)}）`;
    next.target = null;
    next.target_distance_m = null;
    next.target_pace_sec_km = null;
    next.target_pace_min_sec_km = null;
    next.target_pace_max_sec_km = null;
    next.target_hr_min = null;
    next.target_hr_max = null;
  } else {
    next[field] = value;
    if (field === "target_pace_sec_km" && typeof value === "number" && old.target_pace_sec_km) {
      // Keep the allowed range the same width around the new midpoint.
      const d = value - old.target_pace_sec_km;
      if (old.target_pace_min_sec_km != null) next.target_pace_min_sec_km = old.target_pace_min_sec_km + d;
      if (old.target_pace_max_sec_km != null) next.target_pace_max_sec_km = old.target_pace_max_sec_km + d;
    }
  }
  // skipped_at travels with the session: a 沒跑 answer must not become unanswered because the date moved.
  await q(
    `insert into planned_sessions
       (id, plan_id, scheduled_date, week_no, phase, label, type, content, note, target, target_distance_m,
        target_pace_sec_km, target_pace_min_sec_km, target_pace_max_sec_km, target_hr_min, target_hr_max, skipped_at, version, superseded)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, false)`,
    [
      next.id, old.plan_id, next.scheduled_date, old.week_no, old.phase, next.label, next.type, next.content, next.note,
      next.target, next.target_distance_m, next.target_pace_sec_km, next.target_pace_min_sec_km, next.target_pace_max_sec_km,
      next.target_hr_min, next.target_hr_max, old.skipped_at, next.version,
    ],
  );
  await q("update planned_sessions set superseded = true where id = $1", [old.id]);
  await q("update activities set session_id = $2 where session_id = $1", [old.id, next.id]);
  return next.id as string;
}

/**
 * Apply every change of a chat proposal in one transaction. Two changes to the same
 * session chain (the second works on the version the first wrote). Returns the items
 * with applied_session_id filled, or a string error (409 material: a session changed since).
 */
export async function applyProposal(p: ProposalRow): Promise<ProposalItem[] | string> {
  return withTransaction(async (q) => {
    const [locked] = await q<{ status: string }>("select status from proposals where id = $1 for update", [p.id]);
    if (!locked || locked.status !== "pending") return `already ${locked?.status ?? "gone"}`;
    const latest = new Map<string, string>(); // proposed session id -> current version id
    const items: ProposalItem[] = [];
    for (const item of p.items) {
      const currentId = latest.get(item.session_id) ?? item.session_id;
      const [old] = await q<PlannedSessionRow & { race_date: string }>(
        `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date, to_char(p.race_date, 'YYYY-MM-DD') as race_date
           from planned_sessions ps join plans p on p.id = ps.plan_id
          where ps.id = $1 and p.user_id = $2 and ps.superseded = false for update`,
        [currentId, p.user_id],
      );
      if (!old) throw new ProposalConflict("that session was already changed; dismiss this proposal");
      // Checked again here (not only in buildProposal): the value still fits, nothing becomes a race or lands on the race day.
      const conflict = changeConflict(old, item.field, item.new);
      if (conflict) throw new ProposalConflict(conflict);
      const { race_date: _raceDate, ...oldRow } = old;
      const id = await applyChange(q, oldRow, item.field, item.new);
      latest.set(item.session_id, id);
      items.push({ ...item, applied_session_id: id });
    }
    await q("update proposals set status = 'applied', decided_at = now(), items = $2 where id = $1", [p.id, JSON.stringify(items)]);
    return items;
  }).catch((err) => {
    if (err instanceof ProposalConflict) return err.message;
    throw err;
  });
}

class ProposalConflict extends Error {}

/** Woo's one line after the athlete applied a card (template; no model). */
export async function postProposalApplied(userId: string, items: ProposalItem[]): Promise<void> {
  const ids = items.map((i) => i.applied_session_id).filter((id): id is string => !!id);
  const rows = ids.length
    ? await query<PlannedSessionRow>(`select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions where id = any($1::uuid[])`, [ids])
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Describe the final state of each touched session once.
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const i of [...items].reverse()) {
    const s = i.applied_session_id ? byId.get(i.applied_session_id) : undefined;
    if (!s || seen.has(i.session_id)) continue;
    seen.add(i.session_id);
    parts.unshift(`${shortDate(s.scheduled_date)} 是${sessionLabel(s)}`);
  }
  const text = parts.length ? `改好了，課表上${parts.join("、")}。` : "改好了。";
  await postCoachMessage({ user_id: userId, role: "coach", kind: "chat", text });
}

// ---- flags: computed, not asked of the model -------------------------------------------

const WEEK_UP_PCT = 15;     // weekly volume vs last week's actual
const LONG_UP_M = 3000;     // long run vs the longest run so far
const isLong = (s: Pick<PlannedSessionRow, "label" | "type">) => s.type === "long" || /Long|長跑/i.test(s.label ?? "");

/**
 * The amber lines on a card: the week's planned volume after the changes vs last
 * week (+15%), a long run +3 km over the longest so far, and more volume in a 減量
 * week. "Last week" is its actual running volume once that week is over; while it is
 * still running (a card for next week, written mid-week) its planned volume is the
 * baseline instead, otherwise two sessions in would make every card look like +200%.
 * Each flag is one sentence in Chinese; empty when nothing stands out.
 */
export async function computeFlags(
  userId: string,
  planId: string,
  weeks: PlanWeekRow[],
  sessions: PlannedSessionRow[], // the candidate sessions (this week + next), current versions
  items: Pick<ProposalItem, "session_id" | "field" | "new">[],
  today: string,
): Promise<string[]> {
  const flags: string[] = [];
  const byId = new Map(sessions.map((s) => [s.id, { ...s }]));
  const touched = new Set<string>();
  for (const it of items) {
    const s = byId.get(it.session_id);
    if (!s) continue;
    touched.add(s.id);
    if (it.field === "skip") { s.type = "rest"; s.target_distance_m = null; }
    else if (it.field === "target_distance_m" && typeof it.new === "number") s.target_distance_m = it.new;
    else if (it.field === "scheduled_date" && typeof it.new === "string") s.scheduled_date = it.new;
    else if (it.field === "type" && typeof it.new === "string") s.type = it.new as PlannedSessionRow["type"];
  }
  const planned = (list: Iterable<PlannedSessionRow>, from: string, to: string) =>
    [...list].filter((s) => s.type !== "rest" && s.scheduled_date >= from && s.scheduled_date <= to).reduce((t, s) => t + (s.target_distance_m ?? 0), 0);

  // Which week(s) the card touches.
  const weekOf = (date: string) => weeks.find((w) => date >= w.week_start && date <= w.week_end);
  const touchedWeeks = new Map<string, PlanWeekRow>();
  for (const id of touched) {
    const w = weekOf(byId.get(id)!.scheduled_date);
    if (w) touchedWeeks.set(w.week_start, w);
    const o = sessions.find((s) => s.id === id);
    const w2 = o && weekOf(o.scheduled_date);
    if (w2) touchedWeeks.set(w2.week_start, w2);
  }

  for (const w of touchedWeeks.values()) {
    const before = planned(sessions, w.week_start, w.week_end);
    const after = planned(byId.values(), w.week_start, w.week_end);
    const prevFrom = addDays(w.week_start, -7), prevTo = addDays(w.week_start, -1);
    const prevOver = prevTo < today;
    const prev = prevOver
      ? await query<{ m: string | null }>(
          `select sum(distance_m) as m from activities where user_id = $1 and match_status <> 'ignored'
              and (sport_type is null or sport_type = any($4::text[]))
              and (start_time at time zone 'Asia/Tokyo')::date between $2 and $3`,
          [userId, prevFrom, prevTo, [...RUN_SPORTS]],
        )
      : await query<{ m: string | null }>(
          `select sum(target_distance_m) as m from planned_sessions
            where plan_id = $1 and superseded = false and type <> 'rest' and scheduled_date between $2 and $3`,
          [planId, prevFrom, prevTo],
        );
    const prevM = Number(prev[0]?.m ?? 0);
    if (prevM > 0 && after > before && after >= prevM * (1 + WEEK_UP_PCT / 100)) {
      flags.push(`週跑量 ${km(after)} km，比上週${prevOver ? "實跑" : "計畫"} ${km(prevM)} km 多 ${Math.round(((after - prevM) / prevM) * 100)}%`);
    }
    if (/減量|恢復|Taper/i.test(`${w.phase ?? ""} ${w.focus ?? ""}`) && after > before) {
      flags.push(`減量週加量（${km(before)} → ${km(after)} km）`);
    }
  }

  // The long run vs the longest run so far.
  const longest = await query<{ m: number | null }>(
    `select max(distance_m) as m from activities where user_id = $1 and match_status <> 'ignored'
        and (sport_type is null or sport_type = any($2::text[])) and (start_time at time zone 'Asia/Tokyo')::date <= $3`,
    [userId, [...RUN_SPORTS], today],
  );
  const longestM = Number(longest[0]?.m ?? 0);
  if (longestM > 0) {
    for (const it of items) {
      if (it.field !== "target_distance_m" || typeof it.new !== "number") continue;
      const s = byId.get(it.session_id);
      if (!s || !isLong(s)) continue;
      if (it.new - longestM >= LONG_UP_M) flags.push(`比目前最長多 ${km(it.new - longestM)} km（${km(longestM)} → ${km(it.new)} km）`);
    }
  }
  return [...new Set(flags)];
}
