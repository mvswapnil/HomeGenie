import { describe, expect, it } from "vitest";
import type { Member } from "@homegenie/shared";
import { decide, findDuplicateBill, parseMessage, resolveAssignee, isChatter, parseAmount } from "../src/index.js";
import type { Extraction, Extractor } from "../src/index.js";

const MEMBERS: Member[] = [
  { id: "mom", householdId: "h", displayName: "Mom", aliases: ["mummy", "maa", "mom"], role: "owner" },
  { id: "papa", householdId: "h", displayName: "Papa", aliases: ["papa", "dad", "pitaji"], role: "adult" },
  { id: "riya", householdId: "h", displayName: "Riya", aliases: ["riya", "riyu"], role: "kid" },
  { id: "dadi", householdId: "h", displayName: "Dadi", aliases: ["dadi", "dadima"], role: "adult" },
];
const NOW = new Date("2026-09-30T04:30:00Z"); // 10:00 IST

/** Extractor that returns a fixed answer, to test everything after the model. */
const fixed = (x: Extraction): Extractor => ({ name: "fixed", extract: async () => x });
const item = (over: Partial<Extraction["items"][number]> = {}): Extraction["items"][number] => ({
  type: "task", title: "Book AC service", assignee_hint: null, due_text: null, amount: null, list_name: null, biller: null, confidence: 0.95, ...over,
});

describe("assignment", () => {
  const base = { mentions: [] as string[], members: MEMBERS, senderId: "mom", type: "task" as const };
  it("@mention wins", () => expect(resolveAssignee({ ...base, hint: "riya", mentions: ["papa"] }).assignedTo).toBe("papa"));
  it("alias in the hint", () => expect(resolveAssignee({ ...base, hint: "papa ko" })).toEqual({ assignedTo: "papa", assignedBy: "alias" }));
  it("nickname", () => expect(resolveAssignee({ ...base, hint: "Riyu" }).assignedTo).toBe("riya"));
  it("first person → sender", () => expect(resolveAssignee({ ...base, hint: "mujhe", senderId: "dadi" })).toEqual({ assignedTo: "dadi", assignedBy: "first_person" }));
  it("nobody named → sender", () => expect(resolveAssignee({ ...base, hint: null }).assignedBy).toBe("default_sender"));
  it("list entries stay shared", () => expect(resolveAssignee({ ...base, hint: null, type: "list_entry" }).assignedTo).toBeNull());
  it("'sab' → shared", () => expect(resolveAssignee({ ...base, hint: "sab" }).assignedTo).toBeNull());
  it("unknown name falls back to sender", () => expect(resolveAssignee({ ...base, hint: "Ramesh" }).assignedBy).toBe("default_sender"));
});

describe("chatter screen", () => {
  it.each(["ok", "Haan thik hai", "👍", "on my way", "good morning ji", "thank you!", "aa raha hu"])("%s is chatter", (t) => expect(isChatter(t)).toBe(true));
  it.each(["kal doodh le aana", "pay bill", "ok and buy milk", "₹500", "remind me"])("%s is not chatter", (t) => expect(isChatter(t)).toBe(false));
});

describe("decide", () => {
  const resolved = (over = {}) => ({
    type: "task" as const, title: "x", assignedTo: null, assignedBy: "none" as const, dueAt: null, dueIsGuess: false,
    recurrenceRule: null, amount: null, listName: null, biller: null, confidence: 0.95, ...over,
  });
  it("confident → items", () => expect(decide({ actionable: true, items: [] }, [resolved()]).kind).toBe("items"));
  it("low confidence → suggestion", () => expect(decide({ actionable: true, items: [] }, [resolved({ confidence: 0.6 })]).kind).toBe("suggestion"));
  it("guessed date → suggestion", () => expect(decide({ actionable: true, items: [] }, [resolved({ dueIsGuess: true })]).kind).toBe("suggestion"));
  it("not actionable → none", () => expect(decide({ actionable: false, items: [] }, []).kind).toBe("none"));
});

describe("parseMessage", () => {
  it("chatter never reaches the extractor", async () => {
    const boom: Extractor = { name: "boom", extract: async () => { throw new Error("should not be called"); } };
    const r = await parseMessage({ text: "ok", senderId: "riya", members: MEMBERS, now: NOW }, boom);
    expect(r).toMatchObject({ screened: true, decision: { kind: "none" } });
  });

  it("resolves dates and people in code, not in the model", async () => {
    const r = await parseMessage(
      { text: "papa ko bolo kal shaam AC service book karein", senderId: "mom", members: MEMBERS, now: NOW },
      fixed({ actionable: true, items: [item({ assignee_hint: "papa", due_text: "kal shaam" })] }),
    );
    expect(r.decision.kind).toBe("items");
    if (r.decision.kind !== "items") return;
    expect(r.decision.items[0]).toMatchObject({ assignedTo: "papa", assignedBy: "alias", dueAt: "2026-10-01T18:00:00.000+05:30" });
  });

  it("splits a voice note into several items", async () => {
    const r = await parseMessage(
      { text: "milk le aana aur maid ko 6000 dena", senderId: "papa", members: MEMBERS, now: NOW },
      fixed({ actionable: true, items: [item({ type: "list_entry", title: "Milk" }), item({ type: "task", title: "Pay maid", amount: 6000 })] }),
    );
    expect(r.decision.kind === "items" && r.decision.items.length).toBe(2);
  });
});

describe("dedupe", () => {
  const cand = {
    type: "bill" as const, title: "Electricity bill", assignedTo: "mom", assignedBy: "default_sender" as const,
    dueAt: "2026-10-01T09:00:00.000+05:30", dueIsGuess: false, recurrenceRule: null, amount: 4237, listName: null, biller: "Electricity", confidence: 0.95,
  };
  it("same bill within 7 days is a duplicate", () => {
    expect(findDuplicateBill(cand, [{ type: "bill", status: "open", dueAt: "2026-10-03T09:00:00.000+05:30", attrs: { amount: 4237, biller: "electricity" } }])).not.toBeNull();
  });
  it("different amount is not", () => {
    expect(findDuplicateBill(cand, [{ type: "bill", status: "open", dueAt: "2026-10-01T09:00:00.000+05:30", attrs: { amount: 4500, biller: "Electricity" } }])).toBeNull();
  });
  it("next month's bill is not", () => {
    expect(findDuplicateBill(cand, [{ type: "bill", status: "open", dueAt: "2026-11-01T09:00:00.000+05:30", attrs: { amount: 4237, biller: "Electricity" } }])).toBeNull();
  });
});

describe("parseAmount", () => {
  it.each([["₹4,237", 4237], ["Rs. 1499", 1499], ["6k", 6000], ["18500 rupees", 18500], ["2 kg atta", null]])("%s → %s", (t, n) => expect(parseAmount(t)).toBe(n));
});
