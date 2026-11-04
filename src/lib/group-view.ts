import { query, queryOne } from "./db";
import { EVENTS_PAGE, EVENTS_PAGE_MAX, EVENTS_RETENTION_DAYS } from "./group-events";
import { memberProgress, RUNS_WINDOW_DAYS, type MemberData } from "./group-progress";
import { listGroups, membership, SHARE_DEFAULTS, toApiGroup, todayJst } from "./groups";
import { countsWeekNo } from "./labels";
import { elapsedSql, SEGMENT_SELECT } from "./session-group";
import type { PlanWeekRow } from "../types";
import type {
  ApiGroup, ApiGroupEvent, ApiGroupMember, ApiGroupProgress, ApiSegment, ApiSharedActivity, ApiSharedReview, ApiSharedSession,
  ApiSplit, ApiWeek, GroupEventDetailResponse, GroupEventsResponse, GroupResponse, MemberPlanResponse, SessionType, ShareSettings, Verdict,
} from "../../types/api";

// group-race: EVERYTHING one member sees of another member comes out of this file, and nothing else in the project reads
// another user's plans / plan_weeks / planned_sessions / activities / reviews / share_settings (01b §4a). The rules:
//
//   (1) Outside this file no query reads a row of a user other than the caller for those tables. groups.ts reads the caller's
//       own membership, group, invite and share rows; the invite preview's inviter name is its only other-person read.
//   (2) Every query in this file carries the viewer AND the group: either the `exists (viewer is a current member of group
//       $G)` of `visibleMembers` / the events SQL, or `gate()` below, which is the same test plus "and the person whose rows are
//       read is a current member of that group". The person is named by his group_members.id, never by users.id.
//   (3) The private loaders are not exported and take a `Ctx` that only `visibleMembers` can hand out (`ctxOf`): they get the
//       other user's id from the gate and nowhere else, and their SQL re-checks it (`gate()`), so a loader called with the
//       wrong id reads nothing.
//   (4) A field another member may see is behind one of the five ShareSettings switches, applied in ONE place (`applyShare`);
//       what a switch hides is not even read where that is possible. A new field starts with a switch.
//   (5) No type in a response has a user_id; members are named by their group_members.id, which differs in every group.
//
// Non-members: every function answers `undefined` and the handler a 404 identical to an unknown id (nothing here tells the
// two apart). Switches are not errors: a hidden field is null / [] / the event is absent, HTTP 200, and nothing in the response
// (no count, no placeholder) lets the viewer tell what is hidden. No cache: every call reads the current rows.

// ---- the gate --------------------------------------------------------------------------------

interface Visible {
  /** group_members.id: what the viewer sees. */
  id: string;
  /** The other person's users.id. Never leaves this file. */
  user_id: string;
  role: "owner" | "member";
  joined_at: Date;
  display_name: string;
  /** His switches, as seen by this viewer (all true for himself). */
  share: ShareSettings;
  isMe: boolean;
  group: { race_date: string };
}

const ALL_ON: ShareSettings = { progress: true, events: true, plan: true, runs: true, reviews: true };

/**
 * The one gate every cross-user read goes through: the viewer and the target(s) are current members of `groupId`. Returns the
 * members it may talk about (all of them, or just `memberId`) with their switches; [] when the viewer is not a member (or the
 * group does not exist / is disbanded: same). One SQL.
 */
async function visibleMembers(viewerId: string, groupId: string, memberId?: string): Promise<Visible[]> {
  const rows = await query<{
    id: string; user_id: string; role: "owner" | "member"; joined_at: Date; display_name: string; is_me: boolean; race_date: string;
    progress: boolean | null; events: boolean | null; plan: boolean | null; runs: boolean | null; reviews: boolean | null;
  }>(
    `select gm.id, gm.user_id, gm.role, gm.joined_at, u.display_name, (gm.user_id = $1) as is_me,
            to_char(g.race_date, 'YYYY-MM-DD') as race_date,
            s.progress, s.events, s.plan, s.runs, s.reviews
       from group_members gm
       join groups g on g.id = gm.group_id and g.disbanded_at is null
       join users u on u.id = gm.user_id
       left join share_settings s on s.user_id = gm.user_id
      where gm.group_id = $2 and gm.left_at is null and ($3::uuid is null or gm.id = $3::uuid)
        and exists (select 1 from group_members v where v.group_id = $2 and v.user_id = $1 and v.left_at is null)
      order by (gm.user_id = $1) desc, gm.joined_at, gm.id`,
    [viewerId, groupId, memberId ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    role: r.role,
    joined_at: r.joined_at,
    display_name: r.display_name,
    isMe: r.is_me,
    group: { race_date: r.race_date },
    share: r.is_me
      ? { ...ALL_ON }
      : {
          progress: r.progress ?? SHARE_DEFAULTS.progress, events: r.events ?? SHARE_DEFAULTS.events, plan: r.plan ?? SHARE_DEFAULTS.plan,
          runs: r.runs ?? SHARE_DEFAULTS.runs, reviews: r.reviews ?? SHARE_DEFAULTS.reviews,
        },
  }));
}

async function visibleMember(viewerId: string, groupId: string, memberId: string): Promise<Visible | undefined> {
  return (await visibleMembers(viewerId, groupId, memberId))[0];
}

/** What a loader needs: who is looking, in which group, at whom. Only `ctxOf` makes one. Params $1..$4 of every loader query. */
interface Ctx { viewerId: string; groupId: string; memberId: string; userId: string }
const ctxOf = (viewerId: string, groupId: string, v: Visible): Ctx => ({ viewerId, groupId, memberId: v.id, userId: v.user_id });
const ctxParams = (c: Ctx, ...more: unknown[]) => [c.viewerId, c.groupId, c.memberId, c.userId, ...more];
/** The gate again, inside a loader's SQL: $1 viewer, $2 group, $3 member (group_members.id), `col` = the user column being read. */
const gate = (col: string) => `exists (
    select 1 from group_members v
      join groups gg on gg.id = v.group_id and gg.disbanded_at is null
      join group_members t on t.group_id = v.group_id
     where v.group_id = $2 and v.user_id = $1 and v.left_at is null
       and t.id = $3 and t.left_at is null and t.user_id = ${col})`;

// ---- the switches, in one place ------------------------------------------------------------------

export interface Shareable {
  progress?: ApiGroupProgress | null;
  plan?: MemberPlanResponse["plan"];
  weeks?: ApiWeek[];
  sessions?: ApiSharedSession[];
  activities?: MemberPlanResponse["activities"];
  activity?: ApiSharedActivity | null;
  segments?: ApiSharedActivity[];
  review?: ApiSharedReview | null;
}

/**
 * The only place a switch hides something (the events list is filtered in its SQL, same switch). A switched-off field becomes
 * null / []: `progress` hides the dashboard numbers; `plan` the plan, weeks, sessions (and the activities, which are drawn
 * against them); `runs` the activities, the event's recordings; `reviews` every review. Keys the value does not have are left alone.
 */
export function applyShare<T extends Shareable>(share: ShareSettings, t: T): T {
  const out: Shareable = { ...t };
  if (!share.progress && "progress" in out) out.progress = null;
  if (!share.plan) {
    if ("plan" in out) out.plan = null;
    if ("weeks" in out) out.weeks = [];
    if ("sessions" in out) out.sessions = [];
    if ("activities" in out) out.activities = [];
  }
  if (!share.runs) {
    if ("activity" in out) out.activity = null;
    if ("segments" in out) out.segments = [];
    if ("activities" in out) out.activities = [];
  }
  if (!share.reviews) {
    if ("review" in out) out.review = null;
    if (out.activities) out.activities = out.activities.map((a) => ({ ...a, review: null }));
  }
  return out as T;
}

// ---- private loaders (his rows; only for a Ctx the gate produced) ------------------------------------

const iso = (d: Date | string) => new Date(d).toISOString();

interface PlanCore { id: string; race_name: string; race_date: string; goal_time_sec: number | null; weeks: PlanWeekRow[] }

/** His active plan (the one GET /plan picks: the earliest race day) with its weeks. */
async function loadPlanCore(c: Ctx): Promise<PlanCore | undefined> {
  return queryOne<PlanCore>(
    `select p.id, p.race_name, to_char(p.race_date, 'YYYY-MM-DD') as race_date, p.goal_time_sec,
            coalesce((select json_agg(json_build_object('id', w.id, 'plan_id', w.plan_id, 'week_no', w.week_no,
                        'week_start', to_char(w.week_start, 'YYYY-MM-DD'), 'week_end', to_char(w.week_end, 'YYYY-MM-DD'),
                        'phase', w.phase, 'focus', w.focus) order by w.week_no)
                       from plan_weeks w where w.plan_id = p.id), '[]'::json) as weeks
       from plans p
      where p.user_id = $4 and p.status = 'active' and ${gate("p.user_id")}
      order by p.race_date limit 1`,
    ctxParams(c),
  );
}

type SharedSessionRow = Omit<ApiSharedSession, "skipped_at" | "counts_in_week_no"> & { skipped_at: Date | null; moved_to_counts: number | null };

/** His sessions as GET /plan sends them (not superseded, plus the moved rows), cut down to ApiSharedSession. */
async function loadSharedSessions(c: Ctx, plan: PlanCore): Promise<ApiSharedSession[]> {
  const rows = await query<SharedSessionRow & { counts_in_week_no: number | null }>(
    `select ps.id, to_char(ps.scheduled_date, 'YYYY-MM-DD') as scheduled_date, ps.week_no, ps.phase, ps.label, ps.type, ps.content, ps.note,
            ps.target, ps.target_distance_m, ps.target_pace_sec_km, ps.target_pace_min_sec_km, ps.target_pace_max_sec_km,
            ps.target_hr_min, ps.target_hr_max, ps.brief, ps.skipped_at, ps.superseded,
            ps.moved_to_session_id, ps.moved_from_session_id, ps.counts_in_week_no,
            to_char(mt.scheduled_date, 'YYYY-MM-DD') as moved_to_date, mt.counts_in_week_no as moved_to_counts,
            to_char(mf.scheduled_date, 'YYYY-MM-DD') as moved_from_date
       from planned_sessions ps
       join plans p on p.id = ps.plan_id
       left join planned_sessions mt on mt.id = ps.moved_to_session_id
       left join planned_sessions mf on mf.id = ps.moved_from_session_id
      where ps.plan_id = $5 and p.user_id = $4 and (ps.superseded = false or ps.moved_to_session_id is not null) and ${gate("p.user_id")}
      order by ps.scheduled_date, ps.superseded desc`,
    ctxParams(c, plan.id),
  );
  return rows.map(({ moved_to_counts, skipped_at, ...s }) => ({
    ...s,
    skipped_at: skipped_at ? iso(skipped_at) : null,
    moved_to_session_id: s.moved_to_session_id ?? null,
    moved_to_date: s.moved_to_date ?? null,
    moved_from_session_id: s.moved_from_session_id ?? null,
    moved_from_date: s.moved_from_date ?? null,
    counts_in_week_no: countsWeekNo({ ...s, moved_to_counts }, plan.weeks),
  }));
}

/** Everything `memberProgress` needs: the plan (weeks, sessions, the activities on them) and his runs of the last 84 days. 3 queries. */
async function loadMemberData(c: Ctx): Promise<MemberData> {
  const plan = await loadPlanCore(c);
  const sessions = plan ? await loadSharedSessions(c, plan) : [];
  const acts = await query<{ session_id: string | null; distance_m: number; match_status: string; start_time: Date; sport_type: string | null; in_plan: boolean; recent: boolean }>(
    `select a.session_id, a.distance_m, a.match_status, a.start_time, a.sport_type,
            coalesce(a.session_id in (select ps.id from planned_sessions ps where ps.plan_id = $5::uuid), false) as in_plan,
            (a.start_time >= now() - make_interval(days => $6)) as recent
       from activities a
      where a.user_id = $4 and ${gate("a.user_id")}
        and (a.start_time >= now() - make_interval(days => $6)
             or coalesce(a.session_id in (select ps.id from planned_sessions ps where ps.plan_id = $5::uuid), false))`,
    ctxParams(c, plan?.id ?? null, RUNS_WINDOW_DAYS),
  );
  return {
    plan: plan
      ? {
          race_date: plan.race_date,
          weeks: plan.weeks,
          sessions: sessions.map((s) => ({ id: s.id, scheduled_date: s.scheduled_date, type: s.type as SessionType, target_distance_m: s.target_distance_m, counts_in_week_no: s.counts_in_week_no })),
          activities: acts.filter((a) => a.in_plan && a.session_id).map((a) => ({ session_id: a.session_id as string, distance_m: a.distance_m, match_status: a.match_status })),
        }
      : null,
    runs: acts.filter((a) => a.recent && a.match_status !== "ignored").map((a) => ({ start_time: a.start_time, distance_m: a.distance_m, sport_type: a.sport_type })),
  };
}

type SharedActivityRow = {
  id: string; session_id: string | null; sport_type: string | null; start_time: Date; distance_m: number; moving_time_sec: number;
  elapsed_time_sec: number | null; avg_pace_sec_km: number | null; avg_hr: number | null; max_hr: number | null; splits: ApiSplit[] | null;
  seg_count: number | null; seg_index: number | null; seg_primary: string | null;
  r_verdict: Verdict | null; r_comment: string | null; r_reminders: string[] | null; r_source: "manual" | "claude" | null; r_created_at: Date | null; r_corrected_at: Date | null;
};

const CORRECTED_AT = `(select max(m.created_at) from coach_messages m
     where m.user_id = a.user_id and m.role = 'athlete' and m.meta->'correction'->>'activity_id' = a.id::text
       and r.created_at is not null and m.created_at < r.created_at)`;

function toSharedActivity(r: SharedActivityRow): ApiSharedActivity {
  const segment: ApiSegment | null = r.seg_count != null && r.seg_index != null && r.seg_primary != null ? { primary_activity_id: r.seg_primary, index: r.seg_index, count: r.seg_count } : null;
  return {
    id: r.id, session_id: r.session_id, sport_type: r.sport_type, start_time: iso(r.start_time), distance_m: r.distance_m,
    moving_time_sec: r.moving_time_sec, elapsed_time_sec: r.elapsed_time_sec, avg_pace_sec_km: r.avg_pace_sec_km, avg_hr: r.avg_hr, max_hr: r.max_hr,
    splits: r.splits ?? null, segment,
  };
}

/** Only the fields a viewer may see of a review: no model, no adjust_hint; no comment when failed (it holds the error text) or manual (it is his own 心得). */
function toSharedReview(r: { verdict: Verdict | null; reminders: string[] | null; comment: string | null; source: "manual" | "claude"; created_at: Date; corrected_at: Date | null }): ApiSharedReview {
  const failed = r.source === "claude" && r.verdict === null;
  return {
    verdict: r.verdict,
    reminders: r.reminders ?? [],
    // a manual review's comment is the athlete's own 心得 (PUT /activities/{id}/review): never shared (01 H2)
    comment: failed || r.source === "manual" ? null : r.comment,
    source: r.source,
    failed,
    created_at: iso(r.created_at),
    corrected_at: r.corrected_at ? iso(r.corrected_at) : null,
  };
}

/**
 * His recordings (not ignored), oldest first: of one session (`sessionId`) or of every session of a plan (`planId`).
 * `withReviews` joins the session's review onto the recording that carries it (the primary); false reads no review at all.
 */
async function loadSharedActivities(c: Ctx, where: { sessionId: string } | { planId: string }, withReviews: boolean): Promise<(ApiSharedActivity & { review: ApiSharedReview | null })[]> {
  const bySession = "sessionId" in where;
  const rows = await query<SharedActivityRow>(
    `select a.id, a.session_id, a.sport_type, a.start_time, a.distance_m, a.moving_time_sec, ${elapsedSql("a")} as elapsed_time_sec,
            a.avg_pace_sec_km, a.avg_hr, a.max_hr, a.splits, ${SEGMENT_SELECT},
            r.verdict as r_verdict, r.comment as r_comment, r.reminders as r_reminders, r.source as r_source, r.created_at as r_created_at,
            ${CORRECTED_AT} as r_corrected_at
       from activities a
       join planned_sessions ps on ps.id = a.session_id
       join plans p on p.id = ps.plan_id and p.user_id = a.user_id
       left join reviews r on r.activity_id = a.id and $6::boolean
      where a.user_id = $4 and ${bySession ? "ps.id" : "ps.plan_id"} = $5 and a.match_status <> 'ignored' and ${gate("a.user_id")}
      order by a.start_time, a.id`,
    ctxParams(c, bySession ? where.sessionId : where.planId, withReviews),
  );
  return rows.map((r) => ({
    ...toSharedActivity(r),
    review: r.r_created_at && r.r_source ? toSharedReview({ verdict: r.r_verdict, reminders: r.r_reminders, comment: r.r_comment, source: r.r_source, created_at: r.r_created_at, corrected_at: r.r_corrected_at }) : null,
  }));
}

/** The CURRENT review of his session (the one on its primary recording): a corrected verdict is the new one. null = none yet. */
async function loadSharedReview(c: Ctx, sessionId: string): Promise<ApiSharedReview | null> {
  const r = await queryOne<{ verdict: Verdict | null; reminders: string[] | null; comment: string | null; source: "manual" | "claude"; created_at: Date; corrected_at: Date | null }>(
    `select r.verdict, r.reminders, r.comment, r.source, r.created_at, ${CORRECTED_AT} as corrected_at
       from activities a
       join planned_sessions ps on ps.id = a.session_id
       join plans p on p.id = ps.plan_id and p.user_id = a.user_id
       join reviews r on r.activity_id = a.id
      where a.user_id = $4 and a.session_id = $5 and a.match_status <> 'ignored' and ${gate("a.user_id")}
        and a.id = (select x.id from activities x where x.session_id = a.session_id and x.user_id = a.user_id and x.match_status <> 'ignored' order by x.start_time, x.id limit 1)`,
    ctxParams(c, sessionId),
  );
  return r ? toSharedReview(r) : null;
}

// ---- unread --------------------------------------------------------------------------------------

/**
 * Unseen events per group of `viewerId` (all of his, or just `groupId`): newer than the last time he opened the 消息中心
 * (his joining time before the first), not his own, not hidden by the actor's `events` switch, inside the 90 days.
 * Lives here because it reads the other members' switches.
 */
export async function groupUnread(viewerId: string, groupId?: string): Promise<Map<string, number>> {
  const rows = await query<{ group_id: string; n: number }>(
    `select gm.group_id, count(e.id)::int as n
       from group_members gm
       join groups g on g.id = gm.group_id and g.disbanded_at is null
       left join group_events e on e.group_id = gm.group_id and e.member_id <> gm.id
            and e.created_at > coalesce(gm.events_seen_at, gm.joined_at)
            and e.created_at > now() - make_interval(days => $3)
            and (e.kind <> 'session_done' or exists (
                  select 1 from group_members a left join share_settings s on s.user_id = a.user_id
                   where a.id = e.member_id and a.group_id = e.group_id and a.left_at is null and coalesce(s.events, true)
                     and exists (select 1 from activities pa where pa.session_id = e.session_id and pa.user_id = a.user_id and pa.match_status <> 'ignored')))
      where gm.user_id = $1 and gm.left_at is null and ($2::uuid is null or gm.group_id = $2::uuid)
      group by gm.group_id`,
    [viewerId, groupId ?? null, EVENTS_RETENTION_DAYS],
  );
  return new Map(rows.map((r) => [r.group_id, r.n]));
}

/** GET /plan's `groups_unread`: the sum over my groups (one SQL). */
export async function unreadTotal(viewerId: string): Promise<number> {
  try {
    let n = 0;
    for (const v of (await groupUnread(viewerId)).values()) n += v;
    return n;
  } catch (err) {
    // GET /plan is the app's core call: a failing group query (the api deployed before `npm run migrate`) costs the tab dot, not the page.
    console.error("groups_unread not computed", err instanceof Error ? err.message : err);
    return 0;
  }
}

/** GET /groups: my groups with their unread counts. */
export async function groupsList(viewerId: string): Promise<ApiGroup[]> {
  const [groups, unread] = await Promise.all([listGroups(viewerId), groupUnread(viewerId)]);
  return groups.map((g) => ({ ...g, unread: unread.get(g.id) ?? 0 }));
}

// ---- 消息中心 ------------------------------------------------------------------------------------

type EventRow = {
  id: string; kind: ApiGroupEvent["kind"]; created_at: Date; member_id: string; display_name: string; is_me: boolean;
  session_id: string | null; label: string | null; session_date: string | null; verdict: Verdict | null; judging: boolean;
};

/**
 * The events of one group as `viewerId` may see them, newest first. A session_done is here only while its actor is a current
 * member, his `events` switch is on (his own always show to himself) and the session still holds one of his recordings (an unbound or
 * ignored one — 不是這堂, 選錯了 — takes the "he finished it" back, whatever was written when it was bound); joined / left always (facts about the group).
 * `verdict` is the current review's verdict on the session's primary recording; `judging` = recorded but no review row yet.
 * `id` narrows to one event (the detail), `before` is the cursor of the page (an event id of this group).
 */
async function queryEvents(viewerId: string, groupId: string, o: { id?: string; before?: string; limit: number }): Promise<EventRow[]> {
  return query<EventRow>(
    `select e.id, e.kind, e.created_at, a.id as member_id, u.display_name, (a.user_id = $1) as is_me,
            e.session_id, e.label, to_char(e.session_date, 'YYYY-MM-DD') as session_date, r.verdict, (r.id is null and pr.id is not null) as judging
       from group_events e
       join group_members a on a.id = e.member_id and a.group_id = e.group_id
       join users u on u.id = a.user_id
       left join share_settings s on s.user_id = a.user_id
       left join lateral (
         select pa.id from activities pa
          where e.kind = 'session_done' and pa.session_id = e.session_id and pa.user_id = a.user_id and pa.match_status <> 'ignored'
          order by pa.start_time, pa.id limit 1) pr on true
       left join reviews r on r.activity_id = pr.id
      where e.group_id = $2
        and exists (select 1 from group_members v join groups g on g.id = v.group_id and g.disbanded_at is null
                     where v.group_id = $2 and v.user_id = $1 and v.left_at is null)
        and e.created_at > now() - make_interval(days => $6)
        and (e.kind <> 'session_done' or (a.left_at is null and pr.id is not null and (a.user_id = $1 or coalesce(s.events, true))))
        and ($3::uuid is null or e.id = $3::uuid)
        and ($4::uuid is null or (e.created_at, e.id) < (select c.created_at, c.id from group_events c where c.id = $4::uuid and c.group_id = $2))
      order by e.created_at desc, e.id desc
      limit $5`,
    [viewerId, groupId, o.id ?? null, o.before ?? null, o.limit, EVENTS_RETENTION_DAYS],
  );
}

const toApiEvent = (r: EventRow): ApiGroupEvent => ({
  id: r.id,
  kind: r.kind,
  member: { id: r.member_id, display_name: r.display_name, is_me: r.is_me },
  created_at: iso(r.created_at),
  session: r.kind === "session_done" ? { label: r.label ?? "", date: r.session_date ?? "", verdict: r.verdict, judging: r.judging } : null,
});

/** GET /groups/{id}/events. undefined = not a member. `limit` 1..EVENTS_PAGE_MAX (the handler checked). */
export async function groupEvents(viewerId: string, groupId: string, o: { before?: string; limit?: number } = {}): Promise<GroupEventsResponse | undefined> {
  if (!(await membership(viewerId, groupId))) return undefined;
  const limit = Math.min(Math.max(o.limit ?? EVENTS_PAGE, 1), EVENTS_PAGE_MAX);
  const rows = await queryEvents(viewerId, groupId, { before: o.before, limit: limit + 1 });
  return { events: rows.slice(0, limit).map(toApiEvent), has_more: rows.length > limit };
}

/**
 * GET /groups/{id}/events/{eid}: 看詳細. undefined (404, one answer) for: not a member, an event that is not in this group,
 * older than 90 days, not a session_done, one the actor's `events` switch hides, one whose actor left. Then, by his switches:
 * `runs` on → his recordings of that session; `reviews` on → the session's current review.
 */
export async function eventDetail(viewerId: string, groupId: string, eventId: string): Promise<GroupEventDetailResponse | undefined> {
  if (!(await membership(viewerId, groupId))) return undefined;
  const [row] = await queryEvents(viewerId, groupId, { id: eventId, limit: 1 });
  if (!row || row.kind !== "session_done") return undefined;
  const who = await visibleMember(viewerId, groupId, row.member_id);
  if (!who) return undefined;
  const sessionId = row.session_id;
  const c = ctxOf(viewerId, groupId, who);
  const segments = who.share.runs && sessionId ? await loadSharedActivities(c, { sessionId }, false) : [];
  const review = who.share.reviews && sessionId ? await loadSharedReview(c, sessionId) : null;
  const shared = applyShare(who.share, { activity: segments[0] ? stripReview(segments[0]) : null, segments: segments.map(stripReview), review });
  return { event: toApiEvent(row), shared: who.share, activity: shared.activity ?? null, segments: shared.segments ?? [], review: shared.review ?? null };
}

const stripReview = ({ review: _review, ...a }: ApiSharedActivity & { review: ApiSharedReview | null }): ApiSharedActivity => a;

// ---- dashboard ---------------------------------------------------------------------------------

/** GET /groups/{id}: the group, every member with the numbers his switches allow, the newest 3 events, the owner's live invite. undefined = 404. */
export async function groupView(viewerId: string, groupId: string): Promise<GroupResponse | undefined> {
  const mine = await membership(viewerId, groupId);
  if (!mine) return undefined;
  const people = await visibleMembers(viewerId, groupId);
  if (!people.some((p) => p.isMe)) return undefined;
  const today = todayJst();
  const raceDate = mine.group.race_date;

  const members: ApiGroupMember[] = await Promise.all(
    people.map(async (p) => {
      // what his switch hides is not read: himself always, the others by `progress`
      const progress: ApiGroupProgress | null = p.isMe || p.share.progress ? memberProgress(await loadMemberData(ctxOf(viewerId, groupId, p)), raceDate, today) : null;
      return {
        id: p.id,
        display_name: p.display_name,
        is_me: p.isMe,
        role: p.role,
        joined_at: iso(p.joined_at),
        shared: p.share,
        progress: applyShare(p.share, { progress }).progress ?? null,
      };
    }),
  );

  const [unread, events, invite] = await Promise.all([
    groupUnread(viewerId, groupId),
    groupEvents(viewerId, groupId, { limit: 3 }),
    mine.member.role === "owner" ? liveInvite(viewerId, groupId) : Promise.resolve(null),
  ]);
  return {
    group: toApiGroup(mine.group, mine.member, people.length, unread.get(groupId) ?? 0),
    members,
    recent_events: events?.events ?? [],
    invite,
  };
}

/** The owner's live invite: not revoked, not expired, not used up. The plaintext token is not stored, so `token` is null here. */
async function liveInvite(viewerId: string, groupId: string): Promise<GroupResponse["invite"]> {
  const r = await queryOne<{ expires_at: Date; uses_left: number }>(
    `select i.expires_at, i.max_uses - i.uses as uses_left
       from group_invites i
      where i.group_id = $2 and i.revoked_at is null and i.expires_at > now() and i.uses < i.max_uses
        and exists (select 1 from group_members v join groups g on g.id = v.group_id and g.disbanded_at is null
                     where v.group_id = $2 and v.user_id = $1 and v.role = 'owner' and v.left_at is null)
      order by i.created_at desc limit 1`,
    [viewerId, groupId],
  );
  return r ? { token: null, expires_at: iso(r.expires_at), uses_left: r.uses_left } : null;
}

// ---- a member's plan ---------------------------------------------------------------------------

/**
 * GET /groups/{id}/members/{mid}/plan: a read-only subset of his CURRENT active plan (01 N8: not scoped to this group's race).
 * `plan` off → no plan, weeks, sessions (and no activities); `runs` off → no activities; `reviews` off → no review on them.
 * Myself: everything. undefined = not a member, or `memberId` is not a current member of this group (another group's, left).
 */
export async function memberPlanView(viewerId: string, groupId: string, memberId: string): Promise<MemberPlanResponse | undefined> {
  if (!(await membership(viewerId, groupId))) return undefined;
  const who = await visibleMember(viewerId, groupId, memberId);
  if (!who) return undefined;
  const c = ctxOf(viewerId, groupId, who);

  let plan: MemberPlanResponse["plan"] = null;
  let weeks: ApiWeek[] = [];
  let sessions: ApiSharedSession[] = [];
  let activities: MemberPlanResponse["activities"] = [];
  if (who.share.plan) {
    const core = await loadPlanCore(c);
    if (core) {
      plan = { race_name: core.race_name, race_date: core.race_date, goal_time_sec: core.goal_time_sec };
      weeks = core.weeks.map(({ week_no, week_start, week_end, phase, focus }) => ({ week_no, week_start, week_end, phase, focus }));
      sessions = await loadSharedSessions(c, core);
      if (who.share.runs) activities = await loadSharedActivities(c, { planId: core.id }, who.share.reviews);
    }
  }
  const shown = applyShare(who.share, { plan, weeks, sessions, activities });
  return {
    member: { id: who.id, display_name: who.display_name, is_me: who.isMe },
    shared: who.share,
    plan: shown.plan ?? null,
    weeks: shown.weeks ?? [],
    sessions: shown.sessions ?? [],
    activities: shown.activities ?? [],
  };
}
