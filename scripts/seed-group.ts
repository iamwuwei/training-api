import "dotenv/config";
import { randomUUID } from "node:crypto";
import { USERS } from "../seed/seed";
import { end, type Querier, withTransaction } from "../src/lib/db";
import { recordMembership } from "../src/lib/group-events";
import { cleanName, NAME_MAX, RACE_NAME_MAX } from "../src/lib/groups";

// group-race 初始遷入: put the two seeded athletes (ww the owner, gf a member) into one group, once.
// Usage:  npm run seed-group                      create it
//         npm run seed-group -- --name "…"        another group name (default: the race name)
//         npm run seed-group -- --share all|ww|gf also switch ALL five share switches on for both / ww / gf
//         npm run seed-group -- --undo            remove it again (only while it is still the one this script made)
//
// Not in sql/schema.sql: the schema does not know who the users are, and a failed seed must not stop `npm run migrate`.
// Run after `npm run migrate`, before or after the api is deployed (it only touches the group tables). Idempotent: when either
// person has ever been in a group it does nothing and says why (exit 0). The group's race is ww's active plan's race. No invite
// is created. By default NO share_settings row is written: a missing row is the default (progress and finished-session events
// on; plan, runs, reviews off), so each person decides in the settings page what the other may see; --share is for the
// other choices. `--undo` deletes the group, its members, invites and events, never share_settings.
// Exit code: 0 = done, or nothing to do (already seeded, a person missing, nothing to undo); 1 = misuse, no active plan, DB error;
// 2 = --undo refused (not the group this script made: a third person, a used invite, a second group of ww).

const LOCK = "seed-group";
const ww = USERS.ww.id;
const gf = USERS.gf.id;

interface Outcome { done: boolean; reason: string; failed?: boolean; refused?: boolean }
interface Options { undo: boolean; name?: string; share?: "all" | "ww" | "gf" }

function parseArgs(argv: string[]): Options | string {
  const o: Options = { undo: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--undo") o.undo = true;
    else if (a === "--name") o.name = argv[++i];
    else if (a === "--share") {
      const v = argv[++i];
      if (v !== "all" && v !== "ww" && v !== "gf") return "--share takes all, ww or gf";
      o.share = v;
    } else return `unknown argument ${a}`;
  }
  if (o.undo && (o.name !== undefined || o.share !== undefined)) return "--undo takes no other option";
  if (o.name !== undefined && cleanName(o.name, NAME_MAX) === null) return `--name must be 1-${NAME_MAX} characters`;
  return o;
}

async function seedGroup(q: Querier, o: Options): Promise<Outcome> {
  await q("select pg_advisory_xact_lock(hashtext($1))", [LOCK]);

  const users = await q<{ id: string }>("select id from users where id = any($1::uuid[])", [[ww, gf]]);
  if (users.length < 2) return { done: false, reason: "找不到使用者 ww／gf（先跑 npm run seed），什麼都沒做。" };

  const [seen] = await q<{ n: number }>("select count(*)::int as n from group_members where user_id = any($1::uuid[])", [[ww, gf]]);
  if (seen.n > 0) return { done: false, reason: "ww 或 gf 已在（或曾在）群組裡，什麼都沒做。這支腳本只負責第一次安裝。" };

  const [plan] = await q<{ race_name: string; race_date: string }>(
    "select race_name, to_char(race_date, 'YYYY-MM-DD') as race_date from plans where user_id = $1 and status = 'active' order by race_date limit 1",
    [ww],
  );
  if (!plan) return { done: false, failed: true, reason: "ww 沒有 active 課表，沒辦法決定群組的比賽。先跑 npm run seed。" };

  const race = cleanName(plan.race_name, 10_000) ?? plan.race_name.trim();
  const name = o.name !== undefined ? cleanName(o.name, NAME_MAX)! : [...race].slice(0, NAME_MAX).join("");
  const raceName = [...race].slice(0, RACE_NAME_MAX).join("");
  const groupId = randomUUID();
  await q("insert into groups (id, name, race_name, race_date, owner_user_id) values ($1, $2, $3, $4, $5)", [groupId, name, raceName, plan.race_date, ww]);
  for (const [userId, role] of [[ww, "owner"], [gf, "member"]] as const) {
    const memberId = randomUUID();
    await q("insert into group_members (id, group_id, user_id, role) values ($1, $2, $3, $4)", [memberId, groupId, userId, role]);
    await recordMembership(q, groupId, memberId, "joined");
  }

  const who = o.share === "all" ? [ww, gf] : o.share === "ww" ? [ww] : o.share === "gf" ? [gf] : [];
  for (const userId of who) {
    await q(
      `insert into share_settings (user_id, progress, events, plan, runs, reviews) values ($1, true, true, true, true, true)
       on conflict (user_id) do update set progress = true, events = true, plan = true, runs = true, reviews = true, updated_at = now()`,
      [userId],
    );
  }
  return {
    done: true,
    reason: `建立群組「${name}」（${raceName}，${plan.race_date}），ww 擁有者、gf 成員，各一則 joined 事件，沒有邀請。` +
      (who.length ? ` 分享設定：${who.length === 2 ? "兩人" : o.share} 五個開關全開。` : " 沒有寫分享設定（缺列＝預設）。"),
  };
}

async function undoGroup(q: Querier): Promise<Outcome> {
  await q("select pg_advisory_xact_lock(hashtext($1))", [LOCK]);
  const groups = await q<{ id: string }>("select id from groups where owner_user_id = $1 and disbanded_at is null", [ww]);
  if (!groups.length) return { done: false, reason: "ww 沒有進行中的群組，沒有東西可以還原。" };
  if (groups.length > 1) return { done: false, refused: true, reason: "ww 擁有不只一個群組：這不是腳本建的樣子，請用畫面解散。" };
  const id = groups[0].id;

  const others = await q("select 1 from group_members where group_id = $1 and user_id <> all($2::uuid[])", [id, [ww, gf]]);
  if (others.length) return { done: false, refused: true, reason: "群組裡有 ww、gf 以外的人（或曾經有）：不是腳本建的樣子，請用畫面解散。" };
  const used = await q("select 1 from group_invites where group_id = $1 and uses > 0", [id]);
  if (used.length) return { done: false, refused: true, reason: "這個群組的邀請有人用過：不是腳本建的樣子，請用畫面解散。" };

  await q("delete from group_events where group_id = $1", [id]);
  await q("delete from group_invites where group_id = $1", [id]);
  await q("delete from group_members where group_id = $1", [id]);
  await q("delete from groups where id = $1", [id]);
  return { done: true, reason: "已刪除群組、成員、邀請與事件（分享設定不動）。" };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts === "string") {
    console.error(`${opts}\nusage: npm run seed-group [-- --name "…" | --share all|ww|gf | --undo]`);
    process.exitCode = 1;
    return;
  }
  const out = await withTransaction((q) => (opts.undo ? undoGroup(q) : seedGroup(q, opts)));
  console.log(out.reason);
  if (out.failed) process.exitCode = 1;
  if (out.refused) process.exitCode = 2; // --undo said no: a calling script must not read "nothing done" as "done"
  if (!opts.undo && opts.share && !out.done && !out.failed) console.log("（--share 只在建立群組的那一次生效；要改分享請到設定頁，或先 --undo 再重跑。）");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(end);
