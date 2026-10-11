// The Database's Discovery feed: a live list of the products Clynx is looking into, each with a running log of what it is
// thinking about that product (the "thoughts" shown on the right-hand side of the Discovery tab). Everything here is kept in
// memory for the session: the research results themselves live in the Database, and the tab fills its history from those.
// The caller supplies the push function, so this file knows nothing about Electron and can be tested on its own.

export type DiscoverySource =
  | "scanner" // Clynx came across it on its own while scanning
  | "you" // the user asked for it (chat, the Feed's Research button)
  | "refresh" // a re-check of something already in the Database
  | "related" // a sibling / variant found while researching another product
  | "alert" // the market check before a deal notification
  | "bundle" // one item of a listing that holds several products, priced on its own
  | "variant"; // the "(For Parts / Broken)" variant of a product

export type ThoughtKind = "start" | "reaction" | "step" | "finding" | "warn";

export interface DiscoveryThought {
  ts: number;
  kind: ThoughtKind;
  text: string;
}

export interface DiscoveryEntry {
  id: string;
  productId: string;
  name: string;
  source: DiscoverySource;
  status: "researching" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  thoughts: DiscoveryThought[];
}

const MAX_ENTRIES = 40;
const MAX_THOUGHTS = 40;
// A thought that arrives after the entry already finished (background photo search, related-product discovery) still belongs to it.
const LATE_THOUGHT_MS = 10 * 60_000;

export class DiscoveryFeed {
  private entries: DiscoveryEntry[] = []; // newest first
  // Research of one product can nest (a market check that turns into a full lookup): the entry closes when the last one ends.
  private active = new Map<string, { entry: DiscoveryEntry; depth: number }>();

  constructor(private readonly push: (entry: DiscoveryEntry) => void) {}

  list(): DiscoveryEntry[] {
    return this.entries.map((e) => ({ ...e, thoughts: [...e.thoughts] }));
  }

  clear(): void {
    this.entries = [];
    this.active.clear();
  }

  begin(productId: string, name: string, source: DiscoverySource, firstThought?: string): void {
    const running = this.active.get(productId);
    if (running) {
      running.depth++;
      return;
    }
    const entry: DiscoveryEntry = {
      id: `${productId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      productId,
      name,
      source,
      status: "researching",
      startedAt: Date.now(),
      finishedAt: null,
      thoughts: [],
    };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    this.active.set(productId, { entry, depth: 1 });
    if (firstThought) entry.thoughts.push({ ts: Date.now(), kind: "start", text: firstThought });
    this.push(entry);
  }

  note(productId: string, kind: ThoughtKind, text: string): void {
    const entry = this.active.get(productId)?.entry ?? this.recentFinished(productId);
    if (!entry || !text.trim()) return;
    entry.thoughts.push({ ts: Date.now(), kind, text: text.trim() });
    if (entry.thoughts.length > MAX_THOUGHTS) entry.thoughts.splice(0, entry.thoughts.length - MAX_THOUGHTS);
    this.push(entry);
  }

  // Ends one level of research for the product; the entry itself closes (done, or failed) when the last level ends.
  finish(productId: string, outcome: "done" | "failed" = "done"): void {
    const running = this.active.get(productId);
    if (!running) return;
    if (outcome === "failed") running.entry.status = "failed";
    running.depth--;
    if (running.depth > 0) return;
    this.active.delete(productId);
    if (running.entry.status === "researching") running.entry.status = "done";
    running.entry.finishedAt = Date.now();
    this.push(running.entry);
  }

  private recentFinished(productId: string): DiscoveryEntry | null {
    const entry = this.entries.find((e) => e.productId === productId);
    return entry && entry.finishedAt !== null && Date.now() - entry.finishedAt < LATE_THOUGHT_MS ? entry : null;
  }
}
