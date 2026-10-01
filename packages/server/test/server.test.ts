import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { createApi } from "../src/api.js";
import { claimNext, processMessage, runOnce, MAX_ATTEMPTS } from "../src/worker.js";
import { buildContext } from "../src/context.js";
import { renderCorrections, renderFacts } from "../src/memory.js";
import { getMembers, getMessage } from "../src/repo.js";
import { sendDueReminders, type DueReminder } from "../src/reminders.js";
import { createTestDb, H, item, JWT_SECRET, M, OTHER_H, postgresAvailable, postMessage, scripted, seed, tokenFor, U, type TestDb } from "./helpers.js";

const NOW = new Date("2026-09-30T04:30:00Z"); // Wed 30 Sep 2026, 10:00 IST
const ist = (iso: string | null) => (iso ? DateTime.fromISO(iso).setZone("Asia/Kolkata").toFormat("yyyy-MM-dd HH:mm") : null);
const ok = await postgresAvailable();

describe.skipIf(!ok)("server against Postgres", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.query("truncate household, auth.users cascade");
    await seed(t.db);
  });

  const items = async () => (await t.db.query("select * from item where household_id = $1 order by created_at", [H])).rows;
  const events = async (itemId: string) => (await t.db.query("select action, diff, actor_member_id, undone_at from item_event where item_id = $1 order by at", [itemId])).rows;

  describe("parse worker", () => {
    it("turns a message into an item with an event, reminders, memory and a card", async () => {
      const ex = scripted({ "Electricity bill ₹4,237 pay by 1 Oct": { actionable: true, items: [item({ type: "bill", title: "Pay electricity bill", due_text: "1 Oct", amount: 4237, biller: "Electricity" })] } });
      const id = await postMessage(t.db, M.mom, "Electricity bill ₹4,237 pay by 1 Oct");
      expect(await runOnce({ db: t.db, extractor: ex, now: () => NOW })).toBe(1);

      const [bill] = await items();
      expect(bill).toMatchObject({ type: "bill", title: "Pay electricity bill", assigned_to: M.mom, created_by: M.mom, source_message_id: id, status: "open" });
      expect(bill.attrs).toEqual({ amount: 4237, currency: "INR", biller: "Electricity" });
      expect(ist(bill.due_at)).toBe("2026-10-01 09:00");

      expect((await events(bill.id)).map((e) => e.action)).toEqual(["created"]);
      const reminders = (await t.db.query("select fire_at from reminder_schedule where item_id = $1 order by fire_at", [bill.id])).rows;
      // 3 days before is already past (28 Sep), so only the due-day nudge remains
      expect(reminders.map((r) => ist(r.fire_at))).toEqual(["2026-10-01 09:00"]);

      const msg = await getMessage(t.db, id);
      expect(msg?.parseStatus).toBe("item");
      const result = (await t.db.query("select parse_result from chat_message where id = $1", [id])).rows[0].parse_result;
      expect(result).toMatchObject({ itemIds: [bill.id], suggestionId: null, duplicates: [] });

      expect(await renderFacts(t.db, H, await getMembers(t.db, H))).toEqual(["Electricity: usually about ₹4,237, due around the 1st."]);
    });

    it("never calls the model for chatter", async () => {
      const ex = scripted({});
      const id = await postMessage(t.db, M.riya, "ok");
      await runOnce({ db: t.db, extractor: ex, now: () => NOW });
      expect(ex.calls).toHaveLength(0);
      expect((await getMessage(t.db, id))?.parseStatus).toBe("none");
    });

    it("puts shopping items on the right list, creating it if needed", async () => {
      const ex = scripted({
        "doodh aur toothbrush": {
          actionable: true,
          items: [item({ type: "list_entry", title: "Milk", list_name: "Shopping" }), item({ type: "list_entry", title: "Toothbrush", list_name: "packing" })],
        },
      });
      await postMessage(t.db, M.mom, "doodh aur toothbrush");
      await runOnce({ db: t.db, extractor: ex, now: () => NOW });
      const rows = (await t.db.query("select i.title, l.name, i.assigned_to from item i join list l on l.id = i.list_id order by i.title")).rows;
      expect(rows).toEqual([
        { title: "Milk", name: "Shopping", assigned_to: null },
        { title: "Toothbrush", name: "Packing", assigned_to: null },
      ]);
    });

    it("applies a correction to the item it refers to, and the card's Undo reverses it", async () => {
      const ex = scripted({
        "Electricity bill 4237 by 1 Oct": { actionable: true, items: [item({ type: "bill", title: "Pay electricity bill", due_text: "1 Oct", amount: 4237, biller: "Electricity" })] },
        "actually it's ₹4,500": { actionable: true, items: [], updates: [{ ref: "@Pay electricity bill", op: "update", amount: 4500, confidence: 0.95 }] },
      });
      await postMessage(t.db, M.mom, "Electricity bill 4237 by 1 Oct");
      const fix = await postMessage(t.db, M.mom, "actually it's ₹4,500");
      await runOnce({ db: t.db, extractor: ex, now: () => NOW });

      // The model saw the bill in context, with a ref but no id
      const shown = ex.calls[1]!.context!;
      expect(shown.openItems[0]).toMatchObject({ ref: "i1", title: "Pay electricity bill", amount: 4237 });
      expect(JSON.stringify(shown)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(shown.recentMessages.map((m) => m.text)).toEqual(["Electricity bill 4237 by 1 Oct"]);

      let [bill] = await items();
      expect(bill.attrs.amount).toBe(4500);
      expect((await events(bill.id)).map((e) => [e.action, e.diff])).toEqual([
        ["created", { assignedBy: "default_sender" }],
        ["edited", { amount: [4237, 4500] }],
      ]);
      expect((await getMessage(t.db, fix))?.parseStatus).toBe("item");

      const api = createApi(t.db, { jwtSecret: JWT_SECRET }, () => NOW);
      const res = await api.request(`/v1/messages/${fix}/undo`, { method: "POST", headers: { authorization: `Bearer ${await tokenFor(U.mom)}` } });
      expect(res.status).toBe(200);
      [bill] = await items();
      expect(bill.attrs.amount).toBe(4237);
      expect(bill.status).toBe("open");
      // memory followed the correction (undo doesn't rewrite memory; the next bill will)
      expect(await renderFacts(t.db, H, await getMembers(t.db, H))).toEqual(["Electricity: usually about ₹4,500, due around the 1st."]);
    });

    it("'paid' completes the bill and learns who pays it; the next one goes to them", async () => {
      const ex = scripted({
        "Electricity bill 4237 by 1 Oct": { actionable: true, items: [item({ type: "bill", title: "Pay electricity bill", due_text: "1 Oct", amount: 4237, biller: "Electricity" })] },
        "paid": { actionable: true, items: [], updates: [{ ref: "@Pay electricity bill", op: "complete", confidence: 0.95 }] },
        "Electricity bill 3900 by 1 Nov": { actionable: true, items: [item({ type: "bill", title: "Pay electricity bill", due_text: "1 Nov", amount: 3900, biller: "Electricity" })] },
        "Electricity bill 4100 by 1 Dec": { actionable: true, items: [item({ type: "bill", title: "Pay electricity bill", due_text: "1 Dec", amount: 4100, biller: "Electricity" })] },
      });
      const run = () => runOnce({ db: t.db, extractor: ex, now: () => NOW });

      await postMessage(t.db, M.mom, "Electricity bill 4237 by 1 Oct");
      await postMessage(t.db, M.papa, "paid");
      await postMessage(t.db, M.mom, "Electricity bill 3900 by 1 Nov");
      await run();
      let all = await items();
      expect(all[0]).toMatchObject({ status: "done" });
      expect(all[0].completed_at).not.toBeNull();
      expect(all[1].assigned_to).toBe(M.mom); // paid once by Papa: not enough to learn

      await postMessage(t.db, M.papa, "paid");
      await postMessage(t.db, M.mom, "Electricity bill 4100 by 1 Dec");
      await run();
      all = await items();
      expect(all[2].assigned_to).toBe(M.papa); // paid twice by Papa: learned
      expect(await renderFacts(t.db, H, await getMembers(t.db, H))).toEqual([
        "Electricity: usually about ₹4,100, due around the 1st, usually paid by Papa.",
      ]);
    });

    it("a reply 'main kar dunga' claims the task", async () => {
      const ex = scripted({
        "AC service book karna hai": { actionable: true, items: [item({ title: "Book AC service" })] },
        "main kar dunga": { actionable: true, items: [], updates: [{ ref: "@Book AC service", op: "claim", confidence: 0.9 }] },
      });
      const first = await postMessage(t.db, M.mom, "AC service book karna hai");
      await postMessage(t.db, M.papa, "main kar dunga", { replyTo: first });
      await runOnce({ db: t.db, extractor: ex, now: () => NOW });
      expect(ex.calls[1]!.context!.replyTo).toMatchObject({ senderName: "Mom", text: "AC service book karna hai" });
      const [task] = await items();
      expect(task.assigned_to).toBe(M.papa);
      expect((await events(task.id)).at(-1)).toMatchObject({ action: "assigned", actor_member_id: M.papa });
    });

    it("reports a duplicate bill instead of adding it twice", async () => {
      const bill = { actionable: true, items: [item({ type: "bill" as const, title: "Pay electricity bill", due_text: "1 Oct", amount: 4237, biller: "Electricity" })] };
      const ex = scripted({ "bijli bill 4237, 1 Oct": bill, "Electricity 4237 due 1 Oct": bill });
      await postMessage(t.db, M.mom, "bijli bill 4237, 1 Oct");
      const second = await postMessage(t.db, M.papa, "Electricity 4237 due 1 Oct");
      await runOnce({ db: t.db, extractor: ex, now: () => NOW });
      const all = await items();
      expect(all).toHaveLength(1);
      const result = (await t.db.query("select parse_status, parse_result from chat_message where id = $1", [second])).rows[0];
      expect(result.parse_status).toBe("none");
      expect(result.parse_result.duplicates).toEqual([{ itemId: all[0].id, addedBy: M.mom }]);
    });

    it("completing a monthly bill queues next month's", async () => {
      const ex = scripted({
        "Rent 25000 har mahine 5 tareekh": { actionable: true, items: [item({ type: "bill", title: "Pay rent", due_text: "har mahine 5 tareekh", amount: 25000, biller: "Rent" })] },
        "rent paid": { actionable: true, items: [], updates: [{ ref: "@Pay rent", op: "complete", confidence: 0.95 }] },
      });
      await postMessage(t.db, M.mom, "Rent 25000 har mahine 5 tareekh");
      await postMessage(t.db, M.mom, "rent paid");
      await runOnce({ db: t.db, extractor: ex, now: () => NOW });
      const all = await items();
      expect(all.map((i) => [i.status, ist(i.due_at), i.recurrence_rule])).toEqual([
        ["done", "2026-10-05 09:00", "FREQ=MONTHLY;BYMONTHDAY=5"],
        ["open", "2026-11-05 09:00", "FREQ=MONTHLY;BYMONTHDAY=5"],
      ]);
    });

    it("handles each household's messages in order, one at a time, while others proceed", async () => {
      const a1 = await postMessage(t.db, M.mom, "first");
      await postMessage(t.db, M.mom, "second");
      const b1 = await postMessage(t.db, M.stranger, "other household", { householdId: OTHER_H });
      expect(await claimNext(t.db)).toBe(a1);
      expect(await claimNext(t.db)).toBe(b1); // Sharma's second waits for its first
      expect(await claimNext(t.db)).toBeNull();
    });

    it("retries a failing message, then marks it failed", async () => {
      const ex = scripted({ "book AC": new Error("model overloaded") });
      const id = await postMessage(t.db, M.mom, "book AC");
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const claimed = await claimNext(t.db);
        expect(claimed).toBe(id);
        await processMessage({ db: t.db, extractor: ex, now: () => NOW }, id);
      }
      const row = (await t.db.query("select parse_status, parse_attempts, parse_error from chat_message where id = $1", [id])).rows[0];
      expect(row).toEqual({ parse_status: "failed", parse_attempts: 3, parse_error: "model overloaded" });
      expect(await claimNext(t.db)).toBeNull();
    });

    it("low confidence becomes a suggestion; accepting it creates the items", async () => {
      const ex = scripted({ "washing machine kharab lag rahi hai": { actionable: true, items: [item({ title: "Get washing machine repaired", confidence: 0.6 })] } });
      const id = await postMessage(t.db, M.papa, "washing machine kharab lag rahi hai");
      await runOnce({ db: t.db, extractor: ex, now: () => NOW });
      expect(await items()).toHaveLength(0);
      const s = (await t.db.query("select * from suggestion where message_id = $1", [id])).rows[0];
      expect(s.state).toBe("shown");

      const api = createApi(t.db, { jwtSecret: JWT_SECRET }, () => NOW);
      const auth = { authorization: `Bearer ${await tokenFor(U.mom)}` };
      const res = await api.request(`/v1/suggestions/${s.id}/accept`, { method: "POST", headers: auth });
      expect(res.status).toBe(200);
      const [task] = await items();
      expect(task).toMatchObject({ title: "Get washing machine repaired", created_by: M.papa, source_message_id: id });
      expect((await events(task.id))[0]).toMatchObject({ action: "created", actor_member_id: M.mom });
      expect((await api.request(`/v1/suggestions/${s.id}/accept`, { method: "POST", headers: auth })).status).toBe(409);
      expect((await getMessage(t.db, id))?.parseStatus).toBe("item");
    });
  });

  describe("follow-ups to a pending suggestion", () => {
    const vague = { actionable: true, items: [item({ title: "Book AC service", due_text: "next week" })] };

    it("'make it Friday' firms up the date and saves the item", async () => {
      const ex = scripted({
        "AC service next week": vague,
        "make it Friday": { actionable: true, items: [], updates: [{ ref: "@Book AC service", op: "update", due_text: "Friday", confidence: 0.9 }] },
      });
      const first = await postMessage(t.db, M.mom, "AC service next week");
      await postMessage(t.db, M.mom, "make it Friday");
      await runOnce({ db: t.db, extractor: ex, now: () => NOW });
      expect(ex.calls[1]!.context!.openItems[0]).toMatchObject({ ref: "s1", type: "task (suggested, not saved yet, date unclear)" });
      const [task] = await items();
      expect(ist(task.due_at)).toBe("2026-10-02 09:00");
      expect(task.source_message_id).toBe(first);
      expect((await t.db.query("select state from suggestion")).rows[0].state).toBe("accepted");
      expect((await getMessage(t.db, first))?.parseStatus).toBe("item");
    });

    it("a plain yes accepts it as shown", async () => {
      const ex = scripted({
        "AC service next week": vague,
        "haan karna hai": { actionable: true, items: [], updates: [{ ref: "@Book AC service", op: "confirm", confidence: 0.9 }] },
      });
      await postMessage(t.db, M.mom, "AC service next week");
      await postMessage(t.db, M.papa, "haan karna hai");
      await runOnce({ db: t.db, extractor: ex, now: () => NOW });
      const [task] = await items();
      expect(ist(task.due_at)).toBe("2026-10-05 09:00");
    });

    it("'rehne do' dismisses it", async () => {
      const ex = scripted({
        "AC service next week": vague,
        "rehne do": { actionable: true, items: [], updates: [{ ref: "@Book AC service", op: "cancel", confidence: 0.9 }] },
      });
      await postMessage(t.db, M.mom, "AC service next week");
      await postMessage(t.db, M.mom, "rehne do");
      await runOnce({ db: t.db, extractor: ex, now: () => NOW });
      expect(await items()).toHaveLength(0);
      expect((await t.db.query("select state from suggestion")).rows[0].state).toBe("dismissed");
    });
  });

  describe("API", () => {
    const setup = async () => {
      const ex = scripted({ "Pay maid 6000": { actionable: true, items: [item({ type: "bill", title: "Maid salary", amount: 6000, assignee_hint: null })] } });
      await postMessage(t.db, M.papa, "Pay maid 6000");
      await runOnce({ db: t.db, extractor: ex, now: () => NOW });
      return { api: createApi(t.db, { jwtSecret: JWT_SECRET }, () => NOW), item: (await items())[0] };
    };

    it("rejects missing, forged and outsider tokens", async () => {
      const { api, item } = await setup();
      const patch = (headers: Record<string, string>) => api.request(`/v1/items/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ title: "x" }) });
      expect((await patch({})).status).toBe(401);
      expect((await patch({ authorization: "Bearer not-a-jwt" })).status).toBe(401);
      expect((await patch({ authorization: `Bearer ${await tokenFor(U.nobody)}` })).status).toBe(403);
      // A member of another household can't touch Sharma items
      expect((await patch({ authorization: `Bearer ${await tokenFor(U.stranger)}` })).status).toBe(404);
    });

    it("an edit is recorded, and feeds the parser as a correction", async () => {
      const { api, item } = await setup();
      const res = await api.request(`/v1/items/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${await tokenFor(U.mom)}` },
        body: JSON.stringify({ type: "task", assignedTo: M.mom }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ type: "task", assignedTo: M.mom });
      expect(await renderCorrections(t.db, H, await getMembers(t.db, H))).toEqual([
        '"Pay maid 6000" → the family changed type from bill to task and assignee from Papa to Mom.',
      ]);
      // ...and the next message's context carries it
      const next = await postMessage(t.db, M.papa, "next");
      const ctx = await buildContext(t.db, (await getMessage(t.db, next))!, await getMembers(t.db, H), "Asia/Kolkata", NOW);
      expect(ctx.context.corrections).toHaveLength(1);
    });

    it("validates edits", async () => {
      const { api, item } = await setup();
      const auth = { "content-type": "application/json", authorization: `Bearer ${await tokenFor(U.mom)}` };
      expect((await api.request(`/v1/items/${item.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ hacked: true }) })).status).toBe(400);
      expect((await api.request(`/v1/items/${item.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ assignedTo: M.stranger }) })).status).toBe(400);
    });

    it("item undo reverses the latest change only", async () => {
      const { api, item } = await setup();
      const auth = { "content-type": "application/json", authorization: `Bearer ${await tokenFor(U.mom)}` };
      await api.request(`/v1/items/${item.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ title: "Kamala salary" }) });
      await api.request(`/v1/items/${item.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ status: "done" }) });
      expect((await items())[0]).toMatchObject({ title: "Kamala salary", status: "done" });
      await api.request(`/v1/items/${item.id}/undo`, { method: "POST", headers: auth });
      expect((await items())[0]).toMatchObject({ title: "Kamala salary", status: "open", completed_at: null });
    });
  });

  describe("reminders", () => {
    it("sends each due reminder once, to the assignee", async () => {
      const ex = scripted({ "remind papa kal 6 baje gas booking": { actionable: true, items: [item({ type: "reminder", title: "Gas booking", assignee_hint: "papa", due_text: "kal 6 baje" })] } });
      await postMessage(t.db, M.mom, "remind papa kal 6 baje gas booking");
      await runOnce({ db: t.db, extractor: ex, now: () => NOW });
      const sent: DueReminder[] = [];
      const push = { send: async (r: DueReminder) => void sent.push(r) };
      expect(await sendDueReminders(t.db, push, new Date("2026-10-01T12:00:00Z"))).toBe(0); // 17:30 IST: not yet
      expect(await sendDueReminders(t.db, push, new Date("2026-10-01T12:30:00Z"))).toBe(1); // 18:00 IST
      expect(await sendDueReminders(t.db, push, new Date("2026-10-01T13:00:00Z"))).toBe(0);
      expect(sent[0]).toMatchObject({ title: "Gas booking", recipients: [{ memberId: M.papa, pushToken: null }] });
    });
  });

  describe("household setup and row-level security", () => {
    /** Run as a signed-in app user (role authenticated). Rolls back unless `commit`. */
    const asUser = async <T>(userId: string, fn: (q: (sql: string, p?: unknown[]) => Promise<any[]>) => Promise<T>, commit = false): Promise<T> => {
      const c = await t.db.connect();
      let done = false;
      try {
        await c.query("begin");
        await c.query("grant usage on schema public, auth to authenticated; grant all on all tables in schema public to authenticated; grant execute on all functions in schema auth to authenticated");
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
        const out = await fn(async (sql, p) => (await c.query(sql, p)).rows);
        if (commit) {
          await c.query("commit");
          done = true;
        }
        return out;
      } finally {
        if (!done) await c.query("rollback");
        c.release();
      }
    };

    it("creates a household, joins it by invite code, and keeps households apart", async () => {
      const newUser = "44444444-0000-4000-8000-000000000001";
      const joiner = "44444444-0000-4000-8000-000000000002";
      await t.db.query("insert into auth.users (id) values ($1), ($2)", [newUser, joiner]);

      const hid = await asUser(newUser, async (q) => (await q("select create_household('Kapoor', 'Neha') as id"))[0].id, true);
      const code = (await t.db.query("select invite_code from household where id = $1", [hid])).rows[0].invite_code;
      await asUser(joiner, async (q) => q("select join_household($1, 'Vikram')", [code.toLowerCase()]), true);
      const members = (await t.db.query("select display_name, role from member where household_id = $1 order by joined_at", [hid])).rows;
      expect(members).toEqual([{ display_name: "Neha", role: "owner" }, { display_name: "Vikram", role: "adult" }]);
      expect((await t.db.query("select name from list where household_id = $1", [hid])).rows).toEqual([{ name: "Shopping" }]);

      await expect(asUser(joiner, (q) => q("select join_household($1, 'again')", [code]))).rejects.toThrow(/already in a household/);
      await expect(asUser(joiner, (q) => q("select create_household('x', 'y')"))).rejects.toThrow(/already in a household/);

      // Mom (Sharma) sees only Sharma rows
      await postMessage(t.db, M.stranger, "Iyer secret", { householdId: OTHER_H });
      const seen = await asUser(U.mom, (q) => q("select body_text from chat_message"));
      expect(seen.map((r) => r.body_text)).not.toContain("Iyer secret");
      await expect(asUser(U.mom, (q) => q("insert into chat_message (household_id, sender_member_id, client_msg_id, body_text) values ($1, $2, 'x', 'spoof')", [H, M.papa]))).rejects.toThrow(/row-level security/);
    });

    it("rejects a wrong invite code", async () => {
      const u = "44444444-0000-4000-8000-000000000009";
      await t.db.query("insert into auth.users (id) values ($1)", [u]);
      await expect(asUser(u, (q) => q("select join_household('NOPE1234', 'X')"))).rejects.toThrow(/invalid invite code/);
    });
  });
});
