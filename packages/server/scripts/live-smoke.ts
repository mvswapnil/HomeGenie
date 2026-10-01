/**
 * Live end-to-end check: real server process, real Postgres, real Claude.
 * Posts a short family conversation and prints what the app did with each message.
 *
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres ANTHROPIC_API_KEY=sk-... \
 *     npx tsx packages/server/scripts/live-smoke.ts
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { createTestDb, H, M, postMessage, seed, tokenFor, JWT_SECRET, U } from "../test/helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const names: Record<string, string> = { [M.mom]: "Mom", [M.papa]: "Papa", [M.riya]: "Riya", [M.arjun]: "Arjun" };

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("set ANTHROPIC_API_KEY");
  const t = await createTestDb();
  await seed(t.db);
  const port = 18787;
  const server = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url))], {
    env: { ...process.env, DATABASE_URL: t.url, SUPABASE_JWT_SECRET: JWT_SECRET, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => process.stdout.write(`  [server] ${d}`));
  server.stderr.on("data", (d) => process.stdout.write(`  [server] ${d}`));

  try {
    await sleep(2500);
    // Messages are stamped "now", so dates resolve relative to today.
    const now = () => new Date().toISOString();
    const say = async (from: string, text: string, replyTo?: string) => {
      const id = await postMessage(t.db, from, text, { at: now(), replyTo });
      for (let i = 0; i < 60; i++) {
        const r = (await t.db.query("select parse_status, parse_result from chat_message where id = $1", [id])).rows[0];
        if (!["pending", "processing"].includes(r.parse_status)) {
          console.log(`\n${names[from]}: ${text}${replyTo ? "   (reply)" : ""}\n  → ${r.parse_status} ${JSON.stringify(r.parse_result)}`);
          return id;
        }
        await sleep(250);
      }
      throw new Error(`timed out on: ${text}`);
    };

    const bill = await say(M.mom, "Electricity bill ₹4,237 pay by 1st of next month");
    await say(M.mom, "sorry, it's ₹4,512 actually");
    await say(M.papa, "main bhar dunga", bill);
    await say(M.riya, "ok 👍");
    await say(M.arjun, "AC thoda kharab lag raha hai");
    await say(M.papa, "bijli ka bill bhar diya, aur aate waqt doodh le aana Arjun");

    console.log("\nItems now:");
    const rows = (await t.db.query("select i.*, l.name as list from item i left join list l on l.id = i.list_id where i.household_id = $1 order by created_at", [H])).rows;
    for (const i of rows) {
      const due = i.due_at ? DateTime.fromISO(i.due_at).setZone("Asia/Kolkata").toFormat("d LLL HH:mm") : "-";
      console.log(`  ${i.status.padEnd(6)} ${i.type.padEnd(10)} ${i.title.padEnd(28)} for ${names[i.assigned_to] ?? "anyone"}  due ${due}  ${i.attrs.amount ? "₹" + i.attrs.amount : ""} ${i.list ?? ""}`);
    }
    const events = (await t.db.query("select i.title, e.action, e.diff, e.actor_member_id from item_event e join item i on i.id = e.item_id order by e.at")).rows;
    console.log("\nHistory:");
    for (const e of events) console.log(`  ${(names[e.actor_member_id] ?? "parser").padEnd(6)} ${e.action.padEnd(9)} ${e.title}  ${JSON.stringify(e.diff)}`);
    const facts = (await t.db.query("select key, value from household_fact")).rows;
    console.log("\nMemory:", JSON.stringify(facts));

    const res = await fetch(`http://localhost:${port}/health`);
    console.log("\nAPI health:", res.status, await res.text());
    const sugg = (await t.db.query("select id from suggestion where state = 'shown' limit 1")).rows[0];
    if (sugg) {
      const acc = await fetch(`http://localhost:${port}/v1/suggestions/${sugg.id}/accept`, { method: "POST", headers: { authorization: `Bearer ${await tokenFor(U.mom)}` } });
      console.log("Accept suggestion:", acc.status, await acc.text());
    }
  } finally {
    server.kill("SIGTERM");
    await sleep(500);
    await t.drop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
