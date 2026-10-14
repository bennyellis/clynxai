// Database discovery benchmark: a fixed set of representative listings is run through the REAL ScrapeEngine pipeline (cheap filters,
// text judge, photo analysis, Database filing, market check, deal gate) with a scripted stand-in for the AI and a virtual clock, so the
// same run can be repeated on any version of the code and compared. Nothing here touches Facebook, OpenAI, eBay or a user's data.
//
// It only relies on things that exist in older versions too (ScrapeEngine, the fake store of _fixtures.ts, evaluateListing,
// runPostScoringPipeline, the vision queue), so it can be run against an older checkout to get the "before" numbers.
import type { Page } from "playwright";
import { ScrapeEngine } from "../scrapeEngine.js";
import type { ListingDetail, ListingSummary, ScoredListing } from "../types.js";
import { FAKE_PAGE, baseConfig, makeStore, searchItem } from "./_fixtures.js";

// ------------------------------------------------------------------------------------------------ virtual clock
export class VirtualClock {
  now = 1_800_000_000_000;
  private timers: Array<{ id: number; due: number; seq: number; fn: () => void }> = [];
  private nextId = 1;
  private seq = 0;
  private realImmediate = setImmediate;
  private saved: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; now: () => number; random: () => number } | null = null;
  private rng = 12345;

  install(): void {
    this.saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now, random: Math.random };
    const self = this;
    (globalThis as any).setTimeout = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => {
      const id = self.nextId++;
      self.timers.push({ id, due: self.now + Math.max(0, Number(ms) || 0), seq: self.seq++, fn: () => fn(...args) });
      const handle: any = { id, unref: () => handle, ref: () => handle, hasRef: () => true, refresh: () => handle };
      handle[Symbol.toPrimitive] = () => id;
      return handle;
    };
    (globalThis as any).clearTimeout = (h: any) => {
      const id = typeof h === "object" && h ? h.id : Number(h);
      self.timers = self.timers.filter((t) => t.id !== id);
    };
    Date.now = () => self.now;
    // deterministic jitter
    Math.random = () => {
      self.rng = (self.rng * 1103515245 + 12345) & 0x7fffffff;
      return self.rng / 0x7fffffff;
    };
  }

  restore(): void {
    if (!this.saved) return;
    globalThis.setTimeout = this.saved.setTimeout;
    globalThis.clearTimeout = this.saved.clearTimeout;
    Date.now = this.saved.now;
    Math.random = this.saved.random;
    this.saved = null;
  }

  private tick(): Promise<void> {
    return new Promise((resolve) => this.realImmediate(resolve));
  }

  /** Runs `p` to completion, jumping virtual time to the next timer whenever nothing else can make progress. */
  async run<T>(p: Promise<T>): Promise<T> {
    let done = false;
    let value: T | undefined;
    let error: unknown;
    p.then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        error = e;
      }
    );
    let guard = 0;
    while (!done) {
      for (let i = 0; i < 6 && !done; i++) await this.tick();
      if (done) break;
      this.advance();
      if (++guard > 5_000_000) throw new Error("virtual clock: runaway");
    }
    if (error !== undefined) throw error;
    return value as T;
  }

  /** Lets queued work run until it is idle, and advances virtual time until `isIdle()`. */
  async until(isIdle: () => boolean): Promise<void> {
    let guard = 0;
    while (!isIdle()) {
      for (let i = 0; i < 6; i++) await this.tick();
      if (isIdle()) return;
      if (!this.advance()) {
        // nothing scheduled and not idle: give real I/O one more chance, then give up
        for (let i = 0; i < 20; i++) await this.tick();
        if (!isIdle() && this.timers.length === 0) throw new Error("virtual clock: deadlock (work pending but no timer)");
      }
      if (++guard > 5_000_000) throw new Error("virtual clock: runaway");
    }
  }

  private advance(): boolean {
    if (!this.timers.length) return false;
    this.timers.sort((a, b) => a.due - b.due || a.seq - b.seq);
    const t = this.timers.shift()!;
    if (t.due > this.now) this.now = t.due;
    try {
      t.fn();
    } catch {
      // a throwing timer callback must not stop the benchmark
    }
    return true;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ------------------------------------------------------------------------------------------------ the corpus
export type Role = "good" | "bad" | "junk" | "mislabel" | "uncertain" | "naming";

export interface BenchCase {
  id: string;
  title: string;
  price: number;
  role: Role;
  // The product the photos really show, and what it sells for (null: nothing resalable / unknowable).
  truth: string | null;
  // What the text-only AI judge says about this listing (title + description only).
  judge: { potential: boolean; confidence: "low" | "medium" | "high"; category: string; fails?: "first" | "always" };
  // What a vision look at the photos says.
  vision: { identified: string[]; matches?: boolean | null; mismatchReason?: string };
  why: string;
}

// What each product really sells for on eBay (the "market check" answers from here).
export const MARKET: Record<string, number> = {
  "xbox series s": 260,
  "xbox series x": 430,
  "nintendo switch oled": 270,
  "playstation 5 slim digital edition": 380,
  "iphone 13": 340,
  "iphone 14 pro": 620,
  "meta quest 2": 150,
  "dualsense controller": 45,
  "dyson v8": 180,
  "airpods pro 2": 150,
  "canon eos rebel t7": 330,
  "sony wh-1000xm4": 190,
  "steam deck 256gb": 330,
};

export const CORPUS: BenchCase[] = [
  // ---- good deals
  { id: "g1", title: "Xbox Series S 512GB works great", price: 120, role: "good", truth: "Xbox Series S", judge: { potential: true, confidence: "high", category: "console" }, vision: { identified: ["Xbox Series S"], matches: true }, why: "tracked item, round price" },
  { id: "g2", title: "Xbox Series S 512GB Console with Controller", price: 71, role: "good", truth: "Xbox Series S", judge: { potential: true, confidence: "high", category: "console" }, vision: { identified: ["Xbox Series S"], matches: true }, why: "tracked item, price not a multiple of 5" },
  { id: "g3", title: "Microsoft Xbox Series X Console Black", price: 107, role: "good", truth: "Xbox Series X", judge: { potential: true, confidence: "high", category: "console" }, vision: { identified: ["Xbox Series X"], matches: true }, why: "named product, price not a multiple of 5" },
  { id: "g4", title: "Gaming console works great", price: 100, role: "good", truth: "Xbox Series S", judge: { potential: false, confidence: "low", category: "" }, vision: { identified: ["Xbox Series S"], matches: true }, why: "vague title; only the photos say what it is" },
  { id: "g5", title: "Selling my stuff, moving", price: 150, role: "good", truth: "Nintendo Switch OLED", judge: { potential: false, confidence: "low", category: "" }, vision: { identified: ["Nintendo Switch OLED"], matches: true }, why: "title says nothing; photos show a Switch OLED" },
  { id: "g6", title: "PS5 slim digital", price: 250, role: "good", truth: "PlayStation 5 Slim Digital Edition", judge: { potential: true, confidence: "medium", category: "console" }, vision: { identified: ["PlayStation 5 Slim Digital Edition"], matches: true }, why: "abbreviated name for a known product" },
  { id: "g7", title: "Apple iPhone 14 Pro", price: 300, role: "good", truth: "iPhone 14 Pro", judge: { potential: true, confidence: "high", category: "smartphone" }, vision: { identified: ["iPhone 14 Pro"], matches: true }, why: "clear title, big discount" },
  { id: "g8", title: "Headphones", price: 60, role: "good", truth: "Sony WH-1000XM4", judge: { potential: false, confidence: "low", category: "headphones" }, vision: { identified: ["Sony WH-1000XM4"], matches: true }, why: "generic title; photos show a premium model" },
  { id: "g9", title: "Handheld game", price: 120, role: "good", truth: "Steam Deck 256GB", judge: { potential: false, confidence: "low", category: "" }, vision: { identified: ["Steam Deck 256GB"], matches: true }, why: "generic title; photos show a Steam Deck" },
  { id: "g10", title: "Dyson V8 cordless vacuum", price: 80, role: "good", truth: "Dyson V8", judge: { potential: true, confidence: "high", category: "vacuum" }, vision: { identified: ["Dyson V8"], matches: true }, why: "clear title" },
  { id: "g11", title: "Canon camera with lens and bag", price: 135, role: "good", truth: "Canon EOS Rebel T7", judge: { potential: true, confidence: "low", category: "camera" }, vision: { identified: ["Canon EOS Rebel T7"], matches: true }, why: "model unclear from the text, so the text judge is unsure" },
  { id: "g12", title: "Xbox Series S", price: 120, role: "good", truth: "Xbox Series S", judge: { potential: true, confidence: "high", category: "console" }, vision: { identified: ["Xbox Series S"], matches: true }, why: "control: plain tracked item" },
  // ---- the text judge itself fails
  { id: "f1", title: "Dyson V8 vacuum, cordless, with attachments", price: 90, role: "good", truth: "Dyson V8", judge: { potential: true, confidence: "high", category: "vacuum", fails: "first" }, vision: { identified: ["Dyson V8"], matches: true }, why: "the first AI answer is unreadable, a second one is fine" },
  { id: "f2", title: "Sony WH-1000XM4 headphones", price: 85, role: "good", truth: "Sony WH-1000XM4", judge: { potential: true, confidence: "high", category: "headphones", fails: "always" }, vision: { identified: ["Sony WH-1000XM4"], matches: true }, why: "the text AI never gives a readable answer" },
  // ---- bad deals (must not be surfaced as deals)
  { id: "b1", title: "iPhone 13", price: 480, role: "bad", truth: "iPhone 13", judge: { potential: false, confidence: "high", category: "smartphone" }, vision: { identified: ["iPhone 13"], matches: true }, why: "overpriced" },
  { id: "b2", title: "Xbox Series S", price: 350, role: "bad", truth: "Xbox Series S", judge: { potential: false, confidence: "high", category: "console" }, vision: { identified: ["Xbox Series S"], matches: true }, why: "tracked item above its value" },
  { id: "b3", title: "Nintendo Switch OLED console", price: 300, role: "bad", truth: "Nintendo Switch OLED", judge: { potential: false, confidence: "high", category: "console" }, vision: { identified: ["Nintendo Switch OLED"], matches: true }, why: "tracked item above its value" },
  { id: "b4", title: "Meta Quest 2 128GB", price: 190, role: "bad", truth: "Meta Quest 2", judge: { potential: false, confidence: "high", category: "vr headset" }, vision: { identified: ["Meta Quest 2"], matches: true }, why: "overpriced" },
  { id: "b5", title: "Airpods pro 2", price: 170, role: "bad", truth: "AirPods Pro 2", judge: { potential: false, confidence: "high", category: "earbuds" }, vision: { identified: ["AirPods Pro 2"], matches: true }, why: "overpriced" },
  // ---- junk
  { id: "j1", title: "Zara Metallic Halter Neck Dress", price: 25, role: "junk", truth: null, judge: { potential: false, confidence: "medium", category: "clothing" }, vision: { identified: [] }, why: "clothing" },
  { id: "j2", title: "Marcus", price: 15, role: "junk", truth: null, judge: { potential: false, confidence: "low", category: "" }, vision: { identified: [] }, why: "one-word title, photos show nothing resalable" },
  { id: "j3", title: "Misc household items", price: 40, role: "junk", truth: null, judge: { potential: false, confidence: "low", category: "" }, vision: { identified: [] }, why: "vague, photos show nothing specific" },
  { id: "j4", title: "Old stuff", price: 30, role: "junk", truth: null, judge: { potential: false, confidence: "low", category: "" }, vision: { identified: [] }, why: "vague, a bag of cables" },
  { id: "j5", title: "Baby clothes bundle", price: 47, role: "junk", truth: null, judge: { potential: false, confidence: "medium", category: "clothing" }, vision: { identified: [] }, why: "clothing, price not a multiple of 5" },
  // ---- misleading titles
  { id: "m1", title: "PS5 console with controller", price: 200, role: "mislabel", truth: "DualSense Controller", judge: { potential: true, confidence: "high", category: "console" }, vision: { identified: ["DualSense Controller"], matches: false, mismatchReason: "only a DualSense controller is pictured, no console" }, why: "titled as a console, photos show only a controller" },
  { id: "m2", title: "Xbox Series X", price: 250, role: "mislabel", truth: "Xbox Series S", judge: { potential: true, confidence: "high", category: "console" }, vision: { identified: ["Xbox Series S"], matches: false, mismatchReason: "it is an Xbox Series S, not a Series X" }, why: "titled Series X, photos show a Series S" },
  { id: "m3", title: "Nintendo Switch OLED", price: 150, role: "mislabel", truth: null, judge: { potential: true, confidence: "high", category: "console" }, vision: { identified: [], matches: false, mismatchReason: "only a charging dock is pictured" }, why: "tracked item, photos show only an accessory" },
  // ---- cannot be told
  { id: "u1", title: "Console", price: 90, role: "uncertain", truth: null, judge: { potential: false, confidence: "low", category: "" }, vision: { identified: [], matches: null }, why: "blurry photos" },
  { id: "u2", title: "Laptop for sale", price: 200, role: "uncertain", truth: null, judge: { potential: false, confidence: "low", category: "laptop" }, vision: { identified: [], matches: null }, why: "dark photos, no model visible" },
  // ---- names the AI invents
  { id: "n1", title: "Phone charger lot", price: 40, role: "naming", truth: null, judge: { potential: false, confidence: "low", category: "" }, vision: { identified: ["Power Adapter", "Tempered glass screen protector"] }, why: "accessories only" },
  { id: "n2", title: "iPhone 13 128GB blue unlocked", price: 200, role: "naming", truth: "iPhone 13", judge: { potential: true, confidence: "high", category: "smartphone" }, vision: { identified: ["iPhone 13 128GB (front view)"], matches: true }, why: "a view description inside the name" },
  { id: "n3", title: "PS5 bundle with games", price: 230, role: "naming", truth: "PlayStation 5 Slim Digital Edition", judge: { potential: true, confidence: "high", category: "console" }, vision: { identified: ["Sony PlayStation 5 Slim Digital Edition (bundle includes two DualSense controllers and two games)"], matches: true }, why: "a whole sentence as a product name" },
  // ---- an ordinary price on a vague title (its own location visit, so the per-visit allowance is not what is being tested)
  { id: "g13", title: "Old console in box", price: 97, role: "good", truth: "Xbox Series S", judge: { potential: false, confidence: "low", category: "" }, vision: { identified: ["Xbox Series S"], matches: true }, why: "vague title AND a price that is not a multiple of 5: must still be opened and looked at" },
];

// ------------------------------------------------------------------------------------------------ the scripted AI
export interface AiCounters {
  judge: number;
  vision: number;
  identity: number;
  market: number;
  other: number;
  maxInFlight: number;
}

export interface Latencies {
  judge: number;
  vision: number;
  identity: number;
  market: number;
  detail: number;
  goBack: number;
}
export const DEFAULT_LATENCY: Latencies = { judge: 3000, vision: 14000, identity: 3000, market: 30000, detail: 4000, goBack: 1000 };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function marketValueFor(name: string | null | undefined): number | null {
  if (!name) return null;
  const n = norm(name);
  for (const [k, v] of Object.entries(MARKET)) if (n === norm(k) || n.includes(norm(k)) || norm(k).includes(n)) return v;
  return null;
}

export function installBrain(clock: VirtualClock, cases: BenchCase[], counters: AiCounters, latency: Latencies): void {
  const byTitle = new Map(cases.map((c) => [c.title, c]));
  const seenJudge = new Map<string, number>();
  let inFlight = 0;
  const enter = () => {
    inFlight++;
    counters.maxInFlight = Math.max(counters.maxInFlight, inFlight);
  };
  const leave = () => void inFlight--;
  const find = (text: string, re: RegExp): BenchCase | null => {
    const m = re.exec(text);
    return m ? (byTitle.get(m[1].trim()) ?? null) : null;
  };

  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (!u.includes("openai.com")) {
      // photo downloads: a tiny image; everything else (ntfy, ...) is accepted
      if (/^https:\/\/img\.test\//.test(u)) return new Response(new Uint8Array([255, 216, 255, 217]), { status: 200, headers: { "content-type": "image/jpeg" } });
      return new Response("ok", { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const content = body.messages?.[0]?.content;
    const text: string = typeof content === "string" ? content : String(content?.[0]?.text ?? "");
    const reply = (obj: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    enter();
    try {
      if (text.includes("does NOT match anything in the reseller's Search For list")) {
        counters.judge++;
        await clock.sleep(latency.judge);
        const c = find(text, /Listing title: (.*)\n/);
        if (!c) return reply({ isPotentialDeal: false, category: "", estimatedValueRangeUsd: "", confidence: "low", conditionImpact: "unknown", reasoning: "unknown listing", offTopicSuggestion: null });
        const n = (seenJudge.get(c.id) ?? 0) + 1;
        seenJudge.set(c.id, n);
        if (c.judge.fails === "always" || (c.judge.fails === "first" && n === 1)) return new Response(JSON.stringify({ choices: [{ message: { content: "I think this is… (not json" } }] }), { status: 200, headers: { "content-type": "application/json" } });
        return reply({
          isPotentialDeal: c.judge.potential,
          category: c.judge.category,
          estimatedValueRangeUsd: c.judge.potential ? "200-300" : "",
          confidence: c.judge.confidence,
          conditionImpact: "none",
          reasoning: c.judge.potential ? `Priced well under what ${c.truth ?? "this"} sells for.` : c.judge.category ? `Not a deal at $${c.price}.` : "Can't tell what this is from the text.",
          offTopicSuggestion: null,
        });
      }
      if (text.includes("numbered 1 to")) {
        counters.vision++;
        await clock.sleep(latency.vision);
        const c = find(text, /titled "(.*?)", asking price/);
        const claimed = /supposed to be a "(.*?)"/.exec(text)?.[1] ?? null;
        if (!c) return reply({ summary: "A photo.", identifiedProducts: [], matchesClaim: null });
        const v = c.vision;
        let matches: boolean | null = claimed ? (v.matches === undefined ? true : v.matches) : null;
        if (claimed && v.matches === undefined && v.identified.length === 0) matches = null;
        return reply({
          summary: v.identified.length ? `Photos show: ${v.identified.join(", ")}.` : "Photos are unclear; nothing can be identified with confidence.",
          expertTake: "Looks interesting.",
          identifiedProducts: v.identified,
          photoAttribution: [],
          hasValuableBundle: false,
          bundleDescription: "",
          bundleEstimatedValueUsd: null,
          matchesClaim: matches,
          mismatchReason: matches === false ? (v.mismatchReason ?? "something different") : "",
          matchedKnownProduct: null,
          bestTitleMatchPhotoNumber: 1,
        });
      }
      if (text.includes("A reseller keeps a product Database")) {
        counters.identity++;
        await clock.sleep(latency.identity);
        return reply({ decision: "generic", matchId: null, confidence: "high", specificName: null, reason: "just the general product" });
      }
      counters.other++;
      await clock.sleep(1000);
      return reply({});
    } finally {
      leave();
    }
  }) as typeof fetch;
}

// ------------------------------------------------------------------------------------------------ the run
export interface Filing {
  at: number;
  title: string | null;
  product: string;
  kind: "new" | "photo";
}

export interface JobSpan {
  id: string;
  enqueuedAt: number;
  start: number;
  end: number;
}

export interface BenchOptions {
  lowAiMode: boolean;
  // merged over the engine config (e.g. { discovery: { speculativeLooksPerLocation: 0 } })
  config?: Record<string, unknown>;
  latency?: Partial<Latencies>;
  // Several listings arrive back to back (a busy location) when true; otherwise one location of eight at a time.
  locations?: number;
}

export interface CaseOutcome {
  id: string;
  role: Role;
  title: string;
  price: number;
  opened: boolean; // the detail page was loaded
  visionCalls: number;
  surfaced: boolean; // deal, negotiation or worth a look
  isDeal: boolean;
  status: string | null;
  identified: string[]; // filed into / reinforced in the Database
  researchStatus: string | null; // only present in versions that record it
  researchCode: string | null;
  reasoning: string;
}

export interface BenchResult {
  options: BenchOptions;
  outcomes: CaseOutcome[];
  ai: AiCounters;
  spendUsd: number;
  filings: Filing[];
  jobs: JobSpan[];
  scanSpanMs: number;
  drainSpanMs: number;
  totalMs: number;
}

class BenchEngine extends ScrapeEngine {
  details = new Map<string, ListingDetail>();
  opened = new Set<string>();
  latencyMs = 4000;
  protected override async loadListingDetail(_page: Page, listing: ListingSummary): Promise<ListingDetail> {
    this.opened.add(listing.id);
    await new Promise((r) => setTimeout(r, this.latencyMs));
    const d = this.details.get(listing.id);
    if (!d) throw new Error("no detail for " + listing.id);
    return d;
  }
}

function buildDetail(c: BenchCase): ListingDetail {
  return {
    id: c.id,
    title: c.title,
    price: c.price,
    url: `https://example.com/${c.id}`,
    thumbnailUrl: null,
    locationText: "Dover, DE",
    description: "Works great.",
    shippingMentioned: false,
    imageUrls: [`https://img.test/${c.id}/1.jpg`, `https://img.test/${c.id}/2.jpg`],
    hasVideo: false,
    hasOfficialShipping: false,
    mentionsEbay: false,
    seller: { joinedFacebookYear: 2015, rating: null, ratingCount: null, hasProfilePhoto: true, name: "seller" },
    listingAge: "2 hours ago",
    source: "facebook",
    ebayShippingUsd: null,
  } as unknown as ListingDetail;
}

export async function runBench(opts: BenchOptions, cases: BenchCase[] = CORPUS): Promise<BenchResult> {
  const clock = new VirtualClock();
  clock.install();
  const savedFetch = globalThis.fetch;
  try {
    const latency: Latencies = { ...DEFAULT_LATENCY, ...(opts.latency ?? {}) };
    const counters: AiCounters = { judge: 0, vision: 0, identity: 0, market: 0, other: 0, maxInFlight: 0 };
    installBrain(clock, cases, counters, latency);

    // ---- a small fake Database
    const db = new Map<string, { id: string; name: string }>();
    for (const n of ["Xbox Series S", "Xbox Series X", "iPhone 13", "Nintendo Switch OLED"]) db.set(norm(n), { id: "db-" + norm(n).replace(/ /g, "-"), name: n });
    const checked = new Set<string>(["xbox series s", "xbox series x", "iphone 13", "nintendo switch oled"]);
    const filings: Filing[] = [];
    const lookup = (name: string | null) => {
      if (!name) return null;
      const n = norm(name);
      if (db.has(n)) return db.get(n)!;
      for (const [k, v] of db) if (n === k) return v;
      return null;
    };
    const fake = makeStore({
      findMatchingProduct: (name: string) => lookup(name),
      getProductById: (id: string) => [...db.values()].find((p) => p.id === id) ?? null,
      listProductsWithImages: () => [],
      listPrioritizedProductsWithImages: () => [],
      listProductChildren: () => [],
      listProductsSharingBase: () => [],
      listProductPhotoTitles: () => [],
      credibleCodes: () => [],
      listProductImages: () => [],
      addProductImage: (id: string, _img: string, title: string | null) => {
        const p = [...db.values()].find((x) => x.id === id);
        if (p) filings.push({ at: Date.now(), title, product: p.name, kind: "photo" });
      },
      appendProductObservation: () => null,
      recordProductObservation: () => null,
      updatePhotoAnalysis: () => undefined,
      getById: () => null,
      // what the Database already knows an eBay value for: the products a market check has priced so far
      getEbayValueForProductName: (name: string) => {
        const n = norm(name);
        const k = [...checked].find((c) => n === c || n.includes(c) || c.includes(n));
        return k ? marketValueFor(k) : null;
      },
      getEbayValueForTitle: (title: string) => {
        const h = norm(title);
        const k = [...checked].filter((c) => h.includes(c)).sort((a, b) => b.length - a.length)[0];
        return k && marketValueFor(k) !== null ? { name: k, value: marketValueFor(k)! } : null;
      },
      getProductSignals: (matched: string | null, title: string) => {
        const name = [matched, title].find((x) => x && checked.has(norm(x)) && marketValueFor(x) !== null) ?? [...checked].find((k) => norm(title).includes(k));
        const key = name ? norm(name) : null;
        const v = key ? marketValueFor(key) : null;
        if (!key || v === null) return null;
        return { id: "sig-" + key, name: key, valueUsd: v, runTimeDays: 3, compSample: 8, checkedAt: Date.now() - 86_400_000, basis: "sold" as const };
      },
    });
    const config = baseConfig({
      lowAiMode: opts.lowAiMode,
      photoAnalysis: { enabled: true },
      generalDeal: { enabled: true, minConfidence: "medium" },
      autoResearchListings: true,
      searchItems: [searchItem("Xbox Series S", 260), searchItem("Nintendo Switch OLED", 270)],
      ...(opts.config ?? {}),
    });
    // the config module reads lowAiMode through a registered source in the real app; do the same here
    const aiMode = await import("../aiMode.js");
    aiMode.registerLowAiModeSource(() => opts.lowAiMode);

    const logs: Array<{ ts: number; level: string; message: string }> = [];
    const jobs: JobSpan[] = [];
    const enqueuedAt = new Map<string, number>();
    const checkMarket = async (l: { title: string; matchedItem: string | null; identityTexts?: string[] }) => {
      const name = [l.matchedItem, ...(l.identityTexts ?? []), l.title].find((x) => marketValueFor(x) !== null) ?? null;
      // like the real market check, a product that was priced recently is answered from the Database without asking WatchCount/eBay again
      if (!(name && checked.has(norm(name)))) {
        counters.market++;
        await clock.sleep(latency.market);
      }
      const value = marketValueFor(name);
      if (name && value !== null) checked.add(norm(name));
      return { productId: name ? "db-" + norm(name).replace(/ /g, "-") : null, productName: name, valueUsd: value, refreshed: true, note: "" };
    };
    const engine = new BenchEngine({
      store: fake.proxy,
      profileDir: "x",
      getConfig: () => config,
      onLog: (l: any) => void logs.push({ ts: Date.now(), level: l.level, message: l.message }),
      onListing: () => {},
      onNarrate: async () => {},
      onBlacklistUpdated: () => {},
      onBlacklistImagesUpdated: () => {},
      onProductUpdated: () => {},
      onNewProductFound: (name: string, _img: string | null, sourceTitle: string) => {
        if (!db.has(norm(name))) db.set(norm(name), { id: "db-" + norm(name).replace(/ /g, "-"), name });
        filings.push({ at: Date.now(), title: sourceTitle, product: name, kind: "new" });
      },
      onStatus: () => {},
      onWatchMatch: () => {},
      checkMarket,
    } as any);
    engine.latencyMs = latency.detail;
    for (const c of cases) engine.details.set(c.id, buildDetail(c));

    // time each listing's research job (the vision-dependent tail of the pipeline)
    const origTail = (engine as any).runPostScoringPipeline.bind(engine);
    (engine as any).runPostScoringPipeline = async (listing: { id: string }, ...rest: unknown[]) => {
      const start = Date.now();
      try {
        return await origTail(listing, ...rest);
      } finally {
        jobs.push({ id: listing.id, enqueuedAt: enqueuedAt.get(listing.id) ?? start, start, end: Date.now() });
      }
    };

    const perLocation = 8;
    const t0 = Date.now();
    let scanEnd = t0;
    const scan = async () => {
      for (let i = 0; i < cases.length; i++) {
        if (i % perLocation === 0) (engine as any).beginLocationVisit?.(); // newer versions reset their per-visit budgets here
        if (i % perLocation === 0) (engine as any).imageMatchAttemptsThisLocation = 0;
        const c = cases[i];
        const summary = { id: c.id, title: c.title, price: c.price, url: `https://example.com/${c.id}`, thumbnailUrl: null, locationText: "Dover, DE" } as ListingSummary;
        enqueuedAt.set(c.id, Date.now());
        const res = await (engine as any).evaluateListing(FAKE_PAGE, summary, config);
        enqueuedAt.set(c.id, Date.now());
        if (res?.visitedDetailPage) await clock.sleep(latency.goBack);
      }
      scanEnd = Date.now();
    };
    await clock.run(scan());
    await clock.until(() => {
      const q = (engine as any).visionJobs as unknown[];
      return (q?.length ?? 0) === 0 && ((engine as any).visionWorkersActive ?? 0) === 0;
    });
    const t1 = Date.now();

    // ---- outcomes
    const last = new Map<string, ScoredListing>();
    for (const s of fake.saved) last.set(s.listing.id, s);
    const outcomes: CaseOutcome[] = cases.map((c) => {
      const s = last.get(c.id);
      const status = s?.gate?.status ?? null;
      const surfaced = !!s && (s.isDeal || status === "profitable_now" || status === "negotiation" || status === "worth_a_look");
      const mine = filings.filter((f) => f.title === c.title);
      return {
        id: c.id,
        role: c.role,
        title: c.title,
        price: c.price,
        opened: engine.opened.has(c.id),
        visionCalls: 0,
        surfaced,
        isDeal: !!s?.isDeal,
        status,
        identified: [...new Set([...(s?.extraction.matchedItem ? [s.extraction.matchedItem] : []), ...mine.map((f) => f.product)])],
        researchStatus: (s as any)?.research?.status ?? null,
        researchCode: (s as any)?.research?.code ?? null,
        reasoning: s?.extraction.reasoning ?? "(never saved)",
      };
    });
    // photo looks per listing = the vision calls the scripted AI answered for its title
    for (const l of logs) {
      const m = /^Analyzing \d+ photo\(s\) for "(.*)"\.\.\.$/.exec(l.message);
      if (m) {
        const o = outcomes.find((x) => x.title === m[1]);
        if (o) o.visionCalls++;
      }
    }
    const spendUsd = counters.judge * 0.0005 + counters.vision * 0.01 + counters.identity * 0.002 + counters.market * 0.004 + counters.other * 0.001;
    return { options: opts, outcomes, ai: counters, spendUsd, filings, jobs, scanSpanMs: scanEnd - t0, drainSpanMs: t1 - scanEnd, totalMs: t1 - t0 };
  } finally {
    clock.restore();
    globalThis.fetch = savedFetch;
  }
}

// ------------------------------------------------------------------------------------------------ scoring
const CANON_BAD = /\(|\)|\bview\b|\badapter\b|\bscreen protector\b|\bbundle\b|\bincludes?\b/i;
export function isBadName(name: string): boolean {
  return CANON_BAD.test(name) || name.split(/\s+/).length > 10;
}

export interface BenchScore {
  profitable: number;
  surfacedProfitable: number;
  recall: number;
  openedProfitable: number;
  researchedProfitable: number;
  falseDeals: number; // a bad / mislabelled / junk / uncertain listing that was surfaced as a deal or a worth-a-look
  falseDealDetail: string[];
  wrongProductFilings: number;
  badNameFilings: number;
  filingDetail: string[];
  identifiedCorrectly: number;
  identifiable: number;
  insufficientButUnlabelled: number;
  avgListingToResearchedS: number;
  p95ListingToResearchedS: number;
  avgQueueWaitS: number;
  maxQueueWaitS: number;
  avgGapBetweenJobsS: number;
  maxGapBetweenJobsS: number;
  jobsPerHour: number;
  totalMin: number;
  scanMin: number;
  drainMin: number;
  spendUsd: number;
}

// Ground truth: would buying this listing and reselling the product it REALLY is make the user's minimum margin?
// (eBay keeps 16%; the user wants 20% on what they paid.) A mislabelled listing is judged by what the photos really show.
export function isProfitable(c: BenchCase): boolean {
  const value = marketValueFor(c.truth);
  if (value === null || c.role === "mislabel" || c.role === "bad" || c.role === "junk" || c.role === "uncertain") return false;
  return value * 0.84 - c.price >= c.price * 0.2;
}

export function score(r: BenchResult, cases: BenchCase[] = CORPUS): BenchScore {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const prof = r.outcomes.filter((o) => isProfitable(byId.get(o.id)!));
  const falseDealOutcomes = r.outcomes.filter((o) => !isProfitable(byId.get(o.id)!) && o.surfaced && (o.role === "mislabel" || o.isDeal || o.status === "profitable_now" || o.status === "negotiation"));
  const wrong: string[] = [];
  const bad: string[] = [];
  for (const f of r.filings) {
    const c = cases.find((x) => x.title === f.title);
    if (isBadName(f.product)) {
      bad.push(`${f.product} <- ${f.title}`);
      continue;
    }
    if (c && c.truth && norm(f.product) !== norm(c.truth) && !norm(c.truth).includes(norm(f.product)) && !norm(f.product).includes(norm(c.truth))) wrong.push(`${f.product} <- "${f.title}" (really ${c.truth})`);
    if (c && !c.truth) wrong.push(`${f.product} <- "${f.title}" (nothing resalable)`);
  }
  const identifiable = cases.filter((c) => c.role === "good" || c.role === "bad" || (c.role === "naming" && c.truth));
  const identifiedCorrectly = r.outcomes.filter((o) => {
    const c = byId.get(o.id)!;
    return identifiable.includes(c) && c.truth && o.identified.some((n) => norm(n).includes(norm(c.truth!)) || norm(c.truth!).includes(norm(n)));
  }).length;
  // listing seen -> its research finished
  const lat: number[] = [];
  const waits: number[] = [];
  for (const j of r.jobs) {
    lat.push((j.end - j.enqueuedAt) / 1000);
    waits.push(Math.max(0, (j.start - j.enqueuedAt) / 1000));
  }
  lat.sort((a, b) => a - b);
  const sortedJobs = [...r.jobs].sort((a, b) => a.end - b.end);
  const gaps: number[] = [];
  for (let i = 1; i < sortedJobs.length; i++) gaps.push((sortedJobs[i].end - sortedJobs[i - 1].end) / 1000);
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  // Listings that ended up with no deal and nothing saying whether Clynx never looked, could not tell, or decided against it.
  const insufficient = r.outcomes.filter((o) => !o.surfaced && !o.researchStatus).length;
  return {
    profitable: prof.length,
    surfacedProfitable: prof.filter((o) => o.surfaced).length,
    recall: prof.length ? prof.filter((o) => o.surfaced).length / prof.length : 0,
    openedProfitable: prof.filter((o) => o.opened).length,
    researchedProfitable: prof.filter((o) => o.visionCalls > 0 || o.surfaced).length,
    falseDeals: falseDealOutcomes.length,
    falseDealDetail: falseDealOutcomes.map((o) => `${o.title} $${o.price} [${o.role}] -> ${o.status ?? (o.isDeal ? "deal" : "?")}`),
    wrongProductFilings: wrong.length,
    badNameFilings: bad.length,
    filingDetail: [...wrong.map((w) => "WRONG " + w), ...bad.map((b) => "BADNAME " + b)],
    identifiedCorrectly,
    identifiable: identifiable.filter((c) => c.truth).length,
    insufficientButUnlabelled: insufficient,
    avgListingToResearchedS: avg(lat),
    p95ListingToResearchedS: lat.length ? lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)] : 0,
    avgQueueWaitS: avg(waits),
    maxQueueWaitS: waits.length ? Math.max(...waits) : 0,
    avgGapBetweenJobsS: avg(gaps),
    maxGapBetweenJobsS: gaps.length ? Math.max(...gaps) : 0,
    jobsPerHour: r.totalMs > 0 ? (r.jobs.length / r.totalMs) * 3_600_000 : 0,
    totalMin: r.totalMs / 60000,
    scanMin: r.scanSpanMs / 60000,
    drainMin: r.drainSpanMs / 60000,
    spendUsd: r.spendUsd,
  };
}
