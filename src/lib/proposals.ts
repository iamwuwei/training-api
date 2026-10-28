import { randomUUID } from "node:crypto";
import { type PlanBriefing, activityWeekNo, catchUpSessions, changeableSessions } from "./briefing";
import { LIMITS } from "./card-schema";
import { formatAdjustmentValue } from "./claude";
import { postCoachMessage } from "./coach";
import { fixedWeekdays, WEEKDAY_ZH, weekdayOf } from "./constraints";
import { type Querier, query, withTransaction } from "./db";
import { FIELD_NAMES, isRunSport, isValidDate, sessionLabel, shortDate, weekOf } from "./labels";
import type {
  CoachMessageRow, ConstraintRow, NewSession, PlanWeekRow, PlannedSessionRow, ProposalField, ProposalImpact, ProposalItem, ProposalOption, ProposalRow, ProposalWeek, RawCard, SessionType, WeeklyMessageMeta,
} from "../types";

// Woo's proposals: one card = one or more changes applied together, across any weeks
// from today to the day before the race. A change edits a session, `add` puts a new
// one in, `remove` takes one out; the card can also rewrite the descriptions of the
// weeks it touches. Chat cards and the weekly review's cards live in `proposals` (the
// weekly review's older proposals live in weekly_reviews.adjustments, one at a time,
// applied through `applyChange`). Applying writes a new version of each changed
// session and supersedes the old one, so the original plan stays readable and
// activities move along; a removed session is superseded without a successor.

export const PROPOSAL_FIELDS = new Set<string>(["type", "target_distance_m", "target_pace_sec_km", "scheduled_date", "note", "skip"] satisfies ProposalField[]);
/** What a session may be turned into: never `race` (the race day is not Woo's to make or move). */
const PROPOSAL_TYPES = new Set(["easy", "long", "tempo", "interval", "rest"]);

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const km = (m: number) => Math.round(m / 100) / 10;
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

/** "11/1 距離 18 km → 16 km" — a change as one line (the cancelled list, Woo's confirmation). */
export function describeChange(c: { field: string; old: string | number | null; new: string | number | null; date?: string | null }, dateFallback?: string | null): string {
  const d = c.date ?? dateFallback;
  const day = d ? `${shortDate(d)} ` : "";
  if (c.field === "skip") return `${day}改休息`;
  return `${day}${FIELD_NAMES[c.field] ?? c.field} ${formatAdjustmentValue(c.field, c.old)} → ${formatAdjustmentValue(c.field, c.new)}`;
}

/** One row of a card as a line of text: "11/22 日期 11/22 → 11/25", "新增 11/22 休息", "刪除 11/25 Easy 7 km". */
export function describeItem(i: ProposalItem): string {
  const op = i.op ?? "change";
  if (op === "add") return `新增 ${i.date ? `${shortDate(i.date)} ` : ""}${i.label ?? ""}`.trim();
  if (op === "remove") return `刪除 ${i.date ? `${shortDate(i.date)} ` : ""}${i.label ?? ""}`.trim();
  if (i.makeup && i.field === "scheduled_date" && typeof i.new === "string") {
    return `${i.date ? `${shortDate(i.date)} ` : ""}${i.label ?? ""} 補課 → ${shortDate(i.new)}${i.counts_in_week_no != null ? `（算第 ${i.counts_in_week_no} 週）` : ""}`.trim();
  }
  return `${i.label ? `${i.label} ` : ""}${describeChange({ field: i.field ?? "note", old: i.old, new: i.new, date: i.date })}`.trim();
}

/** A whole card as one line: its rows joined, the first six. */
export function describeCard(p: Pick<ProposalRow, "items">): string {
  const items = p.items.map(describeItem);
  return items.length > 6 ? `${items.slice(0, 6).join("、")} 等共 ${items.length} 項` : items.join("、");
}

/** Words the model uses for a session type that are not one of the five values; matched case-insensitively, whitespace trimmed. */
const TYPE_ALIASES: Record<string, string> = {
  recovery: "easy", recover: "easy", "easy run": "easy",
  hill: "interval", hills: "interval", "hill repeats": "interval",
  mp: "tempo", "marathon pace": "tempo", threshold: "tempo", "tempo run": "tempo",
  "long run": "long",
  off: "rest", 休息: "rest", "rest day": "rest",
};
/** The model's session type as one of easy / long / tempo / interval / rest when it is one or a known alias, else the value as it came (the caller rejects it). */
export function normalizeType(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const k = v.trim().toLowerCase();
  return PROPOSAL_TYPES.has(k) ? k : Object.hasOwn(TYPE_ALIASES, k) ? TYPE_ALIASES[k] : v; // own keys only: "constructor" must not come back as a function
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
 * The weekly review's older proposals (adjustments) go through here: the value fits
 * the field, the race day is neither changed nor made, nothing lands on it.
 */
export function changeConflict(old: Pick<PlannedSessionRow, "type"> & { race_date: string | null }, field: string, value: string | number | null): string | null {
  if (old.type === "race") return "the race day cannot be changed";
  const bad = validateChangeValue(field, value);
  if (bad) return bad;
  if (field === "type" && value === "race") return "a session cannot become the race";
  if (field === "scheduled_date" && old.race_date && value === old.race_date) return "a session cannot be moved onto the race day";
  return null;
}

/** The label a session gets when its type is changed (the old label named the old type). */
const LABEL_FOR_TYPE: Record<string, string> = { easy: "Easy", long: "Long", tempo: "Tempo", interval: "Interval", rest: "休息" };

/** A pace midpoint as the allowed range ± 15 s and the text that shows it ("7:30〜8:00"). */
function paceRange(p: number): { min: number; max: number; text: string } {
  return { min: p - 15, max: p + 15, text: `${mmss(p - 15)}〜${mmss(p + 15)}` };
}

/**
 * Write the next version of `old` with one field changed (or the session turned into
 * a rest day for `skip`) and supersede `old`; activities follow. Returns the new row id.
 * Runs on the querier it is given so a card's changes share one transaction. A new date
 * puts the session in the week (week_no, phase) that date belongs to.
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
    if (field === "type" && typeof value === "string" && value !== old.type) {
      // The target text, the pace range and the heart-rate band described the old type ("MP 6:40〜6:50"
      // must not stay on a session that is now Easy): clear them, name the session for its new type.
      // A pace set afterwards on the same card gets a range of its own (below).
      next.label = LABEL_FOR_TYPE[value] ?? old.label;
      next.target = null;
      next.target_pace_sec_km = null;
      next.target_pace_min_sec_km = null;
      next.target_pace_max_sec_km = null;
      next.target_hr_min = null;
      next.target_hr_max = null;
      if (value === "rest") {
        next.target_distance_m = null;
        next.content = `休息（原 ${sessionLabel(old)}）`;
      } else {
        next.content = `${next.label}${old.target_distance_m ? ` ${km(old.target_distance_m)} km` : ""}`;
      }
    }
    if (field === "target_pace_sec_km" && typeof value === "number") {
      if (old.target_pace_sec_km) {
        // Keep the allowed range the same width around the new midpoint.
        const d = value - old.target_pace_sec_km;
        if (old.target_pace_min_sec_km != null) next.target_pace_min_sec_km = old.target_pace_min_sec_km + d;
        if (old.target_pace_max_sec_km != null) next.target_pace_max_sec_km = old.target_pace_max_sec_km + d;
      } else {
        const r = paceRange(value);
        next.target_pace_min_sec_km = r.min;
        next.target_pace_max_sec_km = r.max;
        next.target = r.text;
      }
    }
    if (field === "scheduled_date" && typeof value === "string") {
      const [w] = await q<{ week_no: number; phase: string | null }>(
        "select week_no, phase from plan_weeks where plan_id = $1 and $2::date between week_start and week_end",
        [old.plan_id, value],
      );
      if (w) { next.week_no = w.week_no; next.phase = w.phase ?? old.phase; }
    }
  }
  // A make-up row that is skipped or turned into a rest day is not a make-up any more: the row it replaced is a plain
  // skipped session again, and this one no longer points back or books itself in another week.
  const undoMakeup = old.moved_from_session_id && (field === "skip" || (field === "type" && value === "rest"));
  if (undoMakeup) { next.moved_from_session_id = null; next.counts_in_week_no = null; }
  // skipped_at travels with the session: a 沒跑 answer must not become unanswered because the date moved.
  await insertVersion(q, next, old.skipped_at);
  await q("update planned_sessions set superseded = true where id = $1", [old.id]);
  if (undoMakeup) await q("update planned_sessions set superseded = false, moved_to_session_id = null where id = $1", [old.moved_from_session_id]);
  // The moved row of a make-up points at the make-up's current version.
  else await q("update planned_sessions set moved_to_session_id = $2 where moved_to_session_id = $1", [old.id, next.id]);
  await q("update activities set session_id = $2 where session_id = $1", [old.id, next.id]);
  return next.id as string;
}

/** Insert `next` as a new (current) version row of a session. */
async function insertVersion(q: Querier, next: Record<string, unknown>, skippedAt: Date | null): Promise<void> {
  await q(
    `insert into planned_sessions
       (id, plan_id, scheduled_date, week_no, phase, label, type, content, note, target, target_distance_m,
        target_pace_sec_km, target_pace_min_sec_km, target_pace_max_sec_km, target_hr_min, target_hr_max, skipped_at, version, superseded,
        moved_from_session_id, counts_in_week_no)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, false, $19, $20)`,
    [
      next.id, next.plan_id, next.scheduled_date, next.week_no, next.phase, next.label, next.type, next.content, next.note,
      next.target, next.target_distance_m, next.target_pace_sec_km, next.target_pace_min_sec_km, next.target_pace_max_sec_km,
      next.target_hr_min, next.target_hr_max, skippedAt, next.version, next.moved_from_session_id ?? null, next.counts_in_week_no ?? null,
    ],
  );
}

/**
 * 補課: move a session that was not run (its date is before today) to `toDate`. The old row stays as a history row (superseded,
 * `moved_to_session_id` -> the new row, nothing is rewritten); the new row is version + 1 on the new date, points back with
 * `moved_from_session_id` and carries the week it is booked in (`counts_in_week_no`), decided now: the original week's review
 * not written yet -> the original week, written -> the week of the new date. Activities do not move (the old row has none:
 * a session with an activity is refused before this). Runs on the card's transaction `q`.
 */
export async function applyMakeup(q: Querier, planId: string, old: PlannedSessionRow, toDate: string, weeks: PlanWeekRow[]): Promise<{ id: string; counts_in_week_no: number | null }> {
  const originWeek = weekOf(weeks, old.scheduled_date);
  const newWeek = weekOf(weeks, toDate);
  const reviewed = await q(
    "select 1 from weekly_reviews where plan_id = $1 and week_start <= $2::date and week_start + 6 >= $2::date limit 1",
    [planId, old.scheduled_date],
  );
  const counts = reviewed.length ? newWeek?.week_no ?? null : originWeek?.week_no ?? null;
  const next: Record<string, unknown> = {
    ...old, id: randomUUID(), version: old.version + 1, superseded: false, scheduled_date: toDate,
    week_no: newWeek?.week_no ?? old.week_no, phase: newWeek?.phase ?? old.phase,
    moved_from_session_id: old.id, moved_to_session_id: null, counts_in_week_no: counts,
  };
  await insertVersion(q, next, null);
  await q("update planned_sessions set superseded = true, moved_to_session_id = $2 where id = $1", [old.id, next.id]);
  return { id: next.id as string, counts_in_week_no: counts };
}

/** A new session (op = add): version 1, in the week its date belongs to. */
async function insertSession(q: Querier, planId: string, ns: NewSession): Promise<string> {
  const id = randomUUID();
  const [w] = await q<{ week_no: number; phase: string | null }>(
    "select week_no, phase from plan_weeks where plan_id = $1 and $2::date between week_start and week_end",
    [planId, ns.scheduled_date],
  );
  const p = ns.target_pace_sec_km;
  const min = p != null ? p - 15 : null, max = p != null ? p + 15 : null;
  await q(
    `insert into planned_sessions
       (id, plan_id, scheduled_date, week_no, phase, label, type, content, note, target, target_distance_m,
        target_pace_sec_km, target_pace_min_sec_km, target_pace_max_sec_km, version, superseded)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, false)`,
    [
      id, planId, ns.scheduled_date, w?.week_no ?? null, w?.phase ?? null, ns.label, ns.type,
      `${ns.label}${ns.target_distance_m ? ` ${km(ns.target_distance_m)} km` : ""}`, ns.note,
      min != null && max != null ? `${mmss(min)}〜${mmss(max)}` : null, ns.target_distance_m, p, min, max,
    ],
  );
  return id;
}

// ---- validating the model's cards -------------------------------------------------------------

/** A card that passed every check, ready to be stored (the caller adds user, message, source). */
export interface CardDraft {
  id: string;
  items: ProposalItem[];
  weeks: ProposalWeek[];
  why: string | null;
  basis: string[];
  basis_text: string;
  impact: ProposalImpact;
  flags: string[];
  group_id: string | null;
  option: ProposalOption | null;
}

const isStr = (v: unknown): v is string => typeof v === "string";
/** A model string as one line of plain text: whitespace (newlines included) collapsed, so it can never forge a heading in a later prompt. */
const text = (v: unknown): string => (isStr(v) ? v.replace(/\s+/g, " ").trim() : "");

/** Week numbers a set of items touches: the week a session is in now and the one it lands in. */
export function touchedWeekNos(weeks: PlanWeekRow[], items: ProposalItem[]): Set<number> {
  const out = new Set<number>();
  for (const i of items) {
    const dates = [i.date, i.field === "scheduled_date" && isStr(i.new) ? i.new : null, i.new_session?.scheduled_date];
    for (const d of dates) {
      const w = d ? weekOf(weeks, d) : undefined;
      if (w) out.add(w.week_no);
    }
  }
  return out;
}

/**
 * The model's 1–2 cards (one, or an A/B pair; a weekly review passes `maxCards` 1) checked against the plan. Everything the
 * design lists is checked here: basis_text and impact present, add / remove with a
 * reason, every session in the athlete's own plan and still changeable, dates from today to the
 * day before the race, nothing on the race day, no move off a day the athlete said is fixed, one session a day, and the
 * length limits. A pair with one bad card keeps the good one as a single card (no letter, no group); `dropped` says which
 * card went and why. `error` is set (and `drafts` empty) when nothing is left: the text of the reply is kept either way.
 */
export function checkCards(b: PlanBriefing, raws: RawCard[], today: string, maxCards = 2): { drafts: CardDraft[]; dropped: string[]; error: string | null } {
  if (!Array.isArray(raws) || raws.length < 1 || raws.length > maxCards) return { drafts: [], dropped: [], error: `expected 1 to ${maxCards} cards, got ${Array.isArray(raws) ? raws.length : "none"}` };
  const checked = raws.map((raw, i) => ({ i, raw, d: validateCard(b, raw, today) }));
  const bad = checked.filter((c): c is typeof c & { d: string } => typeof c.d === "string");
  const good = checked.filter((c): c is typeof c & { d: CardDraft } => typeof c.d !== "string");
  const dropped = bad.map((c) => `card ${c.i + 1}: ${c.d}`);
  if (!good.length) return { drafts: [], dropped, error: dropped.join("; ") };
  const drafts = good.map((c) => c.d);
  if (drafts.length === 2) {
    const group = randomUUID();
    for (const [i, d] of drafts.entries()) {
      // The letter is the api's, by order: a model that wrote "B：不補" into the title does not get "A：B：不補" on screen.
      const title = text(raws[i].option_title).replace(/^[AaBb]\s*[：:]\s*/, "");
      if (!title) return { drafts: [], dropped, error: `card ${i + 1}: option_title is required when there are two cards` };
      if (title.length > LIMITS.option_title) return { drafts: [], dropped, error: `card ${i + 1}: option_title longer than ${LIMITS.option_title}` };
      d.group_id = group;
      d.option = { letter: i === 0 ? "A" : "B", title, recommended: raws[i].recommended === true && !(i === 1 && raws[0].recommended === true) };
    }
  }
  return { drafts, dropped, error: null };
}

/** `checkCards` as the old shape: the cards, or a string saying why none is left. */
export function validateCards(b: PlanBriefing, raws: RawCard[], today: string, maxCards = 2): CardDraft[] | string {
  const r = checkCards(b, raws, today, maxCards);
  return r.error ?? r.drafts;
}

function validateCard(b: PlanBriefing, raw: RawCard, today: string): CardDraft | string {
  if (!raw || typeof raw !== "object") return "not an object";
  const race = b.plan.race_date;
  const lastDay = addDays(race, -1);
  const inRange = (d: string) => d >= today && d <= lastDay;
  const changeable = new Map(changeableSessions(b, today).map((s) => [s.id, s]));
  const past = new Map(catchUpSessions(b, today).map((s) => [s.id, s])); // not run, before today: may only be moved forward (補課)
  const byId = new Map(b.sessions.map((s) => [s.id, s]));
  const fixed = fixedWeekdays(b.constraints);

  if (!Array.isArray(raw.changes) || !raw.changes.length) return "no changes";
  if (raw.changes.length > LIMITS.changes) return `more than ${LIMITS.changes} changes`;

  const items: ProposalItem[] = [];
  const touched = new Map<string, Set<string>>(); // session id -> fields changed ("remove" for a removal)
  for (const c of raw.changes) {
    const op = c.op;
    if (op !== "change" && op !== "add" && op !== "remove") return `op ${String(op)}`;
    const reason = text(c.reason);
    if (reason.length > LIMITS.reason) return `reason longer than ${LIMITS.reason}`;

    // field is "" (none) unless op = change. Structured output must pick one enum value, so the model may well put
    // one on an add / remove; it means nothing there (both branches below never read it): ignored, not a reason to drop the card.
    if (op !== "change" && c.field != null && c.field !== "") console.warn(`${op} came with field ${JSON.stringify(c.field)}, ignored`);

    if (op === "add") {
      const ns = c.new_session;
      if (!ns || typeof ns !== "object") return "add without new_session";
      if (!reason) return "add needs a reason";
      if (!isStr(ns.scheduled_date) || !isValidDate(ns.scheduled_date)) return "new_session.scheduled_date must be YYYY-MM-DD";
      if (!inRange(ns.scheduled_date)) return `new_session.scheduled_date ${ns.scheduled_date} is outside today to the day before the race`;
      const nsType = normalizeType(ns.type);
      if (!isStr(nsType) || !PROPOSAL_TYPES.has(nsType)) return "new_session.type must be easy, long, tempo, interval or rest";
      const label = text(ns.label);
      if (!label || label.length > LIMITS.session_label) return "new_session.label is empty or too long";
      const dist = ns.target_distance_m ?? null, pace = ns.target_pace_sec_km ?? null, note = ns.note == null ? null : text(ns.note) || null;
      if (dist !== null && validateChangeValue("target_distance_m", dist)) return "new_session.target_distance_m must be metres";
      if (pace !== null && validateChangeValue("target_pace_sec_km", pace)) return "new_session.target_pace_sec_km must be seconds per km";
      if (note !== null && note.length > LIMITS.session_note) return "new_session.note too long";
      const session: NewSession = { scheduled_date: ns.scheduled_date, type: nsType as NewSession["type"], label, target_distance_m: dist, target_pace_sec_km: pace, note };
      items.push({ op, session_id: null, old: null, new: null, label: sessionLabel({ label, type: session.type, target_distance_m: dist }), date: session.scheduled_date, new_session: session, reason, flags: [] });
      continue;
    }

    const id = c.session_id;
    if (!isStr(id)) return `${op} without session_id`;
    const s = changeable.get(id) ?? past.get(id);
    if (!s) {
      const known = byId.get(id);
      if (known?.type === "race") return "the race day cannot be changed";
      if (known?.done) return `session ${id} is completed`;
      return `session ${id} is not one the athlete can still change`;
    }
    const isPast = s.scheduled_date < today;
    const seen = touched.get(id) ?? new Set<string>();
    if (seen.has("remove") || (op === "remove" && seen.size)) return `session ${id} is both removed and changed`;

    if (op === "remove") {
      if (isPast) return "a past session cannot be removed (it can only be moved forward)";
      if (!reason) return "remove needs a reason";
      seen.add("remove");
      touched.set(id, seen);
      items.push({ op, session_id: id, old: null, new: null, label: sessionLabel(s), date: s.scheduled_date, reason, flags: [] });
      continue;
    }

    const field = c.field;
    if (!isStr(field) || !PROPOSAL_FIELDS.has(field)) return `field ${JSON.stringify(field) ?? "missing"}`; // "" (none) is not a field to change
    if (seen.has(field)) return `session ${id}: ${field} changed twice`;
    if (isPast && field !== "scheduled_date" && !seen.has("scheduled_date")) return "a past session can only be changed after it is moved (補課)";
    const value = field === "skip" ? null : field === "type" ? normalizeType(c.new ?? null) as string | number | null : c.new ?? null;
    const bad = validateChangeValue(field, value);
    if (bad) return bad;
    if (field === "scheduled_date") {
      const to = value as string;
      if (!inRange(to)) return `scheduled_date ${to} is outside today to the day before the race`;
      // A fixed day binds the days ahead; a missed session on one may still be made up.
      if (!isPast && fixed.has(weekdayOf(s.scheduled_date))) return `${shortDate(s.scheduled_date)} is a fixed day (每週${WEEKDAY_ZH[weekdayOf(s.scheduled_date)]}), it cannot move`;
    }
    const current = field === "skip" ? null : (s[field as Exclude<ProposalField, "skip">] as string | number | null);
    if (field !== "skip" && current === value) return `${field} unchanged`;
    seen.add(field);
    touched.set(id, seen);
    items.push({ op, session_id: id, field: field as ProposalField, old: current, new: value, label: sessionLabel(s), date: s.scheduled_date, reason: reason || null, flags: [], ...(isPast && field === "scheduled_date" ? { makeup: true } : {}) });
  }

  // One session a day: after the card, every date it touches holds at most one row.
  const sim = simulate(b, items);
  const crowded = crowdedDay(sim.before, sim.after, items);
  if (crowded) return `two sessions on ${crowded}: the card must change, move, skip or remove the one already there`;

  // Week descriptions: only for weeks the changes touch.
  const weekNos = touchedWeekNos(b.weeks, items);
  if (raw.weeks !== undefined && !Array.isArray(raw.weeks)) return "weeks must be a list";
  const weeks: ProposalWeek[] = [];
  for (const w of raw.weeks ?? []) {
    if (!w || typeof w.week_no !== "number" || !Number.isInteger(w.week_no)) return "weeks[].week_no must be an integer";
    if (!b.weeks.some((x) => x.week_no === w.week_no)) return `week ${w.week_no} is not in the plan`;
    if (!weekNos.has(w.week_no)) continue; // a week this card does not change: the model listed it for nothing, ignore it (do not drop the card)
    if (weeks.some((x) => x.week_no === w.week_no)) return `week ${w.week_no} listed twice`;
    const phase = text(w.phase) || null, focus = text(w.focus) || null;
    if (!phase && !focus) return `week ${w.week_no} has nothing to change`;
    if (phase && phase.length > LIMITS.phase) return `week ${w.week_no} phase longer than ${LIMITS.phase}`;
    if (focus && focus.length > LIMITS.focus) return `week ${w.week_no} focus longer than ${LIMITS.focus}`;
    weeks.push({ week_no: w.week_no, phase, focus });
  }
  if (weeks.length > LIMITS.weeks) return `more than ${LIMITS.weeks} weeks`;

  const basis_text = text(raw.basis_text);
  if (!basis_text) return "basis_text is empty";
  if (basis_text.length > LIMITS.basis_text) return `basis_text longer than ${LIMITS.basis_text}`;
  const imp = raw.impact && typeof raw.impact === "object" ? raw.impact : {};
  const impact: ProposalImpact = { keep: text(imp.keep), change: text(imp.change), risk: text(imp.risk) };
  for (const k of ["keep", "change", "risk"] as const) {
    if (!impact[k]) return `impact.${k} is empty`;
    if (impact[k].length > LIMITS.impact) return `impact.${k} longer than ${LIMITS.impact}`;
  }

  const { rows, card } = computeFlags(b, items, today);
  items.forEach((it, i) => { it.flags = rows[i]; });
  return {
    id: randomUUID(),
    items,
    weeks,
    why: text(raw.why) ? text(raw.why).slice(0, LIMITS.why) : null,
    basis: Array.isArray(raw.basis) ? raw.basis.filter((x): x is string => isStr(x) && x.trim() !== "").slice(0, 4).map((x) => text(x).slice(0, LIMITS.basis_item)) : [],
    basis_text,
    impact,
    flags: card,
    group_id: null,
    option: null,
  };
}

// ---- flags: computed, not asked of the model -------------------------------------------

const WEEK_UP_PCT = 15;     // weekly volume vs the week before
const LONG_UP_M = 3000;     // long run vs the longest run so far
const NEAR_RACE_DAYS = 14;  // a long run this close to the race ...
const NEAR_RACE_LONG_M = 25_000; // ... of this length or more

/** A session as the flags and the one-a-day check see it. `counts`: the week a make-up row is booked in (undefined = the week of its date). */
interface Sim { date: string; type: SessionType; label: string | null; dist: number | null; counts?: number | null }
const isLongSim = (s: Sim) => s.type === "long" || /Long|長跑/i.test(s.label ?? "");
const simKm = (s: Sim | undefined) => (s && s.type !== "rest" && s.type !== "race" ? s.dist ?? 0 : 0);

/**
 * The plan before and after the card, keyed by session id (`new:<item index>` for an add). `owner`: the last item that
 * touched each key. A past session moved by the card (a make-up) is booked the way applyMakeup will book it: in its original
 * week unless that week's review exists (`reviewedWeeks`), then in the week of the new date.
 */
export function simulate(
  b: Pick<PlanBriefing, "sessions" | "weeks"> & Partial<Pick<PlanBriefing, "reviewedWeeks">>,
  items: ProposalItem[],
): { before: Map<string, Sim>; after: Map<string, Sim>; owner: Map<string, number> } {
  const before = new Map<string, Sim>();
  for (const s of b.sessions) before.set(s.id, { date: s.scheduled_date, type: s.type, label: s.label, dist: s.target_distance_m, ...(s.moved_from_session_id ? { counts: s.counts_in_week_no ?? null } : {}) });
  const after = new Map(before);
  const owner = new Map<string, number>(); // sim key -> the last item that touched it
  items.forEach((it, idx) => {
    const op = it.op ?? "change";
    if (op === "add" && it.new_session) {
      after.set(`new:${idx}`, { date: it.new_session.scheduled_date, type: it.new_session.type, label: it.new_session.label, dist: it.new_session.target_distance_m });
      owner.set(`new:${idx}`, idx);
      return;
    }
    const id = it.session_id;
    const cur = id ? after.get(id) : undefined;
    if (!id || !cur) return;
    owner.set(id, idx);
    if (op === "remove") { after.delete(id); return; }
    const next = { ...cur };
    if (it.field === "skip") { next.type = "rest"; next.dist = null; }
    else if (it.field === "target_distance_m" && typeof it.new === "number") next.dist = it.new;
    else if (it.field === "scheduled_date" && isStr(it.new)) {
      if (it.makeup && cur.counts === undefined) {
        const origin = weekOf(b.weeks, cur.date);
        next.counts = origin && !b.reviewedWeeks?.has(origin.week_no) ? origin.week_no : weekOf(b.weeks, it.new)?.week_no ?? null;
      }
      next.date = it.new;
    }
    else if (it.field === "type" && isStr(it.new)) { next.type = it.new as SessionType; next.label = null; }
    after.set(id, next);
  });
  return { before, after, owner };
}

/**
 * The first date the card touches that ends up with two or more sessions and more than it had before the card, or null. A day that
 * was already crowded (a duplicate in the import) only blocks a card that makes it worse, not one that changes a distance on it.
 */
function crowdedDay(before: Map<string, { date: string }>, after: Map<string, { date: string }>, items: ProposalItem[]): string | null {
  const dates = new Set<string>();
  for (const it of items) {
    if (it.date) dates.add(it.date);
    if (it.field === "scheduled_date" && isStr(it.new)) dates.add(it.new);
    if (it.new_session) dates.add(it.new_session.scheduled_date);
  }
  const count = (m: Map<string, { date: string }>) => {
    const c = new Map<string, number>();
    for (const s of m.values()) c.set(s.date, (c.get(s.date) ?? 0) + 1);
    return c;
  };
  const was = count(before), now = count(after);
  return [...dates].sort().find((d) => (now.get(d) ?? 0) > 1 && (now.get(d) ?? 0) > (was.get(d) ?? 0)) ?? null;
}

/**
 * The amber lines of a card, hung on the row that causes them (`rows[i]` belongs to
 * `items[i]`; `card` is what no row owns). The whole plan is simulated with the card
 * applied, then for every week the card touches (the week a row is booked in, see countsWeekNo):
 *  - weekly volume after ≥ +15% over the week before (that week's actual running once it
 *    is over, its planned volume after the card otherwise) and more than before the card;
 *  - a 減量／恢復／Taper week (by its description today) that gets more volume;
 * and for the rows themselves:
 *  - a long run (added, longer, or turned into one) 3 km or more beyond the longest run so far;
 *  - a long run of 25 km or more (added, moved, longer) within 14 days of the race.
 * Each flag is one sentence in Chinese; empty when nothing stands out.
 */
export function computeFlags(
  b: Pick<PlanBriefing, "plan" | "weeks" | "sessions" | "activities"> & Partial<Pick<PlanBriefing, "reviewedWeeks">>,
  items: ProposalItem[],
  today: string,
): { rows: string[][]; card: string[] } {
  const rows: string[][] = items.map(() => []);
  const card: string[] = [];
  const { before, after, owner } = simulate(b, items);

  // A row is in the week it is booked in: a make-up row's counts, else the week of its date.
  const weekNoOf = (s: Sim) => (s.counts !== undefined ? s.counts : weekOf(b.weeks, s.date)?.week_no ?? null);
  const weekKm = (sims: Map<string, Sim>, w: PlanWeekRow) => [...sims.values()].filter((s) => weekNoOf(s) === w.week_no).reduce((t, s) => t + simKm(s), 0);
  const runKm = (w: PlanWeekRow | undefined, from: string, to: string) =>
    b.activities
      .filter((a) => isRunSport(a.sport_type) && (w ? activityWeekNo(a, b.weeks) === w.week_no : a.date >= from && a.date <= to))
      .reduce((t, a) => t + a.distance_m, 0);

  // Weeks the card touches (where a session was and where it ends up).
  const touched = new Map<number, PlanWeekRow>();
  for (const key of owner.keys()) {
    for (const sims of [before, after]) {
      const s = sims.get(key);
      const n = s ? weekNoOf(s) : null;
      const w = n != null ? b.weeks.find((x) => x.week_no === n) : undefined;
      if (w) touched.set(w.week_no, w);
    }
  }
  for (const w of [...touched.values()].sort((x, y) => x.week_no - y.week_no)) {
    const was = weekKm(before, w), now = weekKm(after, w);
    if (now <= was) continue;
    // The item that adds the most volume to this week carries the flag.
    const gain = new Map<number, number>();
    for (const [key, idx] of owner) {
      const inW = (s: Sim | undefined) => (s && weekNoOf(s) === w.week_no ? simKm(s) : 0);
      gain.set(idx, (gain.get(idx) ?? 0) + inW(after.get(key)) - inW(before.get(key)));
    }
    const top = [...gain.entries()].sort((x, y) => y[1] - x[1])[0];
    const put = (msg: string) => (top && top[1] > 0 ? rows[top[0]].push(msg) : card.push(msg));

    const prevFrom = addDays(w.week_start, -7), prevTo = addDays(w.week_start, -1);
    const prevWeek = b.weeks.find((x) => x.week_end === prevTo);
    const prevOver = prevTo < today;
    const prev = prevOver ? runKm(prevWeek, prevFrom, prevTo) : prevWeek ? weekKm(after, prevWeek) : 0;
    const up = prev > 0 && now >= prev * (1 + WEEK_UP_PCT / 100)
      ? `落到第 ${w.week_no} 週：那週 ${km(was)} → ${km(now)} km，比上週${prevOver ? "實跑" : "計畫"} ${km(prev)} km 多 ${Math.round(((now - prev) / prev) * 100)}%`
      : null;
    const light = /減量|恢復|Taper/i.test(`${w.phase ?? ""} ${w.focus ?? ""}`);
    if (up) put(light ? `${up}，而且這週原本是減量週` : up);
    else if (light) put(`落到第 ${w.week_no} 週：減量週加量（${km(was)} → ${km(now)} km）`);
  }

  // The long runs themselves. A session several rows touch is judged once, on its final state, and the flag sits on its last row.
  const longestM = Math.max(0, ...b.activities.filter((a) => isRunSport(a.sport_type) && a.date <= today).map((a) => a.distance_m));
  const touchedBy = new Map<string, { idx: number; lengthens: boolean; moves: boolean }>();
  items.forEach((it, idx) => {
    const op = it.op ?? "change";
    if (op === "remove") return;
    const key = op === "add" ? `new:${idx}` : (it.session_id as string);
    const prev = touchedBy.get(key);
    touchedBy.set(key, {
      idx,
      lengthens: (prev?.lengthens ?? false) || op === "add" || it.field === "target_distance_m" || it.field === "type",
      moves: (prev?.moves ?? false) || it.field === "scheduled_date",
    });
  });
  for (const [key, t] of touchedBy) {
    const sim = after.get(key);
    if (!sim || !isLongSim(sim) || sim.dist == null) continue;
    if (t.lengthens && longestM > 0 && sim.dist - longestM >= LONG_UP_M) {
      rows[t.idx].push(`比目前最長多 ${km(sim.dist - longestM)} km（${km(longestM)} → ${km(sim.dist)} km）`);
    }
    const d = daysBetween(sim.date, b.plan.race_date);
    if ((t.lengthens || t.moves) && sim.dist >= NEAR_RACE_LONG_M && d >= 1 && d <= NEAR_RACE_DAYS) {
      rows[t.idx].push(`離比賽只剩 ${d} 天，這天有 ${km(sim.dist)} km 的長跑`);
    }
  }
  return { rows: rows.map((r) => [...new Set(r)]), card: [...new Set(card)] };
}

// ---- applying a card ------------------------------------------------------------------------------

export interface PlanChanged {
  session_id: string;
  label: string | null;
  date: string | null;
  why: "changed" | "completed";
}

export type ApplyResult =
  | { ok: true; items: ProposalItem[]; superseded: string[] }
  | { ok: false; status: 400 | 409 | 503; error: string; changed?: PlanChanged[] };

/**
 * Why a card can never be applied as written (400): the race day, the date range, a fixed day, values.
 * A date that has passed since the card was written is not here but a 409 (the card is stale, not wrong). `makeup`: the ids
 * moved forward from the past (a fixed day does not hold them).
 */
function hardConflict(
  items: ProposalItem[], rows: Map<string, PlannedSessionRow & { done: boolean }>, race: string, today: string, fixed: Set<number>,
  makeup: Set<string>,
): string | null {
  const lastDay = addDays(race, -1);
  for (const it of items) {
    const op = it.op ?? "change";
    if (op === "add") {
      const ns = it.new_session;
      if (!ns || !isValidDate(ns.scheduled_date) || ns.scheduled_date < today || ns.scheduled_date > lastDay) return "a new session must be dated from today to the day before the race";
      if (!PROPOSAL_TYPES.has(ns.type)) return "a new session cannot be the race";
      continue;
    }
    const row = it.session_id ? rows.get(it.session_id) : undefined;
    if (!row) continue; // gone: reported as changed
    if (row.type === "race" || row.scheduled_date === race) return "the race day cannot be changed";
    if (op === "change") {
      const field = it.field as string;
      const bad = field ? changeConflict({ type: row.type, race_date: race }, field, it.new) : "unsupported field";
      if (bad) return bad;
      if (field === "scheduled_date") {
        const to = it.new as string;
        if (to > lastDay) return "a session must be dated from today to the day before the race";
        if (!makeup.has(row.id) && fixed.has(weekdayOf(row.scheduled_date))) return `${shortDate(row.scheduled_date)} is a fixed day, it cannot move`;
      }
    }
  }
  return null;
}

/**
 * One session a day, on the plan as it is now: the card's moves, adds and removes laid over the live sessions. Checked after
 * the stale check (a card whose sessions changed under it is a 409, not a 400); a session that is gone is left out here.
 * Returns the first crowded date, or null.
 */
function crowdedOnLive(items: ProposalItem[], live: { id: string; scheduled_date: string }[]): string | null {
  const present = new Set(live.map((l) => l.id));
  const sim = new Map(live.map((l) => [l.id, { date: l.scheduled_date, type: "easy" as SessionType, label: null, dist: null }]));
  const was = new Map(sim);
  items.forEach((it, idx) => {
    const op = it.op ?? "change";
    if (op === "add" && it.new_session) { sim.set(`new:${idx}`, { date: it.new_session.scheduled_date, type: it.new_session.type, label: null, dist: null }); return; }
    const cur = it.session_id && present.has(it.session_id) ? sim.get(it.session_id) : undefined;
    if (!it.session_id || !cur) return;
    if (op === "remove") sim.delete(it.session_id);
    else if (it.field === "scheduled_date" && typeof it.new === "string") sim.set(it.session_id, { ...cur, date: it.new });
  });
  return crowdedDay(was, sim, items.filter((it) => it.op === "add" || (it.session_id && present.has(it.session_id))));
}

/**
 * Apply a card in one transaction: every change (a date move, a new version of the
 * session; add inserts; remove supersedes), the week descriptions, and the card's
 * status; the other pending cards of its A/B group become superseded.
 *
 * Refused without writing the plan:
 *  - 409 plan_changed — a session of the card was changed by something else, was
 *    completed, or its date has passed since the card was written. The card is marked
 *    stale (with the reason) and the list says which sessions.
 *  - 400 — the card breaks a hard rule: it touches the race day, leaves the date range,
 *    moves a session off a fixed day, or carries a value that does not fit.
 *  - 409 — the card is not pending any more.
 */
export async function applyProposal(p: ProposalRow, today: string): Promise<ApplyResult> {
  return withTransaction(async (q): Promise<ApplyResult> => {
    const [plan] = await q<{ id: string; race_date: string }>(
      "select id, to_char(race_date, 'YYYY-MM-DD') as race_date from plans where user_id = $1 and status = 'active' order by plans.race_date limit 1",
      [p.user_id],
    );
    // One card at a time per plan, taken before any row lock: two cards applied together queue here instead of each holding
    // some rows (or one holding its A/B partner's proposal row) and waiting for the other's.
    if (plan) {
      // Whoever holds the lock only runs short queries, so a long wait means something is wrong: say "try again" instead of hanging until the Lambda times out.
      await q("set local lock_timeout = '5s'");
      try {
        await q("select pg_advisory_xact_lock(hashtext($1))", [`plan:${plan.id}`]);
      } catch (err) {
        if ((err as { code?: string }).code === "55P03") return { ok: false, status: 503, error: "the plan is being changed by another request, try again" }; // lock_timeout; the transaction is rolled back, nothing was written
        throw err;
      }
      await q("set local lock_timeout = 0");
    }
    const [locked] = await q<{ status: string }>("select status from proposals where id = $1 and user_id = $2 for update", [p.id, p.user_id]);
    if (!locked || locked.status !== "pending") return { ok: false, status: 409, error: `already ${locked?.status ?? "gone"}` };
    if (!plan) return { ok: false, status: 409, error: "no active plan" };

    // The sessions the card names, locked, with whether they are done.
    const ids = [...new Set(p.items.map((i) => i.session_id).filter((id): id is string => !!id))];
    const found = ids.length
      ? await q<PlannedSessionRow & { done: boolean }>(
          `select ps.*, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
                  exists (select 1 from activities a where a.session_id = ps.id and a.match_status <> 'ignored') as done
             from planned_sessions ps join plans pl on pl.id = ps.plan_id
            where ps.id = any($1::uuid[]) and pl.user_id = $2 and ps.plan_id = $3 order by ps.id for update of ps`,
          [ids, p.user_id, plan.id],
        )
      : [];
    const rows = new Map(found.map((r) => [r.id, r]));
    const constraints = await q<ConstraintRow>("select kind, weekday from constraints where user_id = $1 and status = 'active' and (end_date is null or end_date >= $2)", [p.user_id, today]);
    const weeks = await q<PlanWeekRow>("select week_no, to_char(week_start, 'YYYY-MM-DD') as week_start, to_char(week_end, 'YYYY-MM-DD') as week_end, phase, focus from plan_weeks where plan_id = $1 order by week_no", [plan.id]);
    const live = await q<{ id: string; scheduled_date: string }>("select id, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions where plan_id = $1 and superseded = false", [plan.id]);

    // 補課: a session whose date is already past, moved forward by a card written as a make-up (`makeup` is set when the card is
    // checked, from the date it had then). A card that was not a make-up and whose session has since passed is stale, below.
    const dateItemOf = (id: string) => p.items.find((i) => i.session_id === id && i.field === "scheduled_date");
    const makeup = new Set(ids.filter((id) => {
      const row = rows.get(id);
      return !!row && !row.superseded && row.scheduled_date < today && dateItemOf(id)?.makeup === true;
    }));

    const hard = hardConflict(p.items, rows, plan.race_date, today, fixedWeekdays(constraints), makeup);
    if (hard) return { ok: false, status: 400, error: hard };
    if ((p.weeks ?? []).some((w) => !touchedWeekNos(weeks, p.items).has(w.week_no))) return { ok: false, status: 400, error: "a week description for a week this card does not touch" };

    // Anything that moved under the card since it was written?
    const changed: (PlanChanged & { text: string })[] = [];
    for (const id of ids) {
      const item = p.items.find((i) => i.session_id === id)!;
      const row = rows.get(id);
      const day = `${item.date ? `${shortDate(item.date)} ` : ""}${item.label ?? ""}`;
      const to = dateItemOf(id)?.new;
      let why: "changed" | "completed" | null = null, text = "";
      if (!row || row.superseded) { why = "changed"; text = `${day} 在這張卡之後被改過`; }
      else if (row.done) { why = "completed"; text = `${day} 已完成`; }
      else if (row.scheduled_date < today && !makeup.has(id)) { why = "changed"; text = `${day} 的日期已過`; }
      else if (typeof to === "string" && to < today) { why = "changed"; text = `${day} 要移到的 ${shortDate(to)} 已經過了`; }
      if (why) changed.push({ session_id: id, label: item.label, date: row?.scheduled_date ?? item.date, why, text });
    }
    if (changed.length) {
      await q("update proposals set status = 'stale', stale_reason = $2, decided_at = now() where id = $1", [p.id, changed.map((c) => c.text).join("；")]);
      return { ok: false, status: 409, error: "plan_changed", changed: changed.map(({ text: _text, ...c }) => c) };
    }

    const crowded = crowdedOnLive(p.items, live);
    if (crowded) return { ok: false, status: 400, error: `two sessions on ${crowded}` };

    // Apply in the order written, except that a make-up's date move goes first (the session is still in the past until it is
    // moved; any change to it comes after) and a type change goes before the other changes (it clears the pace and
    // heart-rate targets of the old type; a pace the same card sets afterwards must survive). Two changes to the same
    // session chain: the second works on the version the first wrote. `items` keeps the card's own order.
    const latest = new Map<string, string>(); // proposed session id -> current version id
    const items: ProposalItem[] = new Array(p.items.length);
    const rank = (i: ProposalItem) => (i.field === "scheduled_date" && i.session_id && makeup.has(i.session_id) ? 0 : i.field === "type" ? 1 : 2);
    const order = p.items.map((_, i) => i).sort((a, b) => rank(p.items[a]) - rank(p.items[b]) || a - b);
    const madeUp = new Map<string, number | null>(); // original session id -> the week its make-up is booked in
    for (const i of order) {
      const item = p.items[i];
      const op = item.op ?? "change";
      if (op === "add") {
        const id = await insertSession(q, plan.id, item.new_session!);
        items[i] = { ...item, applied_session_id: id };
        continue;
      }
      const currentId = latest.get(item.session_id as string) ?? (item.session_id as string);
      const [old] = await q<PlannedSessionRow>(
        "select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions where id = $1 and plan_id = $2 and superseded = false for update",
        [currentId, plan.id],
      );
      if (!old) throw new Error(`session ${currentId} vanished inside the transaction`); // locked above: cannot happen
      if (op === "remove") {
        // The session was a make-up: the one it replaced is a plain skipped session again.
        await q("update planned_sessions set superseded = false, moved_to_session_id = null where moved_to_session_id = $1", [old.id]);
        await q("update planned_sessions set superseded = true where id = $1", [old.id]);
        items[i] = { ...item };
        continue;
      }
      if (item.field === "scheduled_date" && makeup.has(item.session_id as string) && !latest.has(item.session_id as string)) {
        if (old.moved_from_session_id) {
          // A make-up that was not run either, moved again: the row it replaced keeps pointing at its latest version, the week stays.
          const id = await applyChange(q, old, "scheduled_date", item.new);
          latest.set(item.session_id as string, id);
          madeUp.set(item.session_id as string, old.counts_in_week_no);
          items[i] = { ...item, applied_session_id: id, makeup: true, counts_in_week_no: old.counts_in_week_no };
        } else {
          const made = await applyMakeup(q, plan.id, old, item.new as string, weeks);
          latest.set(item.session_id as string, made.id);
          madeUp.set(item.session_id as string, made.counts_in_week_no);
          items[i] = { ...item, applied_session_id: made.id, makeup: true, counts_in_week_no: made.counts_in_week_no };
        }
        continue;
      }
      const id = await applyChange(q, old, item.field as ProposalField, item.new);
      latest.set(item.session_id as string, id);
      items[i] = { ...item, applied_session_id: id };
    }
    // Several changes to one session: every row points at the version that came out last.
    for (const it of items) if (it.applied_session_id && it.session_id && latest.has(it.session_id)) it.applied_session_id = latest.get(it.session_id);
    for (const w of p.weeks ?? []) {
      await q("update plan_weeks set phase = coalesce($3, phase), focus = coalesce($4, focus) where plan_id = $1 and week_no = $2", [plan.id, w.week_no, w.phase, w.focus]);
      if (w.phase) await q("update planned_sessions set phase = $3 where plan_id = $1 and week_no = $2 and superseded = false", [plan.id, w.week_no, w.phase]);
    }
    // A make-up answers the weekly review's open question about that session ("沒跑" or "還沒同步"): closed as skipped, with no
    // rerun (the week's review stays as it is; the model is not called).
    if (madeUp.size) {
      const dates = new Set(p.items.filter((i) => i.session_id && madeUp.has(i.session_id) && i.date).map((i) => i.date as string));
      const messages = await q<CoachMessageRow>(
        `select * from coach_messages where user_id = $1 and kind = 'weekly' and meta @> '{"asks":[{"state":"open"}]}'::jsonb order by created_at for update`,
        [p.user_id],
      );
      for (const m of messages) {
        const meta = (m.meta ?? {}) as unknown as WeeklyMessageMeta;
        let touched = false;
        for (const a of meta.asks ?? []) {
          if (a.state === "open" && (madeUp.has(a.session_id) || dates.has(a.date))) { a.state = "skipped"; touched = true; }
        }
        if (touched) await q("update coach_messages set meta = $2 where id = $1", [m.id, JSON.stringify(meta)]);
      }
    }
    await q("update proposals set status = 'applied', decided_at = now(), items = $2 where id = $1", [p.id, JSON.stringify(items)]);
    const superseded = p.group_id
      ? (await q<{ id: string }>(
          "update proposals set status = 'superseded', decided_at = now() where group_id = $1 and user_id = $2 and id <> $3 and status = 'pending' returning id",
          [p.group_id, p.user_id, p.id],
        )).map((r) => r.id)
      : [];
    return { ok: true, items, superseded };
  });
}

/** Woo's few lines after the athlete applied a card (template; no model). */
export async function postProposalApplied(userId: string, items: ProposalItem[], weeks: ProposalWeek[] = []): Promise<void> {
  const ids = items.map((i) => i.applied_session_id).filter((id): id is string => !!id);
  const rows = ids.length
    ? await query<PlannedSessionRow>(`select *, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date from planned_sessions where id = any($1::uuid[])`, [ids])
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  // The final state of each touched session once, in the order the card lists them.
  const seen = new Set<string>();
  const parts: string[] = [];
  const makeups = new Map(items.filter((i) => i.makeup && i.session_id).map((i) => [i.session_id as string, i]));
  for (const i of [...items].reverse()) {
    const op = i.op ?? "change";
    const key = i.session_id ?? i.applied_session_id ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    if (op === "remove") { parts.unshift(`${i.date ? `${shortDate(i.date)} ` : ""}${i.label ?? ""} 拿掉了`); continue; }
    const s = i.applied_session_id ? byId.get(i.applied_session_id) : undefined;
    const made = i.session_id ? makeups.get(i.session_id) : undefined;
    if (made && s) {
      // A make-up: "10/27 的 Easy 5 km 補到 10/28，算在第 8 週" (the label is the session as it was proposed).
      parts.unshift(`${made.date ? `${shortDate(made.date)} 的 ` : ""}${made.label ?? ""} 補到 ${shortDate(s.scheduled_date)}${made.counts_in_week_no != null ? `，算在第 ${made.counts_in_week_no} 週` : ""}`);
      continue;
    }
    if (s) parts.unshift(`${shortDate(s.scheduled_date)} 是${sessionLabel(s)}`);
  }
  const shown = parts.slice(0, 5);
  const more = parts.length > shown.length ? `，另外還有 ${parts.length - shown.length} 項` : "";
  const wk = weeks.length ? `第 ${weeks.map((w) => w.week_no).join("、")} 週的描述也更新了。` : "";
  const body = shown.length ? `改好了，課表上${shown.join("、")}${more}。` : "改好了。";
  await postCoachMessage({ user_id: userId, role: "coach", kind: "chat", text: `${body}${wk}` });
}
