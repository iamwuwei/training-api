import type Anthropic from "@anthropic-ai/sdk";
import { anthropicClient, coachModel } from "./claude";
import { loadLiveConstraints } from "./constraints";
import { query, queryOne } from "./db";
import { loadHistorySummary } from "./history-summary";
import {
  type ChunkContext, chunkRanges, computeDraftFlags, dateRange, markSendFailed, nextStep, PLAN_GEN_MAX_CALLS, PLAN_GEN_RETRY_PER_STEP,
  planWeeks, restDates, sendPlanGenJob, todayJst, validateChunk, validateSkeleton,
} from "./plan-gen";
import { buildChunkPrompt, buildRetryTail, buildSkeletonPrompt, CHUNK_SCHEMA, PLAN_SYSTEM, SKELETON_SCHEMA } from "./plan-gen-prompts";
import type { DraftSession, DraftWeek, PlanDraftRow, PlanGenJob } from "../types";

// The worker's side of ai-plan-generation (01b §2.1, §5.4, §8): one SQS message = one step (profile / skeleton / chunk n), each done
// inside the Lambda's 180 s, each queueing the next. The draft's own columns say what is done, so a redelivered message is a no-op.
// Every model call is paid for BEFORE it is made (spendCall: an atomic calls + 1 that refuses at PLAN_GEN_MAX_CALLS), a step makes at
// most 1 + PLAN_GEN_RETRY_PER_STEP calls, and a provider error is never retried (MODEL_MAX_RETRIES = 0): the draft fails and waits for 「繼續」.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The worker Lambda runs 180 s; a step that has used this much does not start another model call. */
export const STEP_BUDGET_MS = 170_000;
/** Below this much time left a retry is not worth starting (a chunk answer takes 25-60 s). */
const MIN_CALL_MS = 20_000;
export const SKELETON_TIMEOUT_MS = 60_000;
export const SKELETON_MAX_TOKENS = 4096;
export const CHUNK_TIMEOUT_MS = 90_000;
export const CHUNK_MAX_TOKENS = 6000;

type FailCode = "model_failed" | "validation_failed" | "calls_exhausted";

/** Take one of the draft's calls. false = none left (calls_exhausted) or the draft is not pending any more. */
export async function spendCall(draftId: string, userId: string): Promise<"ok" | "exhausted" | "gone"> {
  const rows = await query<{ calls: number }>(
    "update plan_drafts set calls = calls + 1, updated_at = now() where id = $1 and user_id = $3 and status = 'pending' and calls < $2 returning calls",
    [draftId, PLAN_GEN_MAX_CALLS, userId],
  );
  if (rows.length) return "ok";
  const d = await queryOne<{ status: string }>("select status from plan_drafts where id = $1 and user_id = $2", [draftId, userId]);
  return d?.status === "pending" ? "exhausted" : "gone";
}

export async function failDraft(id: string, userId: string, code: FailCode, detail: string): Promise<void> {
  console.warn(`plan_gen draft ${id} failed: ${code}: ${detail.slice(0, 300)}`);
  await query("update plan_drafts set status = 'failed', error_code = $2, last_error = $3, updated_at = now() where id = $1 and user_id = $4 and status = 'pending'", [id, code, detail.slice(0, 500), userId]);
}

/** One structured-output call. `data` is undefined when the answer was not JSON (cut off at max_tokens): the caller treats that as a failed check. Provider errors throw. */
export async function askModel(user: string, schema: Record<string, unknown>, maxTokens: number, timeoutMs: number): Promise<{ data: unknown; model: string; note?: string }> {
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: PLAN_SYSTEM, cache_control: { type: "ephemeral" } }];
  const response = await anthropicClient(timeoutMs).messages.create({
    model: coachModel(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: { type: "json_schema", schema } },
  });
  const u = response.usage;
  console.log(`plan_gen usage: in=${u?.input_tokens ?? 0} out=${u?.output_tokens ?? 0} cache_read=${u?.cache_read_input_tokens ?? 0}`);
  if (response.stop_reason === "refusal") throw new Error("the model refused");
  const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  try {
    if (start < 0 || end < 0) throw new Error("no JSON");
    return { data: JSON.parse(text.slice(start, end + 1)), model: response.model };
  } catch {
    return { data: undefined, model: response.model, note: response.stop_reason === "max_tokens" ? "the answer was cut off before it ended" : "the answer was not valid JSON" };
  }
}

/**
 * Ask, validate, and on a failed check ask once more with the sentence appended; the draft is failed (and this returns null) when the
 * model errors, the checks fail twice, the draft has no calls left, or there is no time left in the Lambda for another call.
 */
async function modelStep<T>(
  draftId: string, userId: string, started: number, user: string, schema: Record<string, unknown>, maxTokens: number, timeoutMs: number,
  validate: (raw: unknown) => T | string,
): Promise<{ value: T; model: string } | null> {
  let tail = "";
  let lastError = "";
  for (let attempt = 0; attempt <= PLAN_GEN_RETRY_PER_STEP; attempt++) {
    const left = STEP_BUDGET_MS - (Date.now() - started);
    if (attempt > 0 && left < MIN_CALL_MS) { await failDraft(draftId, userId, "validation_failed", `${lastError}; no time left to ask again`); return null; }
    const spent = await spendCall(draftId, userId);
    if (spent === "gone") return null; // discarded while we worked
    if (spent === "exhausted") { await failDraft(draftId, userId, "calls_exhausted", "the draft has used all its calls"); return null; }
    let answer;
    try {
      answer = await askModel(user + tail, schema, maxTokens, Math.min(timeoutMs, Math.max(left, MIN_CALL_MS)));
    } catch (err) {
      await failDraft(draftId, userId, "model_failed", err instanceof Error ? err.message : "model error");
      return null;
    }
    const checked = answer.data === undefined ? (answer.note ?? "the answer was not valid JSON") : validate(answer.data);
    if (typeof checked !== "string") return { value: checked, model: answer.model };
    lastError = checked;
    await query("update plan_drafts set last_error = $2 where id = $1 and user_id = $3 and status = 'pending'", [draftId, checked.slice(0, 500), userId]);
    tail = buildRetryTail(checked);
  }
  await failDraft(draftId, userId, "validation_failed", lastError);
  return null;
}

/** Queue the step the draft needs now. If the queue refuses, the draft fails (「繼續」sends it again) instead of waiting for the 15-minute stall. */
async function queueNext(d: Pick<PlanDraftRow, "id" | "user_id">, job: Omit<PlanGenJob, "type" | "user_id" | "draft_id">): Promise<void> {
  try {
    await sendPlanGenJob({ type: "plan_gen", user_id: d.user_id, draft_id: d.id, ...job });
  } catch (err) {
    console.error(`plan_gen draft ${d.id}: could not queue ${job.step}`, err);
    await markSendFailed(d.id, d.user_id);
  }
}

const isJob = (j: unknown): j is PlanGenJob => {
  const o = j as Partial<PlanGenJob> | null;
  return !!o && typeof o.draft_id === "string" && UUID_RE.test(o.draft_id) && typeof o.user_id === "string" && UUID_RE.test(o.user_id)
    && (o.step === "profile" || o.step === "skeleton" || (o.step === "chunk" && Number.isInteger(o.chunk) && (o.chunk as number) >= 0));
};

/**
 * The worker's entry for a `plan_gen` message. Returns without doing anything for a draft that is not pending, or whose next step is not
 * the one named (a redelivered or a forged message). Model and validation failures are written to the draft, never thrown; only a database
 * error throws (SQS redelivers, at most 3 times).
 */
export async function runPlanGenStep(job: PlanGenJob): Promise<void> {
  const started = Date.now();
  if (!isJob(job)) { console.warn("plan_gen: malformed job dropped"); return; }
  const d = await queryOne<PlanDraftRow>("select * from plan_drafts where id = $1 and user_id = $2", [job.draft_id, job.user_id]);
  if (!d) { console.warn(`plan_gen: draft ${job.draft_id} not found, dropped`); return; }
  if (d.status !== "pending") { console.log(`plan_gen: draft ${d.id} is ${d.status}, step ${job.step} dropped`); return; }
  const step = nextStep(d);
  if (step !== job.step || (step === "chunk" && job.chunk !== d.chunks_done)) { console.log(`plan_gen: stale job for draft ${d.id} (${job.step}${job.chunk ?? ""}, next is ${step ?? "none"}), dropped`); return; }

  const today = todayJst();
  if (step === "profile") {
    const profile = await loadHistorySummary(d.user_id, today);
    const done = await query("update plan_drafts set profile = $2::jsonb, stage = 'skeleton', updated_at = now() where id = $1 and user_id = $3 and status = 'pending' and profile is null returning id", [d.id, JSON.stringify(profile), d.user_id]);
    if (done.length) await queueNext(d, { step: "skeleton" });
    return;
  }

  const goal = d.intake.goals[0];
  const weeks = planWeeks(d.intake.start_date, goal.race_date);
  const constraints = await loadLiveConstraints(d.user_id, today);
  if (!d.profile) return; // unreachable: nextStep says profile first

  if (step === "skeleton") {
    const made = await modelStep(d.id, d.user_id, started, buildSkeletonPrompt(d.intake, d.profile, constraints, weeks), SKELETON_SCHEMA, SKELETON_MAX_TOKENS, SKELETON_TIMEOUT_MS, (raw) => validateSkeleton(raw, weeks));
    if (!made) return;
    const done = await query(
      "update plan_drafts set skeleton = $2::jsonb, chunks_total = $3, stage = 'chunk', model = $4, updated_at = now() where id = $1 and user_id = $5 and status = 'pending' and skeleton is null returning id",
      [d.id, JSON.stringify(made.value), chunkRanges(made.value.weeks).length, made.model, d.user_id],
    );
    if (done.length) await queueNext(d, { step: "chunk", chunk: 0 });
    return;
  }

  // chunk n
  const skeleton = d.skeleton!;
  const n = d.chunks_done;
  const range = chunkRanges(skeleton.weeks)[n];
  if (!range) { await failDraft(d.id, d.user_id, "validation_failed", `chunk ${n} is not in the skeleton`); return; }
  const mine = skeleton.weeks.filter((w) => w.week_no >= range.from && w.week_no <= range.to);
  const dates = dateRange(mine[0].week_start, mine[mine.length - 1].week_end);
  const ctx: ChunkContext = {
    dates, fixedRest: restDates(d.intake, constraints, dates), raceDate: goal.race_date, raceDistance: goal.distance_m,
    maxDistance: Math.max(45_000, goal.distance_m), weeks: mine,
  };
  const made = await modelStep<DraftSession[]>(d.id, d.user_id, started, buildChunkPrompt(d.intake, d.profile, constraints, skeleton, skeleton.weeks, range, d.sessions), CHUNK_SCHEMA, CHUNK_MAX_TOKENS, CHUNK_TIMEOUT_MS, (raw) => validateChunk(raw, ctx));
  if (!made) return;

  const last = n + 1 === d.chunks_total;
  if (!last) {
    const done = await query(
      "update plan_drafts set sessions = sessions || $2::jsonb, chunks_done = chunks_done + 1, model = $4, updated_at = now() where id = $1 and user_id = $5 and status = 'pending' and chunks_done = $3 returning id",
      [d.id, JSON.stringify(made.value), n, made.model, d.user_id],
    );
    if (done.length) await queueNext(d, { step: "chunk", chunk: n + 1 });
    return;
  }
  const all = [...d.sessions, ...made.value];
  const totalDays = (Date.parse(`${goal.race_date}T00:00:00Z`) - Date.parse(`${d.intake.start_date}T00:00:00Z`)) / 86_400_000 + 1;
  if (all.length !== totalDays) { await failDraft(d.id, d.user_id, "validation_failed", `${all.length} sessions for ${totalDays} days`); return; }
  const flags = computeDraftFlags(all, skeleton.weeks as DraftWeek[], d.intake, d.profile);
  await query(
    "update plan_drafts set sessions = $2::jsonb, chunks_done = chunks_done + 1, flags = $3::jsonb, status = 'ready', stage = null, model = $5, updated_at = now() where id = $1 and user_id = $6 and status = 'pending' and chunks_done = $4",
    [d.id, JSON.stringify(all), JSON.stringify(flags), n, made.model, d.user_id],
  );
}
