import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { nextOccurrence, outOfQuietHours, planReminders } from "../src/reminders.js";
import { billerKey, usualPayer } from "../src/memory.js";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-09-30T04:30:00Z"); // 10:00 IST
const ist = (iso: string) => DateTime.fromISO(iso).setZone(TZ).toFormat("yyyy-MM-dd HH:mm");
const at = (local: string) => DateTime.fromISO(local, { zone: TZ }).toISO()!;

describe("planReminders", () => {
  it("bill: 3 days before at 09:00, and on the day", () => {
    expect(planReminders({ type: "bill", status: "open", dueAt: at("2026-10-10T09:00") }, TZ, NOW).map(ist)).toEqual(["2026-10-07 09:00", "2026-10-10 09:00"]);
  });
  it("task with a time: at that time", () => {
    expect(planReminders({ type: "task", status: "open", dueAt: at("2026-10-01T18:30") }, TZ, NOW).map(ist)).toEqual(["2026-10-01 18:30"]);
  });
  it("quiet hours move to 07:00", () => {
    expect(planReminders({ type: "reminder", status: "open", dueAt: at("2026-10-01T23:00") }, TZ, NOW).map(ist)).toEqual(["2026-10-02 07:00"]);
    expect(planReminders({ type: "reminder", status: "open", dueAt: at("2026-10-01T05:30") }, TZ, NOW).map(ist)).toEqual(["2026-10-01 07:00"]);
  });
  it("nothing in the past, nothing for closed or undated items", () => {
    expect(planReminders({ type: "task", status: "open", dueAt: at("2026-09-29T09:00") }, TZ, NOW)).toEqual([]);
    expect(planReminders({ type: "task", status: "done", dueAt: at("2026-10-05T09:00") }, TZ, NOW)).toEqual([]);
    expect(planReminders({ type: "task", status: "open", dueAt: null }, TZ, NOW)).toEqual([]);
  });
  it("outOfQuietHours leaves daytime alone", () => {
    const t = DateTime.fromISO("2026-10-01T12:00", { zone: TZ });
    expect(outOfQuietHours(t).toISO()).toBe(t.toISO());
  });
});

describe("nextOccurrence", () => {
  it.each([
    ["FREQ=DAILY", "2026-10-01T21:00", "2026-10-02 21:00"],
    ["FREQ=WEEKLY;BYDAY=SU", "2026-10-04T09:00", "2026-10-11 09:00"],
    ["FREQ=MONTHLY;BYMONTHDAY=5", "2026-10-05T09:00", "2026-11-05 09:00"],
    ["FREQ=MONTHLY;BYMONTHDAY=31", "2026-10-31T09:00", "2026-11-30 09:00"],
  ])("%s after %s", (rule, due, next) => expect(ist(nextOccurrence(rule, at(due), TZ)!)).toBe(next));
  it("unknown rules return null", () => expect(nextOccurrence("FREQ=YEARLY", at("2026-10-01T09:00"), TZ)).toBeNull());
});

describe("memory helpers", () => {
  it("billerKey groups the same biller", () => {
    expect(billerKey({ title: "Pay electricity bill", attrs: {} })).toBe("electricity");
    expect(billerKey({ title: "x", attrs: { biller: "Electricity" } })).toBe("electricity");
    expect(billerKey({ title: "School fees", attrs: {} })).toBe("school");
  });
  it("usualPayer needs two payments and a clear leader", () => {
    expect(usualPayer({ label: "x", paidBy: { a: 1 } })).toBeNull();
    expect(usualPayer({ label: "x", paidBy: { a: 2 } })).toBe("a");
    expect(usualPayer({ label: "x", paidBy: { a: 2, b: 2 } })).toBeNull();
    expect(usualPayer({ label: "x", paidBy: { a: 3, b: 1 } })).toBe("a");
  });
});
