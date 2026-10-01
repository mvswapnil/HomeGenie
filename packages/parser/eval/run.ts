/**
 * Parser scorecard. Runs every message in dataset.jsonl through the pipeline and scores it against
 * the MVP bar: at least 85% of messages fully correct (right decision, right items, right fields).
 *
 *   npm run eval                            # heuristic baseline, no API key needed
 *   npm run eval -- --extractor claude      # Claude (needs ANTHROPIC_API_KEY)
 *   npm run eval -- --only bill --verbose   # one category, print every message
 *   npm run eval -- --data path/to/real-messages.jsonl
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import type { Member, ResolvedItem } from "@homegenie/shared";
import { AnthropicExtractor, HeuristicExtractor, parseMessage, withFallback, type Extractor } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TZ = "Asia/Kolkata";
const BAR = 0.85;

/** The test household. Dataset ids refer to these member ids. */
export const MEMBERS: Member[] = [
  { id: "mom", householdId: "eval", displayName: "Mom", aliases: ["mom", "mummy", "maa", "mumma"], role: "owner" },
  { id: "papa", householdId: "eval", displayName: "Papa", aliases: ["papa", "dad", "pitaji"], role: "adult" },
  { id: "riya", householdId: "eval", displayName: "Riya", aliases: ["riya", "riyu"], role: "kid" },
  { id: "arjun", householdId: "eval", displayName: "Arjun", aliases: ["arjun", "bhaiya"], role: "adult" },
  { id: "dadi", householdId: "eval", displayName: "Dadi", aliases: ["dadi", "dadima"], role: "adult" },
];
/** Fixed clock so relative dates are stable: Wednesday 30 Sep 2026, 10:00 IST. */
const NOW = DateTime.fromISO("2026-09-30T10:00:00", { zone: TZ }).toJSDate();

interface ExpectedItem {
  type?: ResolvedItem["type"];
  assignee?: string | null;
  due?: string | null; // yyyy-MM-dd
  time?: string; // HH:mm
  amount?: number;
  list?: string;
  recurrence?: string;
}
interface Case {
  id: string;
  sender: string;
  text: string;
  kind?: string;
  mentions?: string[];
  expect: { decision: "items" | "suggestion" | "none"; items?: ExpectedItem[] };
}

type Field = "decision" | "count" | "type" | "assignee" | "due" | "time" | "amount" | "list" | "recurrence";

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    extractor: get("extractor") ?? "heuristic",
    only: get("only"),
    data: get("data") ?? join(HERE, "dataset.jsonl"),
    verbose: a.includes("--verbose"),
  };
}

function makeExtractor(name: string): Extractor {
  if (name === "heuristic") return new HeuristicExtractor();
  if (name === "claude") return new AnthropicExtractor();
  if (name === "claude+fallback") return withFallback(new AnthropicExtractor(), new HeuristicExtractor());
  throw new Error(`unknown extractor ${name} (heuristic | claude | claude+fallback)`);
}

const local = (iso: string | null) => (iso ? DateTime.fromISO(iso).setZone(TZ) : null);

/** Pair each expected item with an actual one: same type first, then whatever is left. */
function pair(expected: ExpectedItem[], actual: ResolvedItem[]): Array<[ExpectedItem, ResolvedItem | undefined]> {
  const used = new Set<number>();
  return expected.map((e) => {
    let i = actual.findIndex((a, j) => !used.has(j) && a.type === e.type);
    if (i < 0) i = actual.findIndex((_, j) => !used.has(j));
    if (i >= 0) used.add(i);
    return [e, i >= 0 ? actual[i] : undefined];
  });
}

function scoreItem(e: ExpectedItem, a: ResolvedItem | undefined): Array<[Field, boolean, string]> {
  const out: Array<[Field, boolean, string]> = [];
  const d = local(a?.dueAt ?? null);
  if (e.type !== undefined) out.push(["type", a?.type === e.type, `${a?.type}`]);
  if (e.assignee !== undefined) out.push(["assignee", (a?.assignedTo ?? null) === e.assignee, `${a?.assignedTo ?? null} (${a?.assignedBy})`]);
  if (e.due !== undefined) out.push(["due", (d?.toFormat("yyyy-MM-dd") ?? null) === e.due, `${d?.toFormat("yyyy-MM-dd") ?? null}`]);
  if (e.time !== undefined) out.push(["time", d?.toFormat("HH:mm") === e.time, `${d?.toFormat("HH:mm")}`]);
  if (e.amount !== undefined) out.push(["amount", a?.amount === e.amount, `${a?.amount}`]);
  if (e.list !== undefined) out.push(["list", (a?.listName ?? "").toLowerCase() === e.list.toLowerCase(), `${a?.listName}`]);
  if (e.recurrence !== undefined) out.push(["recurrence", a?.recurrenceRule === e.recurrence, `${a?.recurrenceRule}`]);
  return out;
}

async function main() {
  const opts = args();
  const extractor = makeExtractor(opts.extractor);
  const cases: Case[] = readFileSync(opts.data, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Case)
    .filter((c) => !opts.only || c.id.startsWith(opts.only));

  const fieldTotals = new Map<Field, { ok: number; n: number }>();
  const tally = (f: Field, ok: boolean) => {
    const t = fieldTotals.get(f) ?? { ok: 0, n: 0 };
    t.n++;
    if (ok) t.ok++;
    fieldTotals.set(f, t);
  };

  const rows: unknown[] = [];
  let fullyCorrect = 0;
  let errors = 0;
  let screened = 0;
  const t0 = Date.now();

  for (const c of cases) {
    let result;
    try {
      result = await parseMessage({ text: c.text, senderId: c.sender, mentions: c.mentions ?? [], members: MEMBERS, listNames: ["Shopping", "Packing"], tz: TZ, now: NOW }, extractor);
    } catch (err) {
      errors++;
      console.log(`✗ ${c.id.padEnd(9)} ERROR ${(err as Error).message}`);
      rows.push({ id: c.id, error: (err as Error).message });
      continue;
    }
    if (result.screened) screened++;

    const decision = result.decision;
    const actual = decision.kind === "none" ? [] : decision.items;
    const checks: Array<[Field, boolean, string]> = [["decision", decision.kind === c.expect.decision, decision.kind]];
    if (c.expect.decision !== "none") {
      const exp = c.expect.items ?? [];
      checks.push(["count", actual.length === exp.length, `${actual.length}`]);
      for (const [e, a] of pair(exp, actual)) checks.push(...scoreItem(e, a));
    }
    for (const [f, ok] of checks) tally(f, ok);
    const pass = checks.every(([, ok]) => ok);
    if (pass) fullyCorrect++;

    const misses = checks.filter(([, ok]) => !ok).map(([f, , got]) => `${f}=${got}`);
    if (!pass || opts.verbose) {
      console.log(`${pass ? "✓" : "✗"} ${c.id.padEnd(9)} ${JSON.stringify(c.text).slice(0, 60).padEnd(60)} ${pass ? "" : "→ " + misses.join(", ")}`);
    }
    rows.push({ id: c.id, text: c.text, pass, misses, decision, extraction: result.extraction });
  }

  const n = cases.length;
  const rate = n ? fullyCorrect / n : 0;
  console.log("\n" + "─".repeat(72));
  console.log(`Extractor: ${extractor.name}   Messages: ${n}   Time: ${((Date.now() - t0) / 1000).toFixed(1)}s   Screened as chatter: ${screened}   Errors: ${errors}`);
  console.log(`Fully correct: ${fullyCorrect}/${n} = ${(rate * 100).toFixed(1)}%   (bar: ${BAR * 100}%) ${rate >= BAR ? "PASS" : "below bar"}`);
  console.log("Per field:");
  for (const [f, { ok, n: fn }] of fieldTotals) console.log(`  ${f.padEnd(11)} ${String(ok).padStart(3)}/${String(fn).padEnd(3)} ${((ok / fn) * 100).toFixed(0).padStart(3)}%`);

  const outDir = join(HERE, "..", "eval-results");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${DateTime.now().toFormat("yyyyMMdd-HHmmss")}-${opts.extractor}.json`);
  writeFileSync(file, JSON.stringify({ extractor: extractor.name, n, fullyCorrect, rate, fields: Object.fromEntries(fieldTotals), rows }, null, 2));
  console.log(`\nDetails: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
