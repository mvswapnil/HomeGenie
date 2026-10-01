import { describe, expect, it } from "vitest";
import type { Member } from "@homegenie/shared";
import { parseMessage, userPrompt } from "../src/index.js";
import type { ExtractionInput, Extractor, ParseContext } from "../src/index.js";

const MEMBERS: Member[] = [
  { id: "mom", householdId: "h", displayName: "Mom", aliases: ["mom", "mummy"], role: "owner" },
  { id: "papa", householdId: "h", displayName: "Papa", aliases: ["papa"], role: "adult" },
  { id: "arjun", householdId: "h", displayName: "Arjun", aliases: ["arjun", "bhaiya"], role: "adult" },
];
const NOW = new Date("2026-09-30T04:30:00Z"); // 10:00 IST
const fixed = (x: ExtractionInput): Extractor => ({ name: "fixed", extract: async () => x });

const CONTEXT: ParseContext = {
  recentMessages: [{ senderName: "Mom", text: "Electricity bill ₹4,237 pay by 1 Oct", minutesAgo: 5 }],
  openItems: [
    { ref: "i1", type: "bill", title: "Pay electricity bill", assigneeName: "Mom", createdByName: "Mom", due: "Thu 1 Oct, 09:00", amount: 4237, minutesAgo: 5 },
    { ref: "i2", type: "task", title: "Book AC service", assigneeName: null, createdByName: "Mom", due: null, amount: null, minutesAgo: 60 },
  ],
  facts: ["Electricity bill: usually about ₹4,200, due around the 1st, paid by Mom."],
  corrections: [],
};
const REFS = { i1: "item-elec", i2: "item-ac" };
const base = { members: MEMBERS, now: NOW, context: CONTEXT, itemRefs: REFS };

describe("updates to existing items", () => {
  it("a correction changes the amount on the referenced item", async () => {
    const r = await parseMessage(
      { ...base, text: "actually it's ₹4,500", senderId: "mom" },
      fixed({ actionable: true, items: [], updates: [{ ref: "i1", op: "update", amount: 4500, confidence: 0.95 }] }),
    );
    expect(r.updates).toEqual([{ itemId: "item-elec", op: "update", changes: { amount: 4500 }, confidence: 0.95 }]);
    expect(r.decision.kind).toBe("none");
  });

  it("a claim assigns the item to the sender", async () => {
    const r = await parseMessage(
      { ...base, text: "main kar dunga", senderId: "arjun" },
      fixed({ actionable: true, items: [], updates: [{ ref: "i2", op: "claim", confidence: 0.9 }] }),
    );
    expect(r.updates[0]).toMatchObject({ itemId: "item-ac", op: "claim", changes: { assignedTo: "arjun" } });
  });

  it("a short reply skips the chatter screen", async () => {
    const r = await parseMessage(
      { ...base, context: { ...CONTEXT, replyTo: { senderName: "Mom", text: "Book AC service", minutesAgo: 60 } }, text: "ok", senderId: "papa" },
      fixed({ actionable: true, items: [], updates: [{ ref: "i2", op: "claim", confidence: 0.9 }] }),
    );
    expect(r.screened).toBe(false);
    expect(r.updates[0]?.changes.assignedTo).toBe("papa");
  });

  it("refs we didn't offer are dropped", async () => {
    const r = await parseMessage(
      { ...base, text: "paid", senderId: "mom" },
      fixed({ actionable: true, items: [], updates: [{ ref: "i9", op: "complete", confidence: 0.95 }] }),
    );
    expect(r.updates).toEqual([]);
  });

  it("low-confidence updates are dropped", async () => {
    const r = await parseMessage(
      { ...base, text: "maybe done?", senderId: "mom" },
      fixed({ actionable: true, items: [], updates: [{ ref: "i1", op: "complete", confidence: 0.5 }] }),
    );
    expect(r.updates).toEqual([]);
  });

  it("a vague new date doesn't overwrite a real one", async () => {
    const r = await parseMessage(
      { ...base, text: "AC wala next week", senderId: "mom" },
      fixed({ actionable: true, items: [], updates: [{ ref: "i2", op: "update", due_text: "next week", confidence: 0.9 }] }),
    );
    expect(r.updates).toEqual([]);
  });

  it("a message can settle one item and create another", async () => {
    const r = await parseMessage(
      { ...base, text: "bill bhar diya, ab doodh le aana", senderId: "mom" },
      fixed({
        actionable: true,
        items: [{ type: "list_entry", title: "Milk", assignee_hint: null, due_text: null, amount: null, list_name: "Shopping", biller: null, confidence: 0.95 }],
        updates: [{ ref: "i1", op: "complete", confidence: 0.95 }],
      }),
    );
    expect(r.decision.kind).toBe("items");
    expect(r.updates[0]).toMatchObject({ itemId: "item-elec", op: "complete" });
  });

  it("confirm passes through with no field changes", async () => {
    const r = await parseMessage(
      { ...base, itemRefs: { s1: "suggestion:x:0" }, text: "haan", senderId: "mom", context: { ...CONTEXT, replyTo: { senderName: "Mom", text: "AC", minutesAgo: 1 } } },
      fixed({ actionable: true, items: [], updates: [{ ref: "s1", op: "confirm", confidence: 0.9 }] }),
    );
    expect(r.updates).toEqual([{ itemId: "suggestion:x:0", op: "confirm", changes: {}, confidence: 0.9 }]);
  });

  it("extractors that predate updates still work", async () => {
    const r = await parseMessage({ ...base, text: "book AC", senderId: "mom" }, fixed({ actionable: false, items: [] }));
    expect(r.updates).toEqual([]);
  });
});

describe("prompt", () => {
  it("shows refs, notes and replies but never item ids", () => {
    const p = userPrompt({
      text: "actually 4500",
      senderName: "Mom",
      memberNames: ["mom", "papa"],
      listNames: ["Shopping"],
      nowIso: "2026-09-30T10:00:00.000+05:30",
      context: { ...CONTEXT, replyTo: { senderName: "Mom", text: "Electricity bill", minutesAgo: 5 } },
    });
    expect(p).toContain("- i1 | bill | Pay electricity bill | Mom | Thu 1 Oct, 09:00 | 4237 | Mom, 5 min ago");
    expect(p).toContain("Household notes:");
    expect(p).toContain('This message replies to Mom: "Electricity bill"');
    expect(p).not.toContain("item-elec");
  });
});
