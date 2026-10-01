/**
 * Household memory: what the family has taught the app by using it.
 * Learned quietly from items and corrections, shown to the parser as plain sentences,
 * and used in code for one thing only so far: who usually pays a given bill.
 */
import { DateTime } from "luxon";
import type { Item, Member } from "@homegenie/shared";
import type { Queryable } from "./db.js";

export interface BillerFact {
  label: string;
  usualAmount?: number;
  dueDay?: number;
  /** memberId → times they paid it. */
  paidBy?: Record<string, number>;
}

/** "Pay BESCOM electricity bill" and "Electricity" land on the same key. */
export function billerKey(item: Pick<Item, "title" | "attrs">): string {
  const raw = String((item.attrs as { biller?: string })?.biller ?? item.title);
  return raw
    .toLowerCase()
    .replace(/\b(pay|the|bill|bills|fees?|due|ka|ki)\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim() || raw.toLowerCase();
}

/** A bill was added (or corrected): remember its usual amount and due day. Corrections don't count as a new sighting. */
export async function learnFromBill(q: Queryable, item: Item, tz: string, opts: { countHit?: boolean } = {}): Promise<void> {
  if (item.type !== "bill") return;
  const amount = (item.attrs as { amount?: number })?.amount;
  const label = (item.attrs as { biller?: string })?.biller ?? item.title;
  const value: BillerFact = { label };
  if (amount) value.usualAmount = amount;
  if (item.dueAt) value.dueDay = DateTime.fromISO(item.dueAt, { zone: tz }).day;
  await q.query(
    `insert into household_fact (household_id, kind, key, value) values ($1, 'biller', $2, $3)
     on conflict (household_id, kind, key) do update
       set value = household_fact.value || excluded.value, hits = household_fact.hits + $4, last_seen_at = now()`,
    [item.householdId, billerKey(item), JSON.stringify(value), opts.countHit === false ? 0 : 1],
  );
}

/** A bill was paid: remember who paid it. */
export async function learnPayer(q: Queryable, item: Item, memberId: string): Promise<void> {
  if (item.type !== "bill") return;
  await q.query(
    `insert into household_fact (household_id, kind, key, value) values ($1, 'biller', $2, jsonb_build_object('label', $3::text, 'paidBy', jsonb_build_object($4::text, 1)))
     on conflict (household_id, kind, key) do update
       set value = household_fact.value || jsonb_build_object('paidBy',
             coalesce(household_fact.value->'paidBy', '{}'::jsonb)
             || jsonb_build_object($4::text, coalesce((household_fact.value->'paidBy'->>$4)::int, 0) + 1)),
           last_seen_at = now()`,
    [item.householdId, billerKey(item), (item.attrs as { biller?: string })?.biller ?? item.title, memberId],
  );
}

export async function getBillerFacts(q: Queryable, householdId: string): Promise<Map<string, BillerFact>> {
  const { rows } = await q.query("select key, value from household_fact where household_id = $1 and kind = 'biller'", [householdId]);
  return new Map(rows.map((r) => [r.key as string, r.value as BillerFact]));
}

/** The member who has paid this bill at least twice, and more than anyone else. */
export function usualPayer(fact: BillerFact | undefined): string | null {
  const counts = Object.entries(fact?.paidBy ?? {}).sort((a, b) => b[1] - a[1]);
  const [top, second] = counts;
  if (!top || top[1] < 2) return null;
  if (second && second[1] === top[1]) return null;
  return top[0];
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** Facts as sentences for the parser prompt. Most-used first, capped so the prompt stays small. */
export async function renderFacts(q: Queryable, householdId: string, members: Member[], limit = 12): Promise<string[]> {
  const { rows } = await q.query(
    "select kind, key, value from household_fact where household_id = $1 order by hits desc, last_seen_at desc limit $2",
    [householdId, limit],
  );
  const name = (id: string) => members.find((m) => m.id === id)?.displayName ?? "someone";
  return rows.map((r) => {
    if (r.kind === "note") return String(r.value.text ?? r.key);
    const f = r.value as BillerFact;
    const bits = [`${f.label}`];
    if (f.usualAmount) bits.push(`usually about ₹${f.usualAmount.toLocaleString("en-IN")}`);
    if (f.dueDay) bits.push(`due around the ${ordinal(f.dueDay)}`);
    const payer = usualPayer(f);
    if (payer) bits.push(`usually paid by ${name(payer)}`);
    return bits.length > 1 ? `${bits[0]}: ${bits.slice(1).join(", ")}.` : `${bits[0]} is a regular bill.`;
  });
}

/**
 * Recent fixes the family made to items the parser created (within a day of creation),
 * as sentences: `"pay maid 6000" was saved as a bill; the family changed it to type task.`
 */
export async function renderCorrections(q: Queryable, householdId: string, members: Member[], limit = 5): Promise<string[]> {
  const { rows } = await q.query(
    `select e.diff, m.body_text, m.transcript, i.title
     from item_event e
     join item i on i.id = e.item_id
     join chat_message m on m.id = i.source_message_id
     where i.household_id = $1 and e.action in ('edited', 'assigned') and e.actor_member_id is not null
       and e.source_message_id is null and e.undone_at is null
       and e.at < i.created_at + interval '1 day'
     order by e.at desc limit $2`,
    [householdId, limit],
  );
  const name = (id: unknown) => (typeof id === "string" ? members.find((m) => m.id === id)?.displayName ?? "someone" : "nobody");
  const fmt = (field: string, v: unknown) => (field === "assignedTo" ? name(v) : field === "dueAt" && typeof v === "string" ? DateTime.fromISO(v).toFormat("d LLL") : String(v));
  return rows.flatMap((r) => {
    const text = String(r.body_text ?? r.transcript ?? "").replace(/\s+/g, " ").slice(0, 120);
    const changes = Object.entries(r.diff as Record<string, [unknown, unknown]>)
      .filter(([f]) => ["type", "assignedTo", "dueAt", "amount", "title"].includes(f))
      .map(([f, [from, to]]) => `${f === "assignedTo" ? "assignee" : f} from ${fmt(f, from)} to ${fmt(f, to)}`);
    return changes.length ? [`"${text}" → the family changed ${changes.join(" and ")}.`] : [];
  });
}
