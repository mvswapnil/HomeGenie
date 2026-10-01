/**
 * Decides who an item belongs to. Order (see the Data model tab):
 *   1. an @mention picked from autocomplete
 *   2. a name in the text ("for Riya", "papa ko bolo"), matched against member aliases
 *   3. first person ("remind me", "mujhe yaad dilana") → the sender
 *   4. otherwise the sender, except shopping-list entries, which belong to the whole family
 * Items are never silently given to the household owner.
 */
import type { ItemType, Member, ResolvedItem } from "@homegenie/shared";

const FIRST_PERSON = /^(me|myself|i|mujhe|mujhko|main|mera|meri|apne aap|self)$/;
const EVERYONE = /^(everyone|everybody|all|sab|sabko|sab log|family|ghar|anyone|someone|somebody|koi bhi|koi|kisi|kisi ko)$/;

function clean(hint: string): string {
  return hint
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\b(for|ko|ji|se|ke liye|kaun|ne)\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every lower-cased name a member answers to. */
export function namesOf(m: Member): string[] {
  return [m.displayName, ...m.aliases].map((n) => n.toLowerCase().trim()).filter(Boolean);
}

export function matchMember(hint: string, members: Member[]): Member | null {
  const h = clean(hint);
  if (!h) return null;
  // Exact name first, then a name appearing as a whole word inside the hint ("riya beta").
  for (const m of members) if (namesOf(m).includes(h)) return m;
  for (const m of members) {
    for (const n of namesOf(m)) {
      if (new RegExp(`(^|\\s)${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(h)) return m;
    }
  }
  return null;
}

export function resolveAssignee(args: {
  hint: string | null | undefined;
  mentions: string[];
  members: Member[];
  senderId: string;
  type: ItemType;
}): { assignedTo: string | null; assignedBy: ResolvedItem["assignedBy"] } {
  const { hint, mentions, members, senderId, type } = args;

  // 1. Autocomplete @mention: exact, no guessing. With several mentions, the extractor's hint picks one.
  if (mentions.length === 1 && members.some((m) => m.id === mentions[0])) {
    return { assignedTo: mentions[0]!, assignedBy: "mention" };
  }
  if (mentions.length > 1 && hint) {
    const picked = matchMember(hint, members.filter((m) => mentions.includes(m.id)));
    if (picked) return { assignedTo: picked.id, assignedBy: "mention" };
  }

  if (hint) {
    const h = clean(hint);
    // 3. First person
    if (FIRST_PERSON.test(h)) return { assignedTo: senderId, assignedBy: "first_person" };
    if (EVERYONE.test(h)) return { assignedTo: null, assignedBy: "none" };
    // 2. Alias match
    const m = matchMember(hint, members);
    if (m) return { assignedTo: m.id, assignedBy: "alias" };
  }

  // 4. Defaults
  if (type === "list_entry") return { assignedTo: null, assignedBy: "none" };
  return { assignedTo: senderId, assignedBy: "default_sender" };
}
