/**
 * Claude-backed extractor. Forces a single tool call so the output is always schema-shaped JSON,
 * then validates it with zod before anything downstream trusts it.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Extraction, type ExtractInput, type Extractor } from "./types.js";
import { SYSTEM_PROMPT, userPrompt } from "./prompt.js";

const TOOL_NAME = "record_items";

/** JSON Schema twin of the zod `Extraction` schema, for the tool definition. */
const INPUT_SCHEMA = {
  type: "object",
  properties: {
    actionable: { type: "boolean" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["task", "list_entry", "bill", "reminder"] },
          title: { type: "string" },
          assignee_hint: { type: ["string", "null"] },
          due_text: { type: ["string", "null"] },
          amount: { type: ["number", "null"] },
          list_name: { type: ["string", "null"] },
          biller: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["type", "title", "assignee_hint", "due_text", "amount", "list_name", "biller", "confidence"],
      },
    },
    updates: {
      type: "array",
      description: "Changes to open items listed in the context, by ref. Empty if none.",
      items: {
        type: "object",
        properties: {
          ref: { type: "string" },
          op: { type: "string", enum: ["update", "complete", "cancel", "claim", "confirm"] },
          title: { type: ["string", "null"] },
          amount: { type: ["number", "null"] },
          due_text: { type: ["string", "null"] },
          assignee_hint: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["ref", "op", "confidence"],
      },
    },
  },
  required: ["actionable", "items", "updates"],
} as const;

export interface AnthropicExtractorOptions {
  apiKey?: string;
  /** Defaults to PARSER_MODEL, then a small fast model. Benchmark before changing. */
  model?: string;
  maxTokens?: number;
}

export class AnthropicExtractor implements Extractor {
  readonly name: string;
  private client: Anthropic;
  private model: string;
  private maxTokens: number;

  constructor(opts: AnthropicExtractorOptions = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
    this.model = opts.model ?? process.env.PARSER_MODEL ?? "claude-haiku-4-5-20251001";
    this.maxTokens = opts.maxTokens ?? 1024;
    this.name = `claude:${this.model}`;
  }

  async extract(input: ExtractInput): Promise<Extraction> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: TOOL_NAME,
          description: "Record the household items found in the message (or none).",
          input_schema: INPUT_SCHEMA as unknown as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [{ role: "user", content: userPrompt(input) }],
    });
    const call = res.content.find((b) => b.type === "tool_use");
    if (!call || call.type !== "tool_use") throw new Error("extractor: model returned no tool call");
    return Extraction.parse(call.input);
  }
}
