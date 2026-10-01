/**
 * Every write to items goes through here, so each change gets an item_event (for undo,
 * the activity feed and correction learning) and reminders stay in step with due dates.
 */
import { findDuplicateBill } from "@homegenie/parser";
import type { Item, ResolvedItem, ResolvedUpdate } from "@homegenie/shared";
import type { Queryable } from "./db.js";
import { addEvent, findOrCreateList, getItem, toItem } from "./repo.js";
import { getBillerFacts, billerKey, learnFromBill, learnPayer, usualPayer } from "./memory.js";
import { nextOccurrence, scheduleReminders } from "./reminders.js";

/** Fields that can change after creation; diffs are recorded as {field: [old, new]}. */
export interface ItemPatch {
  title?: string;
  type?: Item["type"];
  assignedTo?: string | null;
  dueAt?: string | null;
  amount?: number | null;
  status?: Item["status"];
}
type Diff = Partial<Record<keyof ItemPatch, [unknown, unknown]>>;

const amountOf = (i: Item) => (i.attrs as { amount?: number })?.amount ?? null;

function current(i: Item, field: keyof ItemPatch): unknown {
  return field === "amount" ? amountOf(i) : i[field];
}

/** Apply a patch, return what actually changed. */
async function patchItem(q: Queryable, item: Item, patch: ItemPatch): Promise<{ item: Item; diff: Diff }> {
  const diff: Diff = {};
  for (const [k, v] of Object.entries(patch) as Array<[keyof ItemPatch, unknown]>) {
    if (v === undefined) continue;
    const before = current(item, k);
    const same = k === "dueAt" && typeof before === "string" && typeof v === "string" ? +new Date(before) === +new Date(v) : before === v;
    if (!same) diff[k] = [before, v];
  }
  if (Object.keys(diff).length === 0) return { item, diff };
  const { rows } = await q.query(
    `update item set
       title = coalesce($2, title),
       type = coalesce($3, type),
       assigned_to = case when $4::boolean then $5::uuid else assigned_to end,
       due_at = case when $6::boolean then $7::timestamptz else due_at end,
       attrs = case when $8::boolean then (case when $9::numeric is null then attrs - 'amount' else attrs || jsonb_build_object('amount', $9::numeric) end) else attrs end,
       status = coalesce($10, status),
       completed_at = case when $10 = 'done' then now() when $10 is not null then null else completed_at end
     where id = $1 returning *`,
    [
      item.id,
      diff.title ? patch.title : null,
      diff.type ? patch.type : null,
      "assignedTo" in diff,
      patch.assignedTo ?? null,
      "dueAt" in diff,
      patch.dueAt ?? null,
      "amount" in diff,
      patch.amount ?? null,
      diff.status ? patch.status : null,
    ],
  );
  return { item: toItem(rows[0]), diff };
}

export interface CreateArgs {
  householdId: string;
  tz: string;
  createdBy: string;
  messageId: string | null;
  /** Who accepted a suggestion, if that's how these items came about. */
  actor?: string | null;
  now: Date;
}

export interface CreateResult {
  itemIds: string[];
  duplicates: Array<{ itemId: string; addedBy: string }>;
}

export async function createItems(q: Queryable, items: ResolvedItem[], a: CreateArgs): Promise<CreateResult> {
  const out: CreateResult = { itemIds: [], duplicates: [] };
  const facts = await getBillerFacts(q, a.householdId);
  const openBills = (
    await q.query("select * from item where household_id = $1 and type = 'bill' and status <> 'cancelled' and created_at > now() - interval '60 days'", [a.householdId])
  ).rows.map(toItem);

  for (const r of items) {
    if (r.type === "bill") {
      const dup = findDuplicateBill(r, openBills) as Item | null;
      if (dup) {
        out.duplicates.push({ itemId: dup.id, addedBy: dup.createdBy });
        continue;
      }
    }
    let assignedTo = r.assignedTo;
    // Nobody named, and the family always has the same person pay this bill: give it to them.
    if (r.type === "bill" && r.assignedBy === "default_sender") {
      const payer = usualPayer(facts.get(billerKey({ title: r.title, attrs: { biller: r.biller ?? undefined } })));
      if (payer) assignedTo = payer;
    }
    const listId = r.type === "list_entry" ? await findOrCreateList(q, a.householdId, r.listName ?? "Shopping") : null;
    const attrs: Record<string, unknown> = {};
    if (r.amount !== null) attrs.amount = r.amount;
    if (r.type === "bill") {
      attrs.currency = "INR";
      if (r.biller) attrs.biller = r.biller;
    }
    const { rows } = await q.query(
      `insert into item (household_id, type, title, created_by, assigned_to, list_id, due_at, recurrence_rule, attrs, source_message_id, parse_confidence)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [a.householdId, r.type, r.title, a.createdBy, assignedTo, listId, r.dueAt, r.recurrenceRule, JSON.stringify(attrs), a.messageId, r.confidence],
    );
    const item = toItem(rows[0]);
    await addEvent(q, { itemId: item.id, actor: a.actor ?? null, action: "created", diff: { assignedBy: r.assignedBy }, messageId: a.messageId });
    await scheduleReminders(q, item, a.tz, a.now);
    await learnFromBill(q, item, a.tz);
    if (item.type === "bill") openBills.push(item);
    out.itemIds.push(item.id);
  }
  return out;
}

export interface UpdateArgs {
  householdId: string;
  tz: string;
  actor: string;
  messageId: string | null;
  now: Date;
}

/** Apply a change read from a message. Returns the item id, or null if it no longer applies. */
export async function applyUpdate(q: Queryable, u: ResolvedUpdate, a: UpdateArgs): Promise<string | null> {
  const item = await getItem(q, u.itemId, true);
  if (!item || item.householdId !== a.householdId || item.status === "cancelled" || item.status === "done") return null;
  if (u.op === "confirm") return null; // only meaningful for suggestions

  if (u.op === "complete") return completeItem(q, item, a);
  if (u.op === "cancel") {
    const { diff } = await patchItem(q, item, { status: "cancelled" });
    await addEvent(q, { itemId: item.id, actor: a.actor, action: "cancelled", diff, messageId: a.messageId });
    await q.query("delete from reminder_schedule where item_id = $1 and sent_at is null", [item.id]);
    return item.id;
  }
  const { item: after, diff } = await patchItem(q, item, u.changes);
  if (Object.keys(diff).length === 0) return null;
  const action = u.op === "claim" || (Object.keys(diff).length === 1 && "assignedTo" in diff) ? "assigned" : "edited";
  await addEvent(q, { itemId: item.id, actor: a.actor, action, diff, messageId: a.messageId });
  if ("dueAt" in diff) await scheduleReminders(q, after, a.tz, a.now);
  if ("amount" in diff || "dueAt" in diff) await learnFromBill(q, after, a.tz, { countHit: false });
  return item.id;
}

/** Mark done; learn who paid; queue the next occurrence of a repeating item. */
export async function completeItem(q: Queryable, item: Item, a: UpdateArgs): Promise<string> {
  const { diff } = await patchItem(q, item, { status: "done" });
  await addEvent(q, { itemId: item.id, actor: a.actor, action: "done", diff, messageId: a.messageId });
  await q.query("delete from reminder_schedule where item_id = $1 and sent_at is null", [item.id]);
  await learnPayer(q, item, a.actor);
  if (item.recurrenceRule && item.dueAt) {
    const next = nextOccurrence(item.recurrenceRule, item.dueAt, a.tz);
    if (next) {
      const { rows } = await q.query(
        `insert into item (household_id, type, title, notes, created_by, assigned_to, list_id, due_at, recurrence_rule, attrs, source_message_id, parse_confidence)
         select household_id, type, title, notes, created_by, assigned_to, list_id, $2, recurrence_rule, attrs, source_message_id, parse_confidence
         from item where id = $1 returning *`,
        [item.id, next],
      );
      const nextItem = toItem(rows[0]);
      await addEvent(q, { itemId: nextItem.id, actor: null, action: "created", diff: { repeatOf: item.id }, messageId: a.messageId });
      await scheduleReminders(q, nextItem, a.tz, a.now);
    }
  }
  return item.id;
}

/** A member edits an item in the app. These edits are what the parser learns from. */
export async function editItem(q: Queryable, itemId: string, patch: ItemPatch, a: Omit<UpdateArgs, "messageId">): Promise<Item | null> {
  const item = await getItem(q, itemId, true);
  if (!item || item.householdId !== a.householdId) return null;
  if (patch.status === "done") {
    await completeItem(q, item, { ...a, messageId: null });
    return getItem(q, itemId);
  }
  const { item: after, diff } = await patchItem(q, item, patch);
  if (Object.keys(diff).length === 0) return after;
  const action = diff.status ? (patch.status === "cancelled" ? "cancelled" : patch.status === "snoozed" ? "snoozed" : "reopened") : Object.keys(diff).length === 1 && "assignedTo" in diff ? "assigned" : "edited";
  await addEvent(q, { itemId, actor: a.actor, action, diff, messageId: null });
  await scheduleReminders(q, after, a.tz, a.now);
  if ("amount" in diff || "dueAt" in diff) await learnFromBill(q, after, a.tz, { countHit: false });
  return after;
}

/** Reverse events newest first, mark them undone, and log the undo itself. */
async function revertEvents(q: Queryable, events: Array<{ id: string; item_id: string; action: string; diff: Diff }>, actor: string, tz: string, now: Date): Promise<string[]> {
  const touched = new Set<string>();
  for (const e of events) {
    const item = await getItem(q, e.item_id, true);
    if (!item) continue;
    if (e.action === "created") {
      await patchItem(q, item, { status: "cancelled" });
    } else {
      const back: ItemPatch = {};
      for (const [k, v] of Object.entries(e.diff ?? {}) as Array<[keyof ItemPatch, [unknown, unknown]]>) {
        if (Array.isArray(v)) (back as Record<string, unknown>)[k] = v[0] ?? null;
      }
      await patchItem(q, item, back);
    }
    await q.query("update item_event set undone_at = now() where id = $1", [e.id]);
    await addEvent(q, { itemId: e.item_id, actor, action: "undone", diff: { event: e.id, action: e.action }, messageId: null });
    const fresh = await getItem(q, e.item_id);
    if (fresh) await scheduleReminders(q, fresh, tz, now);
    touched.add(e.item_id);
  }
  return [...touched];
}

/** The Undo on a chat card: reverse everything that message did. */
export async function undoMessage(q: Queryable, messageId: string, a: { householdId: string; actor: string; tz: string; now: Date }): Promise<string[]> {
  const { rows } = await q.query(
    `select e.id, e.item_id, e.action, e.diff from item_event e join item i on i.id = e.item_id
     where e.source_message_id = $1 and i.household_id = $2 and e.undone_at is null and e.action <> 'undone'
     order by e.at desc, e.id desc`,
    [messageId, a.householdId],
  );
  return revertEvents(q, rows, a.actor, a.tz, a.now);
}

/** Undo on an item: reverse its latest change. */
export async function undoLastChange(q: Queryable, itemId: string, a: { householdId: string; actor: string; tz: string; now: Date }): Promise<boolean> {
  const { rows } = await q.query(
    `select e.id, e.item_id, e.action, e.diff from item_event e join item i on i.id = e.item_id
     where e.item_id = $1 and i.household_id = $2 and e.undone_at is null and e.action <> 'undone'
     order by e.at desc, e.id desc limit 1`,
    [itemId, a.householdId],
  );
  return (await revertEvents(q, rows, a.actor, a.tz, a.now)).length > 0;
}


/**
 * A follow-up message changes a pending suggestion ("make it Friday", "₹4,512 actually", "I'll do it").
 * The change is applied to the proposal; once every proposed item is clear (confident, real date),
 * the suggestion is accepted automatically and the items are created. "Cancel" / "done" drop the item.
 * Returns ids of items created, if any.
 */
export async function applySuggestionUpdate(
  q: Queryable,
  ref: { id: string; index: number },
  u: ResolvedUpdate,
  a: UpdateArgs,
): Promise<string[]> {
  const { rows } = await q.query(
    `select s.*, m.sender_member_id, m.household_id from suggestion s join chat_message m on m.id = s.message_id
     where s.id = $1 and m.household_id = $2 and s.state = 'shown' for update of s`,
    [ref.id, a.householdId],
  );
  const s = rows[0];
  if (!s) return [];
  let proposed = s.proposed as ResolvedItem[];
  const p = proposed[ref.index];
  if (!p) return [];

  if (u.op === "cancel" || u.op === "complete") {
    proposed = proposed.filter((_, i) => i !== ref.index);
  } else if (u.op === "confirm") {
    p.dueIsGuess = false; // "yes" to the card as shown, guessed date included
    p.confidence = Math.max(p.confidence, u.confidence);
  } else {
    const c = u.changes;
    if (c.title) p.title = c.title;
    if (c.amount !== undefined) p.amount = c.amount;
    if (c.dueAt) {
      p.dueAt = c.dueAt;
      p.dueIsGuess = false;
    }
    if (c.assignedTo !== undefined) {
      p.assignedTo = c.assignedTo;
      p.assignedBy = u.op === "claim" ? "first_person" : "alias";
    }
    // The family has now spoken to it directly; that is confirmation enough.
    p.confidence = Math.max(p.confidence, u.confidence);
  }

  if (proposed.length === 0) {
    await q.query("update suggestion set state = 'dismissed', proposed = '[]', decided_by = $2, decided_at = now() where id = $1", [s.id, a.actor]);
    return [];
  }
  const firm = proposed.every((it) => it.confidence >= 0.8 && !it.dueIsGuess);
  if (!firm) {
    await q.query("update suggestion set proposed = $2 where id = $1", [s.id, JSON.stringify(proposed)]);
    return [];
  }
  const created = await createItems(q, proposed, { ...a, createdBy: s.sender_member_id, messageId: s.message_id, actor: a.actor });
  await q.query("update suggestion set state = 'accepted', proposed = $2, decided_by = $3, decided_at = now(), item_ids = $4 where id = $1", [
    s.id,
    JSON.stringify(proposed),
    a.actor,
    created.itemIds,
  ]);
  await q.query(
    `update chat_message set parse_status = 'item',
       parse_result = coalesce(parse_result, '{}'::jsonb) || jsonb_build_object('itemIds', $2::jsonb, 'duplicates', $3::jsonb)
     where id = $1`,
    [s.message_id, JSON.stringify(created.itemIds), JSON.stringify(created.duplicates)],
  );
  return created.itemIds;
}
