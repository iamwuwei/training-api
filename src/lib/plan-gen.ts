import { randomUUID } from "node:crypto";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { query, queryOne, withTransaction } from "./db";
import { hasHistorySource } from "./history-summary";
import { isValidDate, shortDate } from "./labels";
import { LONG_UP_M, NEAR_RACE_DAYS, NEAR_RACE_LONG_M, normalizeType, WEEK_UP_PCT } from "./proposals";
import { WEEKDAY_ZH, weekdayOf } from "./constraints";
import type { AthleteProfile, ConstraintRow, DraftFlag, DraftSession, DraftWeek, PlanDraftRow, PlanGenJob, RawChunk, RawSkeleton } from "../types";
import type { ApiAthleteProfile, ApiDraftSession, ApiPlanDraft, PlanIntake, SessionType } from "../../types/api";

// ai-plan-generation: Woo writes a whole plan from an intake form and the athlete's last 12 weeks (01b). This file is the part
// without a model: the form's validation, the week/chunk arithmetic, the checks every model answer must pass, the flags, the
// draft's life (create / read / resume / discard / adopt) and its projection for the app. The prompts are in plan-gen-prompts.ts,
// the worker's steps in plan-gen-run.ts. Nothing here names a Strava table, column or call: history comes from history-summary.ts.

// ---- constants (01b §8; the call caps are enforced in plan-gen-run.ts spendCall) ----------------------------------------------

export const PLAN_GEN_CHUNK_WEEKS = 4;
export const PLAN_GEN_MIN_DAYS = 28;
export const PLAN_GEN_MAX_DAYS = 140;
export const PLAN_GEN_MAX_CALLS = 12;
export const PLAN_GEN_MAX_RESUMES = 2;
export const PLAN_GEN_READY_TTL_DAYS = 7;
export const PLAN_GEN_STALL_MIN = 15;
export const PLAN_GEN_RETRY_PER_STEP = 1;
export const PLAN_GEN_DAILY_LIMIT_DEFAULT = 3;
export const DRAFT_LIMITS = { name: 40, notes: 200, label: 30, content: 120, note: 200, phase: 60, focus: 150, key: 80, summary: 600 } as const;
/** At most this many flags per draft (week + session lines); a broken output must not blow up the response. */
export const MAX_FLAGS = 60;
/** Total flags (before the cap) from which the plan-level line is added. */
export const MANY_FLAGS = 8;

/** Unset = 3; "0" = the feature is off; a whole number = that cap. A bad value ("abc", "-1", "1.5") is 3, never "off" and never "unlimited". */
let warnedLimit: string | undefined;
export function parseDailyLimit(raw: string | undefined): number {
  if (raw === undefined) return PLAN_GEN_DAILY_LIMIT_DEFAULT;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < 0 || n > 1000) {
    if (warnedLimit !== raw) console.warn(`PLAN_GEN_DAILY_LIMIT=${JSON.stringify(raw).slice(0, 40)} is not a whole number, using ${PLAN_GEN_DAILY_LIMIT_DEFAULT}`);
    warnedLimit = raw;
    return PLAN_GEN_DAILY_LIMIT_DEFAULT;
  }
  return n;
}

// ---- small helpers -------------------------------------------------------------------------------------------------------

export const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const mondayOf = (iso: string) => addDays(iso, -((weekdayOf(iso) + 6) % 7));
export const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec) % 60).padStart(2, "0")}`;

/** Characters that hide text, written as escapes so no editor can swallow them: C0/C1 controls other than whitespace (\u0009-\u000d, \u0085), the Arabic letter mark \u061c, zero-width and direction marks \u200b-\u200f, bidi overrides \u202a-\u202e, word joiner \u2060, bidi isolates \u2066-\u2069. */
const HIDDEN = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069]/g;
/** One line of plain text from anything the athlete or the model wrote: no hiding characters, every kind of line break and run of whitespace one space. */
export function oneLine(v: unknown): string {
  return typeof v === "string" ? v.replace(HIDDEN, "").replace(/[\s\u0085]+/g, " ").trim() : "";
}
const MD = /[*`#><]/g;
const URL_RE = /https?:\/\/\S+/gi;
/** A model string as it may be stored and shown: one line, no markdown characters, no links. */
export const modelText = (v: unknown): string => oneLine(typeof v === "string" ? v.replace(URL_RE, "") : v).replace(MD, "").replace(/ {2,}/g, " ").trim();
const chars = (s: string) => [...s].length;
const clip = (s: string, n: number) => (chars(s) > n ? [...s].slice(0, n).join("") : s);

// ---- the form ------------------------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const EXPERIENCE = new Set(["first", "finished", "several"]);
const MINUTES = new Set([30, 45, 60, 90]);

/** The form as a clean PlanIntake, or the fixed code (a string) that says what is wrong. Codes are 01b §4c, in its order. */
export function validateIntake(raw: unknown, today: string): PlanIntake | string {
  if (!isObj(raw)) return "invalid intake";
  const goals = raw.goals;
  if (!Array.isArray(goals) || goals.length !== 1 || !isObj(goals[0]) || goals[0].kind !== "race" || goals[0].priority !== "A") return "goals must have one race goal";
  const g = goals[0];
  const name = oneLine(g.name).replace(MD, "").replace(/ {2,}/g, " ").trim();
  if (!name || chars(name) > DRAFT_LIMITS.name) return "name is empty or too long";
  if (typeof g.race_date !== "string" || !isValidDate(g.race_date)) return "race_date must be YYYY-MM-DD";
  const start = raw.start_date;
  if (typeof start !== "string" || !isValidDate(start) || start < today || start > addDays(today, 14)) return "start_date must be today to today + 14";
  const span = daysBetween(start, g.race_date);
  if (span < PLAN_GEN_MIN_DAYS) return "race is less than 4 weeks away";
  if (span > PLAN_GEN_MAX_DAYS) return "race is more than 20 weeks away";
  const d = g.distance_m;
  if (typeof d !== "number" || !Number.isInteger(d) || d < 1000 || d > 100_000) return "distance_m must be 1000-100000";
  const t = g.target_time_sec;
  if (t !== null) {
    if (typeof t !== "number" || !Number.isInteger(t) || t <= 0) return "target_time_sec must give 2:30-12:00 per km";
    const pace = t / (d / 1000);
    if (pace < 150 || pace > 720) return "target_time_sec must give 2:30-12:00 per km";
  }
  const days = raw.days_per_week;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 2 || days > 6) return "days_per_week must be 2-6";
  const rest = raw.fixed_rest_weekdays;
  if (!Array.isArray(rest) || rest.some((w) => typeof w !== "number" || !Number.isInteger(w) || w < 0 || w > 6) || new Set(rest).size !== rest.length || rest.length > 7 - days) {
    return "fixed_rest_weekdays must be 0-6, unique, at most 7 - days_per_week";
  }
  if (typeof raw.experience !== "string" || !EXPERIENCE.has(raw.experience)) return "experience must be first, finished or several";
  const minutes = raw.weekday_minutes;
  if (minutes !== null && !(typeof minutes === "number" && MINUTES.has(minutes))) return "weekday_minutes must be 30, 45, 60, 90 or null";
  if (raw.notes !== undefined && raw.notes !== null && typeof raw.notes !== "string") return "invalid intake";
  const notes = oneLine(raw.notes ?? "");
  if (chars(notes) > DRAFT_LIMITS.notes) return "notes too long";
  return {
    goals: [{ kind: "race", priority: "A", name, race_date: g.race_date, distance_m: d, target_time_sec: t === null ? null : (t as number) }],
    days_per_week: days,
    fixed_rest_weekdays: [...(rest as number[])].sort((a, b) => a - b),
    experience: raw.experience as PlanIntake["experience"],
    weekday_minutes: minutes === null ? null : (minutes as PlanIntake["weekday_minutes"]),
    notes,
    start_date: start,
  };
}

// ---- weeks and chunks ----------------------------------------------------------------------------------------------------

/** Monday-to-Sunday weeks from the start date to the race day (the first can start mid-week, the last ends on the race day). Only week_no / start / end are filled. */
export function planWeeks(start: string, race: string): DraftWeek[] {
  const weeks: DraftWeek[] = [];
  for (let cur = start; cur <= race; ) {
    const end = addDays(mondayOf(cur), 6) < race ? addDays(mondayOf(cur), 6) : race;
    weeks.push({ week_no: weeks.length + 1, week_start: cur, week_end: end, phase: "", focus: "", km: 0, long_km: 0, key: "", taper: false });
    cur = addDays(end, 1);
  }
  return weeks;
}

export function chunkRanges(weeks: Pick<DraftWeek, "week_no">[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let i = 0; i < weeks.length; i += PLAN_GEN_CHUNK_WEEKS) out.push({ from: weeks[i].week_no, to: weeks[Math.min(i + PLAN_GEN_CHUNK_WEEKS, weeks.length) - 1].week_no });
  return out;
}

/** Every date from `from` to `to`, inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The days the athlete cannot train: his fixed weekdays and the remembered period limits (出國 11/21〜23), inside [from, to]. The race day is never one. */
export function restDates(intake: PlanIntake, constraints: Pick<ConstraintRow, "kind" | "start_date" | "end_date">[], dates: string[]): Set<string> {
  const race = intake.goals[0].race_date;
  const fixed = new Set(intake.fixed_rest_weekdays);
  const periods = constraints.filter((c) => c.kind === "period" && (c.start_date || c.end_date));
  const out = new Set<string>();
  for (const d of dates) {
    if (d === race) continue;
    if (fixed.has(weekdayOf(d)) || periods.some((c) => (!c.start_date || d >= c.start_date) && (!c.end_date || d <= c.end_date))) out.add(d);
  }
  return out;
}

// ---- validating the model's answers --------------------------------------------------------------------------------------

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The skeleton as the draft's weeks, or one English sentence (the retry's feedback). `weeks` is planWeeks(): the week numbers and dates are ours. */
export function validateSkeleton(raw: unknown, weeks: DraftWeek[]): { summary: string; weeks: DraftWeek[] } | string {
  const r = raw as RawSkeleton | null;
  if (!isObj(r) || !Array.isArray(r.weeks)) return "weeks must be an array";
  if (r.weeks.length !== weeks.length) return `weeks must have exactly ${weeks.length} items, got ${r.weeks.length}`;
  const byNo = new Map<number, Record<string, unknown>>();
  for (const w of r.weeks) {
    if (!isObj(w) || num(w.week_no) == null || !Number.isInteger(w.week_no)) return "every week needs an integer week_no";
    const n = w.week_no as number;
    if (n < 1 || n > weeks.length) return `unexpected week_no ${n}`;
    if (byNo.has(n)) return `duplicate week_no ${n}`;
    byNo.set(n, w);
  }
  const out: DraftWeek[] = [];
  for (const base of weeks) {
    const w = byNo.get(base.week_no);
    if (!w) return `missing week_no ${base.week_no}`;
    const km = num(w.km), longKm = num(w.long_km);
    if (km == null || km < 0 || km > 300) return `week ${base.week_no}: km must be 0-300`;
    if (longKm == null || longKm < 0) return `week ${base.week_no}: long_km must be 0 or more`;
    if (longKm > km + 0.1) return `week ${base.week_no}: long_km must not exceed km`;
    const phase = modelText(w.phase), focus = modelText(w.focus), key = modelText(w.key);
    if (!phase || chars(phase) > DRAFT_LIMITS.phase) return `week ${base.week_no}: phase must be 1-${DRAFT_LIMITS.phase} characters`;
    if (!focus || chars(focus) > DRAFT_LIMITS.focus) return `week ${base.week_no}: focus must be 1-${DRAFT_LIMITS.focus} characters`;
    if (chars(key) > DRAFT_LIMITS.key) return `week ${base.week_no}: key must be at most ${DRAFT_LIMITS.key} characters`;
    if (typeof w.taper !== "boolean") return `week ${base.week_no}: taper must be true or false`;
    out.push({ ...base, phase, focus, km: Math.round(km * 10) / 10, long_km: Math.round(longKm * 10) / 10, key, taper: w.taper });
  }
  const summary = clip(modelText(r.summary), DRAFT_LIMITS.summary);
  if (!summary) return "summary must not be empty";
  return { summary, weeks: out };
}

export interface ChunkContext {
  /** Every date of this chunk, ascending. */
  dates: string[];
  /** Fixed rest days (form weekdays + period limits) inside the chunk. Never contains the race day. */
  fixedRest: Set<string>;
  raceDate: string;
  raceDistance: number;
  /** max(45 000, race distance) */
  maxDistance: number;
  weeks: Pick<DraftWeek, "week_no" | "week_start" | "week_end">[];
}

const SESSION_TYPES = new Set<string>(["easy", "long", "tempo", "interval", "rest", "race"]);
const shortStr = (v: unknown) => oneLine(String(v)).slice(0, 24);

/** One chunk's sessions as DraftSessions (ascending by date), or one English sentence naming what is wrong. Hard checks reject, text lengths are cut. */
export function validateChunk(raw: unknown, ctx: ChunkContext): DraftSession[] | string {
  const r = raw as RawChunk | null;
  if (!isObj(r) || !Array.isArray(r.sessions)) return "sessions must be an array";
  const expected = new Set(ctx.dates);
  const seen = new Map<string, Record<string, unknown>>();
  const problems: string[] = [];
  for (const s of r.sessions) {
    const date = isObj(s) && typeof s.date === "string" ? s.date : "";
    if (!isObj(s) || !isValidDate(date)) { problems.push("every session needs a date as YYYY-MM-DD"); continue; }
    if (!expected.has(date)) problems.push(`unexpected ${date}`);
    else if (seen.has(date)) problems.push(`duplicate ${date}`);
    else seen.set(date, s);
  }
  for (const d of ctx.dates) if (!seen.has(d)) problems.push(`missing ${d}`);
  if (problems.length) return [...new Set(problems)].slice(0, 6).join("; ");

  const out: DraftSession[] = [];
  for (const date of ctx.dates) {
    const s = seen.get(date)!;
    const type = normalizeType(s.type);
    if (typeof type !== "string" || !SESSION_TYPES.has(type)) return `${date}: type must be easy, long, tempo, interval, rest or race, got ${shortStr(s.type)}`;
    if (date === ctx.raceDate && type !== "race") return `${date} is the race day: type must be race`;
    if (date !== ctx.raceDate && type === "race") return `${date} is not the race day: type must not be race`;
    if (ctx.fixedRest.has(date) && type !== "rest") return `${date} is a fixed rest day: type must be rest`;

    const dist = num(s.distance_m);
    if (dist == null || dist < 0 || dist > ctx.maxDistance) return `${date}: distance_m must be 0-${ctx.maxDistance}`;
    const distance = Math.round(dist);
    if (type === "race" && Math.abs(distance - ctx.raceDistance) > ctx.raceDistance * 0.01) return `${date}: the race's distance_m must be ${ctx.raceDistance}`;
    if (type !== "rest" && type !== "race" && distance < 1000) return `${date}: distance_m must be at least 1000 on a ${type} day`;

    let pMin = Math.round(num(s.pace_min_sec_km) ?? 0), pMax = Math.round(num(s.pace_max_sec_km) ?? 0);
    for (const p of [pMin, pMax]) if (p !== 0 && (p < 180 || p > 720)) return `${date}: pace must be 0 or 180-720 seconds per km`;
    if (pMin && pMax && pMin > pMax) return `${date}: pace_min_sec_km must not exceed pace_max_sec_km`;
    if (!pMin !== !pMax) pMin = pMax = pMin || pMax;
    let hMin = Math.round(num(s.hr_min) ?? 0), hMax = Math.round(num(s.hr_max) ?? 0);
    for (const h of [hMin, hMax]) if (h !== 0 && (h < 80 || h > 220)) return `${date}: heart rate must be 0 or 80-220`;
    if (hMin && hMax && hMin > hMax) return `${date}: hr_min must not exceed hr_max`;
    if (!hMin !== !hMax) hMin = hMax = hMin || hMax;

    const label = modelText(s.label), content = modelText(s.content);
    if (!label) return `${date}: label must not be empty`;
    if (!content) return `${date}: content must not be empty`;
    const note = clip(modelText(s.note), DRAFT_LIMITS.note);
    const week = ctx.weeks.find((w) => date >= w.week_start && date <= w.week_end);
    if (!week) return `${date} is outside the chunk's weeks`;
    const rest = type === "rest";
    out.push({
      date, type: type as SessionType, label: clip(label, DRAFT_LIMITS.label), content: clip(content, DRAFT_LIMITS.content), note: note || null,
      distance_m: rest || distance === 0 ? null : type === "race" ? ctx.raceDistance : distance, // the race is the race's distance (01b §3d), not the model's +-1%
      pace_min_sec_km: rest || !pMin ? null : pMin, pace_max_sec_km: rest || !pMax ? null : pMax,
      hr_min: rest || !hMin ? null : hMin, hr_max: rest || !hMax ? null : hMax,
      week_no: week.week_no,
    });
  }
  return out;
}

// ---- flags (01b §5.5: the system computes them, the model only plans) -----------------------------------------------------

const km1 = (m: number) => (Math.round(m / 100) / 10).toFixed(1);
const isRunDay = (s: Pick<DraftSession, "type">) => s.type !== "rest" && s.type !== "race";

function distanceName(m: number): string {
  if (Math.abs(m - 42195) <= 422) return "全馬";
  if (Math.abs(m - 21097) <= 211) return "半馬";
  if (Math.abs(m - 10000) <= 100) return "10 km";
  if (Math.abs(m - 5000) <= 50) return "5 km";
  return `${Math.round(m / 100) / 10} km`;
}

/**
 * The amber lines of a draft, hung where they belong: the whole plan, one week, one day. Sentences carry no week number and no date of
 * their own (the place they hang on says it). Pure; the constants are the ones the plan cards use (proposals.ts).
 */
export function computeDraftFlags(sessions: DraftSession[], weeks: DraftWeek[], intake: PlanIntake, profile: AthleteProfile | null): DraftFlag[] {
  const goal = intake.goals[0];
  const sorted = [...sessions].sort((a, b) => (a.date < b.date ? -1 : 1));
  const weekFlags: DraftFlag[] = [];
  const dayFlags: DraftFlag[] = [];
  const volume = new Map<number, number>();
  const runDays = new Map<number, number>();
  for (const s of sorted) {
    if (isRunDay(s)) {
      volume.set(s.week_no, (volume.get(s.week_no) ?? 0) + (s.distance_m ?? 0));
      runDays.set(s.week_no, (runDays.get(s.week_no) ?? 0) + 1);
    }
  }
  const raceWeek = weeks.find((w) => goal.race_date >= w.week_start && goal.race_date <= w.week_end)?.week_no;

  for (const w of weeks) {
    const cur = volume.get(w.week_no) ?? 0, prev = volume.get(w.week_no - 1) ?? 0;
    if (prev > 0 && cur * 100 >= prev * (100 + WEEK_UP_PCT)) weekFlags.push({ scope: "week", week_no: w.week_no, text: `這週 ${km1(cur)} km，比上週多 ${Math.round(((cur - prev) / prev) * 100)}%` });
    if (w.taper && w.week_no > 1 && cur > prev) weekFlags.push({ scope: "week", week_no: w.week_no, text: `這週是減量週，卻比上週多 ${km1(cur - prev)} km` });
    // A week that starts mid-week (the first one) has fewer days to train on: ask for min(what he said, the days it has that are not his rest days).
    const canTrain = dateRange(w.week_start, w.week_end).filter((d) => !intake.fixed_rest_weekdays.includes(weekdayOf(d))).length;
    if (w.week_no !== raceWeek && (runDays.get(w.week_no) ?? 0) !== Math.min(intake.days_per_week, canTrain)) {
      weekFlags.push({ scope: "week", week_no: w.week_no, text: `這週排 ${runDays.get(w.week_no) ?? 0} 天，你說每週 ${intake.days_per_week} 天` });
    }
  }

  let lastLong: DraftSession | undefined;
  /** The longest run he has done or this draft has already planned: a long run is only "longer than he has done" against this, so a plan that builds 2 km a week is not flagged every week. */
  let longestSoFar: number | null = profile?.longest ? profile.longest.km * 1000 : null;
  const lastRace = profile?.last_race ?? null;
  const recoveryDays = lastRace ? (lastRace.distance_m >= 40000 ? 14 : lastRace.distance_m >= 20000 ? 7 : 4) : 0;
  for (const s of sorted) {
    const mine: string[] = [];
    if (s.type === "long" && s.distance_m != null) {
      const ref = longestSoFar;
      if (ref != null && s.distance_m - ref >= LONG_UP_M) mine.push(`比你目前最長多 ${km1(s.distance_m - ref)} km（${km1(ref)} → ${km1(s.distance_m)} km）`);
      const d = daysBetween(s.date, goal.race_date);
      if (s.distance_m >= NEAR_RACE_LONG_M && d <= NEAR_RACE_DAYS) mine.push(`離比賽只剩 ${d} 天，這天有 ${km1(s.distance_m)} km 的長跑`);
      if (lastLong && daysBetween(lastLong.date, s.date) < 6) mine.push(`跟上一次長跑只隔 ${daysBetween(lastLong.date, s.date)} 天`);
    }
    if (s.type === "long") {
      lastLong = s;
      if (s.distance_m != null) longestSoFar = Math.max(longestSoFar ?? 0, s.distance_m);
    }
    if (isRunDay(s) && s.distance_m != null && s.distance_m > goal.distance_m) mine.push(`這堂 ${km1(s.distance_m)} km 超過比賽距離`);
    if (lastRace && ["long", "tempo", "interval"].includes(s.type) && daysBetween(lastRace.date, s.date) <= recoveryDays) {
      mine.push(`${shortDate(lastRace.date)} 剛比完${distanceName(lastRace.distance_m)}，這天就有${s.label}`);
    }
    for (const text of mine) dayFlags.push({ scope: "session", date: s.date, text });
  }

  const total = weekFlags.length + dayFlags.length;
  const kept = [...weekFlags, ...dayFlags].slice(0, MAX_FLAGS);
  return total >= MANY_FLAGS ? [{ scope: "plan", text: "旗標比較多，採用前看一下每週的量" }, ...kept] : kept;
}

/** Flags -> the three places the app reads them. A flag whose week or day is not in the draft is dropped (and logged), never a 500. */
export function flagsToApi(flags: DraftFlag[], weeks: Pick<DraftWeek, "week_no">[], sessions: Pick<DraftSession, "date">[]): { plan: string[]; byWeek: Map<number, string[]>; byDate: Map<string, string[]> } {
  const weekNos = new Set(weeks.map((w) => w.week_no));
  const dates = new Set(sessions.map((s) => s.date));
  const out = { plan: [] as string[], byWeek: new Map<number, string[]>(), byDate: new Map<string, string[]>() };
  const push = <K>(m: Map<K, string[]>, k: K, text: string) => m.set(k, [...(m.get(k) ?? []), text]);
  for (const f of flags) {
    if (f.scope === "plan") out.plan.push(f.text);
    else if (f.scope === "week" && f.week_no != null && weekNos.has(f.week_no)) push(out.byWeek, f.week_no, f.text);
    else if (f.scope === "session" && f.date != null && dates.has(f.date)) push(out.byDate, f.date, f.text);
    else console.warn(`plan flag dropped: scope ${f.scope} week ${f.week_no ?? "-"} date ${f.date ?? "-"} is not in the draft`);
  }
  return out;
}

// ---- steps ---------------------------------------------------------------------------------------------------------------

/** What the draft needs next: profile, then the skeleton, then chunk after chunk; null when all are in. Decided by the data, not by the message. */
export function nextStep(d: Pick<PlanDraftRow, "profile" | "skeleton" | "chunks_done" | "chunks_total">): PlanGenJob["step"] | null {
  if (!d.profile) return "profile";
  if (!d.skeleton) return "skeleton";
  if (d.chunks_total != null && d.chunks_done < d.chunks_total) return "chunk";
  return null;
}

export function stepJob(d: Pick<PlanDraftRow, "id" | "user_id" | "profile" | "skeleton" | "chunks_done" | "chunks_total">): PlanGenJob | null {
  const step = nextStep(d);
  if (!step) return null;
  return { type: "plan_gen", user_id: d.user_id, draft_id: d.id, step, ...(step === "chunk" ? { chunk: d.chunks_done } : {}) };
}

const sqs = new SQSClient({});
/** Queue one step. Throws when it cannot (the caller marks the draft failed or lets SQS retry the job that was running). */
export async function sendPlanGenJob(job: PlanGenJob): Promise<void> {
  if (!process.env.QUEUE_URL) throw new Error("QUEUE_URL is not set");
  await sqs.send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: JSON.stringify(job) }));
}

// ---- a draft's life ------------------------------------------------------------------------------------------------------

const DRAFT_SELECT = "select * from plan_drafts";

/** 'YYYY-MM-DD' of an instant in JST. */
const jstDate = (d: Date) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);

/**
 * The status the app sees (the ONE place that decides it):
 *  - a ready draft older than 7 days, or whose start day is over (JST), is expired (a preview of a plan that began in the past);
 *  - a pending one nobody touched for 15 minutes is a stalled failure;
 *  - a failed (or stalled) draft is only worth continuing on the day it was made, and while its start day is not over: otherwise expired.
 *    That is what keeps "36 model calls a person a day" true: 「繼續」 spends on the day's own 3 drafts, never on an old pile of failed ones.
 */
export function effectiveState(d: Pick<PlanDraftRow, "status" | "error_code" | "updated_at" | "intake" | "created_at">, now: Date): { status: PlanDraftRow["status"]; error_code: PlanDraftRow["error_code"] } {
  const idle = now.getTime() - new Date(d.updated_at).getTime();
  const startOver = !!d.intake?.start_date && d.intake.start_date < jstDate(now);
  if (d.status === "ready" && (idle > PLAN_GEN_READY_TTL_DAYS * 86_400_000 || startOver)) return { status: "expired", error_code: d.error_code };
  const failed = d.status === "failed" || (d.status === "pending" && idle > PLAN_GEN_STALL_MIN * 60_000);
  if (failed) {
    if (startOver || jstDate(new Date(d.created_at)) !== jstDate(now)) return { status: "expired", error_code: d.error_code };
    return { status: "failed", error_code: d.status === "failed" ? d.error_code : "stalled" };
  }
  return { status: d.status, error_code: d.error_code };
}

export type CreateResult =
  | { ok: true; draft: PlanDraftRow }
  | { ok: false; status: 409 | 429; error: string; draft_id?: string };

/** POST /plan-drafts after validation: the checks run in this order, under a per-user lock, so two taps make one draft. */
export async function createDraft(userId: string, intake: PlanIntake, today: string, dailyLimit: number): Promise<CreateResult> {
  return withTransaction(async (q): Promise<CreateResult> => {
    await q("select pg_advisory_xact_lock(hashtext($1))", [`plan-draft:${userId}`]);
    // A pending draft nobody touched for PLAN_GEN_STALL_MIN minutes is what the app already shows as "stalled": its job was lost. It must not
    // block a new one for ever (a stalled draft with no calls or no resumes left has no way out). Discarded, not failed: a failed one could still be
    // resumed next to the new draft, and one user would have two pending rows. It still counts in today's drafts.
    await q(
      "update plan_drafts set status = 'discarded', updated_at = now() where user_id = $1 and status = 'pending' and updated_at < now() - make_interval(mins => $2)",
      [userId, PLAN_GEN_STALL_MIN],
    );
    if (!(await hasHistorySource(q, userId))) return { ok: false, status: 409, error: "strava not connected" };
    const [{ n }] = await q<{ n: number }>(
      "select count(*)::int as n from plan_drafts where user_id = $1 and (created_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date",
      [userId],
    );
    if (n >= dailyLimit) return { ok: false, status: 429, error: "daily limit" };
    const [pending] = await q<{ id: string }>("select id from plan_drafts where user_id = $1 and status = 'pending' limit 1", [userId]);
    if (pending) return { ok: false, status: 409, error: "generating", draft_id: pending.id };
    const [active] = await q<{ id: string }>("select id from plans where user_id = $1 and status = 'active' and race_date >= $2 limit 1", [userId, today]);
    if (active) return { ok: false, status: 409, error: "has active plan" };
    const [draft] = await q<PlanDraftRow>(
      "insert into plan_drafts (id, user_id, mode, status, stage, intake) values ($1, $2, 'new', 'pending', 'profile', $3::jsonb) returning *",
      [randomUUID(), userId, JSON.stringify(intake)],
    );
    return { ok: true, draft };
  });
}

/** The user's own draft, expired ones written back as expired. Someone else's id and an unknown id are the same answer: undefined. */
export async function loadDraft(userId: string, id: string, now = new Date(Date.now())): Promise<PlanDraftRow | undefined> {
  const d = await queryOne<PlanDraftRow>(`${DRAFT_SELECT} where id = $1 and user_id = $2`, [id, userId]);
  if (d && d.status === "ready" && effectiveState(d, now).status === "expired") {
    await query("update plan_drafts set status = 'expired' where id = $1 and user_id = $2 and status = 'ready'", [id, userId]); // updated_at stays: it is when the draft was ready
    return { ...d, status: "expired" };
  }
  return d;
}

/** The newest pending / ready / failed draft, or undefined when there is none worth showing (an expired one is not). */
export async function loadLatestDraft(userId: string, now = new Date(Date.now())): Promise<PlanDraftRow | undefined> {
  const d = await queryOne<PlanDraftRow>(`${DRAFT_SELECT} where user_id = $1 and status in ('pending', 'ready', 'failed') order by created_at desc limit 1`, [userId]);
  if (!d) return undefined;
  if (effectiveState(d, now).status === "expired") {
    if (d.status === "ready") await query("update plan_drafts set status = 'expired' where id = $1 and user_id = $2 and status = 'ready'", [d.id, userId]);
    return undefined; // an expired one is not worth showing (a failed one from an earlier day included)
  }
  return d;
}

export type ResumeResult =
  | { ok: true; draft: PlanDraftRow; job: PlanGenJob }
  | { ok: false; status: 404 | 409; error: string; draft_id?: string };

/**
 * 「繼續」. Like createDraft it works under the user's lock, so "one draft at a time" and "3 drafts a day" hold here too:
 * only a failed draft made today whose start day is not over (effectiveState says so), only while nothing else of his is pending,
 * and only while he has no plan in progress. Lock order: this draft's row, then the user's advisory lock (the order adoptDraft uses);
 * createDraft takes the advisory lock first but never waits for a row (skip locked), so the three cannot wait for each other in a circle.
 */
export async function resumeDraft(userId: string, id: string, now = new Date(Date.now())): Promise<ResumeResult> {
  return withTransaction(async (q): Promise<ResumeResult> => {
    const [d] = await q<PlanDraftRow>(`${DRAFT_SELECT} where id = $1 and user_id = $2 for update`, [id, userId]);
    if (!d) return { ok: false, status: 404, error: "draft not found" };
    await q("select pg_advisory_xact_lock(hashtext($1))", [`plan-draft:${userId}`]);
    const state = effectiveState(d, now);
    if (state.status !== "failed") return { ok: false, status: 409, error: `draft is ${state.status}` };
    if (d.calls >= PLAN_GEN_MAX_CALLS) return { ok: false, status: 409, error: "calls exhausted" };
    if (d.resumes >= PLAN_GEN_MAX_RESUMES) return { ok: false, status: 409, error: "resume limit" };
    // Another stalled draft of his is dead (as createDraft treats it); a live one means he already has a draft being written.
    await q(
      "update plan_drafts set status = 'discarded', updated_at = now() where user_id = $1 and id <> $2 and status = 'pending' and updated_at < now() - make_interval(mins => $3)",
      [userId, id, PLAN_GEN_STALL_MIN],
    );
    const [other] = await q<{ id: string }>("select id from plan_drafts where user_id = $1 and status = 'pending' and id <> $2 limit 1", [userId, id]);
    if (other) return { ok: false, status: 409, error: "generating", draft_id: other.id };
    const [active] = await q<{ id: string }>("select id from plans where user_id = $1 and status = 'active' and race_date >= $2 limit 1", [userId, jstDate(now)]);
    if (active) return { ok: false, status: 409, error: "has active plan" };
    const job = stepJob(d);
    if (!job) return { ok: false, status: 409, error: "draft is failed" };
    const [next] = await q<PlanDraftRow>(
      "update plan_drafts set status = 'pending', resumes = resumes + 1, error_code = null, updated_at = now() where id = $1 and user_id = $2 returning *",
      [id, userId],
    );
    return { ok: true, draft: next, job };
  });
}

export async function discardDraft(userId: string, id: string): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
  const rows = await query("update plan_drafts set status = 'discarded', updated_at = now() where id = $1 and user_id = $2 and status <> 'adopted' returning id", [id, userId]);
  if (rows.length) return { ok: true };
  const d = await queryOne<{ status: string }>("select status from plan_drafts where id = $1 and user_id = $2", [id, userId]);
  return d ? { ok: false, status: 409, error: "draft is adopted" } : { ok: false, status: 404, error: "draft not found" };
}

/** The sending failed after the row was written: do not leave a draft pending that no job will ever move. */
export async function markSendFailed(id: string, userId: string): Promise<void> {
  await query("update plan_drafts set status = 'failed', error_code = 'model_failed', last_error = 'queue send failed', updated_at = now() where id = $1 and user_id = $2 and status = 'pending'", [id, userId]);
}

// ---- adopting ------------------------------------------------------------------------------------------------------------

/** "7:15〜7:45 / 心拍 140〜150"; null when the session has neither. The text on the preview and the text written to planned_sessions (one function). */
export function targetText(s: Pick<DraftSession, "pace_min_sec_km" | "pace_max_sec_km" | "hr_min" | "hr_max">): string | null {
  const pace = s.pace_min_sec_km != null && s.pace_max_sec_km != null ? `${mmss(s.pace_min_sec_km)}〜${mmss(s.pace_max_sec_km)}` : null;
  const hr = s.hr_min != null && s.hr_max != null ? `心拍 ${s.hr_min}〜${s.hr_max}` : null;
  return pace && hr ? `${pace} / ${hr}` : pace ?? hr;
}
const paceMid = (s: Pick<DraftSession, "pace_min_sec_km" | "pace_max_sec_km">) =>
  s.pace_min_sec_km != null && s.pace_max_sec_km != null ? Math.round((s.pace_min_sec_km + s.pace_max_sec_km) / 2) : null;

/** The values of one planned_sessions row (columns in PLANNED_SESSION_COLUMNS order). */
export function toPlannedSessionRow(s: DraftSession, planId: string, week: Pick<DraftWeek, "phase">): unknown[] {
  return [
    randomUUID(), planId, s.date, s.week_no, week.phase, s.label, s.type, s.content, s.note, targetText(s),
    s.distance_m, paceMid(s), s.pace_min_sec_km, s.pace_max_sec_km, s.hr_min, s.hr_max,
  ];
}
const PLANNED_SESSION_COLUMNS = "id, plan_id, scheduled_date, week_no, phase, label, type, content, note, target, target_distance_m, target_pace_sec_km, target_pace_min_sec_km, target_pace_max_sec_km, target_hr_min, target_hr_max, version, superseded";

export type AdoptResult = { ok: true; plan_id: string } | { ok: false; status: 409 | 503; error: string };

/**
 * Write the draft as the user's plan, in ONE transaction: the old plan whose race has passed becomes `finished`, the new plan, its
 * weeks and every day are inserted, the fixed rest weekdays become constraints (once), the draft becomes `adopted`. Nothing is deleted
 * (group_events point at planned_sessions). Adopting an adopted draft again answers the same plan id.
 */
export async function adoptDraft(d: Pick<PlanDraftRow, "id" | "user_id">, today: string, now = new Date(Date.now())): Promise<AdoptResult> {
  return withTransaction(async (q): Promise<AdoptResult> => {
    await q("set local lock_timeout = '5s'");
    let locked: PlanDraftRow | undefined;
    try {
      [locked] = await q<PlanDraftRow>(`${DRAFT_SELECT} where id = $1 and user_id = $2 for update`, [d.id, d.user_id]);
      await q("select pg_advisory_xact_lock(hashtext($1))", [`plan-draft:${d.user_id}`]);
    } catch (err) {
      if ((err as { code?: string }).code === "55P03") return { ok: false, status: 503, error: "busy" }; // lock_timeout; rolled back, nothing written
      throw err;
    }
    await q("set local lock_timeout = 0");
    if (!locked) return { ok: false, status: 409, error: "draft is gone" };
    if (locked.status === "adopted" && locked.adopted_plan_id) return { ok: true, plan_id: locked.adopted_plan_id };
    const state = effectiveState(locked, now).status;
    if (state !== "ready" || !locked.skeleton) return { ok: false, status: 409, error: `draft is ${state}` };

    const [active] = await q<{ id: string }>("select id from plans where user_id = $1 and status = 'active' and race_date >= $2 limit 1", [d.user_id, today]);
    if (active) return { ok: false, status: 409, error: "has active plan" };
    await q("update plans set status = 'finished' where user_id = $1 and status = 'active' and race_date < $2", [d.user_id, today]);

    const goal = locked.intake.goals[0];
    const planId = randomUUID();
    await q(
      "insert into plans (id, user_id, race_name, race_date, goal_time_sec, days_per_week, status) values ($1, $2, $3, $4, $5, $6, 'active')",
      [planId, d.user_id, goal.name, goal.race_date, goal.target_time_sec, locked.intake.days_per_week],
    );
    for (const w of locked.skeleton.weeks) {
      const focus = clip(w.key && !w.focus.includes(w.key) ? `${w.focus}；關鍵課：${w.key}` : w.focus, DRAFT_LIMITS.focus);
      await q(
        "insert into plan_weeks (id, plan_id, week_no, week_start, week_end, phase, focus) values ($1, $2, $3, $4, $5, $6, $7)",
        [randomUUID(), planId, w.week_no, w.week_start, w.week_end, clip(w.phase, DRAFT_LIMITS.phase), focus],
      );
    }
    const phaseOf = new Map(locked.skeleton.weeks.map((w) => [w.week_no, w]));
    const rows = locked.sessions.map((s) => toPlannedSessionRow(s, planId, phaseOf.get(s.week_no) ?? { phase: "" }));
    const width = 16;
    for (let i = 0; i < rows.length; i += 40) {
      const part = rows.slice(i, i + 40);
      const values = part.map((_, r) => `(${Array.from({ length: width }, (_x, c) => `$${r * width + c + 1}`).join(", ")}, 1, false)`);
      await q(`insert into planned_sessions (${PLANNED_SESSION_COLUMNS}) values ${values.join(", ")}`, part.flat());
    }
    for (const weekday of locked.intake.fixed_rest_weekdays) {
      const [have] = await q("select 1 from constraints where user_id = $1 and kind = 'fixed_day' and weekday = $2 and status = 'active' limit 1", [d.user_id, weekday]);
      if (have) continue;
      await q(
        `insert into constraints (id, user_id, text, start_date, end_date, kind, weekday, source_message_id, status, decided_at)
         values ($1, $2, $3, null, null, 'fixed_day', $4, null, 'active', now())`,
        [randomUUID(), d.user_id, `每週${WEEKDAY_ZH[weekday]}固定休息（排課表時說的）`, weekday],
      );
    }
    await q("update plan_drafts set status = 'adopted', adopted_plan_id = $2, updated_at = now() where id = $1 and user_id = $3", [d.id, planId, d.user_id]);
    return { ok: true, plan_id: planId };
  });
}

// ---- for the app ---------------------------------------------------------------------------------------------------------

/** The four fixed lines (01b §6c; 02 §9). The provider's wording stays in plan_drafts.last_error and the logs. */
export const DRAFT_ERROR_TEXT = {
  model_failed: "Woo 這次沒有回完",
  validation_failed: "Woo 排的格式沒過檢查",
  calls_exhausted: "這份用掉的次數到上限了",
  stalled: "產生中斷了",
} as const;

export function toApiProfile(p: AthleteProfile): ApiAthleteProfile {
  return {
    from: p.from, to: p.to, weeks: p.weeks, last4: p.last4, longest: p.longest, avg_pace_sec_km: p.avg_pace_sec_km, avg_hr: p.avg_hr,
    total_runs: p.total_runs, import_error: p.import_error, hr_zones: p.hr_zones, pace_bands: p.pace_bands, last_race: p.last_race,
  };
}

export function toApiDraftSession(s: DraftSession, flags: string[] = []): ApiDraftSession {
  return {
    date: s.date, week_no: s.week_no, type: s.type, label: s.label, content: s.content, note: s.note, target: targetText(s),
    target_distance_m: s.distance_m, target_pace_sec_km: paceMid(s),
    target_pace_min_sec_km: s.pace_min_sec_km, target_pace_max_sec_km: s.pace_max_sec_km, target_hr_min: s.hr_min, target_hr_max: s.hr_max,
    flags,
  };
}

export function toApiDraft(d: PlanDraftRow, now: Date): ApiPlanDraft {
  const { status, error_code } = effectiveState(d, now);
  const weeks = d.skeleton?.weeks ?? [];
  const flags = flagsToApi(d.flags ?? [], weeks, d.sessions ?? []);
  const range = d.skeleton && status === "pending" && d.stage === "chunk" && d.chunks_total != null && d.chunks_done < d.chunks_total ? chunkRanges(weeks)[d.chunks_done] : undefined;
  return {
    id: d.id,
    mode: d.mode,
    status,
    stage: status === "pending" ? d.stage : null,
    progress: { chunks_done: d.chunks_done, chunks_total: d.chunks_total, from_week: range?.from ?? null, to_week: range?.to ?? null },
    intake: d.intake,
    profile: d.profile ? toApiProfile(d.profile) : null,
    summary: d.skeleton?.summary ?? null,
    weeks: weeks.map((w) => ({ week_no: w.week_no, week_start: w.week_start, week_end: w.week_end, phase: w.phase, focus: w.focus, km: w.km, long_km: w.long_km, key: w.key, taper: w.taper, flags: flags.byWeek.get(w.week_no) ?? [] })),
    sessions: (d.sessions ?? []).map((s) => toApiDraftSession(s, flags.byDate.get(s.date) ?? [])),
    flags: flags.plan,
    calls: d.calls,
    max_calls: PLAN_GEN_MAX_CALLS,
    can_resume: status === "failed" && d.calls < PLAN_GEN_MAX_CALLS && d.resumes < PLAN_GEN_MAX_RESUMES,
    error: status === "failed" ? DRAFT_ERROR_TEXT[error_code ?? "model_failed"] : null,
    adopted_plan_id: d.adopted_plan_id,
    created_at: new Date(d.created_at).toISOString(),
    updated_at: new Date(d.updated_at).toISOString(),
  };
}

