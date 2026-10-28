import { query } from "./db";

// Where Woo is with a message that is waiting for him, written into coach_messages.meta.stage as
// the work goes and read back by GET /coach (white-listed there). Progress display only: every
// write here is best-effort and never throws, so a failed stage write cannot fail a reply.
//
// The writes go through the pool-level `query` (autocommit), never a caller's transaction: the
// weekly review runs inside one that holds an advisory lock, and an UPDATE in it would only be
// visible to the app's polling after the whole review committed.

export type CoachStage = "preparing" | "thinking" | "searching" | "writing" | "reading" | "judging";
export const COACH_STAGES: ReadonlySet<string> = new Set<CoachStage>(["preparing", "thinking", "searching", "writing", "reading", "judging"]);
/** Per writer (= per message and run), searching / writing can repeat across pause_turn resumes. */
export const MAX_STAGE_WRITES = 5;

const SET_STAGE = "update coach_messages set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('stage', $1::text)";

/**
 * At most MAX_STAGE_WRITES updates, the same stage twice in a row skipped, failures only warned.
 * The updates run one after the other in call order (stream events fire without being awaited:
 * two UPDATEs on two pool connections could otherwise land the older stage last).
 */
function writer(where: string, params: unknown[]): (stage: CoachStage) => Promise<void> {
  let count = 0;
  let last: CoachStage | undefined;
  let chain: Promise<void> = Promise.resolve();
  return (stage) => {
    if (stage === last || count >= MAX_STAGE_WRITES) return chain;
    count++;
    last = stage;
    chain = chain.then(async () => {
      try {
        await query(`${SET_STAGE} where ${where}`, [stage, ...params]);
      } catch (err) {
        console.warn("stage write failed", err);
      }
    });
    return chain;
  };
}

/** The pending athlete message `messageId` (a chat reply's wait). */
export function stageWriter(messageId: string): (stage: CoachStage) => Promise<void> {
  return writer("id = $2 and status = 'pending'", [messageId]);
}

/** The pending athlete answer(s) about this activity (the verdict's wait); 0 rows for a report-page pick — fine. */
export function stageWriterByActivity(userId: string, activityId: string): (stage: CoachStage) => Promise<void> {
  return writer("user_id = $2 and role = 'athlete' and status = 'pending' and activity_id = $3", [userId, activityId]);
}

/** The weekly message of a review while it is rewritten. */
export function stageWriterByReview(reviewId: string): (stage: CoachStage) => Promise<void> {
  return writer("weekly_review_id = $2 and kind = 'weekly'", [reviewId]);
}

/** Take the stage off the weekly message again (a rewrite that ended, failed or was skipped). Never throws. */
export async function clearReviewStage(reviewId: string): Promise<void> {
  try {
    await query("update coach_messages set meta = meta - 'stage' where weekly_review_id = $1 and kind = 'weekly' and meta ? 'stage'", [reviewId]);
  } catch (err) {
    console.warn("stage clear failed", err);
  }
}
