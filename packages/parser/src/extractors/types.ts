import { z } from "zod";
import { ItemType } from "@homegenie/shared";

/**
 * What an extractor returns. The extractor only quotes and classifies; it never computes dates,
 * picks member ids or decides what gets written. Those are deterministic steps after it.
 */
export const ExtractedItem = z.object({
  type: ItemType,
  /** Short, clean title in the language the family used: "Pay electricity bill", "Atta 5 kg". */
  title: z.string().min(1).max(120),
  /** The person words as written: "Riya", "papa", "me", "mujhe". Null when nobody is named. */
  assignee_hint: z.string().nullable(),
  /** The date/time words exactly as written: "kal shaam 6 baje", "1 Oct", "every month on 5th". */
  due_text: z.string().nullable(),
  amount: z.number().nullable(),
  /** For list entries: which list ("Shopping", "Packing"). */
  list_name: z.string().nullable(),
  /** For bills: who is paid ("Electricity", "BESCOM", "School", "Society maintenance"). */
  biller: z.string().nullable(),
  /** 0–1: how sure the extractor is that this is a real, intended item with these fields. */
  confidence: z.number().min(0).max(1),
});
export type ExtractedItem = z.infer<typeof ExtractedItem>;

/**
 * A change to an item the family already has. `ref` must be one of the open-item refs given in the
 * context ("i3"); code maps refs to ids and drops anything that doesn't match.
 */
export const ExtractedUpdate = z.object({
  ref: z.string(),
  /** update: change fields · complete: done/paid/bought · cancel: no longer needed · claim: sender takes it on
   *  · confirm: "yes, add it" to a suggested card */
  op: z.enum(["update", "complete", "cancel", "claim", "confirm"]),
  title: z.string().nullable().default(null),
  amount: z.number().nullable().default(null),
  due_text: z.string().nullable().default(null),
  assignee_hint: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
});
export type ExtractedUpdate = z.infer<typeof ExtractedUpdate>;

export const Extraction = z.object({
  /** False for chatter, questions and replies that ask nothing of anyone. */
  actionable: z.boolean(),
  items: z.array(ExtractedItem),
  /** Changes to existing items. Older extractor outputs without this field still parse. */
  updates: z.array(ExtractedUpdate).default([]),
});
export type Extraction = z.infer<typeof Extraction>;
/** What an extractor may return: `updates` is optional and defaults to []. */
export type ExtractionInput = z.input<typeof Extraction>;

/** A recent chat message, shown to the extractor so follow-ups ("actually ₹4,500") make sense. */
export interface ContextMessage {
  senderName: string;
  text: string;
  minutesAgo: number;
}

/** An open item, shown with a short ref the extractor can point at. Ids never reach the model. */
export interface ContextItem {
  ref: string;
  type: string;
  title: string;
  assigneeName: string | null;
  createdByName: string;
  /** Household-local, human readable: "Thu 1 Oct, 09:00". */
  due: string | null;
  amount: number | null;
  minutesAgo: number;
}

/** What the household already knows, so each message isn't read in a vacuum. */
export interface ParseContext {
  recentMessages: ContextMessage[];
  openItems: ContextItem[];
  /** Household memory, one plain sentence each: "Electricity bill: usually about ₹4,200, due around the 1st, paid by Mom." */
  facts: string[];
  /** Recent corrections the family made to parsed items, one sentence each. */
  corrections: string[];
  /** The message this one replies to, if any. */
  replyTo?: ContextMessage;
}

export interface ExtractInput {
  /** Message text, or transcript/OCR text for voice and media. */
  text: string;
  senderName: string;
  /** Display names and aliases, so the extractor can recognise who is meant. */
  memberNames: string[];
  /** Existing list names in the household. */
  listNames: string[];
  /** Household-local time, ISO, so the model knows what "kal" means (it still only quotes). */
  nowIso: string;
  context?: ParseContext;
}

export interface Extractor {
  readonly name: string;
  extract(input: ExtractInput): Promise<ExtractionInput>;
}
