/**
 * Row access. Plain SQL, mapped to the shared types. The server connects as a privileged role
 * (Supabase service role), so every query here filters by household_id itself.
 */
import type { BillAttrs, ChatMessage, Item, Member } from "@homegenie/shared";
import type { Queryable } from "./db.js";

type Row = Record<string, any>;

export const toMember = (r: Row): Member => ({
  id: r.id,
  householdId: r.household_id,
  displayName: r.display_name,
  aliases: r.aliases ?? [],
  role: r.role,
});

export const toMessage = (r: Row): ChatMessage => ({
  id: r.id,
  householdId: r.household_id,
  senderMemberId: r.sender_member_id,
  clientMsgId: r.client_msg_id,
  channel: r.channel,
  kind: r.kind,
  bodyText: r.body_text,
  mediaUrl: r.media_url,
  transcript: r.transcript,
  replyToId: r.reply_to_id,
  mentions: r.mentions ?? [],
  createdAt: r.created_at,
  parseStatus: r.parse_status,
});

export const toItem = (r: Row): Item => ({
  id: r.id,
  householdId: r.household_id,
  type: r.type,
  title: r.title,
  notes: r.notes,
  status: r.status,
  createdBy: r.created_by,
  assignedTo: r.assigned_to,
  listId: r.list_id,
  dueAt: r.due_at,
  recurrenceRule: r.recurrence_rule,
  attrs: (r.attrs ?? {}) as BillAttrs,
  sourceMessageId: r.source_message_id,
  parseConfidence: r.parse_confidence,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

export async function getHousehold(q: Queryable, id: string): Promise<{ id: string; tz: string; name: string }> {
  const { rows } = await q.query("select id, tz, name from household where id = $1", [id]);
  if (!rows[0]) throw new Error(`household ${id} not found`);
  return rows[0];
}

export async function getMembers(q: Queryable, householdId: string): Promise<Member[]> {
  const { rows } = await q.query("select * from member where household_id = $1 order by joined_at", [householdId]);
  return rows.map(toMember);
}

export async function getMemberByUser(q: Queryable, userId: string): Promise<Member | null> {
  const { rows } = await q.query("select * from member where user_id = $1", [userId]);
  return rows[0] ? toMember(rows[0]) : null;
}

export async function getListNames(q: Queryable, householdId: string): Promise<string[]> {
  const { rows } = await q.query("select name from list where household_id = $1 order by name", [householdId]);
  return rows.map((r) => r.name);
}

export async function getMessage(q: Queryable, id: string): Promise<ChatMessage | null> {
  const { rows } = await q.query("select * from chat_message where id = $1", [id]);
  return rows[0] ? toMessage(rows[0]) : null;
}

export async function getItem(q: Queryable, id: string, forUpdate = false): Promise<Item | null> {
  const { rows } = await q.query(`select * from item where id = $1${forUpdate ? " for update" : ""}`, [id]);
  return rows[0] ? toItem(rows[0]) : null;
}

/** The text the parser reads: typed text, or the transcript/OCR plus any caption. */
export function messageText(m: ChatMessage): string | null {
  if (m.kind === "text") return m.bodyText;
  if (!m.transcript) return null;
  return m.bodyText ? `${m.transcript}\n\n(caption: ${m.bodyText})` : m.transcript;
}

export async function findOrCreateList(q: Queryable, householdId: string, name: string): Promise<string> {
  const clean = name.trim().replace(/\s+/g, " ");
  const existing = await q.query("select id from list where household_id = $1 and lower(name) = lower($2)", [householdId, clean]);
  if (existing.rows[0]) return existing.rows[0].id;
  const kind = /^shopping$/i.test(clean) ? "shopping" : /^packing$/i.test(clean) ? "packing" : "custom";
  const pretty = clean[0]!.toUpperCase() + clean.slice(1);
  const { rows } = await q.query(
    `insert into list (household_id, name, kind) values ($1, $2, $3)
     on conflict (household_id, name) do update set name = excluded.name returning id`,
    [householdId, pretty, kind],
  );
  return rows[0].id;
}

export async function addEvent(
  q: Queryable,
  e: { itemId: string; actor: string | null; action: string; diff?: Record<string, unknown>; messageId?: string | null },
): Promise<string> {
  const { rows } = await q.query(
    "insert into item_event (item_id, actor_member_id, action, diff, source_message_id) values ($1, $2, $3, $4, $5) returning id",
    [e.itemId, e.actor, e.action, JSON.stringify(e.diff ?? {}), e.messageId ?? null],
  );
  return rows[0].id;
}
