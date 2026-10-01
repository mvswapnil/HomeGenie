/**
 * Shared domain types for HomeGenie.
 * These mirror supabase/migrations/0001_init.sql. Keep them in sync.
 */
import { z } from "zod";

export const HOUSEHOLD_TZ_DEFAULT = "Asia/Kolkata";

export const ItemType = z.enum(["task", "list_entry", "bill", "reminder"]);
export type ItemType = z.infer<typeof ItemType>;

export const ItemStatus = z.enum(["open", "done", "snoozed", "cancelled"]);
export type ItemStatus = z.infer<typeof ItemStatus>;

export const MemberRole = z.enum(["owner", "adult", "kid"]);
export type MemberRole = z.infer<typeof MemberRole>;

export const MessageChannel = z.enum(["app", "share_sheet", "whatsapp"]);
export type MessageChannel = z.infer<typeof MessageChannel>;

export const MessageKind = z.enum(["text", "voice", "image", "document"]);
export type MessageKind = z.infer<typeof MessageKind>;

export const ParseStatus = z.enum(["pending", "item", "suggested", "none", "failed"]);
export type ParseStatus = z.infer<typeof ParseStatus>;

export interface Household {
  id: string;
  name: string;
  tz: string;
  plan: "free" | "family" | "family_plus";
  createdAt: string;
}

export interface Member {
  id: string;
  householdId: string;
  displayName: string;
  /** Other names the family uses: "papa", "mummy", "Riya", "dadi". Lower-cased on match. */
  aliases: string[];
  role: MemberRole;
}

export interface ChatMessage {
  id: string;
  householdId: string;
  senderMemberId: string;
  clientMsgId: string;
  channel: MessageChannel;
  kind: MessageKind;
  /** Typed text, or caption for media. */
  bodyText: string | null;
  mediaUrl: string | null;
  /** Speech-to-text for voice, OCR text for images and PDFs. Filled before parsing. */
  transcript: string | null;
  replyToId: string | null;
  /** Member ids picked from @mention autocomplete. */
  mentions: string[];
  createdAt: string;
  parseStatus: ParseStatus;
}

export interface BillAttrs {
  amount?: number;
  currency?: "INR";
  biller?: string;
  accountRef?: string;
  paidVia?: string;
}

export interface Item {
  id: string;
  householdId: string;
  type: ItemType;
  title: string;
  notes: string | null;
  status: ItemStatus;
  createdBy: string;
  assignedTo: string | null;
  listId: string | null;
  /** ISO timestamp with offset, in the household's time zone. */
  dueAt: string | null;
  /** RFC 5545 RRULE, e.g. "FREQ=MONTHLY;BYMONTHDAY=5". */
  recurrenceRule: string | null;
  attrs: BillAttrs | Record<string, unknown>;
  sourceMessageId: string;
  parseConfidence: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** What the parser hands back for one message: items to write, suggestions to show, or nothing. */
export type ParseDecision =
  | { kind: "none"; reason: string }
  | { kind: "items"; items: ResolvedItem[] }
  | { kind: "suggestion"; items: ResolvedItem[]; reason: string };

/** An item proposal after deterministic resolution, ready to become an `item` row. */
export interface ResolvedItem {
  type: ItemType;
  title: string;
  assignedTo: string | null;
  /** How assignment was decided, for debugging and the eval scorecard. */
  assignedBy: "mention" | "alias" | "first_person" | "default_sender" | "learned" | "none";
  dueAt: string | null;
  /** True when the date was guessed from vague text ("next week", "after Diwali"). */
  dueIsGuess: boolean;
  recurrenceRule: string | null;
  amount: number | null;
  listName: string | null;
  biller: string | null;
  confidence: number;
}

/** A change to an existing item, resolved from a message ("actually ₹4,500", "paid", "I'll do it"). */
export interface ResolvedUpdate {
  itemId: string;
  op: "update" | "complete" | "cancel" | "claim" | "confirm";
  changes: {
    title?: string;
    amount?: number;
    dueAt?: string;
    assignedTo?: string | null;
  };
  confidence: number;
}

/** Stored on chat_message.parse_result; the app draws the cards under a message from it. */
export interface MessageParseResult {
  itemIds: string[];
  suggestionId: string | null;
  updatedItemIds: string[];
  /** Bills this message repeated: "Already added by Mom". */
  duplicates: Array<{ itemId: string; addedBy: string }>;
  reason?: string;
}
