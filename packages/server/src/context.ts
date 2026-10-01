/**
 * Builds what the parser sees besides the message itself: the last few messages, the family's
 * open items (with short refs instead of ids), household memory and recent corrections.
 */
import { DateTime } from "luxon";
import type { ParseContext, ContextItem } from "@homegenie/parser";
import type { ChatMessage, Member, ResolvedItem } from "@homegenie/shared";
import type { Queryable } from "./db.js";
import { messageText, toItem, toMessage } from "./repo.js";
import { renderCorrections, renderFacts } from "./memory.js";

export const CONTEXT_MESSAGES = 10;
export const CONTEXT_MESSAGE_HOURS = 24;
export const CONTEXT_OPEN_ITEMS = 25;

/** Refs to pending suggestions map to "suggestion:<id>:<index>" instead of an item id. */
export const suggestionRef = (id: string, index: number) => `suggestion:${id}:${index}`;
export function parseSuggestionRef(ref: string): { id: string; index: number } | null {
  const m = ref.match(/^suggestion:([0-9a-f-]{36}):(\d+)$/);
  return m ? { id: m[1]!, index: Number(m[2]) } : null;
}

export interface BuiltContext {
  context: ParseContext;
  itemRefs: Record<string, string>;
}

export async function buildContext(q: Queryable, msg: ChatMessage, members: Member[], tz: string, now: Date): Promise<BuiltContext> {
  const nameOf = (id: string | null) => (id ? members.find((m) => m.id === id)?.displayName ?? "someone" : null);
  const minutesAgo = (iso: string) => Math.max(0, (now.getTime() - new Date(iso).getTime()) / 60000);

  const recent = (
    await q.query(
      `select * from chat_message
       where household_id = $1 and created_at < $2 and created_at > $2::timestamptz - make_interval(hours => $3)
       order by created_at desc limit $4`,
      [msg.householdId, msg.createdAt, CONTEXT_MESSAGE_HOURS, CONTEXT_MESSAGES],
    )
  ).rows
    .map(toMessage)
    .reverse()
    .flatMap((m) => {
      const text = messageText(m);
      return text ? [{ senderName: nameOf(m.senderMemberId) ?? "someone", text, minutesAgo: minutesAgo(m.createdAt) }] : [];
    });

  // Items from the last week first, plus anything due soon, so "paid" can find the bill it means.
  const open = (
    await q.query(
      `select * from item
       where household_id = $1 and status in ('open', 'snoozed')
       order by (created_at > $2::timestamptz - interval '7 days') desc, due_at asc nulls last, created_at desc
       limit $3`,
      [msg.householdId, msg.createdAt, CONTEXT_OPEN_ITEMS],
    )
  ).rows.map(toItem);

  const itemRefs: Record<string, string> = {};
  const openItems: ContextItem[] = open.map((it, i) => {
    const ref = `i${i + 1}`;
    itemRefs[ref] = it.id;
    return {
      ref,
      type: it.type,
      title: it.title,
      assigneeName: nameOf(it.assignedTo),
      createdByName: nameOf(it.createdBy) ?? "someone",
      due: it.dueAt ? DateTime.fromISO(it.dueAt, { zone: tz }).toFormat("ccc d LLL, HH:mm") : null,
      amount: (it.attrs as { amount?: number })?.amount ?? null,
      minutesAgo: minutesAgo(it.createdAt),
    };
  });

  // Pending "Make this a task?" cards, so "make it Friday" or "₹4,512 actually" can firm them up.
  const pending = (
    await q.query(
      `select s.id, s.proposed, m.sender_member_id, m.created_at from suggestion s join chat_message m on m.id = s.message_id
       where m.household_id = $1 and s.state = 'shown' and m.created_at > $2::timestamptz - interval '7 days'
       order by m.created_at desc limit 5`,
      [msg.householdId, msg.createdAt],
    )
  ).rows;
  let s = 0;
  for (const p of pending) {
    (p.proposed as ResolvedItem[]).forEach((it, idx) => {
      const ref = `s${++s}`;
      itemRefs[ref] = suggestionRef(p.id, idx);
      openItems.push({
        ref,
        type: `${it.type} (suggested, not saved yet${it.dueIsGuess ? ", date unclear" : ""})`,
        title: it.title,
        assigneeName: nameOf(it.assignedTo),
        createdByName: nameOf(p.sender_member_id) ?? "someone",
        due: it.dueAt ? DateTime.fromISO(it.dueAt, { zone: tz }).toFormat("ccc d LLL, HH:mm") : null,
        amount: it.amount,
        minutesAgo: minutesAgo(p.created_at),
      });
    });
  }

  let replyTo: ParseContext["replyTo"];
  if (msg.replyToId) {
    const r = await q.query("select * from chat_message where id = $1 and household_id = $2", [msg.replyToId, msg.householdId]);
    if (r.rows[0]) {
      const m = toMessage(r.rows[0]);
      replyTo = { senderName: nameOf(m.senderMemberId) ?? "someone", text: messageText(m) ?? "(media)", minutesAgo: minutesAgo(m.createdAt) };
    }
  }

  return {
    context: {
      recentMessages: recent,
      openItems,
      facts: await renderFacts(q, msg.householdId, members),
      corrections: await renderCorrections(q, msg.householdId, members),
      replyTo,
    },
    itemRefs,
  };
}
