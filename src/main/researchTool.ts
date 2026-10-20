// The research_product chat tool, with everything it touches passed in so the whole path (chat -> tool -> evidence check -> Database write) can be
// run end to end in a test. index.ts supplies the real Database, the real web evidence check and the real research starter.
import type { Store } from "./store.js";
import { reconcileVerdict, type VariantVerdict } from "./variantEvidence.js";
import { cleanOfficialName } from "./variantLinking.js";
import { identityTokens } from "./variantIdentity.js";
import { createdVariantMessage, decideResearchTarget, publicHttpUrls, type TrackedProduct } from "./variantResearch.js";
import { isPlausibleProductName } from "./variantFanout.js";
import { buildVocabulary, describeCorrections, looksLikeQuestion, normalizeTypedProduct, placePhrase, splitProductRequest, stripCommand } from "./typedInput.js";

export interface ResearchStartOptions {
  source: "you";
  verdict?: VariantVerdict | null;
  skipSiblingDiscovery?: boolean;
  forcedFamily?: string;
}

export interface ResearchToolDeps {
  store: Pick<
    Store,
    | "findMatchingProduct"
    | "listProductIndex"
    | "getProductById"
    | "addProductStub"
    | "setProductLoading"
    | "setProductParent"
    | "setProductVariantEvidence"
    | "recordVariantClaim"
  >;
  verifyClaim(name: string, parent: TrackedProduct, userUrls: string[]): Promise<VariantVerdict>;
  /** Starts the background research that fills in (and saves) a product's profile. */
  startLookup(id: string, name: string, opts: ResearchStartOptions): void;
  /** Tells the window a product changed. */
  notify(id: string): void;
  newId(): string;
  progress?(message: string): void;
}

// Words that start a command rather than name a product ("research xbox series x galaxy").
const COMMAND_PREFIX = /^(?:please\s+|pls\s+)?(?:(?:can|could|would)\s+you\s+)?(?:go\s+)?(?:research|look\s+up|look\s+into|look\s+at|find|add|check(?:\s+out)?|search(?:\s+for)?|tell\s+me\s+about|what\s+about|how\s+about|do\s+you\s+know(?:\s+about)?)\s+/i;
// A message containing any of these is a question or a sentence, not a product name.
const SENTENCE_WORDS = new Set(["is", "are", "was", "were", "worth", "should", "can", "could", "would", "how", "why", "what", "which", "who", "when", "does", "do", "did", "vs", "versus", "than", "then", "if", "but", "because", "i", "you", "me", "my", "we", "it", "this", "that", "these", "those", "there"]);

/**
 * The model sometimes shortens what the user named to the general product ("Xbox Series X" for "xbox series x galaxy"). When the user's whole message
 * is just a product name that says more than the model passed, the user's wording wins: a specific version is a different product, not a note on the
 * general one. Deliberately conservative: only a short message that is a bare name (after a leading "research ..."), never a question or a sentence.
 */
export function recoverNamedProduct(product: string, userMessage: string | undefined): string | null {
  if (!userMessage) return null;
  const firstLine = userMessage.split(/\r?\n/).find((l) => l.trim()) ?? "";
  let phrase = splitProductRequest(firstLine.trim().replace(COMMAND_PREFIX, "")).product.replace(/\b(?:please|pls|for me|thanks|thank you)\b[\s.!]*$/i, "").replace(/[\s.!]+$/, "").trim();
  if (!phrase || /[?]/.test(phrase)) return null;
  const words = phrase.split(/\s+/);
  if (words.length > 12 || words.some((w) => SENTENCE_WORDS.has(w.toLowerCase().replace(/[^a-z']/g, "")))) return null;
  const mine = new Set(identityTokens(phrase));
  const theirs = identityTokens(product);
  if (theirs.length === 0 || !theirs.every((t) => mine.has(t)) || mine.size <= new Set(theirs).size) return null;
  phrase = phrase.replace(/^["'“”]+|["'“”]+$/g, "");
  return phrase;
}


// Tells the model not to stall: it has just been handed work, so it reports what started and offers follow-ups afterwards (it asked "What should I focus on in the writeup?" before).
const NO_STALL = " Do NOT ask the user what to focus on or how to write it up: say what you started, then offer follow-ups.";

export async function runResearchProductTool(args: Record<string, unknown>, userMessage: string | undefined, deps: ResearchToolDeps): Promise<string> {
  let product = String(args.product ?? "").trim();
  if (!product) return "Failed: no product name given.";
  const userUrls = publicHttpUrls(`${String(args.url ?? "")} ${userMessage ?? ""} ${product}`);
  const recovered = recoverNamedProduct(product, userMessage);
  if (recovered) product = recovered;
  // a leading "research ..." is a command, and "<product>. <request>" is two things: only the product is researched (the request is handed back to the model below)
  product = stripCommand(product);
  if (looksLikeQuestion(product)) {
    return `NOT PLACED: "${product}" reads as a question, not a product name, so nothing was created or changed. Answer the question in chat (use web_research if facts matter), or ask which product they mean.`;
  }
  const split = splitProductRequest(product);
  product = split.product;
  const requestNote = split.request ? ` Their message also asked: "${split.request}". Only "${product}" was researched; do that part yourself now (for editions and versions call research_variants; Clynx also looks for the product's versions and add-ons by itself in the background after a first research and lists them, with their status, on the product's page: say that rather than promising a result).` : "";

  // The user's own words are the query of record. Only a spelling slip or the word order of a real product title is repaired (typedInput.ts), and the repair is reported.
  const { store } = deps;
  const tracked = store.listProductIndex();
  const vocab = buildVocabulary(tracked.map((p) => p.name));
  const normalized = normalizeTypedProduct(product, vocab);
  product = normalized.text;
  const correction = describeCorrections(normalized);
  if (!isPlausibleProductName(product)) {
    return `NOT PLACED: "${product}" looks like a text fragment (unbalanced brackets or a dangling word), not a product name, so nothing was created or changed. Ask the user for the exact product name and do not guess.`;
  }
  const placement = placePhrase(product, vocab, tracked);
  if (placement.kind === "gibberish") {
    return `NOT PLACED: I could not tell what "${product}" is, so nothing was created or changed. Ask the user what they meant (a product name, a model, or a link or photo) and do not guess.`;
  }
  if (placement.kind === "choose") {
    return `NEEDS THE USER'S CHOICE: "${product}" could be more than one kind of thing already in the Database: ${placement.options.map((o) => `"${o}"`).join(" or ")}. Nothing was created or changed. Use ask_choice to ask which one they mean (a game, a console, or something else), then research that one.${correction ? ` ${correction}` : ""}`;
  }
  const answer = await researchDecided(product, userUrls, deps);
  return `${correction ? `${correction} ` : ""}${answer}${requestNote}`;
}

async function researchDecided(product: string, userUrls: string[], deps: ResearchToolDeps): Promise<string> {
  const { store } = deps;
  const decision = await decideResearchTarget(product, {
    findMatching: (name) => store.findMatchingProduct(name),
    listTracked: () => store.listProductIndex(),
    entryHasEvidence: (entry) => {
      const status = store.getProductById(entry.id)?.variantEvidence?.status;
      return status === "verified" || status === "supported";
    },
    verify: (name, parent) => {
      deps.progress?.(`Checking manufacturer and retailer sources for "${name}"...`);
      return deps.verifyClaim(name, parent, userUrls);
    },
  });

  if (decision.kind === "not_recorded") {
    // Nothing becomes a product. What was found is kept on the general entry so the next question starts from it.
    store.recordVariantClaim(decision.parent.id, decision.verdict);
    deps.notify(decision.parent.id);
    return decision.message;
  }

  if (decision.kind === "create_variant") {
    const parentFull = store.getProductById(decision.parent.id);
    const candidateId = deps.newId();
    // The evidence's own name for the product ("Xbox Series X 2TB Galaxy Black Special Edition" for "xbox series x galaxy") is what the entry is filed
    // under when it names every word of the claim and is a clean, short title: it is the name sellers and sold listings use.
    const official = cleanOfficialName(decision.verdict.officialName, product);
    if (official) product = official;
    const id = store.addProductStub(candidateId, product);
    if (id !== candidateId) {
      // Already in the Database under this name: refresh that one, with the evidence.
      store.setProductLoading(id, true);
      store.setProductVariantEvidence(id, reconcileVerdict(store.getProductById(id)?.variantEvidence ?? null, decision.verdict));
      deps.notify(id);
      deps.startLookup(id, product, { source: "you", verdict: decision.verdict, skipSiblingDiscovery: true });
      return `Already have "${product}" in the Database; refreshing it now with the evidence (${decision.verdict.status}: ${decision.verdict.basis}). It is saved when that finishes.${NO_STALL}`;
    }
    store.setProductParent(id, decision.parent.id);
    store.setProductVariantEvidence(id, decision.verdict);
    deps.notify(id);
    deps.startLookup(id, product, { source: "you", verdict: decision.verdict, skipSiblingDiscovery: true, forcedFamily: parentFull?.family ?? undefined });
    return createdVariantMessage(product, decision.parent, decision.verdict);
  }

  if (decision.kind === "refresh_existing") {
    const existing = store.getProductById(decision.existing.id);
    if (existing) {
      store.setProductLoading(existing.id, true);
      deps.notify(existing.id);
      // The user's own wording is what gets researched, not the entry's more generic stored name.
      deps.startLookup(existing.id, product, { source: "you" });
      return `Already have a Database profile for "${existing.name}"; refreshing it with a fresh web search for "${product}" now. It is saved when the research finishes (the Discovery tab shows progress), so don't say it is saved yet.${NO_STALL}`;
    }
  }

  const id = store.addProductStub(deps.newId(), product);
  deps.notify(id);
  deps.startLookup(id, product, { source: "you" });
  return `Started researching "${product}" and added it to the Database as a new entry. It is saved when the research finishes (the Discovery tab shows progress), so don't say it is saved yet.${NO_STALL}`;
}
