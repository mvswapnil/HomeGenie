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

export const Extraction = z.object({
  /** False for chatter, questions and replies that ask nothing of anyone. */
  actionable: z.boolean(),
  items: z.array(ExtractedItem),
});
export type Extraction = z.infer<typeof Extraction>;

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
}

export interface Extractor {
  readonly name: string;
  extract(input: ExtractInput): Promise<Extraction>;
}
