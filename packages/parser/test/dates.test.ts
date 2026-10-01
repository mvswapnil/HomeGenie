import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { resolveDue, parseTime } from "../src/resolve/dates.js";

// Wednesday 30 Sep 2026, 10:00 in Bangalore
const NOW = DateTime.fromISO("2026-09-30T10:00:00", { zone: "Asia/Kolkata" });
const at = (text: string) => {
  const r = resolveDue(text, NOW);
  return { ...r, local: r.dueAt ? DateTime.fromISO(r.dueAt).setZone("Asia/Kolkata").toFormat("yyyy-MM-dd HH:mm") : null };
};

describe("resolveDue: relative days", () => {
  it.each([
    ["kal", "2026-10-01 09:00"],
    ["tomorrow", "2026-10-01 09:00"],
    ["kal shaam", "2026-10-01 18:00"],
    ["kal shaam 6 baje", "2026-10-01 18:00"],
    ["kal subah 7:30", "2026-10-01 07:30"],
    ["parso", "2026-10-02 09:00"],
    ["aaj raat", "2026-09-30 21:00"],
    ["today 5pm", "2026-09-30 17:00"],
    ["2 din mein", "2026-10-02 09:00"],
    ["in 3 days", "2026-10-03 09:00"],
  ])("%s → %s", (text, expected) => {
    expect(at(text).local).toBe(expected);
    expect(at(text).isGuess).toBe(false);
  });
});

describe("resolveDue: weekdays", () => {
  it.each([
    ["Friday", "2026-10-02 09:00"],
    ["friday ko", "2026-10-02 09:00"],
    ["shanivar", "2026-10-03 09:00"],
    ["Mon 9:00", "2026-10-05 09:00"],
    ["next Monday", "2026-10-05 09:00"],
    ["Wednesday", "2026-09-30 09:00".replace("09-30 09:00", "10-07 09:00")], // today 09:00 already passed → next week
    ["sat morning", "2026-10-03 09:00"],
  ])("%s → %s", (text, expected) => {
    expect(at(text).local).toBe(expected);
  });
});

describe("resolveDue: calendar dates", () => {
  it.each([
    ["1 Oct", "2026-10-01 09:00"],
    ["by 1st October", "2026-10-01 09:00"],
    ["Oct 12", "2026-10-12 09:00"],
    ["5th", "2026-10-05 09:00"],
    ["5 tareekh tak", "2026-10-05 09:00"],
    ["30th", "2026-09-30 09:00"],
    ["15/10", "2026-10-15 09:00"],
    ["28 Sep", "2026-09-28 09:00"], // recently passed = overdue, not next year
    ["10 Jan", "2027-01-10 09:00"],
  ])("%s → %s", (text, expected) => {
    expect(at(text).local).toBe(expected);
  });
});

describe("resolveDue: recurrence", () => {
  it("every month on the 5th", () => {
    const r = at("every month on the 5th");
    expect(r.rrule).toBe("FREQ=MONTHLY;BYMONTHDAY=5");
    expect(r.local).toBe("2026-10-05 09:00");
  });
  it("har mahine 10 tareekh", () => {
    expect(at("har mahine 10 tareekh").rrule).toBe("FREQ=MONTHLY;BYMONTHDAY=10");
  });
  it("every Sunday", () => {
    const r = at("every sunday");
    expect(r.rrule).toBe("FREQ=WEEKLY;BYDAY=SU");
    expect(r.local).toBe("2026-10-04 09:00");
  });
  it("roz subah", () => {
    const r = at("roz subah 7 baje");
    expect(r.rrule).toBe("FREQ=DAILY");
    expect(r.local).toBe("2026-10-01 07:00");
  });
});

describe("resolveDue: vague text is a flagged guess", () => {
  it("next week → Monday, guess", () => {
    expect(at("next week")).toMatchObject({ local: "2026-10-05 09:00", isGuess: true });
  });
  it("weekend → Saturday, guess", () => {
    expect(at("this weekend")).toMatchObject({ local: "2026-10-03 09:00", isGuess: true });
  });
  it("after Diwali → no date, guess", () => {
    expect(at("after Diwali")).toMatchObject({ local: null, isGuess: true });
  });
  it("'whenever' → no date, guess", () => {
    expect(at("whenever")).toMatchObject({ local: null, isGuess: true });
  });
  it("words that aren't a date → no date, not a guess", () => {
    expect(at("on the way back")).toMatchObject({ local: null, isGuess: false });
  });
  it("no text → no date, not a guess", () => {
    expect(resolveDue(null, NOW)).toEqual({ dueAt: null, isGuess: false, rrule: null });
  });
});

describe("parseTime", () => {
  it.each([
    ["9am", 9, 0],
    ["9:30 pm", 21, 30],
    ["18:00", 18, 0],
    ["6 baje shaam", 18, 0],
    ["at 7", 7, 0],
  ])("%s", (text, hour, minute) => {
    expect(parseTime(text)).toEqual({ hour, minute });
  });
});

describe("bare hours", () => {
  it("'4 baje' with no day part is 4 pm", () => expect(parseTime("4 baje")).toEqual({ hour: 16, minute: 0 }));
  it("'subah 6 baje' stays 6 am", () => expect(parseTime("subah 6 baje")).toEqual({ hour: 6, minute: 0 }));
});
