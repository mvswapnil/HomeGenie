/**
 * Turns the free-text date the extractor found ("kal shaam", "1 Oct", "every month on the 5th")
 * into a timestamp in the household's time zone. Deterministic on purpose: the LLM only quotes
 * the words, code decides the date, so "next Friday" never drifts with the model.
 */
import { DateTime } from "luxon";

export interface DueResult {
  /** ISO timestamp with offset, or null when no date could be placed. */
  dueAt: string | null;
  /** True when the text was vague and the date is a best guess ("next week", "after Diwali"). */
  isGuess: boolean;
  /** RFC 5545 RRULE when the text describes a repeat. */
  rrule: string | null;
}

const NONE: DueResult = { dueAt: null, isGuess: false, rrule: null };

/** Default time when only a day is given: the 09:00 morning digest. */
export const DEFAULT_HOUR = 9;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** Luxon weekday numbers: Monday = 1 ... Sunday = 7. English and Hindi names. */
const WEEKDAYS: Record<string, number> = {
  monday: 1, mon: 1, somvar: 1, somwar: 1,
  tuesday: 2, tue: 2, tues: 2, mangalvar: 2, mangalwar: 2,
  wednesday: 3, wed: 3, budhvar: 3, budhwar: 3,
  thursday: 4, thu: 4, thurs: 4, guruvar: 4, guruwar: 4, brihaspativar: 4,
  friday: 5, fri: 5, shukravar: 5, shukrawar: 5,
  saturday: 6, sat: 6, shanivar: 6, shaniwar: 6,
  sunday: 7, sun: 7, ravivar: 7, raviwar: 7, itvar: 7, itwar: 7,
};
const RRULE_DAY = ["", "MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** Parts of the day, in Hinglish and English, mapped to a default hour. */
const DAYPARTS: Array<[RegExp, number]> = [
  [/\b(subah|morning)\b/, 9],
  [/\b(dopahar|dopehar|afternoon|lunch)\b/, 14],
  [/\b(shaam|sham|evening)\b/, 18],
  [/\b(raat|night|tonight)\b/, 21],
];

const FESTIVALS = /\b(diwali|deepavali|holi|dussehra|dasara|navratri|eid|christmas|pongal|onam|rakhi|raksha bandhan|ganesh chaturthi|durga puja)\b/;

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pulls an explicit clock time: "9am", "9:30 pm", "18:00", "6 baje", "at 6". */
export function parseTime(text: string): { hour: number; minute: number } | null {
  const t = norm(text);
  let m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let hour = Number(m[1]) % 12;
    if (m[3] === "pm") hour += 12;
    return { hour, minute: Number(m[2] ?? 0) };
  }
  m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return { hour: Number(m[1]), minute: Number(m[2]) };
  m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(baje|bje|o'?clock)\b/) ?? t.match(/\bat (\d{1,2})(?::(\d{2}))?\b(?!\s*(?:st|nd|rd|th|oct|nov|dec|jan|feb|mar|apr|may|jun|jul|aug|sep))/);
  if (m) {
    let hour = Number(m[1]);
    // "6 baje shaam" → 18:00; "9 baje" alone → 9:00; small numbers with evening context go PM
    const part = DAYPARTS.find(([re]) => re.test(t));
    if (part && part[1] >= 14 && hour < 12) hour += 12;
    // No am/pm and no day part: "4 baje" means 4 pm. Nobody schedules pickups at 4 am.
    if (!part && hour >= 1 && hour <= 6) hour += 12;
    if (hour > 23) return null;
    return { hour, minute: Number(m[2] ?? 0) };
  }
  return null;
}

function dayPartHour(t: string): number | null {
  for (const [re, hour] of DAYPARTS) if (re.test(t)) return hour;
  return null;
}

function atTime(day: DateTime, t: string): DateTime {
  const clock = parseTime(t);
  if (clock) return day.set({ hour: clock.hour, minute: clock.minute, second: 0, millisecond: 0 });
  const hour = dayPartHour(t) ?? DEFAULT_HOUR;
  return day.set({ hour, minute: 0, second: 0, millisecond: 0 });
}

/** Next date (today counts if it hasn't passed) matching the weekday. `forceNextWeek` for "next Monday". */
function nextWeekday(now: DateTime, weekday: number, forceNextWeek: boolean): DateTime {
  let delta = (weekday - now.weekday + 7) % 7;
  if (forceNextWeek) {
    // "next Monday" said on a Wednesday = the Monday of next week (5 days out), never 12 days.
    if (delta === 0) delta = 7;
  }
  return now.plus({ days: delta }).startOf("day");
}

function ordinalDay(s: string): number {
  return Number(s.replace(/(st|nd|rd|th)$/, ""));
}

/** "5th" with no month: the next 5th, this month if not yet passed. */
function nextDayOfMonth(now: DateTime, day: number): DateTime {
  let d = now.startOf("day").set({ day: Math.min(day, now.daysInMonth ?? 28) });
  if (d < now.startOf("day")) {
    const nm = now.plus({ months: 1 }).startOf("month");
    d = nm.set({ day: Math.min(day, nm.daysInMonth ?? 28) });
  }
  return d;
}

/** A calendar date with no year: this year, or next year if it has already passed. */
function dateNoYear(now: DateTime, month: number, day: number): DateTime | null {
  let d = DateTime.fromObject({ year: now.year, month, day }, { zone: now.zone });
  if (!d.isValid) return null;
  // Allow a few days in the past: "pay by 28 Sep" sent on 30 Sep is overdue, not next year.
  if (d < now.startOf("day").minus({ days: 7 })) d = d.plus({ years: 1 });
  return d;
}

function recurrence(t: string, now: DateTime): DueResult | null {
  // daily / roz / har din
  if (/\b(daily|every ?day|roz|rozana|har din)\b/.test(t)) {
    const first = atTime(now.startOf("day"), t);
    const start = first < now ? first.plus({ days: 1 }) : first;
    return { dueAt: start.toISO(), isGuess: false, rrule: "FREQ=DAILY" };
  }
  // every Monday / har somvar / weekly on fri
  const wk = t.match(/\b(?:every|har|each)\s+([a-z]+)\b/);
  if (wk && wk[1] && WEEKDAYS[wk[1]] !== undefined) {
    const wd = WEEKDAYS[wk[1]]!;
    let day = atTime(nextWeekday(now, wd, false), t);
    if (day < now) day = day.plus({ weeks: 1 });
    return { dueAt: day.toISO(), isGuess: false, rrule: `FREQ=WEEKLY;BYDAY=${RRULE_DAY[wd]}` };
  }
  // every month on the 5th / har mahine 5 tareekh / monthly on 10th / 5th of every month
  const monthly =
    t.match(/\b(?:every|har|each)\s+(?:month|mahine|mahina)\b.*?\b(\d{1,2})(?:st|nd|rd|th)?\b/) ??
    t.match(/\bmonthly\b.*?\b(\d{1,2})(?:st|nd|rd|th)?\b/) ??
    t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:tareekh|tarikh|date)?\s*(?:of\s+)?(?:every|har)\s+(?:month|mahine|mahina)\b/);
  if (monthly && monthly[1]) {
    const dom = Number(monthly[1]);
    if (dom >= 1 && dom <= 31) {
      let day = atTime(nextDayOfMonth(now, dom), t);
      if (day < now) day = atTime(nextDayOfMonth(now.plus({ days: 1 }), dom), t);
      return { dueAt: day.toISO(), isGuess: false, rrule: `FREQ=MONTHLY;BYMONTHDAY=${dom}` };
    }
  }
  if (/\b(every|har)\s+(month|mahine)\b|\bmonthly\b/.test(t)) {
    // Monthly with no day given: anchor on today's day of month, flag for review.
    const day = atTime(now.plus({ months: 1 }).startOf("day"), t);
    return { dueAt: day.toISO(), isGuess: true, rrule: `FREQ=MONTHLY;BYMONTHDAY=${now.day}` };
  }
  if (/\bweekly\b|\bevery week\b|\bhar hafte\b/.test(t)) {
    const day = atTime(now.plus({ weeks: 1 }).startOf("day"), t);
    return { dueAt: day.toISO(), isGuess: true, rrule: `FREQ=WEEKLY;BYDAY=${RRULE_DAY[now.weekday]}` };
  }
  return null;
}

/**
 * Resolve free date text to a timestamp.
 * @param dueText words quoted by the extractor, e.g. "kal shaam 6 baje"
 * @param now     current time, already in the household zone
 */
export function resolveDue(dueText: string | null | undefined, now: DateTime): DueResult {
  if (!dueText) return NONE;
  const t = norm(dueText);
  if (!t) return NONE;

  const rec = recurrence(t, now);
  if (rec) return rec;

  if (FESTIVALS.test(t)) {
    // Festival dates move every year; leave the date open and ask, rather than guess wrong.
    return { dueAt: null, isGuess: true, rrule: null };
  }

  const today = now.startOf("day");
  const done = (d: DateTime, isGuess = false): DueResult => ({ dueAt: d.toISO(), isGuess, rrule: null });

  // Relative days
  if (/\b(parso|parson|day after tomorrow)\b/.test(t)) return done(atTime(today.plus({ days: 2 }), t));
  if (/\b(kal|tomorrow|tmrw|tmr|tomo)\b/.test(t)) return done(atTime(today.plus({ days: 1 }), t));
  if (/\b(aaj|aj|today|tonight|abhi|right now|asap)\b/.test(t)) {
    if (/\b(abhi|right now|asap)\b/.test(t) && !parseTime(t)) return done(now.plus({ hours: 1 }).startOf("minute"));
    let d = atTime(today, t);
    if (d < now && !parseTime(t) && !dayPartHour(t)) d = now.plus({ hours: 1 }).startOf("minute");
    return done(d);
  }

  // "in 2 days", "2 din mein", "in 3 hours", "1 ghante mein"
  let m = t.match(/\b(?:in\s+)?(\d{1,2})\s*(days?|din|hours?|hrs?|ghante?|ghanta|weeks?|hafte?)\b(?:\s*(?:mein|me|baad|later))?/);
  if (m && (t.includes("in ") || /mein|me\b|baad|later/.test(t))) {
    const n = Number(m[1]);
    const unit = m[2]!;
    if (/^(hours?|hrs?|ghante?|ghanta)$/.test(unit)) return done(now.plus({ hours: n }).startOf("minute"));
    if (/^(weeks?|hafte?)$/.test(unit)) return done(atTime(today.plus({ weeks: n }), t));
    return done(atTime(today.plus({ days: n }), t));
  }

  // Vague spans: best guess, flagged
  if (/\b(next week|agle hafte|agle week)\b/.test(t)) return done(atTime(nextWeekday(now, 1, true), t), true);
  if (/\b(this week|is hafte|iss hafte)\b/.test(t)) return done(atTime(nextWeekday(now, 5, false), t), true);
  if (/\b(weekend|this weekend)\b/.test(t)) return done(atTime(nextWeekday(now, 6, false), t), true);
  if (/\b(month end|end of (?:the )?month|mahine ke end|mahine ke aakhir)\b/.test(t)) return done(atTime(today.endOf("month").startOf("day"), t));
  if (/\b(next month|agle mahine)\b/.test(t)) return done(atTime(today.plus({ months: 1 }).startOf("month"), t), true);
  if (/\b(soon|jaldi|sometime|kabhi|whenever|later|baad me|baad mein|free time)\b/.test(t)) return { dueAt: null, isGuess: true, rrule: null };

  // Weekdays: "Monday", "next Friday", "somvar ko", "this sat"
  for (const word of t.split(" ")) {
    const wd = WEEKDAYS[word];
    if (wd !== undefined) {
      const forceNext = new RegExp(`\\b(next|agle)\\s+${word}\\b`).test(t);
      let d = atTime(nextWeekday(now, wd, forceNext), t);
      if (d < now) d = d.plus({ weeks: 1 });
      return done(d);
    }
  }

  // "1 Oct", "1st October", "Oct 1", "October 1st"
  for (const dm of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/g)) {
    const month = MONTHS[dm[2]!];
    if (month === undefined) continue;
    const d = dateNoYear(now, month, Number(dm[1]));
    if (d) return done(atTime(d, t));
  }
  for (const dm of t.matchAll(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) {
    const month = MONTHS[dm[1]!];
    if (month === undefined) continue;
    const d = dateNoYear(now, month, Number(dm[2]));
    if (d) return done(atTime(d, t));
  }

  // "1/10", "01-10-2026": Indian order, day first
  m = t.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    if (m[3]) {
      const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
      const d = DateTime.fromObject({ year, month, day }, { zone: now.zone });
      if (d.isValid) return done(atTime(d, t));
    } else {
      const d = dateNoYear(now, month, day);
      if (d) return done(atTime(d, t));
    }
  }

  // "5th", "5 tareekh", "by the 10th"
  m = t.match(/\b(\d{1,2})(st|nd|rd|th)\b/) ?? t.match(/\b(\d{1,2})\s*(?:tareekh|tarikh)\b/);
  if (m) {
    const dom = ordinalDay(m[1]!);
    if (dom >= 1 && dom <= 31) return done(atTime(nextDayOfMonth(now, dom), t));
  }

  // A bare time or day part: today if still ahead, else tomorrow
  if (parseTime(t) || dayPartHour(t) !== null) {
    let d = atTime(today, t);
    if (d < now) d = d.plus({ days: 1 });
    return done(d);
  }

  // Words that aren't a date at all ("on the way back", "before guests come"): no date, no question.
  return NONE;
}
