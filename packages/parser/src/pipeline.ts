/**
 * One message in, one decision out:
 *   chatter screen → extractor (LLM) → deterministic resolution → decide.
 * The extractor proposes; code resolves dates and people and decides what gets written.
 */
import { DateTime } from "luxon";
import { HOUSEHOLD_TZ_DEFAULT, type Item, type Member, type ParseDecision, type ResolvedItem, type ResolvedUpdate } from "@homegenie/shared";
import { isChatter } from "./chatter.js";
import { Extraction, type Extractor, type ParseContext } from "./extractors/types.js";
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
  /** Recent messages, open items, household memory. Built by the server; optional for evals. */
  context?: ParseContext;
  /** Maps the refs shown in context.openItems ("i3") back to item ids. Only these can be updated. */
  itemRefs?: Record<string, string>;
}

export interface ParseResult {
  decision: ParseDecision;
  /** Raw extractor output, kept for debugging and the eval report. */
  extraction: Extraction | null;
  extractor: string;
  /** True when the chatter screen answered and no model was called. */
  screened: boolean;
  /** Changes to existing items, already checked against the refs we offered. */
  updates: ResolvedUpdate[];
}

/** Map extractor updates onto real items. Unknown refs and low-confidence updates are dropped. */
export function resolveUpdates(extraction: Extraction, input: ParseInput, now: DateTime): ResolvedUpdate[] {
  const out: ResolvedUpdate[] = [];
  for (const u of extraction.updates) {
    const itemId = input.itemRefs?.[u.ref];
    if (!itemId || u.confidence < CONFIDENCE_THRESHOLD) continue;
    const changes: ResolvedUpdate["changes"] = {};
    if (u.op === "claim") changes.assignedTo = input.senderId;
    if (u.op === "update") {
      if (u.title) changes.title = u.title.trim();
      if (u.amount !== null && u.amount > 0) changes.amount = u.amount;
      if (u.due_text) {
        const due = resolveDue(u.due_text, now);
        if (due.dueAt && !due.isGuess) changes.dueAt = due.dueAt; // a vague new date isn't worth overwriting a real one
      }
      if (u.assignee_hint) {
        const who = resolveAssignee({ hint: u.assignee_hint, mentions: input.mentions ?? [], members: input.members, senderId: input.senderId, type: "task" });
        if (who.assignedBy !== "default_sender") changes.assignedTo = who.assignedTo;
      }
      if (Object.keys(changes).length === 0) continue;
    }
    out.push({ itemId, op: u.op, changes, confidence: u.confidence });
  }
  return out;
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

  // A short reply to a message ("haan main kar dunga", "done") can settle an item, so replies skip the screen.
  if (isChatter(input.text) && !(input.mentions?.length) && !input.context?.replyTo) {
    return { decision: { kind: "none", reason: "chatter" }, extraction: null, extractor: "chatter-screen", screened: true, updates: [] };
  }

  const sender = input.members.find((m) => m.id === input.senderId);
  const extraction = Extraction.parse(
    await extractor.extract({
      text: input.text,
      senderName: sender?.displayName ?? "Unknown",
      memberNames: [...new Set(input.members.flatMap(namesOf))],
      listNames: input.listNames ?? ["Shopping"],
      nowIso: now.toISO() ?? "",
      context: input.context,
    }),
  );
  const items = resolveItems(extraction, input, now);
  const updates = resolveUpdates(extraction, input, now);
  // An update-only message ("paid") is actionable even with no new items.
  const decision = items.length === 0 && updates.length > 0 ? ({ kind: "none", reason: "updates only" } as const) : decide(extraction, items);
  return { decision, extraction, extractor: extractor.name, screened: false, updates };
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
