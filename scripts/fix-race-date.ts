import "dotenv/config";
import { end, query } from "../src/lib/db";

// One-off: 富士山マラソン 2026 is Sunday 12/13, not Monday 12/14. For every plan
// still on 12/14 this drops the last plain rest day before the race and moves the
// days after it one day earlier, so the race lands on 12/13 and the day before
// stays 完全休息. Weeks and the plan's race_date follow.
//
//   npm run fix-race-date            # dry run: prints each plan's last week before / after
//   npm run fix-race-date -- --apply # writes it

const OLD = "2026-12-14";
const NEW = "2026-12-13";

interface Plan { id: string; user: string; race_date: string }
interface Session { id: string; scheduled_date: string; type: string; label: string | null; content: string | null; superseded: boolean }
interface Week { id: string; week_no: number; week_start: string; week_end: string; focus: string | null }

function shift(d: string, days: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const plans = await query<Plan>(
    `select p.id, u.display_name as user, to_char(p.race_date, 'YYYY-MM-DD') as race_date
       from plans p join users u on u.id = p.user_id
      where p.race_name = '富士山マラソン' order by u.display_name`,
  );
  if (!plans.length) console.log("no 富士山マラソン plans");

  for (const plan of plans) {
    console.log(`\n== ${plan.user} (plan ${plan.id}) race_date ${plan.race_date}`);
    if (plan.race_date !== OLD) { console.log("   already moved, skipping"); continue; }

    const sessions = await query<Session>(
      `select id, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date, type, label, content, superseded
         from planned_sessions where plan_id = $1 and scheduled_date >= '2026-12-07'
        order by scheduled_date, version`,
      [plan.id],
    );
    const weeks = await query<Week>(
      `select id, week_no, to_char(week_start, 'YYYY-MM-DD') as week_start, to_char(week_end, 'YYYY-MM-DD') as week_end, focus
         from plan_weeks where plan_id = $1 and week_end >= '2026-12-07' order by week_no`,
      [plan.id],
    );
    const line = (s: Session) => `   ${s.scheduled_date} ${(s.label ?? s.type).padEnd(6)} ${s.content ?? ""}${s.superseded ? " (superseded)" : ""}`;
    console.log("   before:"); sessions.forEach((s) => console.log(line(s)));

    // The rest day to drop: the latest plain 休息 (not 完全休息) between 12/08 and 12/13.
    const drop = [...sessions].reverse().find((s) => !s.superseded && s.type === "rest" && s.label !== "完全休息"
      && s.scheduled_date >= "2026-12-08" && s.scheduled_date <= "2026-12-13");
    if (!drop) { console.log("   !! no plain rest day found between 12/08 and 12/13; fix this plan by hand"); continue; }

    const moved = sessions.filter((s) => s.scheduled_date > drop.scheduled_date);
    const after = sessions
      .filter((s) => s.scheduled_date !== drop.scheduled_date)
      .map((s) => (s.scheduled_date > drop.scheduled_date ? { ...s, scheduled_date: shift(s.scheduled_date, -1) } : s));
    console.log(`   drop ${drop.scheduled_date} ${drop.label ?? drop.type}; move ${moved.length} row(s) one day earlier`);
    console.log("   after:"); after.forEach((s) => console.log(line(s)));

    const lastWeek = weeks.find((w) => w.week_start === OLD);
    const prevWeek = weeks.find((w) => w.week_end === shift(OLD, -1));
    console.log(`   weeks: ${weeks.map((w) => `#${w.week_no} ${w.week_start}〜${w.week_end}`).join(", ")}`);
    if (!lastWeek || !prevWeek) console.log("   !! expected a race week starting 12/14 and the week before ending 12/13; weeks left untouched");

    if (!apply) continue;

    const stmts: string[] = ["begin"];
    stmts.push(`delete from planned_sessions where plan_id = '${plan.id}' and scheduled_date = '${drop.scheduled_date}'`);
    for (const s of moved) stmts.push(`update planned_sessions set scheduled_date = scheduled_date - 1 where id = '${s.id}'`);
    if (lastWeek && prevWeek) {
      stmts.push(`update plan_weeks set week_end = '${shift(NEW, -1)}' where id = '${prevWeek.id}'`);
      stmts.push(`update plan_weeks set week_start = '${NEW}', week_end = '${NEW}', focus = replace(coalesce(focus, ''), '12/14', '12/13') where id = '${lastWeek.id}'`);
    }
    stmts.push(`update plans set race_date = '${NEW}' where id = '${plan.id}'`);
    stmts.push("commit");
    await query(stmts.join(";\n"));
    console.log("   applied");
  }
  if (!apply) console.log("\n(dry run; add --apply to write)");
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(end);
