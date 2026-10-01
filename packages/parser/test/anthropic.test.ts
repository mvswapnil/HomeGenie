import { describe, expect, it } from "vitest";
import { AnthropicExtractor } from "../src/index.js";

/** Swap the SDK client for a stub that returns a canned response, so this runs without a key. */
function withResponse(content: unknown[]) {
  const x = new AnthropicExtractor({ apiKey: "test", model: "test-model" });
  let sent: Record<string, unknown> | undefined;
  (x as unknown as { client: unknown }).client = {
    messages: { create: async (req: Record<string, unknown>) => ((sent = req), { content }) },
  };
  return { x, sent: () => sent! };
}

const input = { text: "kal doodh le aana", senderName: "Mom", memberNames: ["mom", "papa"], listNames: ["Shopping"], nowIso: "2026-09-30T10:00:00.000+05:30" };

describe("AnthropicExtractor", () => {
  it("forces the record_items tool and parses its input", async () => {
    const { x, sent } = withResponse([
      { type: "tool_use", id: "t1", name: "record_items", input: { actionable: true, items: [{ type: "list_entry", title: "Milk", assignee_hint: null, due_text: "kal", amount: null, list_name: "Shopping", biller: null, confidence: 0.95 }] } },
    ]);
    const out = await x.extract(input);
    expect(out.items[0]).toMatchObject({ type: "list_entry", title: "Milk", due_text: "kal" });
    expect(sent()).toMatchObject({ model: "test-model", temperature: 0, tool_choice: { type: "tool", name: "record_items" } });
  });

  it("rejects output that doesn't match the schema", async () => {
    const { x } = withResponse([{ type: "tool_use", id: "t1", name: "record_items", input: { actionable: true, items: [{ type: "grocery", title: "Milk" }] } }]);
    await expect(x.extract(input)).rejects.toThrow();
  });

  it("errors when the model returns no tool call", async () => {
    const { x } = withResponse([{ type: "text", text: "Sure!" }]);
    await expect(x.extract(input)).rejects.toThrow(/no tool call/);
  });
});
