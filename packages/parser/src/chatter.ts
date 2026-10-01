/**
 * Cheap screen that runs before the LLM: plain acknowledgements and greetings never cost a model call.
 * Deliberately conservative. Anything it isn't sure about goes on to the extractor.
 */
const ACK_WORDS = new Set([
  "ok", "okay", "okk", "k", "kk", "haan", "han", "ha", "haa", "hmm", "hm", "ji", "jee", "accha", "acha", "achha",
  "thik", "theek", "hai", "h", "sure", "cool", "nice", "great", "done", "yes", "yup", "yeah", "no", "nahi", "na",
  "thanks", "thank", "you", "thx", "ty", "shukriya", "dhanyavad", "lol", "haha", "hahaha",
  "good", "morning", "night", "gm", "gn", "afternoon", "evening",
  "on", "my", "way", "omw", "reached", "pahunch", "gaya", "gayi", "gaye", "aa", "raha", "rahi", "rahe", "hu", "hoon", "hun",
  "coming", "leaving", "nikal", "nikla", "nikli", "home", "ghar", "ghr", "love", "miss", "bas", "bye", "tc", "take", "care",
  "it", "is", "are", "am", "the", "a", "to", "will", "be", "there", "soon",
]);

/** Words that mean the message may carry an ask even if short ("pay", "kal", "₹"). */
const SIGNAL = /\d|₹|\brs\b|\b(pay|bill|buy|get|book|remind|yaad|kal|aaj|tomorrow|today|le aana|lana|call|fix|order)\b/i;

export function isChatter(text: string | null | undefined): boolean {
  if (!text) return true;
  const stripped = text.replace(/\p{Extended_Pictographic}|‍|️/gu, " ").trim();
  if (!stripped) return true; // emoji-only
  if (SIGNAL.test(stripped)) return false;
  const words = stripped
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return true;
  if (words.length > 8) return false;
  return words.every((w) => ACK_WORDS.has(w));
}
