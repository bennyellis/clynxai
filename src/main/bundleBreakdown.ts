// Listings that hold several products ("PS5 Pro with 2 controllers and a 2TB external hard drive").
//
// Clynx doesn't research that whole sentence as if it were one product. It breaks the listing down into its items, finds what each
// one sells for on its own, and only then values the lot. The lot is NOT the sum of its parts: the main item is the focal point
// (a console with two controllers and a drive sells for a little more than the console alone, not for the console plus the full
// price of everything), extras add part of what they'd fetch alone with diminishing returns, and items that are slow or awkward to
// sell (a used monitor) are left out of the bundle altogether: the bundle is built from the things most likely to sell.
import { callOpenAI, ensureOpenAIAccess, OPENAI_MODEL } from "./openai.js";
import { mentionsExtras } from "./profitGate.js";

export type Sellability = "easy" | "moderate" | "hard";

export interface BundleItem {
  // A specific, searchable product name (eBay-style): "PlayStation 5 DualSense wireless controller".
  name: string;
  quantity: number;
  // "main": what the listing is mainly about. "accessory": made to go with the main item (controllers, cables, a case).
  // "extra": a product that is worth something on its own (a hard drive, a game, a headset).
  role: "main" | "accessory" | "extra";
  sellability: Sellability;
  // The model's rough used price per unit, used only when the real lookup finds nothing.
  guessUsd: number | null;
}

export interface BundleBreakdown {
  items: BundleItem[];
}

/** Does the listing's wording suggest more than one product? (A cheap check, so single-item listings never cost an AI call.) */
export function looksLikeBundle(text: string): boolean {
  return mentionsExtras(text) || /\bw\/(?!o)|&|\band (a|an|the|\d|two|three|four)\b/i.test(text);
}

// ---------- breaking a listing down (one small text-only AI call, remembered per listing)

const cache = new Map<string, BundleBreakdown | null>();
const CACHE_LIMIT = 300;
const MAX_ITEMS = 6;

function cacheKey(title: string, description: string): string {
  return `${title.trim().toLowerCase()}|${description.trim().toLowerCase().slice(0, 300)}`;
}

function asSellability(v: unknown): Sellability {
  return v === "easy" || v === "hard" ? v : "moderate";
}

/** Reads the model's answer into clean items: exactly one main item, sane quantities, nothing nameless. Null when it isn't usable. */
export function parseBreakdown(raw: unknown): BundleBreakdown | null {
  const list = (raw as { items?: unknown })?.items;
  if (!Array.isArray(list)) return null;
  const items: BundleItem[] = [];
  for (const entry of list.slice(0, MAX_ITEMS)) {
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!name) continue;
    const q = Math.round(Number(e.quantity));
    const guess = Number(e.guessUsd);
    items.push({
      name,
      quantity: Number.isFinite(q) ? Math.min(10, Math.max(1, q)) : 1,
      role: e.role === "main" || e.role === "accessory" ? e.role : "extra",
      sellability: asSellability(e.sellability),
      guessUsd: Number.isFinite(guess) && guess > 0 ? Math.round(guess) : null,
    });
  }
  if (items.length === 0) return null;
  // Exactly one main item: the first one the model marked, else the one with the highest guess, else the first.
  const firstMain = items.findIndex((i) => i.role === "main");
  let mainIndex = firstMain;
  if (mainIndex < 0) {
    mainIndex = items.reduce((best, item, idx) => ((item.guessUsd ?? 0) > (items[best].guessUsd ?? 0) ? idx : best), 0);
  }
  return { items: items.map((item, idx) => (idx === mainIndex ? { ...item, role: "main" as const } : item.role === "main" ? { ...item, role: "extra" as const } : item)) };
}

export async function breakDownListing(title: string, description: string): Promise<BundleBreakdown | null> {
  const key = cacheKey(title, description);
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    ensureOpenAIAccess();
  } catch {
    return null;
  }
  const prompt = `A reseller is looking at one Facebook Marketplace listing. Break it down into the separate products the ASKING PRICE INCLUDES.

Listing title: "${title}"
Listing text: "${description.trim().slice(0, 900) || "(none)"}"

Rules:
- One entry per distinct product that comes with the price. Leave out anything the seller sells separately, wants extra for, or says is NOT included.
- Exactly one entry has role "main": the product the listing is mainly about (usually what the title leads with, the most valuable item).
- "name": a specific product name as it would appear on eBay ("PlayStation 5 DualSense wireless controller", "2TB portable external hard drive"), without condition words or quantities.
- "quantity": how many of it come with the listing (integer).
- "role": "accessory" for things made to go with the main item (controllers, cables, chargers, a case, a dock), "extra" for products worth something on their own (a hard drive, a game, a headset, a monitor).
- "sellability": "hard" for bulky, fragile or low-demand used items that are slow to sell or costly to ship (monitors, TVs, printers, furniture, speakers), "easy" for small items that are in demand and ship easily, otherwise "moderate".
- "guessUsd": your rough typical USED resale price for ONE of it in whole US dollars, or null if you can't say.
- At most ${MAX_ITEMS} entries. If the listing is just one product, return just that one as "main".

Respond with ONLY a JSON object: { "items": [ { "name": string, "quantity": number, "role": "main" | "accessory" | "extra", "sellability": "easy" | "moderate" | "hard", "guessUsd": number | null } ] }`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await callOpenAI(
      "chat",
      { model: OPENAI_MODEL, messages: [{ role: "user", content: prompt }], max_completion_tokens: 700, reasoning_effort: "minimal", response_format: { type: "json_object" } },
      controller.signal
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    const parsed = text.trim() ? parseBreakdown(JSON.parse(text)) : null;
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(key, parsed);
    return parsed;
  } catch {
    return null; // not remembered: a hiccup shouldn't stick
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- valuing the lot

export interface PricedBundleItem {
  item: BundleItem;
  // What ONE of it sells for on its own (null: nothing found, and no estimate).
  unitValueUsd: number | null;
  // How long the Database says it takes to sell (null: unknown).
  runTimeDays: number | null;
  // The price is the model's rough guess, not a lookup.
  estimated?: boolean;
}

export interface BundleLine {
  name: string;
  quantity: number;
  unitValueUsd: number | null;
  // What this line adds to the lot's value (the focal item: its full value).
  countedUsd: number;
  status: "main" | "counted" | "left out" | "no price";
  note: string;
  estimated: boolean;
}

export interface BundleValuation {
  mainName: string;
  mainValueUsd: number;
  // What the extras add to the main item's value, after the discounts below.
  upliftUsd: number;
  totalValueUsd: number;
  // What the lot is worth beyond the main item as it was passed in (the same as upliftUsd unless something else took over as focal).
  addedUsd: number;
  // What simply adding everything up would have said (shown so the difference is visible; never used).
  naiveSumUsd: number;
  lines: BundleLine[];
  summary: string;
}

// How much of an extra's standalone price it adds to the bundle: things made for the main item are worth a bit more to the buyer.
export const ACCESSORY_WEIGHT = 0.55;
export const EXTRA_WEIGHT = 0.45;
// A second, third... unit of the same thing adds half as much as the first (a buyer needs one controller; more is a bonus).
export const ADDITIONAL_UNIT_FACTOR = 0.5;
// The extras can lift the lot by roughly this share of the focal item at most (soft: it flattens out towards it), or by half of what
// they add up to, whichever is more, so a lot with no dominant item isn't squashed.
export const UPLIFT_CAP_OF_FOCAL = 0.3;
export const UPLIFT_CAP_OF_RAW = 0.5;
// Items that take this long to sell are left out of the bundle.
export const SLOW_SELLER_DAYS = 14;
// A bigger item than the "main" one (by this factor) takes over as the focal point.
const TAKEOVER_FACTOR = 1.25;

const BULKY = /\b(monitors?|tvs?|televisions?|printers?|projectors?|crt|furniture|desks?|chairs?|treadmills?|speakers?|subwoofers?)\b/i;

const money = (n: number) => `$${Math.round(n)}`;

function whyHard(p: PricedBundleItem): string | null {
  if (p.item.sellability === "hard" || BULKY.test(p.item.name)) return "bulky or slow to sell";
  if (p.runTimeDays !== null && p.runTimeDays >= SLOW_SELLER_DAYS) return `slow to sell (about ${Math.round(p.runTimeDays)} days)`;
  return null;
}

function unitText(line: { quantity: number; unitValueUsd: number | null; estimated: boolean }): string {
  if (line.unitValueUsd === null) return "";
  return `~${money(line.unitValueUsd)}${line.quantity > 1 ? " each" : ""}${line.estimated ? ", estimated" : ""}`;
}

function describeList(lines: BundleLine[]): string {
  return lines.map((l) => `${l.quantity > 1 ? `${l.quantity} x ` : ""}${l.name} (${unitText(l)})`).join(", ");
}

export function valueBundle(args: { main: BundleItem; mainValueUsd: number; extras: PricedBundleItem[] }): BundleValuation {
  const mainValue = Math.max(0, args.mainValueUsd);
  const lines: BundleLine[] = [];

  // Something worth clearly more than the "main" item takes over as the focal point.
  const eligible = args.extras.filter((e) => e.unitValueUsd !== null && !whyHard(e));
  const bigger = eligible.reduce<PricedBundleItem | null>((best, e) => ((e.unitValueUsd ?? 0) > (best?.unitValueUsd ?? 0) ? e : best), null);
  const takeover = bigger && (bigger.unitValueUsd ?? 0) > mainValue * TAKEOVER_FACTOR ? bigger : null;
  const focalValue = takeover ? (takeover.unitValueUsd as number) : mainValue;
  const focalName = takeover ? takeover.item.name : args.main.name;

  lines.push({ name: focalName, quantity: takeover ? takeover.item.quantity : args.main.quantity, unitValueUsd: focalValue, countedUsd: focalValue, status: "main", note: "the main item", estimated: !!takeover?.estimated });

  // The others, in the order they were found. The old main item becomes an accessory-weight extra if something took over.
  const others: PricedBundleItem[] = args.extras.filter((e) => e !== takeover);
  if (takeover) others.unshift({ item: { ...args.main, role: "accessory" }, unitValueUsd: mainValue, runTimeDays: null });

  let raw = 0;
  let naive = focalValue;
  const counted: BundleLine[] = [];
  const leftOut: BundleLine[] = [];
  for (const p of others) {
    const base = { name: p.item.name, quantity: p.item.quantity, unitValueUsd: p.unitValueUsd, estimated: !!p.estimated };
    if (p.unitValueUsd === null) {
      lines.push({ ...base, countedUsd: 0, status: "no price", note: "no price found, so it adds nothing" });
      continue;
    }
    naive += p.unitValueUsd * p.item.quantity;
    const hard = whyHard(p);
    if (hard) {
      const line: BundleLine = { ...base, countedUsd: 0, status: "left out", note: `${hard}, so I left it out of the bundle` };
      leftOut.push(line);
      lines.push(line);
      continue;
    }
    const weight = p.item.role === "accessory" ? ACCESSORY_WEIGHT : EXTRA_WEIGHT;
    const adds = p.unitValueUsd * weight * (1 + ADDITIONAL_UNIT_FACTOR * (p.item.quantity - 1));
    raw += adds;
    const line: BundleLine = { ...base, countedUsd: adds, status: "counted", note: `adds about ${money(adds)} as part of the lot` };
    counted.push(line);
    lines.push(line);
  }

  // Diminishing returns: the more the extras pile up, the less each adds, flattening out towards a cap tied to the focal item.
  const cap = Math.max(focalValue * UPLIFT_CAP_OF_FOCAL, raw * UPLIFT_CAP_OF_RAW);
  const uplift = raw > 0 && cap > 0 ? Math.round(cap * (1 - Math.exp(-raw / cap))) : 0;
  const total = Math.round(focalValue + uplift);

  // Spread the (smaller) uplift back over the counted lines so the numbers shown add up to it.
  if (raw > 0) for (const l of counted) l.countedUsd = (l.countedUsd / raw) * uplift;

  const parts: string[] = [`${focalName} (${money(focalValue)} on its own) is the main item`];
  if (counted.length) {
    const standalone = counted.reduce((sum, l) => sum + (l.unitValueUsd as number) * l.quantity, 0);
    parts.push(`${describeList(counted)} add about ${money(uplift)} together, not the ${money(standalone)} they'd fetch separately`);
  }
  if (leftOut.length) parts.push(`left out of the bundle: ${leftOut.map((l) => `${l.name} (${l.note.split(",")[0]})`).join(", ")}`);
  const unpriced = lines.filter((l) => l.status === "no price");
  if (unpriced.length) parts.push(`no price found for ${unpriced.map((l) => l.name).join(", ")}`);

  return {
    mainName: focalName,
    mainValueUsd: Math.round(focalValue),
    upliftUsd: uplift,
    totalValueUsd: total,
    addedUsd: Math.round(total - mainValue),
    naiveSumUsd: Math.round(naive),
    lines,
    summary: parts.join("; "),
  };
}
