// The research_product chat tool, with everything it touches passed in so the whole path (chat -> tool -> evidence check -> Database write) can be
// run end to end in a test. index.ts supplies the real Database, the real web evidence check and the real research starter.
import type { Store } from "./store.js";
import { reconcileVerdict, type VariantVerdict } from "./variantEvidence.js";
import { identityTokens } from "./variantIdentity.js";
import { createdVariantMessage, decideResearchTarget, publicHttpUrls, type TrackedProduct } from "./variantResearch.js";

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
  let phrase = firstLine.trim().replace(COMMAND_PREFIX, "").replace(/\b(?:please|pls|for me|thanks|thank you)\b[\s.!]*$/i, "").replace(/[\s.!]+$/, "").trim();
  if (!phrase || /[?]/.test(phrase)) return null;
  const words = phrase.split(/\s+/);
  if (words.length > 12 || words.some((w) => SENTENCE_WORDS.has(w.toLowerCase().replace(/[^a-z']/g, "")))) return null;
  const mine = new Set(identityTokens(phrase));
  const theirs = identityTokens(product);
  if (theirs.length === 0 || !theirs.every((t) => mine.has(t)) || mine.size <= new Set(theirs).size) return null;
  phrase = phrase.replace(/^["'“”]+|["'“”]+$/g, "");
  return phrase;
}

function cleanOfficialName(name: string | undefined, claim: string): string | null {
  if (!name) return null;
  const cleaned = name.replace(/\s+/g, " ").replace(/^[\W_]+|[\W_]+$/g, "").trim();
  if (cleaned.length < claim.length - 2 || cleaned.length > 90 || /[<>{}\[\]]/.test(cleaned)) return null;
  const have = new Set(identityTokens(cleaned));
  return identityTokens(claim).every((t) => have.has(t)) ? cleaned : null;
}

export async function runResearchProductTool(args: Record<string, unknown>, userMessage: string | undefined, deps: ResearchToolDeps): Promise<string> {
  let product = String(args.product ?? "").trim();
  if (!product) return "Failed: no product name given.";
  const userUrls = publicHttpUrls(`${String(args.url ?? "")} ${userMessage ?? ""} ${product}`);
  const recovered = recoverNamedProduct(product, userMessage);
  if (recovered) product = recovered;

  const { store } = deps;
  const decision = await decideResearchTarget(product, {
    findMatching: (name) => store.findMatchingProduct(name),
    listTracked: () => store.listProductIndex(),
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
      return `Already have "${product}" in the Database; refreshing it now with the evidence (${decision.verdict.status}: ${decision.verdict.basis}). It is saved when that finishes.`;
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
      return `Already have a Database profile for "${existing.name}"; refreshing it with a fresh web search for "${product}" now. It is saved when the research finishes (the Discovery tab shows progress), so don't say it is saved yet.`;
    }
  }

  const id = store.addProductStub(deps.newId(), product);
  deps.notify(id);
  deps.startLookup(id, product, { source: "you" });
  return `Started researching "${product}" and added it to the Database as a new entry. It is saved when the research finishes (the Discovery tab shows progress), so don't say it is saved yet.`;
}
