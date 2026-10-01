/**
 * Rule-based extractor. Two jobs:
 *   1. a baseline score for the eval harness, so the LLM has something to beat;
 *   2. a fallback when the model API is down, so captures degrade instead of failing.
 * It is not expected to reach the 85% bar on its own.
 */
import type { ExtractedItem, Extraction, ExtractInput, Extractor } from "./types.js";

const DONE = /\b(paid|pay kar diya|pay ho gaya|bhar diya|bhar di|jama kar diya|le aaya|le aayi|le aaye|bought|got it|kar diya|kar di|ho gaya|ho gayi|already)\b/;
const REMIND = /\b(remind|reminder|yaad dila|yaad dilana|yaad rakhna|yaad karana)\w*/;
const BUY = /\b(buy|get|bring|order|le aana|le ana|le aao|lana|le lena|le le|kharid\w*|mangwa\w*|mangao|khatam|finished|over ho gaya|nahi hai|chahiye)\b|\badd\b.*\bto\b.*\b(list|shopping)\b|\blist\s+me\w*\b.*\b(daal|add)\w*/;
/** "packing list", "Diwali list": a named list other than Shopping. */
const NAMED_LIST = /\b([a-z]+)\s+list\b/;
const BILL_WORD = /\b(bill|fees?|rent|kiraya|emi|premium|recharge|maintenance|due|bhada|installment|dues)\b/;
const PAY = /\b(pay|bharna|bhar do|bhar dena|jama karna|jama kar do|payment|pay karna|pay kar do|pay kar dena)\b/;
const TASK_VERB = /\b(book|call|fix|repair|service|renew|pick|drop|collect|submit|apply|clean|schedule|appointment|bulana|bula lo|bulao|karwa\w*|karna hai|kar dena|kar do|karo|check|cancel|return|send|bhejna|bhej do|le jaana|le jana|pickup|deliver)\b/;
const VAGUE = /\b(kharab|broken|not working|leak\w*|toot\w*|band ho gaya|needs?|zaroorat|lag raha|lagta hai|should|chahiye)\b/;
const REQUEST_Q = /\b(can you|could you|please|pls|plz|kya tum|kya aap|zara)\b/;

const BILLERS: Array<[RegExp, string]> = [
  [/\b(electricity|bijli|light bill|bescom|msedcl|tata power|adani)\b/, "Electricity"],
  [/\b(water|paani|pani)\b/, "Water"],
  [/\b(gas|cylinder|lpg|indane|png)\b/, "Gas"],
  [/\b(school|tuition|coaching)\b/, "School fees"],
  [/\b(rent|kiraya|bhada)\b/, "Rent"],
  [/\b(maintenance|society)\b/, "Society maintenance"],
  [/\b(broadband|wifi|wi-fi|internet|fiber|fibre|act)\b/, "Broadband"],
  [/\b(mobile|recharge|postpaid|prepaid|jio|airtel|vi)\b/, "Mobile"],
  [/\b(insurance|premium|lic)\b/, "Insurance"],
  [/\b(emi|loan)\b/, "EMI"],
  [/\b(credit card|card bill)\b/, "Credit card"],
  [/\b(dth|tata play|dish tv|cable)\b/, "DTH"],
  [/\b(newspaper|akhbaar|paper wala)\b/, "Newspaper"],
  [/\b(milk|doodh|dudh)\s*(bill|wala|ka hisaab)\b/, "Milk"],
];

/** Words that place an item in time; their presence means the clause carries a due date. */
const DATE_HINT = /\b(aaj|aj|kal|parso|parson|today|tonight|tomorrow|tmrw|abhi|asap|subah|shaam|sham|raat|dopahar|morning|evening|night|afternoon|next|agle|this|weekend|month end|every|har|daily|roz|monthly|weekly|by|before|tak|baje|am|pm|mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|ravivar|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|tareekh|tarikh|diwali|holi|week|hafte|din|days?|hours?|ghante)\b|\b\d{1,2}(st|nd|rd|th)\b|\b\d{1,2}[/-]\d{1,2}\b|\b\d{1,2}:\d{2}\b/;

const FILLER = new Set([
  "please", "pls", "plz", "zara", "bhi", "and", "aur", "also", "the", "a", "an", "some", "thoda", "thodi", "kuch",
  "ko", "ka", "ki", "ke", "se", "me", "mein", "hai", "hain", "h", "na", "ji", "bhai", "yaar", "beta", "to", "for",
  "can", "you", "could", "kya", "tum", "aap", "it", "is", "are", "we", "need", "needs", "let's", "lets",
  "le", "aana", "ana", "aao", "lana", "lena", "lo", "buy", "get", "bring", "order", "kharidna", "kharid", "mangwa", "mangwana", "mangao",
  "khatam", "ho", "gaya", "gayi", "finished", "over", "nahi", "chahiye", "add", "list", "shopping", "daal", "do", "dena", "karna", "kar", "karo",
  "remind", "reminder", "yaad", "dila", "dilana", "rakhna", "us", "me", "mujhe", "about", "that", "this",
]);

/** Strip money and quantities so "₹4,237" or "2 kg" are never read as dates. */
function withoutAmounts(s: string): string {
  return s
    .replace(/(?:₹|rs\.?|inr)\s*\d[\d,]*(?:\.\d+)?k?/gi, " ")
    .replace(/\b\d[\d,]*(?:\.\d+)?\s*(?:k|kg|g|gm|grams?|l|ltr|litres?|liters?|ml|pcs|pieces?|packets?|dozen|rupees|rs)\b/gi, " ")
    .replace(/\b\d{3,}\b/g, " ");
}

export function parseAmount(s: string): number | null {
  const m =
    s.match(/(?:₹|rs\.?|inr)\s*(\d[\d,]*(?:\.\d+)?)(k)?/i) ??
    s.match(/\b(\d[\d,]*(?:\.\d+)?)(k)?\s*(?:rupees|rs|rupaye|rupay)\b/i) ??
    s.match(/\b(\d{3,}(?:,\d{3})*(?:\.\d+)?)\b/) ??
    s.match(/\b(\d+(?:\.\d+)?)(k)\b/i);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function capitalise(s: string): string {
  const t = s.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/** Connectives and helper verbs that carry no meaning in a title. */
const TITLE_NOISE = new Set([
  "on", "at", "by", "liye", "bolo", "bol", "karni", "karna", "karwa", "karwana", "karwa", "le", "i'll", "ill", "i", "will", "lag", "rahi", "raha",
  "the", "way", "back", "dena", "hai", "tak", "apna", "apni", "ki", "ka", "ke", "ko", "se", "dila", "de", "you", "your", "ask",
]);

function stripWords(clause: string, drop: Set<string>, names: string[]): string {
  const dateWords = DATE_HINT;
  return clause
    // drop clock times ("7 baje", "11am", "6:30 pm", "at 4") and dates ("15/10") before word filtering
    .replace(/\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm|baje|bje)\b/gi, " ")
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\b/gi, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ")
    .split(/\s+/)
    .filter((w) => {
      const lw = w.toLowerCase().replace(/[^\p{L}\p{N}@]/gu, "");
      if (!lw) return false;
      if (drop.has(lw) || TITLE_NOISE.has(lw)) return false;
      if (lw.startsWith("@")) return false;
      if (names.includes(lw)) return false;
      if (dateWords.test(lw) && !/^\d/.test(lw)) return false;
      return true;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function findAssigneeHint(text: string, names: string[]): string | null {
  const t = text.toLowerCase();
  if (/\b(remind me|mujhe|mujhko|i need to|i have to|i'll|main\s+\w+\s+(?:lunga|lungi|karunga|karungi))\b/.test(t)) return "me";
  const at = t.match(/@([\p{L}]+)/u);
  if (at) return at[1]!;
  for (const n of names) {
    if (new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "u").test(t)) return n;
  }
  return null;
}

function splitClauses(text: string): string[] {
  return text
    .replace(/(\d),(\d)/g, "$1$2")
    .split(/\n|;|,|\.\s|\s+(?:aur|and|also|plus|n|&)\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

export class HeuristicExtractor implements Extractor {
  readonly name = "heuristic";

  async extract(input: ExtractInput): Promise<Extraction> {
    const raw = input.text.trim();
    const t = raw.toLowerCase().replace(/(\d),(\d)/g, "$1$2");
    const names = input.memberNames.map((n) => n.toLowerCase());

    if (DONE.test(t) && !BUY.test(t) && !REMIND.test(t)) return { actionable: false, items: [] };
    if (t.endsWith("?") && !REQUEST_Q.test(t) && !REMIND.test(t)) return { actionable: false, items: [] };

    const hint = findAssigneeHint(raw, names);
    const dueText = DATE_HINT.test(withoutAmounts(t)) ? withoutAmounts(t) : null;

    // Reminder: one item for the whole message.
    if (REMIND.test(t)) {
      const title = stripWords(withoutAmounts(raw), FILLER, names) || "Reminder";
      return {
        actionable: true,
        items: [{ type: "reminder", title: capitalise(title), assignee_hint: hint, due_text: dueText, amount: null, list_name: null, biller: null, confidence: 0.85 }],
      };
    }

    // Bill: needs a bill word, or a pay verb with an amount.
    const amount = parseAmount(t);
    if (BILL_WORD.test(t) || (PAY.test(t) && amount !== null)) {
      const biller = BILLERS.find(([re]) => re.test(t))?.[1] ?? null;
      const title = biller ? (biller.endsWith("fees") ? biller : `${biller} bill`) : capitalise(stripWords(withoutAmounts(raw), FILLER, names) || "Bill");
      return {
        actionable: true,
        items: [{ type: "bill", title, assignee_hint: hint, due_text: dueText, amount, list_name: null, biller, confidence: amount !== null ? 0.9 : 0.75 }],
      };
    }

    // Shopping (or another named list): one entry per clause.
    if (BUY.test(t) && !TASK_VERB.test(t.replace(BUY, ""))) {
      const named = t.match(NAMED_LIST)?.[1];
      const known = input.listNames.find((l) => l.toLowerCase() === named);
      const listName = known ?? "Shopping";
      const drop = new Set([...FILLER, "to", "the", "into", "in", "mein", "daal", "do", ...(named ? [named] : [])]);
      const items: ExtractedItem[] = [];
      for (const clause of splitClauses(raw)) {
        const title = stripWords(clause, drop, names);
        if (!title || title.length < 2) continue;
        items.push({ type: "list_entry", title: capitalise(title), assignee_hint: null, due_text: dueText, amount: null, list_name: listName, biller: null, confidence: 0.85 });
      }
      if (items.length) return { actionable: true, items };
    }

    // Task: an action verb, or a vague mention (lower confidence → suggestion).
    const strong = TASK_VERB.test(t);
    if (strong || VAGUE.test(t)) {
      const title = stripWords(withoutAmounts(raw), FILLER, names) || raw;
      return {
        actionable: true,
        items: [{ type: "task", title: capitalise(title.slice(0, 80)), assignee_hint: hint, due_text: dueText, amount: null, list_name: null, biller: null, confidence: strong ? 0.85 : 0.6 }],
      };
    }

    return { actionable: false, items: [] };
  }
}
