import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Querier, query, queryOne, withTransaction } from "./db";
import { recordMembership } from "./group-events";
import { isValidDate } from "./labels";
import type { GroupInviteRow, GroupMemberRow, GroupRow } from "../types";
import type { AcceptInviteResponse, ApiGroup, ApiGroupInvite, InvitePreviewResponse, InviteState, ShareSettings } from "../../types/api";

// group-race: groups, members, invite links, the share switches. Everything here reads and writes only the CALLER's own
// membership rows, group rows, invite rows and his own share_settings row. What one member sees of another (names in the
// member list, progress, events, plans) is src/lib/group-view.ts, the only reader of another user's rows. The one other place
// another person's name appears is the invite preview (who invited you), which is the point of the page.
//
// Membership is never deleted: `left_at` (+ `left_reason`) closes it, `groups.disbanded_at` closes a group. "A current member"
// is always `left_at is null` AND the group not disbanded. A user may hold GROUP_MAX_PER_USER of them, a group has at most
// GROUP_MAX_MEMBERS. Lock order, the same in every transaction that writes membership: the user's advisory lock (only create /
// accept take it, to serialise one person's joins), then the group row (`for update`: accept, createInvite, disband, leave, remove),
// then the invite or member rows. leave / remove / disband all start with the group row because their `group_events` insert takes a
// KEY SHARE on it through the foreign key; taking the member row first (as leave / remove once did) deadlocked against disband
// (40P01). Two tabs, or two people accepting at once, cannot overshoot the limits.

export const GROUP_MAX_MEMBERS = 5;
export const GROUP_MAX_PER_USER = 3;
export const INVITE_TTL_DAYS = 7;
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const NAME_MAX = 30;
export const RACE_NAME_MAX = 40;
/** A user with no share_settings row: progress and finished-session events on, everything else off (01 H1). */
export const SHARE_DEFAULTS: ShareSettings = { progress: true, events: true, plan: false, runs: false, reviews: false };
export const SHARE_KEYS = ["progress", "events", "plan", "runs", "reviews"] as const;

/** A race day further away than this is a typo (9999-12-31 would make the countdown break the layout). */
export const RACE_DATE_MAX_YEARS = 5;
const maxRaceDate = () => { const t = todayJst(); return `${Number(t.slice(0, 4)) + RACE_DATE_MAX_YEARS}${t.slice(4)}`; };

export const todayJst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

// ---- small pure helpers ----------------------------------------------------------------------

/** C0 / C1 controls, zero-width and direction marks, the BOM: shown as nothing, so they are dropped. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
/** Line breaks and tabs are word gaps ("Fuji\nMountain" is two words), not invisible: they become a space before the controls are dropped. */
const BREAKS = /[\t\n\r\u000b\u000c\u0085\u2028\u2029]/g;

/** A group / race name: one line, no markup characters, 1..max characters. null = invalid (400). */
export function cleanName(v: unknown, max: number): string | null {
  if (typeof v !== "string" || v.length > 1000) return null;
  const s = v.replace(BREAKS, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().replace(/[*`#><]/g, "").replace(/\s+/g, " ").trim();
  if (!s || [...s].length > max) return null;
  return s;
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
/** 32 random bytes = 256 bit, 43 base64url characters. */
export const newToken = (): string => randomBytes(32).toString("base64url");

export interface GroupBody { name: string; race_name: string; race_date: string }
/** POST /groups body: the cleaned values, or the 400 text. */
export function parseGroupBody(body: unknown): { ok: true; value: GroupBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const name = cleanName(b.name, NAME_MAX);
  if (!name) return { ok: false, error: `name must be 1-${NAME_MAX} characters` };
  const race_name = cleanName(b.race_name, RACE_NAME_MAX);
  if (!race_name) return { ok: false, error: `race_name must be 1-${RACE_NAME_MAX} characters` };
  if (typeof b.race_date !== "string" || !isValidDate(b.race_date)) return { ok: false, error: "race_date must be YYYY-MM-DD" };
  if (b.race_date < todayJst()) return { ok: false, error: "race_date must not be in the past" };
  if (b.race_date > maxRaceDate()) return { ok: false, error: `race_date must be within ${RACE_DATE_MAX_YEARS} years` };
  return { ok: true, value: { name, race_name, race_date: b.race_date } };
}

export function toApiGroup(
  g: Pick<GroupRow, "id" | "name" | "race_name" | "race_date" | "created_at">,
  mine: { role: "owner" | "member"; joined_at: Date },
  memberCount: number,
  unread = 0,
): ApiGroup {
  return {
    id: g.id,
    name: g.name,
    race_name: g.race_name,
    race_date: g.race_date,
    created_at: new Date(g.created_at).toISOString(),
    joined_at: new Date(mine.joined_at).toISOString(),
    my_role: mine.role,
    member_count: memberCount,
    max_members: GROUP_MAX_MEMBERS,
    unread,
  };
}

const GROUP_COLS = "g.id, g.name, g.race_name, to_char(g.race_date, 'YYYY-MM-DD') as race_date, g.owner_user_id, g.created_at, g.disbanded_at";

// ---- membership ------------------------------------------------------------------------------

export interface Membership { group: GroupRow; member: GroupMemberRow }

/**
 * Is `userId` a current member of `groupId`? The first step of every route that carries a group id. undefined = not a member,
 * the group does not exist, or it was disbanded: the three are indistinguishable (the handler answers the same 404).
 */
export async function membership(userId: string, groupId: string): Promise<Membership | undefined> {
  const row = await queryOne<GroupRow & { m_id: string; m_role: GroupMemberRow["role"]; m_joined_at: Date; m_seen: Date | null }>(
    `select ${GROUP_COLS}, gm.id as m_id, gm.role as m_role, gm.joined_at as m_joined_at, gm.events_seen_at as m_seen
       from group_members gm join groups g on g.id = gm.group_id
      where gm.user_id = $1 and gm.group_id = $2 and gm.left_at is null and g.disbanded_at is null`,
    [userId, groupId],
  );
  if (!row) return undefined;
  const { m_id, m_role, m_joined_at, m_seen, ...group } = row;
  return {
    group,
    member: { id: m_id, group_id: group.id, user_id: userId, role: m_role, joined_at: m_joined_at, left_at: null, left_reason: null, events_seen_at: m_seen },
  };
}

/** My groups, oldest membership first. `unread` is 0 here: the count reads other members' switches, so group-view.ts fills it in. */
export async function listGroups(userId: string): Promise<ApiGroup[]> {
  const rows = await query<GroupRow & { role: "owner" | "member"; joined_at: Date; member_count: number }>(
    `select ${GROUP_COLS}, gm.role, gm.joined_at,
            (select count(*)::int from group_members x where x.group_id = g.id and x.left_at is null) as member_count
       from group_members gm join groups g on g.id = gm.group_id
      where gm.user_id = $1 and gm.left_at is null and g.disbanded_at is null
      order by gm.joined_at, g.id`,
    [userId],
  );
  return rows.map((r) => toApiGroup(r, r, r.member_count));
}

/** Serialises everything that adds a membership for one user (create, accept). Held until the transaction ends. */
export async function lockUser(q: Querier, userId: string): Promise<void> {
  await q("select pg_advisory_xact_lock(hashtext($1))", [`user-groups:${userId}`]);
}

/** How many current memberships `userId` holds. */
export async function activeGroupCount(q: Querier, userId: string): Promise<number> {
  const [r] = await q<{ n: number }>(
    `select count(*)::int as n from group_members gm join groups g on g.id = gm.group_id
      where gm.user_id = $1 and gm.left_at is null and g.disbanded_at is null`,
    [userId],
  );
  return r?.n ?? 0;
}

/** The group row, locked until the transaction ends; false = no such group or already disbanded. The first statement of leave / remove / disband. */
const lockGroup = async (q: Querier, groupId: string): Promise<boolean> =>
  (await q("select id from groups where id = $1 and disbanded_at is null for update", [groupId])).length > 0;

const memberCountOf = async (q: Querier, groupId: string): Promise<number> =>
  (await q<{ n: number }>("select count(*)::int as n from group_members where group_id = $1 and left_at is null", [groupId]))[0]?.n ?? 0;

// ---- create / disband ------------------------------------------------------------------------

export async function createGroup(userId: string, body: GroupBody): Promise<{ ok: true; group: ApiGroup } | { ok: false; reason: "limit" }> {
  const out = await withTransaction(async (q) => {
    await lockUser(q, userId);
    if ((await activeGroupCount(q, userId)) >= GROUP_MAX_PER_USER) return undefined;
    const groupId = randomUUID();
    const memberId = randomUUID();
    const [g] = await q<GroupRow>(
      `insert into groups (id, name, race_name, race_date, owner_user_id) values ($1, $2, $3, $4, $5)
       returning id, name, race_name, to_char(race_date, 'YYYY-MM-DD') as race_date, owner_user_id, created_at, disbanded_at`,
      [groupId, body.name, body.race_name, body.race_date, userId],
    );
    const [m] = await q<GroupMemberRow>(
      "insert into group_members (id, group_id, user_id, role) values ($1, $2, $3, 'owner') returning *",
      [memberId, groupId, userId],
    );
    await recordMembership(q, groupId, memberId, "joined");
    return toApiGroup(g, m, 1);
  });
  if (!out) return { ok: false, reason: "limit" };
  await afterJoin(userId, out);
  return { ok: true, group: out };
}

/** Owner only. Everyone is out at once (`left_reason` disbanded), every invite is revoked, no event is written. */
export async function disbandGroup(userId: string, groupId: string): Promise<"ok" | "not_member" | "not_owner"> {
  const mine = await membership(userId, groupId);
  if (!mine) return "not_member";
  if (mine.member.role !== "owner") return "not_owner";
  return withTransaction(async (q) => {
    const g = await q("select id from groups where id = $1 and disbanded_at is null for update", [groupId]);
    if (!g.length) return "not_member" as const; // disbanded a moment ago
    await q("update groups set disbanded_at = now() where id = $1", [groupId]);
    await q("update group_members set left_at = now(), left_reason = 'disbanded' where group_id = $1 and left_at is null", [groupId]);
    await q("update group_invites set revoked_at = now() where group_id = $1 and revoked_at is null", [groupId]);
    return "ok" as const;
  });
}

// ---- invites ---------------------------------------------------------------------------------

export interface CreatedInvite { token: string; expires_at: string; uses_left: number }

/** Owner only. A new link revokes the live one; the plaintext token exists only in the return value (the table has its sha256). */
export async function createInvite(userId: string, groupId: string): Promise<{ ok: true; invite: ApiGroupInvite & { token: string } } | { ok: false; reason: "not_member" | "not_owner" | "full" }> {
  const mine = await membership(userId, groupId);
  if (!mine) return { ok: false, reason: "not_member" };
  if (mine.member.role !== "owner") return { ok: false, reason: "not_owner" };
  const token = newToken();
  const out = await withTransaction(async (q) => {
    const g = await q("select id from groups where id = $1 and disbanded_at is null for update", [groupId]);
    if (!g.length) return "not_member" as const;
    const seats = GROUP_MAX_MEMBERS - (await memberCountOf(q, groupId));
    if (seats <= 0) return "full" as const;
    await q("update group_invites set revoked_at = now() where group_id = $1 and revoked_at is null", [groupId]);
    const [inv] = await q<{ expires_at: Date }>(
      `insert into group_invites (id, group_id, token_hash, created_by, expires_at, max_uses)
       values ($1, $2, $3, $4, now() + make_interval(days => $5), $6) returning expires_at`,
      [randomUUID(), groupId, hashToken(token), userId, INVITE_TTL_DAYS, seats],
    );
    return { token, expires_at: new Date(inv.expires_at).toISOString(), uses_left: seats };
  });
  if (out === "not_member" || out === "full") return { ok: false, reason: out };
  return { ok: true, invite: out };
}

/** Owner only. Nothing live is fine (idempotent). */
export async function revokeInvite(userId: string, groupId: string): Promise<"ok" | "not_member" | "not_owner"> {
  const mine = await membership(userId, groupId);
  if (!mine) return "not_member";
  if (mine.member.role !== "owner") return "not_owner";
  await query("update group_invites set revoked_at = now() where group_id = $1 and revoked_at is null", [groupId]);
  return "ok";
}

type InviteFacts = Pick<GroupInviteRow, "revoked_at" | "uses" | "max_uses"> & { expired: boolean };
/** The order the page checks them in: revoked, expired, used up, already in it, already in the maximum, full. */
function inviteState(inv: InviteFacts, isMember: boolean, groupCount: number, memberCount: number): InviteState {
  if (inv.revoked_at) return "revoked";
  if (inv.expired) return "expired";
  if (inv.uses >= inv.max_uses) return "used_up";
  if (isMember) return "already_member";
  if (groupCount >= GROUP_MAX_PER_USER) return "group_limit";
  if (memberCount >= GROUP_MAX_MEMBERS) return "full";
  return "ok";
}

/**
 * GET /invites/{token}. undefined = no such invite or its group was disbanded (404). `group` (name, race, who invited) only
 * when the page needs it: to offer the join (`ok`) or the way in (`already_member`); every other state is a fixed line and
 * tells a holder of the link nothing about the group.
 */
export async function previewInvite(viewerId: string, token: string): Promise<InvitePreviewResponse | undefined> {
  const row = await queryOne<GroupInviteRow & { expired: boolean; g_name: string; g_race_name: string; g_race_date: string; inviter: string }>(
    `select i.*, (i.expires_at <= now()) as expired, g.name as g_name, g.race_name as g_race_name,
            to_char(g.race_date, 'YYYY-MM-DD') as g_race_date, u.display_name as inviter
       from group_invites i join groups g on g.id = i.group_id and g.disbanded_at is null
       join users u on u.id = i.created_by
      where i.token_hash = $1`,
    [hashToken(token)],
  );
  if (!row) return undefined;
  const isMember = !!(await membership(viewerId, row.group_id));
  const [count, members] = await Promise.all([
    activeGroupCount(query, viewerId),
    memberCountOf(query, row.group_id),
  ]);
  const state = inviteState(row, isMember, count, members);
  const show = state === "ok" || state === "already_member";
  return {
    state,
    group: show ? { id: row.group_id, name: row.g_name, race_name: row.g_race_name, race_date: row.g_race_date, member_count: members, invited_by: row.inviter } : null,
  };
}

export type AcceptResult = ({ ok: true } & AcceptInviteResponse) | { ok: false; state: Exclude<InviteState, "ok"> };

/** POST /invites/{token}/accept. undefined = 404. Nothing is consumed unless the join succeeds. */
export async function acceptInvite(viewerId: string, token: string): Promise<AcceptResult | undefined> {
  const out = await withTransaction(async (q): Promise<AcceptResult | undefined> => {
    const [first] = await q<{ id: string; group_id: string }>("select id, group_id from group_invites where token_hash = $1", [hashToken(token)]);
    if (!first) return undefined;
    // lock order: the user, then the group, then the invite row
    await lockUser(q, viewerId);
    const [g] = await q<GroupRow>(`select ${GROUP_COLS} from groups g where g.id = $1 and g.disbanded_at is null for update`, [first.group_id]);
    if (!g) return undefined;
    const [inv] = await q<GroupInviteRow & { expired: boolean }>("select *, (expires_at <= now()) as expired from group_invites where id = $1 for update", [first.id]);
    const [mine] = await q("select 1 from group_members where group_id = $1 and user_id = $2 and left_at is null", [g.id, viewerId]);
    const state = inviteState(inv, !!mine, await activeGroupCount(q, viewerId), await memberCountOf(q, g.id));
    if (state !== "ok") return { ok: false, state };
    // a returning member reuses his row (left_at back to null, a fresh joined_at, nothing seen yet)
    const [m] = await q<GroupMemberRow>(
      `insert into group_members (id, group_id, user_id, role) values ($1, $2, $3, 'member')
       on conflict (group_id, user_id) do update set left_at = null, left_reason = null, role = 'member', joined_at = now(), events_seen_at = null
       returning *`,
      [randomUUID(), g.id, viewerId],
    );
    await q("update group_invites set uses = uses + 1 where id = $1", [inv.id]);
    await recordMembership(q, g.id, m.id, "joined");
    return { ok: true, group: toApiGroup(g, m, await memberCountOf(q, g.id)) };
  });
  if (out?.ok) await afterJoin(viewerId, out.group);
  return out;
}

// ---- leave / remove --------------------------------------------------------------------------

/** `left_at` set, a `left` event; he keeps his other groups. The owner cannot leave (he disbands). */
export async function leaveGroup(userId: string, groupId: string): Promise<"ok" | "owner" | "none"> {
  const mine = await membership(userId, groupId);
  if (!mine) return "none";
  if (mine.member.role === "owner") return "owner";
  return withTransaction(async (q) => {
    if (!(await lockGroup(q, groupId))) return "none" as const; // disbanded a moment ago
    const hit = await q<{ id: string }>(
      `update group_members set left_at = now(), left_reason = 'left'
        where id = $1 and group_id = $2 and user_id = $3 and left_at is null returning id`,
      [mine.member.id, groupId, userId],
    );
    if (!hit.length) return "none" as const; // removed a moment ago
    await recordMembership(q, groupId, mine.member.id, "left");
    return "ok" as const;
  });
}

/** Owner removes a member (`mid` is a group_members.id of THIS group). Same effect and event as leaving, and the live invite is revoked with it. */
export async function removeMember(ownerId: string, groupId: string, memberId: string): Promise<"ok" | "not_member" | "not_owner" | "not_found" | "self"> {
  const mine = await membership(ownerId, groupId);
  if (!mine) return "not_member";
  if (mine.member.role !== "owner") return "not_owner";
  const target = await queryOne<{ id: string; user_id: string }>(
    "select id, user_id from group_members where id = $1 and group_id = $2 and left_at is null",
    [memberId, groupId],
  );
  if (!target) return "not_found";
  if (target.user_id === ownerId) return "self";
  return withTransaction(async (q) => {
    if (!(await lockGroup(q, groupId))) return "not_found" as const; // disbanded a moment ago
    const hit = await q<{ id: string }>(
      `update group_members set left_at = now(), left_reason = 'removed'
        where id = $1 and group_id = $2 and left_at is null returning id`,
      [target.id, groupId],
    );
    if (!hit.length) return "not_found" as const;
    await recordMembership(q, groupId, target.id, "left");
    // Removing is not blocking unless the way back is closed: the removed person still holds the link he came in with. The group's live
    // invite is revoked in the same transaction (the group row is already locked); the owner makes a new link when he wants one.
    // Anyone using the old link then gets exactly what any revoked link gets (409 revoked / preview "revoked"). leave does not do this.
    await q("update group_invites set revoked_at = now() where group_id = $1 and revoked_at is null", [groupId]);
    return "ok" as const;
  });
}

/** PUT /groups/{id}/seen: the 消息中心 was opened. false = not a current member. */
export async function markSeen(userId: string, groupId: string): Promise<boolean> {
  const hit = await query<{ id: string }>(
    `update group_members gm set events_seen_at = now() from groups g
      where g.id = gm.group_id and g.disbanded_at is null and gm.group_id = $1 and gm.user_id = $2 and gm.left_at is null
      returning gm.id`,
    [groupId, userId],
  );
  return hit.length > 0;
}

// ---- my share switches -----------------------------------------------------------------------

/** My own switches (the defaults when I never set any). Only ever read for the caller's own user id. */
export async function getShare(userId: string): Promise<ShareSettings> {
  const row = await queryOne<ShareSettings>("select progress, events, plan, runs, reviews from share_settings where user_id = $1", [userId]);
  return row ?? { ...SHARE_DEFAULTS };
}

/** Change only the switches given (booleans; the handler has checked them). Takes effect on the next request of anyone. */
export async function putShare(userId: string, patch: Partial<ShareSettings>): Promise<ShareSettings> {
  const given = SHARE_KEYS.map((k) => (typeof patch[k] === "boolean" ? patch[k] : null));
  if (given.every((v) => v === null)) return getShare(userId);
  const [row] = await query<ShareSettings>(
    `insert into share_settings (user_id, progress, events, plan, runs, reviews)
     values ($1, coalesce($2::boolean, true), coalesce($3::boolean, true), coalesce($4::boolean, false), coalesce($5::boolean, false), coalesce($6::boolean, false))
     on conflict (user_id) do update set
       progress = coalesce($2::boolean, share_settings.progress), events = coalesce($3::boolean, share_settings.events),
       plan = coalesce($4::boolean, share_settings.plan), runs = coalesce($5::boolean, share_settings.runs),
       reviews = coalesce($6::boolean, share_settings.reviews), updated_at = now()
     returning progress, events, plan, runs, reviews`,
    [userId, ...given],
  );
  return row;
}

// ---- the ai-plan-generation hook -------------------------------------------------------------

/**
 * ai-plan-generation's goals list hooks in here (its 01b §12.3 `upsertGoalFromGroup`): called after a group was created or
 * joined, outside the membership transaction, errors swallowed. In group-race it does nothing: the "is this race inside his
 * plan" question is answered by dates (group-progress.ts planRange), not by goals.
 */
export async function onGroupRaceJoined(_userId: string, _race: { name: string; race_date: string; group_id: string }): Promise<void> {
  // intentionally empty
}

async function afterJoin(userId: string, group: ApiGroup): Promise<void> {
  try {
    await onGroupRaceJoined(userId, { name: group.race_name, race_date: group.race_date, group_id: group.id });
  } catch (err) {
    console.error(`onGroupRaceJoined failed for group ${group.id}`, err instanceof Error ? err.message : err);
  }
}
