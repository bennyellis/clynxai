// The identity step of the scan decision (stage 5 of scanPipeline.ts): when a listing's words do not say WHICH model it is (a phone with no lock state, "Xbox Series X" with no disc / digital / edition),
// list what it could be, let the resolve ladder (identityLadder.ts) narrow it within its budgets, and hand the deal gate the verdict: settled, or "still not sure, so no alert and price it low".
// Pure apart from the injected value lookup and rungs; nothing here fetches anything.
import { resolveIdentity, vagueMarker, type Candidate, type Identity, type LadderBudget, type LadderState, type Resolution, type Rung } from "./identityLadder.js";
import { namingFacts, parsePhone, phoneEntry, resolveName, type NamingFacts } from "./namingEngine.js";
import { lineFor, nameKey } from "./modelFacts.js";

export interface ScanListing {
  id: string;
  title: string;
  description: string | null;
  priceUsd: number;
  /** Changes when there is new evidence (a new photo, an edited description, a price drop). */
  evidenceKey: string;
}

export interface ScanIdentityDeps {
  /** What an entry of this name is worth (null when unknown). */
  valueOf(name: string): number | null;
  isDeal(askingUsd: number, valueUsd: number): boolean;
  state: LadderState;
  facts?: NamingFacts;
  /** Photo, label and search rungs, supplied by the engine when it has them; absent rungs are skipped. */
  extraRungs?: Partial<Record<"all_photos" | "labels_and_codes" | "image_search" | "line_research", Rung>>;
  budget?: LadderBudget;
  now?: number;
}

export interface ScanIdentityVerdict {
  /** The listing is something that never alerts (an iCloud-locked phone, a blacklisted one...). */
  forParts: string | null;
  /** Words for the gate's "identity unconfirmed" list: non-empty means the gate must not call this a deal. */
  unconfirmed: string[];
  /** The Vague marker text ("" when settled or not applicable). */
  marker: string;
  /** The value to price it at while not settled: the lowest candidate's. */
  valueUsd: number | null;
  resolution: Resolution | null;
}

const none: ScanIdentityVerdict = { forParts: null, unconfirmed: [], marker: "", valueUsd: null, resolution: null };

/** What the listing could be, or null when its words already say (or it is not a kind of thing with undecided models). */
export function candidatesFor(text: string, valueOf: (name: string) => number | null, facts: NamingFacts): { candidates: Candidate[]; missing: string[] } | null {
  const found = candidatesUnfiltered(text, valueOf, facts);
  if (!found) return null;
  // Only possibilities Clynx can price matter, and only when they are priced differently: with one known value (or values within ~15%) which model it is cannot change the decision, so the listing is handled as it always was.
  const priced = found.candidates.filter((c) => c.valueUsd !== null);
  if (priced.length < 2) return null;
  const values = priced.map((c) => c.valueUsd as number);
  if (Math.max(...values) < Math.min(...values) * 1.15) return null;
  return { candidates: priced, missing: found.missing };
}

function candidatesUnfiltered(text: string, valueOf: (name: string) => number | null, facts: NamingFacts): { candidates: Candidate[]; missing: string[] } | null {
  const phone = parsePhone(text);
  if (phone.model && !phone.forParts) {
    const entry = phoneEntry(phone);
    if (entry && entry.certainty === "vague") {
      const size = phone.storage ? ` (${phone.storage})` : "";
      const names = [`${phone.model} Unlocked${size}`, `${phone.model} Locked${size}`];
      return { candidates: names.map((name) => ({ name, valueUsd: valueOf(name) })), missing: ["whether it is unlocked or locked to a carrier"] };
    }
    return null;
  }
  const r = resolveName(text, facts);
  // the bare line name ("Xbox Series X", "MacBook Air"): lines with a default model resolve to it (generic); lines with none just match the line itself
  const bareLine = lineFor(text, facts.lines);
  const isBare = r.generic || (!!bareLine && nameKey(text) === nameKey(bareLine.name));
  if (isBare) {
    const line = r.generic ? facts.lines.find((l) => l.name === r.line) : bareLine;
    if (line && line.models.length > 1) return { candidates: line.models.map((m) => ({ name: m.canonical, valueUsd: valueOf(m.canonical) })), missing: ["which model (disc or digital, size, edition)"] };
  }
  return null;
}

/** Rung 0: the title, the description and the item's specifics read again together. */
function textRung(listing: ScanListing, valueOf: (name: string) => number | null, facts: NamingFacts): Rung {
  return async (identity) => {
    const text = `${listing.title}\n${listing.description ?? ""}`;
    const phone = parsePhone(text);
    if (phone.model) {
      const e = phoneEntry(phone);
      if (e && e.certainty === "settled") return { candidates: [{ name: e.name, valueUsd: valueOf(e.name) }], confidence: "settled", found: "the description states the lock state" };
      return { candidates: identity.candidates, confidence: identity.confidence, found: "the title and description do not say unlocked or locked", missing: identity.missing };
    }
    const r = resolveName(text, facts);
    const kept = r.how === "model" && !r.generic ? identity.candidates.filter((c) => nameKey(c.name) === nameKey(r.canonical)) : [];
    if (kept.length === 1) return { candidates: kept, confidence: "settled", found: `the description names it: ${r.canonical}` };
    // the description names the model without repeating the line ("This is the Digital Edition"): try every few-word phrase of it after the line's name; settled only when they all agree
    const line = resolveName(listing.title, facts).line;
    if (line && listing.description) {
      const words = listing.description.replace(/[^A-Za-z0-9&+'\- ]+/g, " ").split(/\s+/).filter(Boolean);
      const hits = new Set<string>();
      for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= words.length; i++) {
        if (i > 0 && /^(?:no|not|without|non|never)$/i.test(words[i - 1])) continue; // "no disc drive" does not name the disc model
        const m = resolveName(`${line} ${words.slice(i, i + n).join(" ")}`, facts);
        if (m.how === "model" && !m.generic && identity.candidates.some((c) => nameKey(c.name) === nameKey(m.canonical))) hits.add(m.canonical);
      }
      if (hits.size === 1) {
        const only = identity.candidates.filter((c) => nameKey(c.name) === nameKey([...hits][0]));
        return { candidates: only, confidence: "settled", found: `the description names it: ${only[0].name}` };
      }
    }
    return { candidates: identity.candidates, confidence: identity.confidence, found: "the title and description do not say which model", missing: identity.missing };
  };
}

export async function assessListingIdentity(listing: ScanListing, deps: ScanIdentityDeps): Promise<ScanIdentityVerdict> {
  const facts = deps.facts ?? namingFacts();
  const phone = parsePhone(`${listing.title}\n${listing.description ?? ""}`);
  if (phone.model && phone.forParts) return { ...none, forParts: phone.forParts, unconfirmed: [`${phone.forParts}`], marker: `For Parts: ${phone.forParts}. It never alerts.` };
  const found = candidatesFor(listing.title, deps.valueOf, facts);
  if (!found) return none;
  const known = found.candidates.every((c) => c.valueUsd !== null);
  const start: Identity = { candidates: found.candidates, confidence: known ? "likely" : "vague", missing: found.missing, tried: [] };
  const resolution = await resolveIdentity(deps.state, {
    listingId: listing.id,
    askingUsd: listing.priceUsd,
    start,
    evidenceKey: listing.evidenceKey,
    isDeal: deps.isDeal,
    rungs: { text_and_specifics: textRung(listing, deps.valueOf, facts), ...(deps.extraRungs ?? {}) },
    budget: deps.budget,
    now: deps.now,
  });
  const marker = vagueMarker(resolution.identity);
  return { forParts: null, unconfirmed: resolution.mayAlert ? [] : found.missing, marker, valueUsd: resolution.valueUsd, resolution };
}
