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

// ---- a question is not a request to act (Beta 28 live test: "hi! what can you do for me?" started the scanner; "what should I check before buying one?" wrote a watch note)

/** Tools that change something: the scanner, settings, lists, watches, notes. A greeting or a pure question must never run one. */
export const SIDE_EFFECT_TOOLS = new Set([
  "add_search_item",
  "remove_search_item",
  "add_custom_instruction",
  "add_product_watch_note",
  "add_blacklist_term",
  "remove_blacklist_term",
  "set_general_deal_detection",
  "update_config",
  "start_scanner",
  "stop_scanner",
  "clear_feed",
  "create_watch",
  "pause_watch",
  "resume_watch",
  "delete_watch",
]);

const GREETING = /^(?:hi|hello|hey|yo|sup|hiya|howdy|good (?:morning|afternoon|evening)|thanks|thank you|thx|ok|okay|cool|nice|great|awesome|lol)\b[\s!.,?]*$/i;
const QUESTION_START = /^(?:what|whats|what's|how|why|which|who|when|where|is|are|was|were|do|does|did|can|could|would|should|will|tell me|explain|any|hi|hello|hey)\b/i;
const ASKS_FOR_ACTION = /\b(?:start|stop|run|begin|launch|kick off|scan|add|remove|delete|clear|create|make|set|change|turn|switch|enable|disable|pause|resume|block|blacklist|note|remind|remember|log|save|track|watch|monitor|alert|notify|hunt|look for|search for|find me|go ahead|do it)\b/i;
const CAN_YOU_ACTION = /^(?:can|could|would|will) you\b/i;

/**
 * True when the message only greets, thanks or ASKS (what can you do, what should I check, is it worth it) and does not ask for any change. Used to refuse side-effect tools for that
 * turn: the model answers in words instead. "can you start the scanner?" and "add a Series S under $250" are requests and stay allowed; a short "yes / do it / go ahead" is an answer to
 * the previous turn and also stays allowed (those are handled by classifyShortAnswer).
 */
export function isInformationalOnly(message: string): boolean {
  const m = message.trim();
  if (!m) return false;
  if (classifyShortAnswer(m)) return false;
  if (GREETING.test(m)) return true;
  const questionLike = /\?/.test(m) || QUESTION_START.test(m);
  if (!questionLike) return false;
  if (CAN_YOU_ACTION.test(m) && ASKS_FOR_ACTION.test(m)) return false;
  return !ASKS_FOR_ACTION.test(m) || /^(?:what|how|why|which|who|when|where)\b[^.]*\b(?:can you do|do you do|are you|is it|should i|do i|does it)\b/i.test(m);
}

export function actionNotRunMessage(tool: string): string {
  return `Not run: the person only said hello or asked a question, and "${tool}" changes things. Nothing was changed. Answer their message in plain words (use web_research if facts matter) and, if useful, offer to do it when they ask. Do not say you did anything.`;
}

// ---- internal tool names are never shown to the person

const TOOL_PHRASES: Array<[RegExp, string]> = [
  [/\bresearch_variants\b/gi, "the variants check"],
  [/\bresearch_product\b/gi, "the product research"],
  [/\bweb_research\b/gi, "a web search"],
  [/\badd_reference_photos\b/gi, "the photo search"],
  [/\bfind_products\b/gi, "a Database lookup"],
  [/\bidentify_from_photo\b/gi, "the photo check"],
  [/\bcheck_model_name\b/gi, "the name check"],
  [/\badd_product_watch_note\b/gi, "a watch note"],
  [/\badd_search_item\b/gi, "the Search For list"],
  [/\bremove_search_item\b/gi, "the Search For list"],
  [/\badd_custom_instruction\b/gi, "a custom instruction"],
  [/\b(?:add|remove)_blacklist_term\b/gi, "the Blacklist"],
  [/\bset_general_deal_detection\b/gi, "the general deal setting"],
  [/\bupdate_config\b/gi, "a setting"],
  [/\b(?:start|stop)_scanner\b/gi, "the scanner"],
  [/\bclear_feed\b/gi, "the Feed"],
  [/\b(?:create|pause|resume|delete)_watch\b/gi, "the Watch"],
  [/\blist_watch_matches\b/gi, "the Watch matches"],
  [/\bask_choice\b/gi, "a question"],
  [/\blibrary_(?:op|list)\b/gi, "the Library"],
];

/** Replaces internal tool identifiers ("research_variants says...", "I ran research_product on X") with plain words, keeping a leading capital. */
export function plainToolNames(text: string): string {
  let out = text.replace(/`([a-z]+_[a-z_]+)`/g, "$1");
  for (const [re, phrase] of TOOL_PHRASES) {
    out = out.replace(re, (m, offset: number) => {
      const atStart = offset === 0 || /[.!?]\s*$/.test(out.slice(0, offset));
      return /^[A-Z]/.test(m) || atStart ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase;
    });
  }
  return out;
}

const WANTS_PICTURE =/\b(thumbnail|thumb|photo|photos|picture|pictures|pic|pics|image|images|looks? like|similar to|match(?:es|ing)? (?:the|this)|same as (?:the|this)|what does it look)\b/i;

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
