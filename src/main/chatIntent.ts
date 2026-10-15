// Deterministic safeguards for the chat: things that should never depend on a language model remembering a rule. Pure functions, no I/O.
//   - what a short reply ("both", "yes", "do it", "the first one") is an answer TO, and an instruction to act on it
//   - when the user is repeating themselves or is frustrated: ask nothing
//   - when an assistant reply PROMISES an action ("I'll pull both") that no tool performed
//   - when a message refers to the product's picture (so the thumbnail is worth sending)
//   - which Database products matter to this message (so the whole list does not ride along every turn)

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const AFFIRM = /^(?:yes|yeah|yep|yup|sure|ok|okay|k|please|go ahead|go for it|do it|just do it|do that|sounds good|that works|proceed|continue|fine|alright)[\s.!]*$/i;
const BOTH = /^(?:both|all of them|all of it|all|everything|the both|both please|both of them|both of those)[\s.!]*$/i;
const ORDINAL: Array<[RegExp, number]> = [
  [/^(?:the\s+)?(?:first|1st|1|one|a|option a|option 1|number 1|number one)(?:\s+one)?[\s.!)]*$/i, 0],
  [/^(?:the\s+)?(?:second|2nd|2|two|b|option b|option 2|number 2|number two)(?:\s+one)?[\s.!)]*$/i, 1],
  [/^(?:the\s+)?(?:third|3rd|3|three|c|option c|option 3|number 3)(?:\s+one)?[\s.!)]*$/i, 2],
  [/^(?:the\s+)?(?:last|final)(?:\s+one)?[\s.!)]*$/i, -1],
];
const NEGATIVE = /^(?:no|nope|nah|don'?t|do not|cancel|stop|never ?mind)[\s.!]*$/i;

export type ShortAnswer = { kind: "both" } | { kind: "affirm" } | { kind: "ordinal"; index: number } | { kind: "negative" };

/** The kind of short answer a message is, or null when it is an ordinary message. */
export function classifyShortAnswer(message: string): ShortAnswer | null {
  const m = message.trim();
  if (!m || m.length > 40) return null;
  if (BOTH.test(m)) return { kind: "both" };
  if (NEGATIVE.test(m)) return { kind: "negative" };
  if (AFFIRM.test(m)) return { kind: "affirm" };
  for (const [re, index] of ORDINAL) if (re.test(m)) return { kind: "ordinal", index };
  return null;
}

/** The last thing the assistant asked, trimmed to its question (the final sentence ending in "?", with the options that follow it). */
export function lastAssistantQuestion(history: ChatTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "assistant") continue;
    const text = history[i].content.trim();
    if (!text.includes("?")) return null;
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (let j = sentences.length - 1; j >= 0; j--) if (sentences[j].includes("?")) return sentences.slice(Math.max(0, j - 1)).join(" ").slice(0, 400);
    return text.slice(-300);
  }
  return null;
}

/** The numbered or lettered options the assistant offered in its last message, in order ("1) ... 2) ..." / "A) ... B) ..."). */
export function offeredOptions(history: ChatTurn[]): string[] {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "assistant") continue;
    const text = history[i].content;
    const found: string[] = [];
    for (const m of text.matchAll(/(?:^|[\s(])(?:\d|[A-Da-d])[).]\s+([^\n]*?)(?=(?:\s+(?:\d|[A-Da-d])[).]\s)|\s*[?\n]|$)/g)) found.push(m[1].trim().replace(/[,;]?\s*\b(?:or|and)\s*$/i, "").replace(/[,;]\s*$/, "").trim());
    return found.filter(Boolean);
  }
  return [];
}

const FRUSTRATED = /(stop asking|quit asking|(already|just) (told|said|answered)|i said|multiple times|how many times|for the last time|again and again|just do (it|that)|do it already|why (are|do) you (keep|still)|you keep asking|i('ve| have) (told|said))/i;

/** True when the user is repeating an instruction, or sounds frustrated: the only acceptable replies are action or a stated limit. */
export function isRepeatOrFrustrated(message: string, history: ChatTurn[]): boolean {
  if (FRUSTRATED.test(message)) return true;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const mine = norm(message);
  if (!mine) return false;
  const priorUsers = history.filter((t) => t.role === "user").slice(-6).map((t) => norm(t.content));
  // the same short instruction again ("both", "do it"), or a restatement that contains an earlier one
  const repeats = priorUsers.filter((p) => p && (p === mine || (mine.length > 8 && p.length > 8 && (mine.includes(p) || p.includes(mine))))).length;
  if (repeats >= 1 && classifyShortAnswer(message)) return true;
  if (repeats >= 1 && (history.filter((t) => t.role === "assistant" && t.content.includes("?")).length >= 2)) return true;
  // two earlier short answers and now another: the assistant has asked too many times
  const shortAnswers = history.filter((t) => t.role === "user" && classifyShortAnswer(t.content)).length;
  return shortAnswers >= 2 && !!classifyShortAnswer(message);
}

/**
 * A one-line instruction for the model about how to read this message, or null. Built only from what the user and the assistant actually said; never invents a
 * task. It states the answer to the question that was asked, and (when the user is repeating or frustrated) that nothing further may be asked.
 */
export function followUpHint(message: string, history: ChatTurn[]): string | null {
  const answer = classifyShortAnswer(message);
  const repeated = isRepeatOrFrustrated(message, history);
  const question = lastAssistantQuestion(history);
  const parts: string[] = [];
  if (answer && question) {
    const options = offeredOptions(history);
    if (answer.kind === "both") parts.push(`The user's message "${message.trim()}" answers your last question ("${question}") with BOTH options: do all of what you offered, together, now.`);
    else if (answer.kind === "affirm") parts.push(`The user's message "${message.trim()}" says YES to your last question ("${question}"): do it now.`);
    else if (answer.kind === "negative") parts.push(`The user's message "${message.trim()}" says NO to your last question ("${question}"): do not do it, and do not ask again.`);
    else {
      const pick = options.length ? (answer.index === -1 ? options[options.length - 1] : options[answer.index]) : null;
      parts.push(
        pick
          ? `The user's message "${message.trim()}" picks option "${pick}" from your last question ("${question}"): do exactly that now.`
          : `The user's message "${message.trim()}" picks an option from your last question ("${question}"): take the ${answer.index === -1 ? "last" : ["first", "second", "third"][answer.index]} one you offered and do it now.`
      );
    }
  } else if (answer && !question) {
    parts.push(`The user's message "${message.trim()}" is a short answer to something earlier in the conversation: act on the most recent thing you offered or were asked to do.`);
  }
  if (repeated) parts.push("The user is repeating an instruction or is frustrated. Ask NO questions and offer NO options. Either do the task with sensible defaults, or say in one sentence what you cannot do and what you can.");
  if (!parts.length) return null;
  parts.push("Pick sensible defaults yourself (counts, sources). Do not offer a menu.");
  return parts.join(" ");
}

const PROMISE = /\b(?:i(?:'|’)?ll|i will|i am going to|i(?:'|’)?m going to|i(?:'|’)?m about to|let me|i can start|i(?:'|’)?ll go|going to|i(?:'|’)?ll now|now i(?:'|’)?ll)\s+(?:go\s+|now\s+|just\s+|quickly\s+|also\s+)?(?:pull|grab|fetch|find|search|look|run|start|get|add|save|collect|gather|hunt|scrape|check|dig|research|refresh|update|load|download|bring|do)\b/i;
const IS_QUESTION_ONLY = /\?\s*$/;

/** True when a reply promises to do something now (and so a tool should have been called). A reply that only asks a question is not a promise. */
export function promisesAction(reply: string): boolean {
  const text = reply.trim();
  if (!text) return false;
  if (!PROMISE.test(text)) return false;
  // "I'll do X if you tell me Y?" is a conditional offer, not a promise to act now
  return !(IS_QUESTION_ONLY.test(text) && /\bif you\b|\bonce you\b|\bwhen you\b/i.test(text));
}

const WANTS_PICTURE = /\b(thumbnail|thumb|photo|photos|picture|pictures|pic|pics|image|images|looks? like|similar to|match(?:es|ing)? (?:the|this)|same as (?:the|this)|what does it look)\b/i;

/** Whether the message refers to how the product looks, so the open product's own picture is worth sending to the model. */
export function wantsProductPicture(message: string): boolean {
  return WANTS_PICTURE.test(message);
}

// ---------------------------------------------------------------- relevant products

const STOP = new Set(["the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "is", "it", "this", "that", "me", "my", "i", "you", "do", "does", "what", "how", "about", "with", "find", "more", "look", "up", "research", "please", "can", "could", "show", "tell", "want", "need", "get"]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/(\d)\s*[-]?\s*(tb|gb)\b/g, "$1$2")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

export interface ProductRef {
  id: string;
  name: string;
  prioritized?: boolean;
  parentProductId?: string | null;
}

/**
 * The few Database products worth mentioning to the model for THIS message: the open product with its parent and variants, products the user starred, and the ones whose
 * names share words with the message and the last few turns. Everything else is reachable on demand (the find_products tool), so the prompt stays the same size however
 * big the Database is.
 */
export function relevantProducts<T extends ProductRef>(products: T[], message: string, history: ChatTurn[], focus: T | null, limit = 14): T[] {
  const chosen = new Map<string, T>();
  const add = (p: T | undefined) => p && chosen.size < limit && chosen.set(p.id, p);
  if (focus) {
    add(focus);
    add(focus.parentProductId ? products.find((p) => p.id === focus.parentProductId) : undefined);
    for (const p of products) if (p.parentProductId === focus.id) add(p);
  }
  const recent = [message, ...history.slice(-4).map((t) => t.content)].join(" ");
  const wanted = new Set(words(recent));
  const scored = products
    .map((p) => {
      const ws = words(p.name);
      const hits = ws.filter((w) => wanted.has(w)).length;
      return { p, score: ws.length ? hits / Math.sqrt(ws.length) + (hits >= 2 ? 1 : 0) : 0 };
    })
    .filter((x) => x.score > 0.3)
    .sort((a, b) => b.score - a.score);
  for (const { p } of scored) add(p);
  for (const p of products) if (p.prioritized) add(p);
  return [...chosen.values()];
}

/** Products whose names match a free-text query, best first (what the find_products tool returns). */
export function searchProducts<T extends ProductRef>(products: T[], query: string, limit = 12): T[] {
  const q = new Set(words(query));
  if (q.size === 0) return products.slice(0, limit);
  return products
    .map((p) => {
      const ws = words(p.name);
      const hits = ws.filter((w) => q.has(w)).length;
      return { p, score: hits ? hits / Math.sqrt(Math.max(1, ws.length)) + hits * 0.1 : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p);
}
