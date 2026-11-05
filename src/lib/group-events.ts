import { randomUUID } from "node:crypto";
import { type Querier, query, queryOne } from "./db";
import { sessionLabel } from "./labels";
import type { PlannedSessionRow } from "../types";

// group-race 消息中心: how events get written. Reading them is src/lib/group-view.ts.
//
// Two kinds of write, both a plain INSERT and never an update / delete (only `seed-group --undo` deletes):
//  - session_done: the athlete bound a recording to a planned session. One row in each group he is in at that moment
//    (<= 3), once per (group, session) (unique index group_events_session_once_idx), so a re-judge, a second segment,
//    or the same session reached by the api and by the worker writes nothing more. The verdict is NOT stored here: the
//    reader joins the current reviews row, so a corrected verdict is the new one.
//  - joined / left: written inside the membership transaction (groups.ts), same `q`.

export const EVENTS_RETENTION_DAYS = 90;
export const EVENTS_PAGE = 30;
export const EVENTS_PAGE_MAX = 50;
/** `group_events.label` is a snapshot of the session's label ("Long 18 km"), at most this many characters. */
export const EVENT_LABEL_MAX = 40;

/**
 * Record that `userId` finished `sessionId` (one primary recording `activityId`) in every group he is in now.
 * One SQL for someone in no group. Synchronous, no retry, no queue message, never throws: a failed insert is one log line
 * and the binding that called us goes on (01 E2). Safe to call any number of times for the same session.
 */
export async function recordSessionDone(userId: string, sessionId: string, activityId: string): Promise<void> {
  try {
    const groups = await queryOne<{ n: number }>(
      `select count(*)::int as n from group_members gm join groups g on g.id = gm.group_id and g.disbanded_at is null
        where gm.user_id = $1 and gm.left_at is null`,
      [userId],
    );
    if (!groups?.n) return;
    // The session must be the athlete's own (a plan of his): the caller has already bound his activity to it.
    const session = await queryOne<Pick<PlannedSessionRow, "label" | "type" | "target_distance_m">>(
      `select ps.label, ps.type, ps.target_distance_m
         from planned_sessions ps join plans p on p.id = ps.plan_id
        where ps.id = $2 and p.user_id = $1`,
      [userId, sessionId],
    );
    if (!session) return;
    const label = [...sessionLabel(session)].slice(0, EVENT_LABEL_MAX).join("");
    await query(
      `insert into group_events (id, group_id, member_id, kind, session_id, activity_id, label, session_date)
       select gen_random_uuid(), gm.group_id, gm.id, 'session_done', $2::uuid, $3::uuid, $4::text, ps.scheduled_date
         from group_members gm join groups g on g.id = gm.group_id and g.disbanded_at is null
        cross join (select ps0.scheduled_date from planned_sessions ps0 join plans p on p.id = ps0.plan_id where ps0.id = $2::uuid and p.user_id = $1) ps
        where gm.user_id = $1 and gm.left_at is null
       on conflict (group_id, session_id) where session_id is not null do nothing`,
      [userId, sessionId, activityId, label],
    );
  } catch (err) {
    console.error(`group event for session ${sessionId} not written`, err instanceof Error ? err.message : err);
  }
}

/** `joined` / `left`: a membership fact, inside the transaction that changes the membership (`q` is that transaction's). */
export async function recordMembership(q: Querier, groupId: string, memberId: string, kind: "joined" | "left"): Promise<void> {
  await q(
    "insert into group_events (id, group_id, member_id, kind) values ($1, $2, $3, $4)",
    [randomUUID(), groupId, memberId, kind],
  );
}
