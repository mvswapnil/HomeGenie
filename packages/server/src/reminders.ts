/**
 * Reminder timing (Data model tab):
 *   - bills: a nudge 3 days before the due date at 09:00, and one at the due time
 *   - everything else with a due time: at that time (date-only items are already 09:00, the digest)
 *   - quiet hours 22:00–07:00 household time: moved to 07:00
 *   - nothing in the past
 * Pure functions, so the rules are easy to test and change.
 */
import { DateTime } from "luxon";
import type { Item } from "@homegenie/shared";
import type { Queryable } from "./db.js";

export const QUIET_START = 22;
export const QUIET_END = 7;
export const BILL_LEAD_DAYS = 3;

export function outOfQuietHours(t: DateTime): DateTime {
  if (t.hour >= QUIET_START) return t.plus({ days: 1 }).set({ hour: QUIET_END, minute: 0, second: 0, millisecond: 0 });
  if (t.hour < QUIET_END) return t.set({ hour: QUIET_END, minute: 0, second: 0, millisecond: 0 });
  return t;
}

export function planReminders(item: Pick<Item, "type" | "dueAt" | "status">, tz: string, now: Date): string[] {
  if (!item.dueAt || item.status !== "open") return [];
  const due = DateTime.fromISO(item.dueAt, { zone: tz });
  const nowDt = DateTime.fromJSDate(now, { zone: tz });
  const times: DateTime[] = [];
  if (item.type === "bill") times.push(due.minus({ days: BILL_LEAD_DAYS }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 }));
  times.push(due);
  const seen = new Set<string>();
  return times
    .map(outOfQuietHours)
    .filter((t) => t > nowDt)
    .map((t) => t.toUTC().toISO()!)
    .filter((iso) => (seen.has(iso) ? false : (seen.add(iso), true)))
    .sort();
}

/** Replace an item's unsent reminders with a fresh plan. Sent ones stay as history. */
export async function scheduleReminders(q: Queryable, item: Item, tz: string, now: Date): Promise<number> {
  await q.query("delete from reminder_schedule where item_id = $1 and sent_at is null", [item.id]);
  const plan = planReminders(item, tz, now);
  for (const fireAt of plan) {
    await q.query("insert into reminder_schedule (item_id, fire_at, channel) values ($1, $2, 'push')", [item.id, fireAt]);
  }
  return plan.length;
}

export interface DueReminder {
  reminderId: string;
  itemId: string;
  title: string;
  type: string;
  dueAt: string | null;
  amount: number | null;
  /** Who gets the push: the assignee, or every member when the item is unassigned. */
  recipients: Array<{ memberId: string; pushToken: string | null }>;
}

/** Push delivery is pluggable: Expo in the app build, a logger in development. */
export interface PushSender {
  send(r: DueReminder): Promise<void>;
}

export const logPushSender: PushSender = {
  async send(r) {
    console.log(`[reminder] ${r.title} → ${r.recipients.map((x) => x.memberId).join(", ")}`);
  },
};

/** Send every reminder whose time has come. Claimed with SKIP LOCKED so two workers never double-send. */
export async function sendDueReminders(q: Queryable, sender: PushSender, now: Date, limit = 50): Promise<number> {
  const { rows } = await q.query(
    `update reminder_schedule r set sent_at = $1
     where r.id in (
       select r2.id from reminder_schedule r2 join item i on i.id = r2.item_id
       where r2.sent_at is null and r2.fire_at <= $1 and i.status = 'open'
       order by r2.fire_at limit $2 for update of r2 skip locked)
     returning r.id, r.item_id`,
    [now.toISOString(), limit],
  );
  for (const r of rows) {
    const item = (await q.query("select * from item where id = $1", [r.item_id])).rows[0];
    const recipients = (
      await q.query(
        item.assigned_to
          ? "select id, push_token from member where id = $1"
          : "select id, push_token from member where household_id = $1",
        [item.assigned_to ?? item.household_id],
      )
    ).rows.map((m) => ({ memberId: m.id, pushToken: m.push_token }));
    await sender.send({
      reminderId: r.id,
      itemId: item.id,
      title: item.title,
      type: item.type,
      dueAt: item.due_at,
      amount: item.attrs?.amount ?? null,
      recipients,
    });
  }
  return rows.length;
}

/** Next occurrence for the RRULEs the parser produces. Returns null for rules we don't generate. */
export function nextOccurrence(rule: string, dueAt: string, tz: string): string | null {
  const due = DateTime.fromISO(dueAt, { zone: tz });
  const parts = Object.fromEntries(rule.split(";").map((p) => p.split("=") as [string, string]));
  switch (parts.FREQ) {
    case "DAILY":
      return due.plus({ days: 1 }).toISO();
    case "WEEKLY":
      return due.plus({ weeks: 1 }).toISO();
    case "MONTHLY": {
      const dom = Number(parts.BYMONTHDAY ?? due.day);
      const next = due.plus({ months: 1 }).startOf("month");
      return next.set({ day: Math.min(dom, next.daysInMonth ?? 28), hour: due.hour, minute: due.minute }).toISO();
    }
    default:
      return null;
  }
}
