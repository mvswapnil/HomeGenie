/**
 * One message in, one decision out:
 *   chatter screen → extractor (LLM) → deterministic resolution → decide.
 * The extractor proposes; code resolves dates and people and decides what gets written.
 */
import { DateTime } from "luxon";
import { HOUSEHOLD_TZ_DEFAULT, type Item, type Member, type ParseDecision, type ResolvedItem } from "@homegenie/shared";
import { isChatter } from "./chatter.js";
import type { Extraction, Extractor } from "./extractors/types.js";
import { resolveDue } from "./resolve/dates.js";
import { namesOf, resolveAssignee } from "./resolve/members.js";

/** Starting threshold from the MVP plan; tune it on the concierge-week messages. */
export const CONFIDENCE_THRESHOLD = 0.8;

export interface ParseInput {
  /** Text to parse: body, or transcript/OCR for voice and media (body appended as caption). */
  text: string;
  senderId: string;
  mentions?: string[];
  members: Member[];
  listNames?: string[];
  tz?: string;
  /** Injected for tests and evals; defaults to the real clock. */
  now?: Date;
}

export interface ParseResult {
  decision: ParseDecision;
  /** Raw extractor output, kept for debugging and the eval report. */
  extraction: Extraction | null;
  extractor: string;
  /** True when the chatter screen answered and no model was called. */
  screened: boolean;
}

export function resolveItems(extraction: Extraction, input: ParseInput, now: DateTime): ResolvedItem[] {
  return extraction.items.map((x) => {
    const due = resolveDue(x.due_text, now);
    const who = resolveAssignee({
      hint: x.assignee_hint,
      mentions: input.mentions ?? [],
      members: input.members,
      senderId: input.senderId,
      type: x.type,
    });
    return {
      type: x.type,
      title: x.title.trim(),
      assignedTo: who.assignedTo,
      assignedBy: who.assignedBy,
      dueAt: due.dueAt,
      dueIsGuess: due.isGuess,
      recurrenceRule: due.rrule,
      amount: x.amount,
      listName: x.type === "list_entry" ? (x.list_name ?? "Shopping") : null,
      biller: x.biller,
      confidence: x.confidence,
    };
  });
}

/** Clear asks become items; anything shaky becomes one tap-to-accept suggestion; nothing else shows. */
export function decide(extraction: Extraction, items: ResolvedItem[]): ParseDecision {
  if (!extraction.actionable || items.length === 0) return { kind: "none", reason: "not actionable" };
  const low = items.filter((i) => i.confidence < CONFIDENCE_THRESHOLD);
  if (low.length) return { kind: "suggestion", items, reason: `low confidence (${low.map((i) => i.confidence).join(", ")})` };
  const vagueDate = items.filter((i) => i.dueIsGuess);
  if (vagueDate.length) return { kind: "suggestion", items, reason: "date is a guess" };
  return { kind: "items", items };
}

export async function parseMessage(input: ParseInput, extractor: Extractor): Promise<ParseResult> {
  const tz = input.tz ?? HOUSEHOLD_TZ_DEFAULT;
  const now = DateTime.fromJSDate(input.now ?? new Date(), { zone: tz });

  if (isChatter(input.text) && !(input.mentions?.length)) {
    return { decision: { kind: "none", reason: "chatter" }, extraction: null, extractor: "chatter-screen", screened: true };
  }

  const sender = input.members.find((m) => m.id === input.senderId);
  const extraction = await extractor.extract({
    text: input.text,
    senderName: sender?.displayName ?? "Unknown",
    memberNames: [...new Set(input.members.flatMap(namesOf))],
    listNames: input.listNames ?? ["Shopping"],
    nowIso: now.toISO() ?? "",
  });
  const items = resolveItems(extraction, input, now);
  return { decision: decide(extraction, items), extraction, extractor: extractor.name, screened: false };
}

/** Wraps a primary extractor with a fallback, so a model outage degrades to rules instead of failing. */
export function withFallback(primary: Extractor, fallback: Extractor): Extractor {
  return {
    name: `${primary.name}|fallback:${fallback.name}`,
    async extract(input) {
      try {
        return await primary.extract(input);
      } catch {
        return fallback.extract(input);
      }
    },
  };
}

/**
 * Same bill posted twice by two members: same biller and amount, due within 7 days of each other.
 * Returns the existing item so the card can say "Already added by Mom".
 */
export function findDuplicateBill(candidate: ResolvedItem, existing: Pick<Item, "type" | "status" | "dueAt" | "attrs">[]): (typeof existing)[number] | null {
  if (candidate.type !== "bill" || candidate.amount === null) return null;
  const due = candidate.dueAt ? DateTime.fromISO(candidate.dueAt) : null;
  for (const it of existing) {
    if (it.type !== "bill" || it.status === "cancelled") continue;
    const attrs = it.attrs as { amount?: number; biller?: string };
    if (attrs.amount !== candidate.amount) continue;
    if ((attrs.biller ?? "").toLowerCase() !== (candidate.biller ?? "").toLowerCase()) continue;
    if (due && it.dueAt) {
      const days = Math.abs(DateTime.fromISO(it.dueAt).diff(due, "days").days);
      if (days > 7) continue;
    }
    return it;
  }
  return null;
}
