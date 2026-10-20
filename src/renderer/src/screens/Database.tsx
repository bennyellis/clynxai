import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BlacklistedImage, BlacklistTerm, ChatAttachment, ChatChoice, ChatChoiceOption, ChatContext, ChatMessage, ProductImage, ProductProfile } from "../lib/api.js";
import { AttachButton, AttachmentBar, ChatChoiceButtons, ChatStatusLine, useImageIntake } from "../components/ChatExtras.js";
import { ClynxAvatar, YouLabel } from "../components/ChatAvatar.js";
import { attachmentHistoryNote } from "../lib/chatAttachments.js";
import { dismissAllChoices, dismissChoice, forgetSteps } from "../lib/chatExtras.js";
import { api } from "../lib/api.js";
import { Modal } from "../components/Modal.js";
import { useLightbox } from "../components/ImageLightbox.js";
import { ThumbnailSizeSlider, useThumbnailSize } from "../components/ThumbnailSize.js";
import { WatchFormFlow } from "../components/WatchFormFlow.js";
import { AddonsSection } from "../components/AddonsSection.js";
import { VariantsFoundSection } from "../components/VariantsFoundSection.js";
import { DiscoveryTab, resetDiscoveryUi } from "./DiscoveryTab.js";
import { ReviewTab } from "./ReviewTab.js";
import { keepRangeUsd } from "../../../main/resaleMath.js";
import { imageSource } from "../lib/imageSource.js";
import { AutoFolderMenu, folderLabel, folderMetaFor, pictureNote, useFolderMeta, type FolderMeta } from "../components/AutoFolderTools.js";
import { FolderDialog, LibraryNote, MY_FOLDERS, NeedsReviewPanel, OrganizeCard, PhotoActions, TrashPanel, doLibraryOp, folderPaths, statusBadge, type LibraryFolder } from "../components/LibraryTools.js";
import {
  homeDatabaseNav,
  libraryRootNav,
  readSavedDatabaseNav,
  validateDatabaseNav,
  writeSavedDatabaseNav,
  type DatabaseNav,
  type DatabaseTabId,
  type LibrarySortId,
} from "../lib/navState.js";

// Per explicit instruction — the Database screen is now three clearly
// separated sections instead of one long scrolling page: Discovery (a live
// feed of what Clynx is researching), Library (researched products already in the Database),
// and Blacklist (both the term list and the image gallery). Local to this
// component, not App.tsx's own screen routing, and survives a switch away
// to another top-level screen and back the same way every other bit of
// this screen's own state already does (Database itself never unmounts —
// see App.tsx).
type DatabaseTab = DatabaseTabId;

// Mirrors chat.ts's PRODUCT_CATEGORIES — only used here to pick a stable,
// sensible display order for section headers (real grouping just uses
// whatever category string the product actually has), so this drifting out
// of sync with the backend list would just reorder sections, never break
// anything.
const CATEGORY_ORDER = [
  "Video Games & Consoles",
  "Phones & Tablets",
  "Computers & Laptops",
  "TVs & Electronics",
  "Cameras",
  "Audio & Headphones",
  "Tools & Equipment",
  "Furniture",
  "Appliances",
  "Sporting Goods & Outdoors",
  "Bikes & Scooters",
  "Clothing & Accessories",
  "Pet Supplies",
  "Toys & Games",
  "Collectibles",
  "Musical Instruments",
  "Other",
];

interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  streaming?: boolean;
  error?: boolean;
  // Beta 13: photos attached to this message (the model's history keeps a short note instead of the pixels).
  attachments?: ChatAttachment[];
}

// Per explicit instruction — a product's family (see types.ts's
// ProductProfile.family) can be a multi-level path like "Xbox > Games >
// Xbox 360", not just a single flat name — this builds that into a real
// tree per category so the UI can nest a "Games" folder inside "Xbox," and
// a per-generation folder inside THAT, however deep the AI actually made
// it for a given product line. `items` on a node are products whose family
// path ends EXACTLY there (e.g. the Xbox console/controllers sit directly
// on the "Xbox" node, not inside "Games"); `children` are its sub-folders.
interface FamilyNode {
  segment: string; // this node's own label, e.g. "Games" or "Xbox 360"
  path: string; // full path from the category root, e.g. "Xbox > Games > Xbox 360"
  items: ProductProfile[];
  children: FamilyNode[];
}

// pathOf: where a product sits (its auto-organized family, or its own folder path for "My folders"). extraPaths: folders to show even when empty.
function buildFamilyTree(products: ProductProfile[], pathOf: (p: ProductProfile) => string | null | undefined = (p) => p.family, extraPaths: string[] = []): FamilyNode[] {
  const roots: FamilyNode[] = [];
  const ensure = (path: string): FamilyNode | undefined => {
    const segments = path.split(">").map((s) => s.trim()).filter(Boolean);
    let level = roots;
    let parentPath = "";
    let node: FamilyNode | undefined;
    for (const segment of segments) {
      node = level.find((n) => n.segment === segment);
      if (!node) {
        node = { segment, path: parentPath ? `${parentPath} > ${segment}` : segment, items: [], children: [] };
        level.push(node);
      }
      parentPath = node.path;
      level = node.children;
    }
    return node;
  };
  for (const extra of extraPaths) ensure(extra);
  for (const p of products) {
    const familyPath = pathOf(p);
    if (!familyPath) continue;
    const segments = familyPath
      .split(">")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!segments.length) continue;
    let level = roots;
    let parentPath = "";
    let node: FamilyNode | undefined;
    for (const segment of segments) {
      node = level.find((n) => n.segment === segment);
      if (!node) {
        node = { segment, path: parentPath ? `${parentPath} > ${segment}` : segment, items: [], children: [] };
        level.push(node);
      }
      parentPath = node.path;
      level = node.children;
    }
    node!.items.push(p);
  }
  const sortTree = (nodes: FamilyNode[]) => {
    nodes.sort((a, b) => a.segment.localeCompare(b.segment));
    for (const n of nodes) sortTree(n.children);
  };
  sortTree(roots);
  return roots;
}

// Per explicit instruction — "for variants/special editions of products, in
// the original Library listing, include these variants... clicked on and
// reveal information like avg sales price, sales speed, and reference
// photos, just like the original Library listing." Deliberately its OWN
// word list, separate from scorer.ts's VARIANT_QUALIFIER_WORDS (which
// excludes "slim" on purpose, per an earlier live correction — "a Slim
// redesign runs similarly priced... not a different price tier," so a
// plain "ps5" SEARCH should still catch Slim listings). That was about
// whether a search should flag something as a match; this is about whether
// two Database entries deserve their own separate tracked price/photos —
// a genuinely different question, and the user's own example here
// explicitly wants PS5/PS5 Slim/PS5 Pro treated as three distinct,
// separately-browsable variants despite Slim's search-matching staying
// broad. Not exported/shared with scorer.ts's list for that reason.
const DATABASE_VARIANT_QUALIFIER_WORDS = new Set(["pro", "slim", "max", "plus", "mini", "lite", "se", "xl", "oled", "air"]);

// Same filler-stripping as store.ts's productNameTokens (kept as its own
// copy — this runs in the renderer, store.ts is main-process-only) minus
// the variant words above, which get pulled out separately so two names
// can be compared on "same base product" (ignoring filler) AND "same
// variant tier" (the variant words alone) independently.
const LIBRARY_NAME_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "with", "for", "of", "new", "used", "edition",
  "bundle", "set", "kit", "pack", "brand", "great", "condition", "like", "excellent", "good",
]);

function nameTokenSets(name: string): { base: Set<string>; variants: Set<string> } {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !LIBRARY_NAME_STOPWORDS.has(w));
  const base = new Set<string>();
  const variants = new Set<string>();
  for (const w of words) (DATABASE_VARIANT_QUALIFIER_WORDS.has(w) ? variants : base).add(w);
  return { base, variants };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// The product page's eBay value section: a secondary headline of the app (what is this worth?), so it gets a big
// number and a tile per fact behind it instead of a line of small print.
function EbayValuePanel({
  product,
  busy,
  message,
  onRefresh,
}: {
  product: ProductProfile;
  busy: boolean;
  message: string | null;
  onRefresh: () => void;
}) {
  const checked = product.ebayCompsCheckedAt !== null;
  const hasSold = product.ebayAvgSoldPriceUsd !== null && !!product.ebayCompsSampleSize;
  const hasActive = product.ebayActiveMedianUsd !== null && !!product.ebayActiveSampleSize;
  // Everything here is what the BUYER pays in total (the sold item price plus the shipping they paid): eBay's cut is taken from all
  // of it, so that total is what "You'd keep" is worked out from.
  const soldShipping = Math.max(0, product.ebayAvgShippingUsd ?? 0);
  const soldTotal = hasSold ? (product.ebayAvgSoldPriceUsd as number) + soldShipping : null;
  const headline = product.ebayEstimatedValueUsd ?? soldTotal;
  const basisLabel =
    product.ebayEstimateBasis === "active"
      ? "from current asking prices (no sold comps found)"
      : product.ebayEstimateBasis === "blend"
        ? "from sold comps + current asking prices"
        : "from sold comps";
  const days = product.ebayAvgRunTimeDays;
  const sellTime = days === null ? null : days < 1 ? `${(days * 24).toFixed(1)} hours` : `${days.toFixed(1)} days`;
  // What the user keeps after eBay's cut varies sale to sale, so it's shown as a dollar range.
  const { lowUsd: keepLow, highUsd: keepHigh } = keepRangeUsd(headline ?? 0);
  const money = (n: number) => `$${n.toFixed(n >= 100 ? 0 : 2).replace(/\.00$/, "")}`;

  const tile = (label: string, value: React.ReactNode, detail?: React.ReactNode, accent?: string) => (
    <div
      key={label}
      style={{
        background: "var(--bg-elevated)",
        border: `1px solid ${accent ?? "var(--border)"}`,
        borderRadius: 12,
        padding: "12px 14px",
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.15, marginTop: 4, color: accent ?? "var(--text)" }}>{value}</div>
      {detail && <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 3 }}>{detail}</div>}
    </div>
  );

  return (
    <div style={{ padding: "18px 18px 16px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0.4, color: "var(--text)" }}>📊 eBay VALUE</div>
        <button className="icon" style={{ fontSize: 13.5, padding: "7px 14px" }} disabled={busy} onClick={onRefresh}>
          {busy ? "Researching…" : checked ? "Research again" : "Research now"}
        </button>
      </div>

      {headline !== null ? (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
            <div style={{ fontSize: 52, fontWeight: 800, lineHeight: 1, color: "var(--text)" }}>{money(headline)}</div>
            <div style={{ fontSize: 14, color: "var(--text-muted)" }}>estimated sale price · {basisLabel}</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginTop: 14 }}>
            {/* Order: what sellers are asking, what it actually sold for, what you'd keep, how fast it sells. */}
            {hasActive
              ? tile(
                  "Asking median",
                  money(product.ebayActiveMedianUsd as number),
                  `${product.ebayActiveSampleSize} active listing${product.ebayActiveSampleSize === 1 ? "" : "s"} · shipping included`
                )
              : tile("Asking median", "—", "Not enough active listings")}
            {hasSold
              ? tile(
                  "Sold average",
                  money(soldTotal as number),
                  <>
                    {product.ebayCompsSampleSize} sold comp{product.ebayCompsSampleSize === 1 ? "" : "s"}
                    {product.ebayAvgShippingUsd !== null &&
                      (product.ebayAvgShippingUsd === 0
                        ? " · free shipping"
                        : ` · ${money(product.ebayAvgSoldPriceUsd as number)} + ${money(product.ebayAvgShippingUsd)} shipping`)}
                  </>
                )
              : tile("Sold average", "—", "No sold comps found")}
            {tile("You'd keep", `${money(keepLow)}–${money(keepHigh)}`, "after eBay's fees", "var(--success)")}
            {sellTime !== null && tile("Sells in", sellTime, days !== null && days < 7 ? "fast mover" : undefined)}
          </div>
        </>
      ) : (
        <div style={{ marginTop: 10, fontSize: 14.5, color: "var(--text-muted)" }}>
          {checked
            ? "Checked eBay, but didn't find sold comps or active listings confidently matching this exact product (special editions, other colors and different bundles are filtered out, not counted)."
            : "Not checked yet. Click \"Research now\" to find what this product sold for on eBay and what sellers are asking for it right now."}
        </div>
      )}

      {days !== null && days < 7 && (
        <div
          style={{
            marginTop: 12,
            padding: "9px 14px",
            borderRadius: 10,
            background: "var(--success-bg)",
            color: "var(--success)",
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          🔥 Sells in under a week on eBay — good resale velocity for this one.
        </div>
      )}
      {product.myStore && (
        <div
          style={{
            marginTop: 14,
            padding: "12px 14px",
            borderRadius: 12,
            border: "1px solid var(--accent-1)",
            background: "var(--bg-elevated)",
          }}
        >
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--accent-1)" }}>
            🏪 Your eBay store · <span style={{ textTransform: "none" }}>{product.myStore.seller}</span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginTop: 4 }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: "var(--text)" }}>{money(product.myStore.medianUsd)}</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              what you list it for · {product.myStore.sampleSize} of your listing{product.myStore.sampleSize === 1 ? "" : "s"}
              {product.myStore.lowUsd !== product.myStore.highUsd && ` (${money(product.myStore.lowUsd)}–${money(product.myStore.highUsd)})`}
            </div>
          </div>
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
            {product.myStore.items.map((item) => (
              <a key={item.url} href={item.url} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: "var(--text-muted)", textDecoration: "none" }}>
                {money(item.priceUsd)} · {item.title}
              </a>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 6 }}>Your own asking prices, kept separate from the market numbers above.</div>
        </div>
      )}
      {message && <p style={{ fontSize: 13.5, color: "var(--text-muted)", margin: "10px 0 0" }}>{message}</p>}
      <p style={{ fontSize: 11.5, color: "var(--text-dim)", margin: "10px 0 0" }}>
        Sold comps are collected from Watchcount.com; asking prices come from eBay's current listings
        {checked && product.ebayCompsCheckedAt !== null && ` — checked ${new Date(product.ebayCompsCheckedAt).toLocaleDateString()}, recomputed whenever research runs again`}
      </p>
    </div>
  );
}

// Two products are "variants of each other" when they're the SAME base
// product (identical base tokens once variant words are pulled out) but
// DIFFERENT tiers (different variant-word membership) — "PlayStation 5" vs
// "PlayStation 5 Pro" qualifies; "PlayStation 5" vs "PlayStation 5" (itself)
// or vs an unrelated "Xbox Series X" does not. Same category required too,
// as a sanity bound against two unrelated products that happen to share a
// generic base word.
function findVariantSiblings(product: ProductProfile, allProducts: ProductProfile[]): ProductProfile[] {
  const { base, variants } = nameTokenSets(product.name);
  if (!base.size) return [];
  const seenNames = new Set<string>([normalizedName(product.name)]);
  return allProducts.filter((p) => {
    if (p.id === product.id || p.category !== product.category) return false;
    const other = nameTokenSets(p.name);
    if (!(sameSet(base, other.base) && !sameSet(variants, other.variants))) return false;
    // Never list the same product twice (the main process merges duplicate entries; this keeps one from showing in the
    // meantime), and never list a twin of the page's own product.
    const key = normalizedName(p.name);
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });
}

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Blank-box entries (no thumbnail) get researched the moment they are SEEN (shown on screen, not clicked): every
// request is batched for a moment, then handed to the main process, which works through them a few at a time. An
// entry is asked for at most once per half hour (the main process keeps its own cooldown too).
const thumbnailsRequested = new Map<string, number>();
let pendingThumbnailIds: string[] = [];
let thumbnailFlushTimer: ReturnType<typeof setTimeout> | null = null;
function queueThumbnailRequest(product: ProductProfile): void {
  if (product.imageUrl || product.loading || product.keepThumbnail) return;
  const last = thumbnailsRequested.get(product.id);
  if (last !== undefined && Date.now() - last < 30 * 60_000) return;
  thumbnailsRequested.set(product.id, Date.now());
  pendingThumbnailIds.push(product.id);
  if (thumbnailFlushTimer) return;
  thumbnailFlushTimer = setTimeout(() => {
    const ids = pendingThumbnailIds;
    pendingThumbnailIds = [];
    thumbnailFlushTimer = null;
    void api.ensureThumbnails(ids);
  }, 200);
}
function requestThumbnails(products: ProductProfile[]): void {
  products.forEach(queueThumbnailRequest);
}

// A folder tile with no picture to show gets one when it is seen: the blank products inside it are researched (their
// photos then fill the folder's collage), and its brand logo / group picture is looked up. The Database list is refreshed
// when a logo was found (group pictures arrive through their own push).
const foldersRequested = new Map<string, number>();
function requestFolderImage(segments: string[]): void {
  const key = segments.join(" > ").toLowerCase();
  const last = foldersRequested.get(key);
  if (last !== undefined && Date.now() - last < 30 * 60_000) return;
  foldersRequested.set(key, Date.now());
  void api.ensureFolderImage(segments).then((found) => {
    if (found) window.dispatchEvent(new Event("clynx:products-stale"));
  });
}

function useFolderImpression(items: ProductProfile[], segments: string[] | null, needsPicture: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!needsPicture || !el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        items.filter((p) => !p.imageUrl).slice(0, 6).forEach(queueThumbnailRequest);
        if (segments) requestFolderImage(segments);
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [needsPicture, items.length, segments?.join(" > ")]);
  return ref;
}

// Reports a product as seen while it is on screen: a tile scrolling into view is an impression.
function useImpression(product: ProductProfile) {
  const ref = useRef<HTMLDivElement>(null);
  const blank = !product.imageUrl && !product.loading && !product.keepThumbnail;
  useEffect(() => {
    const el = ref.current;
    if (!blank || !el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          queueThumbnailRequest(product);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [blank, product.id]);
  return ref;
}

// Every product under a node, at any depth — what a folder tile's own
// count badge and representative thumbnail need, since a "Games" folder's
// count should include every game across all its per-generation
// sub-folders, not just ones sitting directly on "Games" itself (which may
// well be zero once everything has a generation assigned).
function collectAllItems(node: FamilyNode): ProductProfile[] {
  return [...node.items, ...node.children.flatMap(collectAllItems)];
}

function findFamilyNode(tree: FamilyNode[], segments: string[]): FamilyNode | null {
  let level = tree;
  let node: FamilyNode | null = null;
  for (const segment of segments) {
    node = level.find((n) => n.segment === segment) ?? null;
    if (!node) return null;
    level = node.children;
  }
  return node;
}

// Per explicit instruction — "for any product that already has a high sales
// price and speed, add a fire symbol." There's no single dollar figure that
// means "high" the same way for a $50 game and a $2000 laptop, so "high" is
// relative to the rest of the library: at/above the average watchcount-
// confirmed sale price across every product that actually has one.
// "Speed" reuses the SAME <7-day threshold already used for the product
// page's own "sells in under a week" badge. Both signals have to be real
// (not null) and both have to clear their bar — a product with no
// watchcount data yet never lights up, rather than guessing.
function isHotProduct(product: ProductProfile, avgSoldPriceAcrossLibrary: number | null): boolean {
  if (product.ebayAvgSoldPriceUsd === null || product.ebayAvgRunTimeDays === null || avgSoldPriceAcrossLibrary === null) return false;
  return product.ebayAvgSoldPriceUsd >= avgSoldPriceAcrossLibrary && product.ebayAvgRunTimeDays < 7;
}

// Per explicit instruction — Library's own "Sort By." Price sorts use the
// same real watchcount-confirmed average sale price isHotProduct reads,
// not the general (unverified) estimate — a product with none pushes to
// the end regardless of direction rather than being treated as free.
type LibrarySortBy = LibrarySortId;

function compareProducts(a: ProductProfile, b: ProductProfile, sortBy: LibrarySortBy): number {
  if (sortBy === "az") return a.name.localeCompare(b.name);
  if (sortBy === "recent") return b.createdAt - a.createdAt;
  const av = a.ebayAvgSoldPriceUsd;
  const bv = b.ebayAvgSoldPriceUsd;
  if (av === null && bv === null) return a.name.localeCompare(b.name);
  if (av === null) return 1;
  if (bv === null) return -1;
  return sortBy === "priceAsc" ? av - bv : bv - av;
}

function sortProducts(items: ProductProfile[], sortBy: LibrarySortBy): ProductProfile[] {
  return [...items].sort((a, b) => compareProducts(a, b, sortBy));
}

// A folder tile represents several products at once, so price/recency
// sorting uses a representative value across everything inside it: the
// single highest sale price found anywhere in the folder for price sorts
// ("this folder has something worth up to $X"), or the most recently added
// member for "recent." A-Z always sorts folders by their own name instead.
function sortFamilyNodes(nodes: FamilyNode[], sortBy: LibrarySortBy): FamilyNode[] {
  if (sortBy === "az") return [...nodes].sort((a, b) => a.segment.localeCompare(b.segment));
  const valueOf = (node: FamilyNode): number | null => {
    const items = collectAllItems(node);
    if (sortBy === "recent") return items.length ? Math.max(...items.map((p) => p.createdAt)) : null;
    const prices = items.map((p) => p.ebayAvgSoldPriceUsd).filter((v): v is number => v !== null);
    return prices.length ? Math.max(...prices) : null;
  };
  return [...nodes].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av === null && bv === null) return a.segment.localeCompare(b.segment);
    if (av === null) return 1;
    if (bv === null) return -1;
    return sortBy === "priceAsc" ? av - bv : bv - av;
  });
}

export function Database({
  active = true,
  requestedProductId,
  onRequestedProductHandled,
  homeSignal,
}: {
  // False while another screen is showing. The library (every product with its photo, tens of MB) is loaded the first time this screen is
  // shown, not when the app starts.
  active?: boolean;
  // Set by App.tsx when the Feed's Research button asks to jump straight to
  // one product's own page — per explicit instruction, more convenient than
  // landing on the grid and having to find/click it. undefined when this
  // screen is used standalone (kept optional rather than required so this
  // component doesn't strictly depend on App.tsx's navigation plumbing).
  requestedProductId?: string | null;
  onRequestedProductHandled?: () => void;
  // Bumped by App.tsx when the Database's sidebar icon is clicked while it is already showing: back to the Database's home.
  homeSignal?: number;
} = {}) {
  // Where the Database was left last time (lib/navState.ts): read once, validated against the real products once they load (see below).
  const [savedNav] = useState(readSavedDatabaseNav);
  const [tab, setTab] = useState<DatabaseTab>(savedNav.tab);
  const [products, setProducts] = useState<ProductProfile[]>([]);
  // null = show every category (the old behavior). Clicking a category pill
  // below jumps straight to just that section instead of making the user
  // scroll past every other category to find it.
  const [activeCategory, setActiveCategory] = useState<string | null>(savedNav.activeCategory);
  const [searchQuery, setSearchQuery] = useState(savedNav.searchQuery);
  // Set the instant a product tile is clicked — swaps the whole screen to a
  // dedicated detail page for that one product (see ProductDetailPage
  // below), per explicit instruction, rather than expanding inline.
  const [selectedProductId, setSelectedProductId] = useState<string | null>(savedNav.selectedProductId);
  const [clearing, setClearing] = useState(false);
  const [showClearAllDialog, setShowClearAllDialog] = useState(false);
  // Clear all now queues the matching deletes for the Clynx server, so the dialog has to say so when cloud sync is on.
  const [clearAllReachesServer, setClearAllReachesServer] = useState(false);
  useEffect(() => {
    if (!showClearAllDialog) return;
    let cancelled = false;
    void api.cloud
      .getStatus()
      .then((c) => {
        if (!cancelled) setClearAllReachesServer(Boolean(c.enabled && c.authenticated));
      })
      .catch(() => {
        if (!cancelled) setClearAllReachesServer(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showClearAllDialog]);
  // Library's "Find photos" catch-up button — how many products still have
  // fewer than 5 reference photos, plus live progress while it runs (see
  // index.ts's runPhotoBackfill).
  const [missingPhotos, setMissingPhotos] = useState(0);
  const [photoBackfill, setPhotoBackfill] = useState<{ running: boolean; done: number; total: number }>({ running: false, done: 0, total: 0 });
  const photoInfoLoaded = useRef(false);
  // Beta 13: the person's own folders, Needs review / Trash panels and the folder dialogs (see components/LibraryTools.tsx).
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [trashCount, setTrashCount] = useState(0);
  const [showReview, setShowReview] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [folderDialog, setFolderDialog] = useState<{ mode: "create" | "rename" | "delete"; folder: LibraryFolder | null } | null>(null);
  const loadLibraryMeta = useCallback(() => {
    api.libraryFolders().then(setFolders);
    api.libraryReview().then((r) => setReviewCount(r.length));
    api.libraryTrash().then((t) => setTrashCount(t.products.length + t.folders.length + t.images.length));
  }, []);
  useEffect(() => {
    loadLibraryMeta();
    const off = api.onLibraryChanged((what) => {
      loadLibraryMeta();
      // a folder rename / delete changes where many products are shown: reload them
      if (what.folders) void api.listProducts().then(setProducts);
    });
    return () => {
      off();
    };
  }, [loadLibraryMeta]);
  useEffect(() => {
    const off = api.onPhotoBackfillProgress((p) => {
      setPhotoBackfill(p);
      if (!p.running && photoInfoLoaded.current) api.countProductsMissingPhotos().then(setMissingPhotos);
    });
    return () => {
      off();
    };
  }, []);
  useEffect(() => {
    if (!active || photoInfoLoaded.current) return;
    photoInfoLoaded.current = true;
    api.countProductsMissingPhotos().then(setMissingPhotos);
    api.getPhotoBackfillStatus().then(setPhotoBackfill);
  }, [active]);
  // Per explicit instruction — the Library's own "+" button, for a product
  // the user already has their own photo/info for rather than something
  // the AI needs to research. The dialog only collects name/category —
  // clicking Create triggers the same native file-picker every other
  // manual photo add in this app uses (see index.ts's products:createManual),
  // rather than duplicating an upload control inline here.
  const [showAddProductDialog, setShowAddProductDialog] = useState(false);
  const [addProductName, setAddProductName] = useState("");
  const [addProductCategory, setAddProductCategory] = useState(CATEGORY_ORDER[0]);
  const [addingProduct, setAddingProduct] = useState(false);
  // Per explicit instruction — "Sort By" for the Library grid, applied
  // wherever products are actually rendered (the category grid's own
  // folders/ungrouped items, search results, and a drilled-into folder's
  // own contents) — see compareProducts/sortProducts/sortFamilyNodes above.
  const [librarySortBy, setLibrarySortBy] = useState<LibrarySortBy>(savedNav.sortBy);
  // Per explicit instruction — small → extra large, remembered per grid;
  // 140 matches this grid's original fixed minimum width.
  const [librarySize, setLibrarySize] = useThumbnailSize("dbLibraryThumbSize", 140);
  // Per explicit instruction — a second grouping tier within category, now
  // potentially several levels deep (see FamilyNode above): when set, the
  // grid shows just this one folder's own contents (drilled into, segment
  // by segment) instead of the whole category. Cleared implicitly whenever
  // a search is active (see the render below) rather than tracked
  // separately, since a name search should show flat matches, not make the
  // user pick their way back out of a folder first.
  const [viewingPath, setViewingPath] = useState<{ category: string; segments: string[] } | null>(savedNav.viewingPath);
  // Guards against refetching products.list on every render while waiting
  // for a requested product that genuinely doesn't exist (a bug, or a race
  // that never resolves) — at most one extra refetch per request.
  const triedRefetchForRef = useRef<string | null>(null);

  // A product just created by listings:research (see index.ts) normally
  // already arrives here via the onProductUpdated push below (sent before
  // that IPC call even resolves) — but this waits for it to actually show
  // up in `products` before navigating, with one safety-net refetch, rather
  // than trusting exact message ordering blindly. Navigating before the
  // data exists would otherwise trip the "product no longer exists, fall
  // back to grid" effect further down and silently cancel the navigation.
  useEffect(() => {
    if (!requestedProductId) return;
    if (products.some((p) => p.id === requestedProductId)) {
      setSelectedProductId(requestedProductId);
      // So "← Back to Database" lands on Library (where this product
      // actually lives) rather than wherever the tab happened to be left.
      setTab("library");
      triedRefetchForRef.current = null;
      onRequestedProductHandled?.();
      return;
    }
    if (triedRefetchForRef.current !== requestedProductId) {
      triedRefetchForRef.current = requestedProductId;
      api.listProducts().then(setProducts);
    }
  }, [requestedProductId, products, onRequestedProductHandled]);

  // True once the library has been fetched at least once: a remembered product, category or folder is only judged "gone" after that.
  const [productsLoaded, setProductsLoaded] = useState(false);
  const libraryLoaded = useRef(false);
  useEffect(() => {
    if (!active || libraryLoaded.current) return;
    libraryLoaded.current = true;
    api.listProducts().then((list) => {
      setProducts(list);
      setProductsLoaded(true);
    });
  }, [active]);
  useEffect(() => {
    // A folder's brand logo was just found (see requestFolderImage): its products carry it, so reload them (once the library has been loaded).
    const refetch = () => {
      if (libraryLoaded.current) void api.listProducts().then(setProducts);
    };
    window.addEventListener("clynx:products-stale", refetch);
    const off = api.onProductUpdated((updated) => {
      // Upsert, not update-only — a product created from chat (research_product)
      // never went through a local list-append, so its very first
      // "products:updated" event is the only chance to add it to this
      // screen's list rather than silently no-op on an unknown id.
      setProducts((prev) => (prev.some((p) => p.id === updated.id) ? prev.map((p) => (p.id === updated.id ? updated : p)) : [updated, ...prev]));
    });
    return () => {
      off();
      window.removeEventListener("clynx:products-stale", refetch);
    };
  }, []);

  // Per explicit instruction — a representative photo for a FOLDER-level
  // grouping ("Xbox > Games", "Xbox > Accessories") rather than the
  // family's own brand logo or an arbitrary member's photo — see
  // ensureGroupThumbnail in index.ts and FamilyTile below. Keyed by the
  // lowercased full path, matching store.ts's group_thumbnails table.
  const [groupThumbnails, setGroupThumbnails] = useState<Record<string, string>>({});
  // The automatic folders' own settings: the names the person gave them and their pictures (with where each came from).
  const folderMeta = useFolderMeta();
  useEffect(() => {
    api.listGroupThumbnails().then(setGroupThumbnails);
    const off = api.onGroupThumbnailUpdated((path, imageData) => {
      setGroupThumbnails((prev) => ({ ...prev, [path.toLowerCase()]: imageData }));
    });
    return () => {
      off();
    };
  }, []);

  // Per explicit instruction — the "high sales price" half of the fire
  // badge (see isHotProduct above): the average watchcount-confirmed sale
  // price across every product in the WHOLE library that actually has one,
  // recomputed whenever products changes. null (rather than 0) when
  // nothing has a price yet, so isHotProduct never lights up on a
  // meaningless "average of nothing" comparison.
  const avgSoldPriceAcrossLibrary = useMemo(() => {
    const prices = products.map((p) => p.ebayAvgSoldPriceUsd).filter((v): v is number => v !== null);
    return prices.length ? prices.reduce((sum, v) => sum + v, 0) / prices.length : null;
  }, [products]);

  // Per explicit instruction — a second grouping tier within category: a
  // product's own family (e.g. "Xbox", or a deeper path like "Xbox > Games
  // > Xbox 360"), assigned by the AI during research (see chat.ts's
  // categoryAndFamilyInstructions), folds related products — different
  // models, bundled controllers, bundled games — under one master tile
  // instead of listing them flat and unrelated. A product with no family
  // (nothing meaningfully groups it) stays directly in `ungrouped`, same
  // flat behavior this screen always had. `items` keeps the full flat list
  // per category too, for the search path below, which deliberately
  // bypasses family folding entirely.
  const grouped = useMemo(() => {
    const map = new Map<string, ProductProfile[]>();
    for (const p of products) {
      // A product the person put in one of their own folders is shown there instead of in its auto-organized place.
      const cat = p.folderPath ? MY_FOLDERS : p.category || "Other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(p);
    }
    if (folders.length > 0 && !map.has(MY_FOLDERS)) map.set(MY_FOLDERS, []);
    const categories = [...map.keys()].sort((a, b) => {
      if (a === MY_FOLDERS || b === MY_FOLDERS) return a === MY_FOLDERS ? -1 : 1; // the person's own folders come first
      const ai = CATEGORY_ORDER.indexOf(a);
      const bi = CATEGORY_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    return categories.map((category) => {
      const items = map.get(category)!;
      const mine = category === MY_FOLDERS;
      const tree = mine ? buildFamilyTree(items, (p) => p.folderPath, folderPaths(folders).map((f) => f.path)) : buildFamilyTree(items);
      const ungrouped = mine ? [] : items.filter((p) => !p.family);
      return { category, items, tree, ungrouped };
    });
  }, [products, folders]);

  // Falls back to "show everything" if the selected category disappears (its last product got deleted) rather than silently showing
  // nothing; the same for a folder view left open when its last member gets deleted (or reassigned elsewhere by a fresh research pass),
  // which falls back out to the category grid, and for an open product that no longer exists (deleted from another window), which falls
  // back to the grid. The same check validates what was remembered from last time, so a restored Database never lands on something that
  // is gone. Waits for the first load: before it, every product would look "deleted".
  useEffect(() => {
    if (!productsLoaded) return;
    const current: DatabaseNav = { tab, selectedProductId, searchQuery, activeCategory, sortBy: librarySortBy, viewingPath, scrollTop: 0 };
    const next = validateDatabaseNav(current, {
      productIds: new Set(products.map((p) => p.id)),
      categories: new Set(grouped.map((g) => g.category)),
      hasFolder: (category, segments) => findFamilyNode(grouped.find((g) => g.category === category)?.tree ?? [], segments) !== null,
    });
    if (next === current) return;
    if (next.selectedProductId !== selectedProductId) setSelectedProductId(next.selectedProductId);
    if (next.tab !== tab) setTab(next.tab);
    if (next.activeCategory !== activeCategory) setActiveCategory(next.activeCategory);
    if (next.viewingPath !== viewingPath) setViewingPath(next.viewingPath);
  }, [productsLoaded, products, grouped, tab, selectedProductId, searchQuery, activeCategory, librarySortBy, viewingPath]);

  // ---- remembering where the Database was left (lib/navState.ts). The Library grid unmounts whenever another tab or a product page is
  // showing, so its scroll offset is saved as the reader scrolls and put back when the grid returns (rather than keeping a second copy of
  // the photo-heavy grid mounted out of sight).
  const libraryScroll = useRef(savedNav.scrollTop);
  const libraryEl = useRef<HTMLDivElement | null>(null);
  const restoreScrollPending = useRef(false);
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navSnapshot = useRef<DatabaseNav>(savedNav);
  navSnapshot.current = { tab, selectedProductId, searchQuery, activeCategory, sortBy: librarySortBy, viewingPath, scrollTop: libraryScroll.current };
  const setLibraryEl = useCallback((el: HTMLDivElement | null) => {
    libraryEl.current = el;
    if (el) restoreScrollPending.current = true;
  }, []);
  // Runs after every render, cheap when nothing is pending. Until the library has loaded the grid is too short to scroll to a remembered
  // offset, so a non-zero offset waits for the load.
  useLayoutEffect(() => {
    const el = libraryEl.current;
    if (!el || !restoreScrollPending.current) return;
    if (libraryScroll.current > 0 && !productsLoaded) return;
    restoreScrollPending.current = false;
    el.scrollTop = libraryScroll.current;
  });
  useEffect(() => {
    writeSavedDatabaseNav(navSnapshot.current);
  }, [tab, selectedProductId, searchQuery, activeCategory, librarySortBy, viewingPath]);
  useEffect(
    () => () => {
      if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
    },
    []
  );
  // Coming back from another screen (the Database stays mounted, hidden): make sure the grid is where it was left.
  useLayoutEffect(() => {
    const el = libraryEl.current;
    if (active && el && el.clientHeight > 0 && productsLoaded && Math.abs(el.scrollTop - libraryScroll.current) > 1) el.scrollTop = libraryScroll.current;
  }, [active, productsLoaded]);
  function onLibraryScroll(e: React.UIEvent<HTMLDivElement>) {
    // A hidden grid reports a zero-height box: that is not the reader scrolling.
    if (e.currentTarget.clientHeight === 0) return;
    libraryScroll.current = e.currentTarget.scrollTop;
    if (scrollSaveTimer.current) return;
    scrollSaveTimer.current = setTimeout(() => {
      scrollSaveTimer.current = null;
      writeSavedDatabaseNav(navSnapshot.current);
    }, 400);
  }
  function resetLibraryToRoot() {
    const root = libraryRootNav(navSnapshot.current);
    setSelectedProductId(root.selectedProductId);
    setSearchQuery(root.searchQuery);
    setActiveCategory(root.activeCategory);
    setViewingPath(root.viewingPath);
    libraryScroll.current = 0;
    libraryEl.current?.scrollTo({ top: 0 });
  }
  // The Database's sidebar icon was clicked while already open: back to the home view (the Discovery tab, nothing selected). Sorting is a
  // preference and stays.
  const seenHomeSignal = useRef(homeSignal);
  useEffect(() => {
    if (homeSignal === undefined || homeSignal === seenHomeSignal.current) return;
    seenHomeSignal.current = homeSignal;
    const home = homeDatabaseNav(navSnapshot.current.sortBy);
    setTab(home.tab);
    setSelectedProductId(home.selectedProductId);
    setSearchQuery(home.searchQuery);
    setActiveCategory(home.activeCategory);
    setViewingPath(home.viewingPath);
    libraryScroll.current = home.scrollTop;
    resetDiscoveryUi();
  }, [homeSignal]);

  const visibleGroups = activeCategory ? grouped.filter((g) => g.category === activeCategory) : grouped;

  // Name search on top of the category filter, not instead of it — added
  // for convenience once the Database has enough products that scrolling
  // (even within one category) stops being quick. Categories that end up
  // with zero matches are dropped entirely rather than shown as empty
  // headers.
  const searchedGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return visibleGroups;
    return visibleGroups
      .map((g) => ({ category: g.category, items: g.items.filter((p) => p.name.toLowerCase().includes(q)) }))
      .filter((g) => g.items.length > 0);
  }, [visibleGroups, searchQuery]);

  const selectedProduct = selectedProductId ? products.find((p) => p.id === selectedProductId) ?? null : null;

  async function refresh(id: string) {
    setProducts((prev) => prev.map((p) => (p.id === id ? { ...p, loading: true } : p)));
    const updated = await api.refreshProduct(id);
    if (updated) setProducts((prev) => prev.map((p) => (p.id === id ? updated : p)));
  }

  async function remove(id: string) {
    await api.deleteProduct(id);
    setProducts((prev) => prev.filter((p) => p.id !== id));
    if (selectedProductId === id) setSelectedProductId(null);
  }

  // Per explicit instruction — only the researched products themselves
  // (and their reference-photo galleries); the Blacklist and Blacklisted
  // Images sections are separate data, deliberately untouched, same as
  // Feed's own "Clear all" never touches the Blacklist either.
  async function clearAllProducts() {
    setClearing(true);
    try {
      await api.clearAllProducts();
      setProducts([]);
      setSelectedProductId(null);
    } finally {
      setClearing(false);
      setShowClearAllDialog(false);
    }
  }

  async function createManualProduct() {
    const name = addProductName.trim();
    if (!name || addingProduct) return;
    setAddingProduct(true);
    try {
      const created = await api.createManualProduct(name, addProductCategory);
      if (created) {
        setProducts((prev) => [created, ...prev]);
        setAddProductName("");
        setShowAddProductDialog(false);
      }
    } finally {
      setAddingProduct(false);
    }
  }

  async function saveEdit(
    id: string,
    patch: Partial<{
      name: string;
      aiSummary: string;
      resalePriceUsd: number | null;
      resaleTimeToSell: string | null;
      keepThumbnail: boolean;
      desiredPriceUsd: number | null;
      hardCapAtDesiredPrice: boolean;
      prioritized: boolean;
    }>
  ) {
    const updated = await api.editProduct(id, patch);
    if (updated) setProducts((prev) => prev.map((p) => (p.id === id ? updated : p)));
  }

  // The Library tile's own star button — a pure flag toggle, never touches
  // the Search For list or any filter (see types.ts's
  // ProductProfile.prioritized). Reads the CURRENT value off local state
  // rather than needing its own round trip first.
  function togglePrioritized(id: string) {
    const current = products.find((p) => p.id === id);
    if (current) saveEdit(id, { prioritized: !current.prioritized });
  }

  async function pickThumbnail(id: string) {
    const updated = await api.pickProductThumbnail(id);
    if (updated) setProducts((prev) => prev.map((p) => (p.id === id ? updated : p)));
  }

  // The tile's magnifying-glass button — kicks off a real Facebook
  // Marketplace search for this product, same as asking the Dashboard
  // assistant to do it (see products:searchNow in index.ts, which reuses
  // add_search_item's own logic). Results land live in the Feed/Activity
  // the same as any other chat-triggered search, so nothing further to do
  // here beyond firing the request.
  async function searchProduct(id: string) {
    await api.searchProductNow(id);
  }

  if (selectedProduct) {
    return (
      <ProductDetailPage
        product={selectedProduct}
        allProducts={products}
        onBack={() => setSelectedProductId(null)}
        onSelectProduct={(id) => setSelectedProductId(id)}
        onRefresh={() => refresh(selectedProduct.id)}
        onDelete={() => remove(selectedProduct.id)}
        onSaveEdit={(patch) => saveEdit(selectedProduct.id, patch)}
        onPickThumbnail={() => pickThumbnail(selectedProduct.id)}
        folders={folders}
      />
    );
  }

  const TAB_LABELS: Record<DatabaseTab, string> = { discovery: "Discovery", library: "Library", review: "Review", blacklist: "Blacklist" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, height: "100%" }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 28 }}>Database</h1>
        <p style={{ color: "var(--text-muted)", margin: "6px 0 0", fontSize: 15 }}>
          Build a knowledge profile for a product once, reuse it every time scoring runs into it.
        </p>
      </div>

      {/* Per explicit instruction — three clearly separated sections
          instead of one long scrolling page: Discovery (a live feed of the
          products Clynx is looking into, with its thoughts and a box to ask
          it things), Library (products already researched), Blacklist (both
          the term list and the image gallery). */}
      <div style={{ display: "flex", gap: 8, borderBottom: "1px solid var(--border)" }}>
        {(Object.keys(TAB_LABELS) as DatabaseTab[]).map((t) => (
          <button
            key={t}
            className="ghost"
            // Clicking the tab you are already on takes the Library back to its root (folders, category, search and scroll cleared).
            onClick={() => (t === tab ? t === "library" && resetLibraryToRoot() : setTab(t))}
            aria-current={tab === t ? "page" : undefined}
            style={{
              padding: "13px 20px",
              borderRadius: "10px 10px 0 0",
              fontWeight: 600,
              fontSize: 15.5,
              borderBottom: `2px solid ${tab === t ? "var(--accent-1)" : "transparent"}`,
              color: tab === t ? "var(--text)" : "var(--text-muted)",
              background: tab === t ? "var(--bg-card-hover)" : "transparent",
            }}
          >
            {t === "discovery" ? "🔭 " : t === "library" ? "📚 " : t === "review" ? "🔎 " : "🚫 "}
            {TAB_LABELS[t]}
            {t === "library" && products.length > 0 ? ` (${products.length})` : ""}
          </button>
        ))}
      </div>

      {tab === "discovery" && (
        <div style={{ flex: 1, minHeight: 0 }}>
          <DiscoveryTab
            products={products}
            onOpenProduct={(id) => {
              setSelectedProductId(id);
              setTab("library");
            }}
          />
        </div>
      )}

      {tab === "library" && (
        <div ref={setLibraryEl} onScroll={onLibraryScroll} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 18, paddingRight: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              {products.length > 0 && (
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search products by name..."
                  style={{ width: 240 }}
                />
              )}
              {products.length > 0 && (
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14.5, color: "var(--text-muted)" }}>
                  Sort by
                  <select value={librarySortBy} onChange={(e) => setLibrarySortBy(e.target.value as LibrarySortBy)}>
                    <option value="recent">Recently added</option>
                    <option value="priceDesc">Price: high to low</option>
                    <option value="priceAsc">Price: low to high</option>
                    <option value="az">A–Z</option>
                  </select>
                </label>
              )}
              <ThumbnailSizeSlider value={librarySize} onChange={setLibrarySize} min={90} max={280} step={10} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {(missingPhotos > 0 || photoBackfill.running) && (
                <button
                  className="icon ghost"
                  disabled={photoBackfill.running}
                  title={`Searches the web for stock photos of the ${missingPhotos} product${missingPhotos === 1 ? "" : "s"} with fewer than 5 reference photos, and uses the best one as the thumbnail if there isn't one yet. Runs in the background.`}
                  onClick={() => api.backfillProductPhotos()}
                >
                  {photoBackfill.running ? `📸 Finding photos… ${photoBackfill.done}/${photoBackfill.total}` : `📸 Find photos (${missingPhotos})`}
                </button>
              )}
              <button className="icon ghost" onClick={() => setFolderDialog({ mode: "create", folder: null })} title="Make a folder of your own">
                📁 New folder
              </button>
              <button className="icon ghost" onClick={() => setShowReview(true)} title="Photos and names Clynx wants you to look at" style={reviewCount > 0 ? { color: "var(--warn)" } : undefined}>
                🔎 Needs review{reviewCount > 0 ? ` (${reviewCount})` : ""}
              </button>
              <button className="icon ghost" onClick={() => setShowTrash(true)} title="Deleted items stay here for 30 days; recent changes can be undone">
                🗑 Trash{trashCount > 0 ? ` (${trashCount})` : ""}
              </button>
              <button className="primary" onClick={() => setShowAddProductDialog(true)}>
                + Add product
              </button>
              <button
                className="icon ghost"
                style={{ color: "var(--danger)", fontSize: 12.5 }}
                disabled={clearing || !products.length}
                onClick={() => setShowClearAllDialog(true)}
              >
                {clearing ? "Clearing..." : "Clear all"}
              </button>
            </div>
          </div>

          {products.length === 0 && (
            <div className="card" style={{ color: "var(--text-dim)" }}>
              No products yet. Ask Clynx on the Discovery tab to look one up, or I'll pick up products on my own while
              scanning.
            </div>
          )}

          {/* Per explicit instruction — a folder drilled into (e.g. "Xbox",
              or deeper: "Xbox > Games") takes over the grid with just its
              own contents, same "go one level deeper" feel as opening a
              folder, instead of expanding in place among everything else.
              A search in progress always wins over this — see the state's
              own comment. */}
          {viewingPath && !searchQuery.trim() ? (
            (() => {
              const categoryGroup = grouped.find((g) => g.category === viewingPath.category);
              const node = categoryGroup ? findFamilyNode(categoryGroup.tree, viewingPath.segments) : null;
              if (!categoryGroup || !node) return null; // the cleanup effect will clear viewingPath a moment later
              return (
                <FolderView
                  category={viewingPath.category}
                  segments={viewingPath.segments}
                  node={node}
                  librarySize={librarySize}
                  groupThumbnails={groupThumbnails}
                  folderMeta={folderMeta}
                  sortBy={librarySortBy}
                  avgSoldPriceAcrossLibrary={avgSoldPriceAcrossLibrary}
                  onNavigate={(segments) => setViewingPath(segments.length ? { category: viewingPath.category, segments } : null)}
                  onOpenProduct={setSelectedProductId}
                  onSearchProduct={searchProduct}
                  onDeleteProduct={remove}
                  onTogglePrioritized={togglePrioritized}
                  folderActions={
                    viewingPath.category === MY_FOLDERS ? (
                      (() => {
                        const here = folderPaths(folders).find((f) => f.path === viewingPath.segments.join(" > "));
                        const folder = folders.find((f) => f.id === here?.id) ?? null;
                        return folder ? (
                          <span style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                            <button className="icon ghost" onClick={() => setFolderDialog({ mode: "create", folder })}>
                              + Subfolder
                            </button>
                            <button className="icon ghost" onClick={() => setFolderDialog({ mode: "rename", folder })}>
                              Rename
                            </button>
                            <button className="icon ghost" style={{ color: "var(--danger)" }} onClick={() => setFolderDialog({ mode: "delete", folder })}>
                              Delete
                            </button>
                          </span>
                        ) : null;
                      })()
                    ) : (
                      <span style={{ marginLeft: "auto" }}>
                        <AutoFolderMenu category={viewingPath.category} segments={viewingPath.segments} items={collectAllItems(node)} meta={folderMeta} />
                      </span>
                    )
                  }
                />
              );
            })()
          ) : (
            <>
              {searchQuery.trim() && searchedGroups.length === 0 && (
                <div className="card" style={{ color: "var(--text-dim)" }}>
                  No products match "{searchQuery.trim()}".
                </div>
              )}

              {searchQuery.trim()
                ? // Search bypasses family folding entirely — a name match
                  // buried inside a folder the user hasn't opened would
                  // otherwise look like it's simply missing.
                  searchedGroups.map(({ category, items }) => (
                    <div key={category} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                          {category}
                        </div>
                        <div style={{ fontSize: 14, color: "var(--text-dim)" }}>{items.length}</div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${librarySize}px, 1fr))`, gap: 14 }}>
                        {sortProducts(items, librarySortBy).map((p) => (
                          <ProductTile
                            key={p.id}
                            product={p}
                            onClick={() => setSelectedProductId(p.id)}
                            onSearch={() => searchProduct(p.id)}
                            onDelete={() => remove(p.id)}
                            onTogglePrioritized={() => togglePrioritized(p.id)}
                            hot={isHotProduct(p, avgSoldPriceAcrossLibrary)}
                          />
                        ))}
                      </div>
                    </div>
                  ))
                : activeCategory === null && grouped.length > 1
                  ? // Per explicit instruction — the Library home page shows
                    // one collage tile per category instead of every
                    // category's full contents inline (the old behavior,
                    // which forced a long scroll just to see what's there).
                    // Click a category tile to drill into exactly what used
                    // to render here directly — see the branch below.
                    (
                      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${librarySize}px, 1fr))`, gap: 14 }}>
                        {grouped.map(({ category, items, tree, ungrouped }) => (
                          <CategoryTile
                            key={category}
                            category={category}
                            count={items.length}
                            items={items}
                            generatedThumbnailUrl={groupThumbnails[category.toLowerCase()] ?? null}
                            onOpen={() => setActiveCategory(category)}
                          />
                        ))}
                      </div>
                    )
                  : visibleGroups.map(({ category, tree, ungrouped }) => (
                      <div key={category} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          {grouped.length > 1 && (
                            <button className="icon ghost" onClick={() => setActiveCategory(null)}>
                              ← Back to Database
                            </button>
                          )}
                          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                            {category}
                          </div>
                          <div style={{ fontSize: 14, color: "var(--text-dim)" }}>{tree.length + ungrouped.length}</div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${librarySize}px, 1fr))`, gap: 14 }}>
                          {sortFamilyNodes(tree, librarySortBy).map((node) => (
                            <FamilyTile
                              key={node.segment}
                              family={node.segment}
                              items={collectAllItems(node)}
                              isTopLevel
                              category={category}
                              folderMeta={folderMeta}
                              pathSegments={[node.segment]}
                              onOpen={() => setViewingPath({ category, segments: [node.segment] })}
                            />
                          ))}
                          {sortProducts(ungrouped, librarySortBy).map((p) => (
                            <ProductTile
                              key={p.id}
                              product={p}
                              onClick={() => setSelectedProductId(p.id)}
                              onSearch={() => searchProduct(p.id)}
                              onDelete={() => remove(p.id)}
                              onTogglePrioritized={() => togglePrioritized(p.id)}
                              hot={isHotProduct(p, avgSoldPriceAcrossLibrary)}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
            </>
          )}

          <LibraryNote />
          {showReview && <NeedsReviewPanel products={products} onClose={() => setShowReview(false)} />}
          {showTrash && <TrashPanel onClose={() => setShowTrash(false)} />}
          {folderDialog && <FolderDialog mode={folderDialog.mode} folders={folders} folder={folderDialog.folder} onClose={() => setFolderDialog(null)} />}

          {showClearAllDialog && (
            <Modal title="Clear the whole Database?" onClose={() => setShowClearAllDialog(false)}>
              <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.5 }}>
                Delete all {products.length} researched product{products.length === 1 ? "" : "s"} and their photo
                galleries? This can't be undone. Your Blacklist and Blacklisted Images are separate and won't be
                touched.
                {clearAllReachesServer && " This also deletes them from your Clynx server and from any other computer signed in to it."}
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="icon" style={{ flex: 1 }} onClick={() => setShowClearAllDialog(false)}>
                  Cancel
                </button>
                <button className="danger-solid" style={{ flex: 1 }} onClick={clearAllProducts}>
                  Delete all
                </button>
              </div>
            </Modal>
          )}

          {showAddProductDialog && (
            <Modal
              title="Add a product"
              onClose={() => {
                setShowAddProductDialog(false);
                setAddProductName("");
              }}
            >
              <p style={{ margin: 0, fontSize: 14.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                For a product you already know — Clynx doesn't research it. Clicking Create opens a file picker for an
                optional photo.
              </p>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14, color: "var(--text-muted)" }}>
                Name
                <input
                  autoFocus
                  value={addProductName}
                  onChange={(e) => setAddProductName(e.target.value)}
                  placeholder="e.g. Xbox Series S (Black)"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && addProductName.trim()) createManualProduct();
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14, color: "var(--text-muted)" }}>
                Category
                <select value={addProductCategory} onChange={(e) => setAddProductCategory(e.target.value)}>
                  {CATEGORY_ORDER.filter((c) => c !== "Other").map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  <option value="Other">Other</option>
                </select>
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="icon"
                  style={{ flex: 1 }}
                  onClick={() => {
                    setShowAddProductDialog(false);
                    setAddProductName("");
                  }}
                >
                  Cancel
                </button>
                <button className="primary" style={{ flex: 1 }} disabled={!addProductName.trim() || addingProduct} onClick={createManualProduct}>
                  {addingProduct ? "Creating…" : "Create"}
                </button>
              </div>
            </Modal>
          )}
        </div>
      )}

      {tab === "review" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <ReviewTab
            onOpenProduct={(id) => {
              setSelectedProductId(id);
              setTab("library");
            }}
          />
        </div>
      )}

      {tab === "blacklist" && (
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 22, paddingRight: 4 }}>
          <BlacklistSection />
          <BlacklistedImagesSection />
        </div>
      )}
    </div>
  );
}

// Listings whose title matches a blacklisted term are skipped automatically
// before ever being opened (see store.ts's isBlacklisted / scrapeEngine.ts)
// — per explicit instruction, for things categorically unrelated to
// reselling (real estate, rentals, job postings...), not just uninteresting
// resalable items. Grows two ways: the user typing a term here (or telling
// the Database chat to blacklist something), or the scanner auto-suggesting
// one when the general-deal AI recognizes an off-topic listing. They look
// like any other term (no marker, per explicit instruction) and can be
// removed the same way if they turn out too broad.
function BlacklistSection() {
  const [terms, setTerms] = useState<BlacklistTerm[]>([]);
  const [draft, setDraft] = useState("");
  // Per explicit instruction — "when the AI blacklists listings, make sure
  // it blacklists both the title and the image(s), report both in
  // Blacklist": this section now also loads the image gallery (see
  // BlacklistedImagesSection below, which already owned this data) purely
  // to show each term's own linked photo(s) inline, right next to the term
  // itself, instead of only in that separate gallery further down the page.
  const [images, setImages] = useState<BlacklistedImage[]>([]);
  const lightbox = useLightbox();

  useEffect(() => {
    api.listBlacklistTerms().then(setTerms);
    const offTerms = api.onBlacklistUpdated(setTerms);
    api.listBlacklistedImages().then(setImages);
    const offImages = api.onBlacklistImagesUpdated(setImages);
    return () => {
      offTerms();
      offImages();
    };
  }, []);

  async function add() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setDraft("");
    const updated = await api.addBlacklistTerm(trimmed);
    if (updated) setTerms(updated);
  }

  async function remove(term: string) {
    const updated = await api.removeBlacklistTerm(term);
    setTerms(updated);
  }

  const imagesByTerm = useMemo(() => {
    const map = new Map<string, BlacklistedImage[]>();
    for (const img of images) {
      if (!img.linkedTerm) continue;
      const list = map.get(img.linkedTerm) ?? [];
      list.push(img);
      map.set(img.linkedTerm, list);
    }
    return map;
  }, [images]);

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>🚫 Blacklist</div>
        <div style={{ fontSize: 14, color: "var(--text-dim)" }}>
          {terms.length} term{terms.length === 1 ? "" : "s"}
        </div>
      </div>
      <p style={{ fontSize: 14, color: "var(--text-muted)", margin: 0 }}>
        Listings whose title matches one of these are skipped automatically before ever being opened — for things
        unrelated to reselling (real estate, rentals, job postings...), not just uninteresting items. Ask the
        assistant above to blacklist something, or add a term directly below.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`e.g. "for rent", "timeshare"`} style={{ flex: 1 }} />
        <button className="icon" type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>
      {terms.length > 0 && (
        // Terms flow left to right and wrap onto the next line; a term and its photo(s) stay together as one item.
        <div data-testid="blacklist-terms" style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: "8px 14px" }}>
          {terms.map((t) => {
            const linkedImages = imagesByTerm.get(t.term) ?? [];
            return (
              <div key={t.term} data-testid="blacklist-term" style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "nowrap" }}>
                <span className="pill" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 4px 4px 10px" }}>
                  {t.term}
                  <button
                    className="icon ghost"
                    title="Remove"
                    onClick={() => remove(t.term)}
                    style={{ padding: "0 4px", fontSize: 14, lineHeight: 1, color: "var(--text-dim)" }}
                  >
                    ×
                  </button>
                </span>
                {/* The listing photo(s) that were blacklisted alongside this
                    term (see store.ts's addBlacklistTerm) — same image data
                    shown in the Blacklisted Images gallery below, just
                    surfaced here too so the two halves of one AI decision
                    (title + photo) read as one thing, not two separate
                    lists the user has to cross-reference. */}
                {linkedImages.map((img) => (
                  <img
                    key={img.id}
                    src={img.imageData}
                    alt=""
                    title={img.sourceTitle ?? undefined}
                    onClick={() => lightbox.open(img.imageData, { subjectName: t.term, kind: "blacklisted", imageId: img.id })}
                    style={{
                      width: 30,
                      height: 30,
                      objectFit: "cover",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      cursor: "zoom-in",
                      flexShrink: 0,
                    }}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// The image counterpart to BlacklistSection above — per explicit
// instruction, the scanner now recognizes an ineligible category (a boat, a
// car, real estate...) directly from a listing's thumbnail, even when the
// title never mentioned it, and stores that photo as a growing reference
// set for future thumbnail checks ("next time it sees something similar").
// Since this is the AI's own visual guess rather than a hard keyword match,
// each entry gets an explicit yes/no from the user instead of silently
// trusting it forever — "Correct" needs no confirmation (a positive
// acknowledgment has nothing to undo), but "Remove" opens a themed dialog
// first, since deleting it also drops it from the reference set future
// checks compare against.
function BlacklistedImagesSection() {
  const [images, setImages] = useState<BlacklistedImage[]>([]);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  // Per explicit instruction — small → extra large, remembered per grid;
  // 120 matches this grid's original fixed minimum width.
  const [imgSize, setImgSize] = useThumbnailSize("dbBlacklistImgThumbSize", 120);
  // Per explicit instruction — every photo in the app is clickable to zoom
  // in, except Library's tile grid and Feed's listing cards.
  const lightbox = useLightbox();

  useEffect(() => {
    api.listBlacklistedImages().then(setImages);
    const off = api.onBlacklistImagesUpdated(setImages);
    return () => {
      off();
    };
  }, []);

  async function confirm(id: string) {
    const updated = await api.confirmBlacklistedImage(id);
    setImages(updated);
  }

  async function remove(id: string) {
    const updated = await api.removeBlacklistedImage(id);
    setImages(updated);
    setPendingRemoveId(null);
  }

  const pending = images.find((img) => img.id === pendingRemoveId) ?? null;

  // Nothing to review yet — skip the section entirely rather than showing
  // an empty gallery with nothing to act on.
  if (!images.length) return null;

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>🖼️ Blacklisted Images</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <ThumbnailSizeSlider value={imgSize} onChange={setImgSize} min={80} max={240} step={10} />
          <div style={{ fontSize: 14, color: "var(--text-dim)" }}>
            {images.length} image{images.length === 1 ? "" : "s"}
          </div>
        </div>
      </div>
      <p style={{ fontSize: 14, color: "var(--text-muted)", margin: 0 }}>
        Listings Clynx skipped after recognizing the photo itself as an ineligible category (a vehicle, real estate,
        furniture, etc.) — even when the title never said so. Review each one below.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${imgSize}px, 1fr))`, gap: 12 }}>
        {images.map((img) => (
          <div key={img.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ position: "relative" }}>
              <img
                src={img.imageData}
                alt={img.category ?? ""}
                onClick={() =>
                  lightbox.open(img.imageData, {
                    subjectName: img.category ?? "unrecognized item",
                    kind: "blacklisted",
                    imageId: img.id,
                  })
                }
                style={{
                  width: "100%",
                  height: Math.round(imgSize * (100 / 120)),
                  objectFit: "cover",
                  borderRadius: 10,
                  border: `1px solid ${img.confirmed ? "var(--success)" : "var(--border)"}`,
                  display: "block",
                  cursor: "zoom-in",
                }}
              />
              {img.confirmed && (
                <span title="Confirmed correct by you" style={{ position: "absolute", top: 6, right: 6, fontSize: 15 }}>
                  ✅
                </span>
              )}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", textTransform: "capitalize" }} title={img.reason ?? undefined}>
              {img.category ?? "unrecognized"}
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <button
                className="icon ghost"
                disabled={img.confirmed}
                onClick={() => confirm(img.id)}
                style={{ flex: 1, fontSize: 13, padding: "4px 6px", border: "1px solid var(--border)" }}
              >
                {img.confirmed ? "✓ Confirmed" : "Correct"}
              </button>
              <button
                className="icon ghost"
                onClick={() => setPendingRemoveId(img.id)}
                style={{ flex: 1, fontSize: 13, padding: "4px 6px", border: "1px solid var(--border)", color: "var(--danger)" }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      {pending && (
        <Modal title="Remove this image?" onClose={() => setPendingRemoveId(null)}>
          <img src={pending.imageData} alt="" style={{ width: "100%", height: 160, objectFit: "cover", borderRadius: 10, display: "block" }} />
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>
            Clynx flagged this as "{pending.category ?? "unrecognized"}" — {pending.reason ?? "no reason given"}. Was it wrong?
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon" style={{ flex: 1 }} onClick={() => setPendingRemoveId(null)}>
              Keep it
            </button>
            <button className="danger-solid" style={{ flex: 1 }} onClick={() => remove(pending.id)}>
              Yes, remove
            </button>
          </div>
        </Modal>
      )}
      {lightbox.node}
    </div>
  );
}

// The "master tile" for a family — per explicit instruction, a folder-style
// stand-in for however many products (a console, its controllers, its
// bundled games) share the same AI-assigned family within one category, so
// the grid shows one Xbox tile instead of four unrelated-looking ones.
// Deliberately minimal (no search/delete/blacklist buttons of its own —
// those apply to actual products, not this grouping) — its only job is to
// drill into FolderView below.
//
// isTopLevel gates the brand-logo preference (see types.ts's
// ProductProfile.familyLogoUrl): only true for a category's own root-level
// family tiles (the actual "Xbox" folder), never for a nested sub-folder
// ("Games", "Xbox 360" within it) — those aren't brands in their own
// right, and would otherwise all redundantly show the same Xbox logo as
// their parent instead of looking like a sub-folder.
// Shared by FamilyTile and CategoryTile below — per explicit instruction,
// a folder/category tile with more than one image worth showing collages
// them together (up to 4, in a 1/2-across/2x2 grid depending on count)
// instead of picking just one arbitrarily. A single image (most often a
// real brand logo) still gets the old full-tile "contain on white"
// treatment — a logo is designed to be read whole, not cropped or
// crowded into a quadrant next to other photos.
function CollageImage({ images, isLogo = false, emptyIcon = "📁" }: { images: string[]; isLogo?: boolean; emptyIcon?: string }) {
  if (images.length === 0) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 30,
          color: "var(--text-dim)",
          background: "var(--bg-elevated)",
        }}
      >
        <span className="floaty">{emptyIcon}</span>
      </div>
    );
  }
  if (images.length === 1) {
    return (
      <img
        src={images[0]}
        alt=""
        loading="lazy"
        style={{
          width: "100%",
          height: "100%",
          objectFit: isLogo ? "contain" : "cover",
          background: isLogo ? "#ffffff" : undefined,
          padding: isLogo ? 10 : 0,
          display: "block",
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gridTemplateRows: images.length > 2 ? "1fr 1fr" : "1fr",
        gap: 2,
        background: "var(--border)",
      }}
    >
      {images.slice(0, 4).map((src, i) => (
        <div
          key={i}
          style={{
            overflow: "hidden",
            background: "#ffffff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            // A lone 3rd tile spans both columns on its own row, instead of
            // leaving an empty 4th quadrant looking broken.
            gridColumn: images.length === 3 && i === 0 ? "1 / span 2" : undefined,
          }}
        >
          <img src={src} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "contain", padding: 6 }} />
        </div>
      ))}
    </div>
  );
}

function FamilyTile({
  family,
  items,
  isTopLevel = false,
  groupThumbnailUrl = null,
  pathSegments = null,
  category = null,
  folderMeta = null,
  onOpen,
}: {
  family: string;
  items: ProductProfile[];
  // Which category the folder is in, and the automatic folders' settings (renamed labels, pictures).
  category?: string | null;
  folderMeta?: Map<string, FolderMeta> | null;

  // The folder's full path (["Xbox", "Games"]), for finding its picture when it has none.
  pathSegments?: string[] | null;
  isTopLevel?: boolean;
  // A representative photo for THIS sub-grouping as a whole (e.g. a
  // generic "Xbox games" shot for the "Games" folder) — see
  // ensureGroupThumbnail in index.ts. Only meaningful for a non-top-level
  // folder (isTopLevel already prefers the brand logo instead) — folded
  // into the collage below as one of its tiles rather than replacing a
  // member photo outright.
  groupThumbnailUrl?: string | null;
  onOpen: () => void;
}) {
  const auto = !!category && !!folderMeta && category !== MY_FOLDERS && !!pathSegments?.length;
  const meta = auto ? folderMetaFor(folderMeta!, category!, pathSegments!) : null;
  const shownName = auto ? folderLabel(folderMeta!, category!, pathSegments!) : family;
  // A picture the person chose beats everything, a brand logo included; Clynx's own pictures do not replace a brand logo.
  const chosen = !!meta?.thumbData && (meta.thumbLocked || meta.thumbSource === "user_upload" || meta.thumbSource === "user_selected");
  const logo = isTopLevel && !chosen ? (items.find((p) => p.familyLogoUrl)?.familyLogoUrl ?? null) : null;
  // Per explicit instruction — "do that for all items that have multiple
  // versions of the same product type, such as different games, different
  // console models/editions": when there's no single brand logo to show
  // instead, collage together up to 4 of this folder's OWN member photos
  // — the actual different games/editions inside it — rather than just
  // whichever one happened to be first.
  const previewImages = logo
    ? [logo]
    : meta?.thumbData
      ? [meta.thumbData]
      : (() => {
        const images: string[] = [];
        if (groupThumbnailUrl && !auto) images.push(groupThumbnailUrl);
        for (const p of items) {
          if (images.length >= 4) break;
          if (p.imageUrl && !images.includes(p.imageUrl)) images.push(p.imageUrl);
        }
        return images;
      })();
  const folderRef = useFolderImpression(items, pathSegments, previewImages.length === 0 || (isTopLevel && !logo));
  return (
    <div
      ref={folderRef}
      onClick={onOpen}
      className="card enter"
      style={{
        aspectRatio: "1 / 1",
        padding: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        cursor: "pointer",
        position: "relative",
        border: "1px solid var(--border-strong)",
        background: "var(--gradient-soft)",
      }}
      title={`Open ${shownName} (${items.length} item${items.length === 1 ? "" : "s"})${pictureNote(meta) ? ` - ${pictureNote(meta)}` : ""}`}
    >
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <CollageImage images={previewImages} isLogo={!!logo} />
        {auto && (
          <div style={{ position: "absolute", top: 4, left: 4 }}>
            <AutoFolderMenu category={category!} segments={pathSegments!} items={items} meta={folderMeta!} compact />
          </div>
        )}
        <div
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            background: "rgba(20,18,28,0.72)",
            border: "1px solid rgba(255,255,255,0.25)",
            borderRadius: 999,
            padding: "2px 8px",
            fontSize: 13,
            fontWeight: 700,
            color: "white",
          }}
        >
          {items.length}
        </div>
      </div>
      <div
        style={{
          padding: "6px 9px",
          fontSize: 14,
          fontWeight: 700,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          borderTop: "1px solid var(--border-strong)",
        }}
      >
        📁 {shownName}
      </div>
    </div>
  );
}

// Per explicit instruction — Library's own home page used to lay out every
// category's full contents inline, one below the next, forcing a long
// scroll just to see what's there. Now each category is ONE tile here
// (click to drill into its own tree/ungrouped grid, same as a FamilyTile
// drilling into a folder) — see CategoryTile's own doc comment below for
// what that tile's thumbnail actually shows now.

// Per explicit instruction — "in Library's home screen... instead of there
// being 4 different photos smashed into one, generate an image of
// '<category>' and include text on the image of what that category is."
// FamilyTile (the folders you drill INTO) keeps its existing collage; this
// is ONLY the top-level home-screen grid. generatedThumbnailUrl is null
// until index.ts's ensureCategoryThumbnail finishes (it's fire-and-forget,
// triggered the first time any product is ever assigned this category) —
// shown as a plain placeholder meanwhile rather than blocking on it, same
// "show something now, upgrade live once ready" pattern as every other
// async thumbnail in this app. The category's own name is no longer
// repeated as a caption below the image once it HAS a generated
// thumbnail — it's already baked into the image itself (see
// generateCategoryImage's fixed text-overlay position/font/size) — so
// showing it twice would just be redundant.
function CategoryTile({
  category,
  count,
  items = [],
  generatedThumbnailUrl,
  onOpen,
}: {
  category: string;
  count: number;
  // The category's products: their own photos make the tile's picture (and blank ones get researched when it is seen).
  items?: ProductProfile[];
  generatedThumbnailUrl: string | null;
  onOpen: () => void;
}) {
  const memberImages = items.filter((p) => p.imageUrl).slice(0, 4).map((p) => p.imageUrl as string);
  const categoryRef = useFolderImpression(items, null, !generatedThumbnailUrl && memberImages.length === 0);
  return (
    <div
      ref={categoryRef}
      onClick={onOpen}
      className="card enter"
      style={{
        aspectRatio: "1 / 1",
        padding: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        cursor: "pointer",
        position: "relative",
        border: "1px solid var(--border-strong)",
        background: "var(--gradient-soft)",
      }}
      title={`Open ${category} (${count} item${count === 1 ? "" : "s"})`}
    >
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {generatedThumbnailUrl ? (
          <img
            src={generatedThumbnailUrl}
            alt={category}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : memberImages.length > 0 ? (
          <CollageImage images={memberImages} isLogo={false} />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              fontSize: 34,
              color: "var(--text-dim)",
            }}
          >
            <span className="floaty">🗂️</span>
            <span style={{ fontSize: 13, fontWeight: 700, textAlign: "center", padding: "0 10px" }}>{category}</span>
          </div>
        )}
        <div
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            background: "rgba(20,18,28,0.72)",
            border: "1px solid rgba(255,255,255,0.25)",
            borderRadius: 999,
            padding: "2px 8px",
            fontSize: 13,
            fontWeight: 700,
            color: "white",
          }}
        >
          {count}
        </div>
      </div>
    </div>
  );
}

// What a folder tile drills into — a breadcrumb back up the path (however
// deep it goes: "Xbox > Games > Xbox 360" gets a clickable crumb per
// level, not just one "back" button), this node's own sub-folders as more
// FamilyTiles (so drilling in is recursive — "Games" shows a tile per
// console generation, which itself drills further), and this node's own
// direct products in the same ProductTile grid as the top-level Library
// view, so every action (open, search, delete, blacklist, zoom) still
// works identically on a product no matter how deep it's nested.
function FolderView({
  category,
  segments,
  node,
  librarySize,
  groupThumbnails,
  folderMeta,
  sortBy,
  avgSoldPriceAcrossLibrary,
  onNavigate,
  onOpenProduct,
  onSearchProduct,
  onDeleteProduct,
  onTogglePrioritized,
  folderActions,
}: {
  folderMeta: Map<string, FolderMeta>;
  // Buttons for the person's own folders (new subfolder / rename / delete); absent for the auto-organized ones.
  folderActions?: React.ReactNode;
  category: string;
  segments: string[];
  node: FamilyNode;
  librarySize: number;
  // Path (lowercased) -> image data — see Database's own groupThumbnails
  // state and FamilyTile's groupThumbnailUrl prop below.
  groupThumbnails: Record<string, string>;
  sortBy: LibrarySortBy;
  avgSoldPriceAcrossLibrary: number | null;
  // Pass [] to go all the way back out to the category grid, or a shorter
  // prefix of `segments` to jump back up to that ancestor level.
  onNavigate: (segments: string[]) => void;
  onOpenProduct: (id: string) => void;
  onSearchProduct: (id: string) => Promise<void>;
  onDeleteProduct: (id: string) => void;
  onTogglePrioritized: (id: string) => void;
}) {
  const totalCount = collectAllItems(node).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button className="icon ghost" onClick={() => onNavigate(segments.slice(0, -1))}>
          ← Back to {segments.length > 1 ? folderLabel(folderMeta, category, segments.slice(0, -1)) : category}
        </button>
        <div style={{ fontSize: 15, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ cursor: "pointer" }} onClick={() => onNavigate([])}>
            {category}
          </span>
          {segments.map((seg, i) => (
            <React.Fragment key={i}>
              <span>/</span>
              <span
                style={{ cursor: i < segments.length - 1 ? "pointer" : "default", color: i === segments.length - 1 ? "var(--text)" : undefined }}
                onClick={() => i < segments.length - 1 && onNavigate(segments.slice(0, i + 1))}
              >
                {category === MY_FOLDERS ? seg : folderLabel(folderMeta, category, segments.slice(0, i + 1))}
              </span>
            </React.Fragment>
          ))}
        </div>
        <span style={{ fontSize: 14, color: "var(--text-dim)" }}>({totalCount})</span>
        {folderActions}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${librarySize}px, 1fr))`, gap: 14 }}>
        {sortFamilyNodes(node.children, sortBy).map((child) => (
          <FamilyTile
            key={child.segment}
            family={child.segment}
            items={collectAllItems(child)}
            groupThumbnailUrl={groupThumbnails[child.path.toLowerCase()] ?? null}
            category={category}
            folderMeta={folderMeta}
            pathSegments={[...segments, child.segment]}
            onOpen={() => onNavigate([...segments, child.segment])}
          />
        ))}
        {sortProducts(node.items, sortBy).map((p) => (
          <ProductTile
            key={p.id}
            product={p}
            onClick={() => onOpenProduct(p.id)}
            onSearch={() => onSearchProduct(p.id)}
            onDelete={() => onDeleteProduct(p.id)}
            onTogglePrioritized={() => onTogglePrioritized(p.id)}
            hot={isHotProduct(p, avgSoldPriceAcrossLibrary)}
          />
        ))}
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function BanIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <line x1="5.5" y1="5.5" x2="18.5" y2="18.5" />
    </svg>
  );
}

// Filled when prioritized, plain outline otherwise — see ProductTile's own
// Prioritize button below.
function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2.5 15.09 8.76 22 9.77 17 14.64 18.18 21.52 12 18.27 5.82 21.52 7 14.64 2 9.77 8.91 8.76 12 2.5" />
    </svg>
  );
}

// A square photo tile, not the old horizontal "info box" row — per explicit
// instruction, the grid reads more like a gallery you scan visually than a
// list you read. Deliberately minimal action buttons here (Refresh/Edit
// moved to the detail page you land on after clicking) — the two
// exceptions, overlaid directly on the thumbnail, are the magnifying-glass
// search button (kick off an actual Facebook Marketplace search for this
// product without opening its page) and the trash button (delete it from
// the Database right from the grid) — both one-click, per explicit
// instruction.
function ProductTile({
  product,
  onClick,
  onSearch,
  onDelete,
  onTogglePrioritized,
  hot = false,
}: {
  product: ProductProfile;
  onClick: () => void;
  onSearch: () => Promise<void>;
  onDelete: () => void;
  onTogglePrioritized: () => void;
  // Per explicit instruction — "already has a high sales price and speed":
  // pre-computed by the caller (see isHotProduct/Database's own
  // avgSoldPriceAcrossLibrary), not derived in here, since "high" is only
  // meaningful relative to the rest of the library, not to one product in
  // isolation.
  hot?: boolean;
}) {
  const tileRef = useImpression(product);
  const [searching, setSearching] = useState(false);
  // Per explicit instruction — themed popups only, never window.confirm.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingBlacklist, setConfirmingBlacklist] = useState(false);
  const [blacklisting, setBlacklisting] = useState(false);

  async function handleSearch(e: React.MouseEvent) {
    e.stopPropagation();
    if (searching) return;
    setSearching(true);
    try {
      await onSearch();
    } finally {
      setSearching(false);
    }
  }

  function handleTogglePrioritized(e: React.MouseEvent) {
    e.stopPropagation();
    onTogglePrioritized();
  }

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    setConfirmingDelete(true);
  }

  function handleBlacklistClick(e: React.MouseEvent) {
    e.stopPropagation();
    setConfirmingBlacklist(true);
  }

  // Same pattern as Feed's own Blacklist button (ListingCard.tsx) — add the
  // product's own canonical name as a blacklist term (so matching listings
  // get skipped automatically from now on), then remove it from the
  // Library the same way Delete does, since there's no longer a reason to
  // keep researching something the scanner will now skip on sight.
  async function confirmBlacklist() {
    setBlacklisting(true);
    try {
      // Per explicit instruction — "blacklist both the title and the image
      // if possible": this product's own thumbnail, when it has one.
      await api.addBlacklistTerm(product.name, product.imageUrl, product.name);
      onDelete();
    } finally {
      setBlacklisting(false);
      setConfirmingBlacklist(false);
    }
  }

  return (
    <div
      ref={tileRef}
      onClick={() => {
        // The confirm modals below are React children of this card even
        // though they portal elsewhere in the DOM — React still bubbles
        // their backdrop-click-to-close through the React tree, so without
        // this guard dismissing one would also "click through" to navigate
        // into the product's detail page.
        if (confirmingDelete || confirmingBlacklist) return;
        onClick();
      }}
      className="card enter"
      style={{
        aspectRatio: "1 / 1",
        padding: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        cursor: "pointer",
        position: "relative",
      }}
      title="Click to view details"
    >
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {product.imageUrl ? (
          // Per explicit instruction — the ONE deliberate exception (along
          // with Feed's listing cards) to "every image opens a zoomed-in
          // view": clicking the thumbnail here should do the same thing as
          // clicking anywhere else on the tile (open the product), not
          // compete with it for the click. No onClick of its own, so a
          // click just bubbles up to the card's own handler above.
          <img
            src={product.imageUrl}
            alt=""
            loading="lazy"
            className="tile-image"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            onError={(e) => {
              (e.currentTarget as HTMLElement).style.visibility = "hidden";
            }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 30,
              color: "var(--text-dim)",
              background: "var(--bg-elevated)",
            }}
          >
            <span className="floaty">📦</span>
          </div>
        )}
        {/* Per explicit instruction — a manual "this one's noteworthy" flag,
            top-left so it never collides with the search/blacklist/delete
            cluster bottom-right. Purely informational for the AI (see
            types.ts's ProductProfile.prioritized) — never touches the
            Search For list or any filter on its own. */}
        <button
          className="icon"
          onClick={handleTogglePrioritized}
          title={product.prioritized ? "Prioritized — click to unmark" : "Mark as prioritized (noteworthy to Clynx)"}
          style={{
            position: "absolute",
            top: 6,
            left: 6,
            width: 27,
            height: 27,
            padding: 0,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(20,18,28,0.72)",
            border: "1px solid rgba(255,255,255,0.25)",
            color: product.prioritized ? "#facc15" : "white",
          }}
        >
          <StarIcon filled={product.prioritized} />
        </button>
        {hot && (
          <span
            title={`Sells for a high price AND fast (avg. ${product.ebayAvgRunTimeDays !== null && product.ebayAvgRunTimeDays < 1 ? `${(product.ebayAvgRunTimeDays * 24).toFixed(1)}h` : `${product.ebayAvgRunTimeDays?.toFixed(1)}d`} to sell)`}
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              width: 27,
              height: 27,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "50%",
              background: "rgba(20,18,28,0.72)",
              border: "1px solid rgba(255,255,255,0.25)",
              fontSize: 15,
              pointerEvents: "none",
            }}
          >
            🔥
          </span>
        )}
        <button
          className="icon"
          onClick={handleSearch}
          disabled={searching}
          title="Search Facebook Marketplace for this now"
          style={{
            position: "absolute",
            bottom: 6,
            right: 6,
            width: 27,
            height: 27,
            padding: 0,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(20,18,28,0.72)",
            border: "1px solid rgba(255,255,255,0.25)",
            color: "white",
          }}
        >
          {searching ? (
            <span className="typing-dots" style={{ transform: "scale(0.6)" }}>
              <span />
              <span />
              <span />
            </span>
          ) : (
            <SearchIcon />
          )}
        </button>
        <button
          className="icon"
          onClick={handleDelete}
          title="Delete from Database"
          style={{
            position: "absolute",
            bottom: 6,
            right: 37,
            width: 27,
            height: 27,
            padding: 0,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(20,18,28,0.72)",
            border: "1px solid rgba(255,255,255,0.25)",
            color: "var(--danger)",
          }}
        >
          <TrashIcon />
        </button>
        <button
          className="icon"
          onClick={handleBlacklistClick}
          title="Blacklist this product — skip matching listings automatically"
          style={{
            position: "absolute",
            bottom: 6,
            right: 68,
            width: 27,
            height: 27,
            padding: 0,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(20,18,28,0.72)",
            border: "1px solid rgba(255,255,255,0.25)",
            color: "white",
          }}
        >
          <BanIcon />
        </button>
      </div>
      <div
        style={{
          padding: "6px 9px",
          fontSize: 14,
          fontWeight: 600,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          borderTop: "1px solid var(--border)",
        }}
      >
        {product.name}
      </div>
      {product.loading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            color: "white",
            fontSize: 13,
          }}
        >
          <span className="typing-dots">
            <span />
            <span />
            <span />
          </span>
        </div>
      )}
      {confirmingDelete && (
        <Modal title="Delete this product?" onClose={() => setConfirmingDelete(false)}>
          <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.5 }}>
            Delete "{product.name}" and its photo gallery from the Database? This can't be undone.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon" style={{ flex: 1 }} onClick={() => setConfirmingDelete(false)}>
              Cancel
            </button>
            <button
              className="danger-solid"
              style={{ flex: 1 }}
              onClick={() => {
                setConfirmingDelete(false);
                onDelete();
              }}
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
      {confirmingBlacklist && (
        <Modal title="Blacklist this product?" onClose={() => setConfirmingBlacklist(false)}>
          <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.5 }}>
            Add "{product.name}" to the Blacklist? Listings matching this name will be skipped automatically from now
            on, and this removes it from your Library.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon" style={{ flex: 1 }} disabled={blacklisting} onClick={() => setConfirmingBlacklist(false)}>
              Cancel
            </button>
            <button className="danger-solid" style={{ flex: 1 }} disabled={blacklisting} onClick={confirmBlacklist}>
              {blacklisting ? "Blacklisting..." : "Yes, blacklist"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// A growing library of confirmed-genuine reference photos for this product
// — per explicit instruction, the scanner auto-adds one every time it
// confirms a real deal tied to this product (see scrapeEngine.ts), and the
// user can add/remove their own here too. This is what the scanner then
// compares an unmatched, possibly mistitled listing's photos against (see
// vision.ts's referenceProducts), so a bigger, more curated library here
// directly means fewer missed/misidentified listings going forward.
//
// Per explicit instruction — "clean up the way Library pages look... make
// sure that everything fits on one page": this used to be its own
// always-expanded grid section further down the page (ProductImageGallery).
// Pulled into a shared hook instead, so the SAME live list backs both the
// new auto-cycling carousel thumbnail in the header (ReferencePhotoCarousel
// below) and the "click to see more" full grid (ReferencePhotosModal below)
// — adding/deleting in the modal shows up in the carousel immediately,
// rather than each owning its own separate, possibly-stale copy.
// refreshKey: pass the product's updatedAt so photos that land in the
// background (stock photos found right after research finishes) show up
// without having to close and reopen the page.
function useProductImages(productId: string, refreshKey?: number) {
  const [allImages, setAllImages] = useState<ProductImage[]>([]);
  const [adding, setAdding] = useState(false);

  // Condition-awareness — the carousel/modal below are the "what does this
  // normally look like" gallery; a poor-condition/damaged reference photo
  // (see webResearch.ts's findPoorConditionProductImage) would be
  // misleading mixed in there (the auto-cycling header thumbnail showing a
  // beat-up unit as if it were representative), so it's split out here
  // rather than filtered ad hoc at every consumer.
  const images = useMemo(() => allImages.filter((img) => img.kind === "normal"), [allImages]);
  const poorConditionImages = useMemo(() => allImages.filter((img) => img.kind === "poor_condition"), [allImages]);

  const refresh = React.useCallback(() => {
    api.listProductImages(productId).then(setAllImages);
  }, [productId]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  async function add() {
    setAdding(true);
    try {
      const added = await api.addProductImage(productId);
      if (added) setAllImages((prev) => [added, ...prev]);
    } finally {
      setAdding(false);
    }
  }

  async function remove(imageId: string) {
    await api.deleteProductImage(imageId);
    setAllImages((prev) => prev.filter((i) => i.id !== imageId));
  }

  return { images, poorConditionImages, adding, add, remove, refresh };
}

// Per explicit instruction — "the thumbnail in the top left should cycle
// through all the reference photos automatically with a 1s fade transition
// between each image. When a user hovers their cursor over the thumbnail,
// have it so it prompts the user with 'Click to see more images'." Falls
// back to the product's own imageUrl (or the placeholder) when there are no
// reference photos yet to cycle through, same as the old static thumbnail
// did. The fade is a plain opacity dip-and-recover around the swap (0.5s
// out, swap src, 0.5s back in) rather than a true two-layer crossfade —
// simpler to keep correct, and still reads as "a 1s fade transition between
// each image" per what was asked.
function ReferencePhotoCarousel({
  images,
  fallbackImageUrl,
  onClick,
  size = 140,
}: {
  images: ProductImage[];
  fallbackImageUrl: string | null;
  onClick: () => void;
  size?: number;
}) {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);
  const [hovering, setHovering] = useState(false);

  // Reset to the first photo whenever the underlying list changes identity
  // (a different product's page, or this product's own list just refreshed)
  // so a stale index never points past the end.
  useEffect(() => {
    setIndex(0);
    setVisible(true);
  }, [images]);

  useEffect(() => {
    if (images.length < 2) return;
    const FADE_MS = 500;
    const HOLD_MS = 3000;
    let fadeTimeout: ReturnType<typeof setTimeout>;
    const holdInterval = setInterval(() => {
      setVisible(false);
      fadeTimeout = setTimeout(() => {
        setIndex((i) => (i + 1) % images.length);
        setVisible(true);
      }, FADE_MS);
    }, HOLD_MS + FADE_MS);
    return () => {
      clearInterval(holdInterval);
      clearTimeout(fadeTimeout);
    };
  }, [images]);

  const src = images.length > 0 ? (images[index % images.length]?.imageData ?? null) : fallbackImageUrl;

  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={onClick}
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid var(--border)",
        cursor: "pointer",
        background: "var(--bg-elevated)",
        flexShrink: 0,
      }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: visible ? 1 : 0, transition: "opacity 0.5s ease" }}
          onError={(e) => {
            (e.currentTarget as HTMLElement).style.visibility = "hidden";
          }}
        />
      ) : (
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: Math.round(size * 0.26), color: "var(--text-dim)" }}>
          <span className="floaty">📦</span>
        </div>
      )}
      {images.length > 0 && !hovering && (
        <div
          title={imageSource(images[index % images.length]?.sourceTitle).detail ?? undefined}
          style={{
            position: "absolute",
            left: 8,
            bottom: 8,
            maxWidth: "calc(100% - 16px)",
            padding: "3px 9px",
            borderRadius: 999,
            background: "rgba(15, 11, 30, 0.82)",
            border: "1px solid rgba(255, 255, 255, 0.3)",
            color: "#fff",
            fontSize: 11.5,
            fontWeight: 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            pointerEvents: "none",
            opacity: visible ? 1 : 0,
            transition: "opacity 0.5s ease",
          }}
        >
          Source: {imageSource(images[index % images.length]?.sourceTitle).name}
        </div>
      )}
      {hovering && images.length > 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(10,8,20,0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            fontSize: Math.max(12.5, Math.round(size * 0.075)),
            fontWeight: 600,
            color: "white",
            padding: 8,
          }}
        >
          Click to see more images
        </div>
      )}
    </div>
  );
}

// The full reference-photo library, opened from clicking the carousel above
// — same add/delete/zoom-to-lightbox functionality the old always-visible
// grid had, just reached with a click instead of permanently taking up page
// space. Per explicit instruction — "remove the stars": the old ⭐
// "use as this product's thumbnail" button (and its api.setThumbnailFromImage
// call) is gone; everything else here works exactly as before.
function ReferencePhotosModal({
  productId,
  productName,
  allProducts,
  images,
  adding,
  onAdd,
  onRemove,
  onRefresh,
  onClose,
}: {
  productId: string;
  productName: string;
  allProducts: ProductProfile[];
  images: ProductImage[];
  adding: boolean;
  onAdd: () => void;
  onRemove: (imageId: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  // Per explicit instruction — every photo in the app is clickable to zoom
  // in, except Library's tile grid and Feed's listing cards; the zoomed
  // view is also where the "ask about this image"/feedback panel lives.
  const lightbox = useLightbox();

  return (
    <Modal title={`📸 Reference photos (${images.length})`} onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button className="icon ghost" style={{ fontSize: 13 }} disabled={adding} onClick={onAdd}>
          {adding ? "Adding..." : "+ Add photo"}
        </button>
      </div>
      {images.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
          None yet — these build up automatically as the scanner confirms real deals for this product, or add your own.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {images.map((img) => (
            <div key={img.id} style={{ position: "relative", width: 64 }} title={img.sourceTitle ?? undefined}>
              <img
                src={img.imageData}
                alt=""
                onClick={() =>
                  lightbox.open(img.imageData, {
                    subjectName: productName,
                    kind: "reference",
                    imageId: img.id,
                    productId,
                    sourceTitle: img.sourceTitle,
                    onFeedbackApplied: onRefresh,
                  })
                }
                style={{ width: 64, height: 64, borderRadius: 8, objectFit: "cover", border: "1px solid var(--border)", cursor: "zoom-in", opacity: statusBadge(img.status) ? 0.55 : 1 }}
              />
              <div style={{ fontSize: 10, color: "var(--text-dim)", textAlign: "center", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {imageSource(img.sourceTitle).name}
              </div>
              {statusBadge(img.status) && (
                <div style={{ fontSize: 10, textAlign: "center", color: statusBadge(img.status)!.color, fontWeight: 700 }} title="Not used as a reference until you confirm it (Needs review)">
                  {statusBadge(img.status)!.label}
                </div>
              )}
              <PhotoActions image={img} productId={productId} products={allProducts} onChanged={onRefresh} />
              <button
                className="icon"
                title="Delete this reference photo"
                onClick={() => onRemove(img.id)}
                style={{
                  position: "absolute",
                  top: -7,
                  right: -7,
                  width: 22,
                  height: 22,
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "50%",
                  background: "rgba(20,18,28,0.72)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  color: "var(--danger)",
                }}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>
      )}
      {lightbox.node}
    </Modal>
  );
}

// The "separate page" a product tile opens into — full details, editable
// name/writeup, and the SAME Database chat (not a new per-product thread)
// so research can keep going without leaving this product's page.
function ProductDetailPage({
  product,
  allProducts,
  onBack,
  onSelectProduct,
  onRefresh,
  onDelete,
  onSaveEdit,
  onPickThumbnail,
  folders,
}: {
  folders: LibraryFolder[];
  product: ProductProfile;
  // Per explicit instruction — the "Variants" section below needs the
  // whole Library to find this product's own siblings (see
  // findVariantSiblings); Database() already holds this in state for the
  // main grid, so it's just passed down rather than re-fetched here.
  allProducts: ProductProfile[];
  onBack: () => void;
  // Jumps this same detail page to a different product (a clicked
  // variant) without leaving the page — reuses Database()'s own
  // setSelectedProductId, same navigation "Back to Database" already uses.
  onSelectProduct: (id: string) => void;
  onRefresh: () => void;
  onDelete: () => void;
  onSaveEdit: (
    patch: Partial<{
      name: string;
      aiSummary: string;
      resalePriceUsd: number | null;
      resaleTimeToSell: string | null;
      keepThumbnail: boolean;
      desiredPriceUsd: number | null;
      hardCapAtDesiredPrice: boolean;
      prioritized: boolean;
    }>
  ) => void;
  onPickThumbnail: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(product.name);
  // Per explicit instruction — what the user is actually willing to pay.
  // The "Average sale price"/"Typical time to sell" fields that used to
  // live in this same section were removed — redundant now that the
  // eBay/watchcount comps section below shows the real thing automatically
  // — but Desired Price stays, since there's no automatic equivalent for
  // "what YOU consider worth paying." hardCapAtDesiredPrice takes effect
  // immediately on toggle (see scrapeEngine.ts's evaluateListing), not
  // gated behind the Save button, since it's a plain checkbox with nothing
  // to draft.
  const [desiredPriceDraft, setDesiredPriceDraft] = useState(product.desiredPriceUsd !== null ? String(product.desiredPriceUsd) : "");
  // Per explicit instruction — a manual "research eBay comps again" button
  // on this page. Busy state disables the button mid-request; message
  // shows the result inline (success or failure) until the next click.
  // The product prop itself refreshes via the products:updated broadcast
  // the IPC handler sends on success (same mechanism every other edit on
  // this page uses), so there's nothing to do here on success besides
  // clearing busy/showing the message.
  const [ebayCompsBusy, setEbayCompsBusy] = useState(false);
  const [ebayCompsMessage, setEbayCompsMessage] = useState<string | null>(null);
  // Per explicit instruction — "avg. Facebook Marketplace price... only
  // available after the ai has come across the same product multiple
  // times... place this right above eBay sold comps." A live aggregation
  // (see api.getFacebookPriceStats/store.ts's getFacebookPriceStats), not
  // a manually-triggered one like eBay comps — re-fetched whenever this
  // page mounts for a given product or a new listing arrives anywhere in
  // the app (a fresh listing might be the one that just crossed the
  // multiple-sightings threshold for THIS product), rather than needing a
  // "Research now" click.
  const [fbPriceStats, setFbPriceStats] = useState<{ avgPriceUsd: number; sampleSize: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    function refresh() {
      api.getFacebookPriceStats(product.id).then((stats) => {
        if (!cancelled) setFbPriceStats(stats);
      });
    }
    refresh();
    const off = api.onListingsRefresh(refresh);
    return () => {
      cancelled = true;
      off();
    };
  }, [product.id]);

  async function refreshEbayComps() {
    setEbayCompsBusy(true);
    setEbayCompsMessage(null);
    try {
      const result = await api.refreshEbayComps(product.id);
      setEbayCompsMessage(result.message);
    } finally {
      setEbayCompsBusy(false);
    }
  }

  function startEdit() {
    setNameDraft(product.name);
    setEditing(true);
  }

  function save() {
    onSaveEdit({ name: nameDraft });
    setEditing(false);
  }

  function saveResaleInfo() {
    const parsedDesired = desiredPriceDraft.trim() ? Number(desiredPriceDraft) : null;
    onSaveEdit({
      desiredPriceUsd: parsedDesired !== null && Number.isFinite(parsedDesired) ? parsedDesired : null,
    });
  }

  function toggleHardCap(next: boolean) {
    onSaveEdit({ hardCapAtDesiredPrice: next });
  }

  // showGreeting=false — the generic "here's what this box is for" greeting
  // is redundant once you're already on a specific product's own page, per
  // explicit instruction; the main Database screen's chat keeps it.
  // context="product" + productId scope this conversation to just this one
  // product (see chat.ts's buildProductSystemPrompt) — the AI knows which
  // product it's talking about without being told every message, and gets
  // access to add_product_watch_note, which only makes sense here.
  const { chat, draft, setDraft, send, scrollRef, textareaRef, attachments, setAttachments, intake, busy, pickChoice } = useDatabaseChat({ context: "product", productId: product.id });
  // Per explicit instruction — "the thumbnail in the top left should cycle
  // through all the reference photos automatically... when the user clicks
  // the thumbnail, it'll bring up all Reference Photos": one shared list
  // (see useProductImages' own doc comment) backs both the header's
  // auto-cycling ReferencePhotoCarousel and the ReferencePhotosModal it
  // opens into.
  const photos = useProductImages(product.id, product.updatedAt);
  // Condition-awareness — the poor-condition gallery below is small enough
  // (usually one photo, from the single findPoorConditionProductImage
  // search per product) that it opens straight into the same zoomed
  // lightbox every other photo in the app uses, rather than a whole
  // separate grid-modal component like ReferencePhotosModal.
  const poorConditionLightbox = useLightbox();
  const [photosModalOpen, setPhotosModalOpen] = useState(false);
  const [showWatchFlow, setShowWatchFlow] = useState(false);
  // Per explicit instruction — a short excerpt of the AI's own research
  // writeup shown right under the name now ("*brief AI description*" in the
  // layout this was redesigned from) — the full writeup itself still isn't
  // shown/editable here (see the fuller doc comment further down), this is
  // just enough to identify the product at a glance without opening chat.
  const briefDescription = useMemo(() => {
    const trimmed = product.aiSummary.trim();
    // A research that could not run is a state with a plain note, never raw error text (older entries saved "(Research failed: ...)" as their description: those are shown the same way).
    if (product.researchState === "failed" || trimmed.startsWith("(Research failed")) {
      return product.researchNote ?? "The research could not finish just now. Clynx will try this one again by itself, or press Research now.";
    }
    if (!trimmed) return "";
    const firstSentence = trimmed.split(/(?<=[.!?])\s/)[0];
    const brief = firstSentence.length > 160 ? `${firstSentence.slice(0, 157)}…` : firstSentence;
    return product.researchState === "unsourced" ? `${brief} (not confirmed: no web pages were read)` : brief;
  }, [product.aiSummary, product.researchState, product.researchNote]);
  // Per explicit instruction — "for variants/special editions of products,
  // in the original Library listing, include these variants." See
  // findVariantSiblings' own doc comment above for what actually counts as
  // a variant (same base product, different tier — PS5 vs PS5 Pro, not PS5
  // vs an Xbox). Recomputed from the full products list on every render
  // (cheap — a handful of token-set comparisons), so a brand-new variant
  // researched elsewhere shows up here the moment products:updated adds it.
  const variants = useMemo(() => findVariantSiblings(product, allProducts), [product, allProducts]);
  // A specific model (an EVGA XC card) is filed under the general entry it was found as (the plain RTX 3060 Ti):
  // this page shows the specific models under a general entry, and the general entry above a specific model.
  const specificModels = useMemo(() => allProducts.filter((p) => p.parentProductId === product.id), [product.id, allProducts]);
  // What this page shows (itself, its variants, its specific models) shouldn't sit there as blank boxes.
  useEffect(() => {
    requestThumbnails([product, ...variants, ...specificModels]);
  }, [product.id, product.imageUrl, variants, specificModels]);
  const parentProduct = useMemo(
    () => (product.parentProductId ? (allProducts.find((p) => p.id === product.parentProductId) ?? null) : null),
    [product.parentProductId, allProducts]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%" }}>
      <button className="icon ghost" onClick={onBack} style={{ alignSelf: "flex-start" }}>
        ← Back to Database
      </button>

      {/* One merged card — product info and the research chat share a
          single scroll region, with just the composer pinned at the
          bottom, instead of two separate boxes stacked on the page. */}
      <div className="card enter" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: 0, overflow: "hidden" }}>
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", gap: 18, padding: 16, borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
              {/* Per explicit instruction — "make the thumbnail in the top
                  left much larger to compensate" (for the observedNotes/
                  lookoutNotes sections removed from below, freeing up the
                  vertical room this now uses). */}
              <ReferencePhotoCarousel images={photos.images.filter((i) => i.status !== "needs_review" && i.status !== "quarantined")} fallbackImageUrl={product.imageUrl} onClick={() => setPhotosModalOpen(true)} size={400} />
              <button className="icon ghost" style={{ fontSize: 11.5 }} onClick={onPickThumbnail}>
                Change thumbnail
              </button>
              <label
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-muted)" }}
                title="When checked, Refresh/research will never replace this photo"
              >
                <input
                  type="checkbox"
                  checked={product.keepThumbnail}
                  onChange={(e) => onSaveEdit({ keepThumbnail: e.target.checked })}
                />
                Keep thumbnail
              </label>
              {photos.poorConditionImages.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Poor-condition reference</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {photos.poorConditionImages.map((img) => (
                      <img
                        key={img.id}
                        src={img.imageData}
                        alt=""
                        onClick={() =>
                          poorConditionLightbox.open(img.imageData, {
                            subjectName: product.name,
                            kind: "reference",
                            imageId: img.id,
                            productId: product.id,
                            sourceTitle: img.sourceTitle,
                            onFeedbackApplied: photos.refresh,
                          })
                        }
                        style={{ width: 56, height: 56, borderRadius: 8, objectFit: "cover", border: "1px solid var(--warn)", cursor: "zoom-in" }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                {editing ? (
                  <input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    style={{ fontWeight: 700, fontSize: 21, flex: 1, minWidth: 0 }}
                  />
                ) : (
                  <div style={{ fontWeight: 700, fontSize: 21 }}>{product.name}</div>
                )}
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  {editing ? (
                    <>
                      <button className="icon" disabled={!nameDraft.trim()} onClick={save}>
                        Save
                      </button>
                      <button className="icon ghost" onClick={() => setEditing(false)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      {/* Per explicit instruction — "on individual Database
                          product pages, add a 👁 Watch action. Clicking it
                          should open/create a Watch already linked to that
                          product. Prefill relevant information where
                          appropriate... but do NOT silently impose
                          conditions the user didn't choose." Identity is
                          already certain (this exact product), so
                          WatchFormFlow skips straight to its conditions
                          step — only maxPriceUsd is prefilled, from this
                          product's own "what YOU consider worth paying"
                          field, which is exactly what that field is for;
                          profit/discount/age/location stay blank until the
                          user actually sets them. */}
                      <button className="icon" onClick={() => setShowWatchFlow(true)}>
                        👁 Watch
                      </button>
                      <button className="icon" disabled={product.loading} onClick={onRefresh}>
                        {product.loading ? "Researching..." : "Refresh"}
                      </button>
                      <button className="icon" onClick={startEdit}>
                        Edit
                      </button>
                      <button className="icon ghost" title="Remove" onClick={onDelete} style={{ color: "var(--text-dim)" }}>
                        ×
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Per explicit instruction — a "brief AI description" under
                  the name (the new compact layout's own header). The AI's
                  own FULL research writeup (aiSummary) still isn't shown or
                  editable in its entirety here — this is only its first
                  sentence, just enough to identify the product at a glance.
                  observedNotes/lookoutNotes (the "Learned from real listings"/
                  "Watching for" sections that used to render right below
                  this) are deliberately no longer shown at all now — per
                  explicit instruction, "these are for the ai only for its
                  own learning purposes." The underlying fields are untouched
                  (still written by the scanner, still fed into future
                  scoring prompts — see store.ts's appendProductWatchNote and
                  chat.ts's buildProductSystemPrompt) — only this page's
                  display of them was removed. */}
              {briefDescription && !product.loading && (
                <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.4 }}>{briefDescription}</div>
              )}

              {product.loading ? (
                <div className="pill" style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="typing-dots">
                    <span />
                    <span />
                    <span />
                  </span>
                  researching product...
                </div>
              ) : null}
            </div>
          </div>

          <div style={{ padding: "10px 18px", borderBottom: "1px solid var(--border)" }}>
            <OrganizeCard product={product} folders={folders} />
          </div>

          {parentProduct && (
            <div style={{ padding: "10px 18px", borderBottom: "1px solid var(--border)", fontSize: 13.5, color: "var(--text-muted)" }}>
              🔬 A specific model of{" "}
              <button className="icon ghost" style={{ padding: "2px 6px", fontWeight: 700 }} onClick={() => onSelectProduct(parentProduct.id)}>
                {parentProduct.name}
              </button>
            </div>
          )}

          {product.compsValidation && (product.compsValidation.sold || product.compsValidation.active) && (
            <div style={{ padding: "10px 18px", borderBottom: "1px solid var(--border)", fontSize: 12.5, color: "var(--text-muted)" }}>
              <strong style={{ color: "var(--text)" }}>Price check:</strong>{" "}
              {[
                { label: "sold", v: product.compsValidation.sold },
                { label: "asking", v: product.compsValidation.active },
              ]
                .filter((x) => x.v)
                .map((x) => `${x.label}: ${x.v!.retrieved} found, ${x.v!.exact + x.v!.compatible} verified as this product, ${x.v!.uncertain} unsure, ${x.v!.rejected} rejected`)
                .join(" · ")}
              . Only verified results are used for the price.
            </div>
          )}

          {(product.variantEvidence || product.variantClaims.length > 0) && (
            <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", fontSize: 12.5, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 6 }}>
              {product.variantEvidence && (
                <div>
                  <strong style={{ color: product.variantEvidence.status === "verified" || product.variantEvidence.status === "supported" ? "var(--good, var(--text))" : "var(--warn)" }}>
                    {{ verified: "Verified", supported: "Supported", unverified: "Not verified yet", disproven: "Disputed" }[product.variantEvidence.status]}
                  </strong>
                  {": "}
                  {product.variantEvidence.basis}
                  {product.parentProductId ? " Its value comes only from sales of this exact version." : ""}
                </div>
              )}
              {product.variantClaims.length > 0 && (
                <div>
                  <div style={{ fontWeight: 600, color: "var(--text)" }}>Checked but not added as products</div>
                  {product.variantClaims.map((c) => (
                    <div key={c.claim}>
                      "{c.claim}": {{ verified: "verified", supported: "supported", unverified: "not verified (nothing found yet, which does not mean it does not exist)", disproven: "disputed" }[c.status]}. {c.basis}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {specificModels.length > 0 && (
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)", marginBottom: 8 }}>🔬 Specific models ({specificModels.length})</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {specificModels.map((m) => {
                  const value = m.ebayEstimatedValueUsd ?? (m.ebayAvgSoldPriceUsd !== null ? m.ebayAvgSoldPriceUsd + Math.max(0, m.ebayAvgShippingUsd ?? 0) : null);
                  return (
                    <button
                      key={m.id}
                      className="card"
                      onClick={() => onSelectProduct(m.id)}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: 8, width: 260, textAlign: "left", cursor: "pointer", background: "var(--bg-elevated)" }}
                    >
                      <div style={{ width: 48, height: 48, borderRadius: 8, overflow: "hidden", flexShrink: 0, background: "var(--bg)" }}>
                        {m.imageUrl ? (
                          <img src={m.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                        ) : (
                          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>📦</div>
                        )}
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</div>
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{value !== null ? `~$${value.toFixed(0)}` : "No comps yet"}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "8px 0 0" }}>
                Listings that turn out to be a particular brand or model of this product are filed as their own entry, with their own photos and prices.
              </p>
            </div>
          )}

          {variants.length > 0 && (
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)", marginBottom: 8 }}>
                🧩 Variants ({variants.length})
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {variants.map((v) => (
                  <button
                    key={v.id}
                    className="card"
                    onClick={() => onSelectProduct(v.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: 8,
                      width: 220,
                      textAlign: "left",
                      cursor: "pointer",
                      background: "var(--bg-elevated)",
                    }}
                  >
                    <div style={{ width: 48, height: 48, borderRadius: 8, overflow: "hidden", flexShrink: 0, background: "var(--bg)" }}>
                      {v.imageUrl ? (
                        <img src={v.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      ) : (
                        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>
                          📦
                        </div>
                      )}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontSize: 13.5,
                          fontWeight: 700,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {v.name}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {v.ebayAvgSoldPriceUsd !== null ? (
                          <>
                            ${v.ebayAvgSoldPriceUsd.toFixed(0)}
                            {v.ebayAvgRunTimeDays !== null &&
                              ` · ${v.ebayAvgRunTimeDays < 1 ? `${(v.ebayAvgRunTimeDays * 24).toFixed(1)}h` : `${v.ebayAvgRunTimeDays.toFixed(1)}d`}`}
                          </>
                        ) : (
                          "No comps yet"
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "8px 0 0" }}>
                Click a variant to see its own avg. sale price, sell speed, and reference photos.
              </p>
            </div>
          )}

          <AddonsSection product={product} />
          <VariantsFoundSection product={product} />

          {fbPriceStats && (
            <div style={{ padding: "10px 18px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontSize: 14, color: "var(--text)" }}>
                🛒 Avg. Facebook Marketplace Price:{" "}
                <strong>${fbPriceStats.avgPriceUsd.toFixed(0)}</strong>
                <span style={{ color: "var(--text-dim)" }}>
                  {" "}
                  • Based on {fbPriceStats.sampleSize} real listing{fbPriceStats.sampleSize === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          )}

          <EbayValuePanel product={product} busy={ebayCompsBusy} message={ebayCompsMessage} onRefresh={refreshEbayComps} />

          {/* Per explicit instruction — reordered to match the redesigned
              layout: price limit now comes AFTER the two comp/price
              sections above, right before the chat, instead of before them. */}
          <div style={{ padding: "10px 18px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: "var(--text-muted)" }}>
                💰 Set price limit ($)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="e.g. 150"
                  value={desiredPriceDraft}
                  onChange={(e) => setDesiredPriceDraft(e.target.value)}
                  style={{ width: 110 }}
                />
              </label>
              <button className="icon" onClick={saveResaleInfo}>
                Save
              </button>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12.5,
                  color: product.desiredPriceUsd === null ? "var(--text-dim)" : "var(--text)",
                  cursor: product.desiredPriceUsd === null ? "not-allowed" : "pointer",
                }}
                title="Skip any listing recognized as this product priced any higher, no matter how good the discount looks"
              >
                <input
                  type="checkbox"
                  checked={product.hardCapAtDesiredPrice}
                  disabled={product.desiredPriceUsd === null}
                  onChange={(e) => toggleHardCap(e.target.checked)}
                />
                Hard cap
              </label>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--text-dim)", margin: "4px 0 0" }}>
              What YOU consider worth paying for this specific product — trains Clynx toward it, and (with Hard cap)
              can enforce it directly.
            </p>
          </div>

          {chat.map((entry) => (
            <ChatRow key={entry.id} entry={entry} onStop={() => api.cancelChat(entry.id)} onPick={(c, o) => pickChoice(c, o, entry.id)} busy={busy} />
          ))}
        </div>

        <ChatComposer
          draft={draft}
          setDraft={setDraft}
          onSend={send}
          textareaRef={textareaRef}
          attachments={attachments}
          onRemoveAttachment={(i) => setAttachments((a) => a.filter((_, j) => j !== i))}
          intake={intake}
          busy={busy}
          placeholder={`Ask Clynx about this one: 'what should I check before buying?', 'be on the lookout for games', 'refresh the research'`}
        />
      </div>
      {photosModalOpen && (
        <ReferencePhotosModal
          productId={product.id}
          productName={product.name}
          allProducts={allProducts}
          images={photos.images}
          adding={photos.adding}
          onAdd={photos.add}
          onRemove={photos.remove}
          onRefresh={photos.refresh}
          onClose={() => setPhotosModalOpen(false)}
        />
      )}
      {showWatchFlow && (
        <WatchFormFlow
          initial={{
            searchPhrase: product.name,
            linkedProductId: product.id,
            linkedProductName: product.name,
            maxPriceUsd: product.desiredPriceUsd,
          }}
          onClose={() => setShowWatchFlow(false)}
          onSaved={() => setShowWatchFlow(false)}
        />
      )}
    </div>
  );
}

// Shared chat wiring for the Database screen's assistant — same streaming
// mechanism and IPC channels either way, its own local conversation (not
// merged with Dashboard's). Pulled out of ChatPanel so ProductDetailPage
// can drive the exact same chat logic while composing its own merged
// layout (product info + chat history in one scroll region) instead of
// ChatPanel's own self-contained card. showGreeting seeds the "here's what
// this box is for" message — kept on the main Database screen for a
// first-time user, dropped on a product's own page where it's redundant.
// A product research_product touches shows up live via the same
// products:updated event Database() already listens for — the moment the
// backend creates or refreshes the stub, not after a full round trip back
// through this chat reply.
function useDatabaseChat(opts: { context: ChatContext; productId?: string }) {
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const intake = useImageIntake(attachments, setAttachments);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const offChunk = api.onChatChunk((requestId, delta) => {
      setChat((prev) => prev.map((m) => (m.id === requestId ? { ...m, content: m.content + delta } : m)));
    });
    const offDone = api.onChatDone((requestId, full) => {
      setChat((prev) => prev.map((m) => (m.id === requestId ? { ...m, content: full, streaming: false } : m)));
      forgetSteps(requestId);
    });
    const offError = api.onChatError((requestId, message) => {
      setChat((prev) =>
        prev.map((m) => (m.id === requestId ? { ...m, streaming: false, error: true, content: `Error: ${message}` } : m))
      );
    });
    return () => {
      offChunk();
      offDone();
      offError();
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.length]);

  const busy = chat.some((m) => m.streaming);

  function send(textOverride?: string, choice?: { choiceId: string; optionId: string }) {
    const text = (textOverride ?? draft).trim();
    if ((!text && !attachments.length) || busy) return;
    const sent = attachments;
    if (!choice) dismissAllChoices();
    if (textOverride === undefined) setDraft("");
    setAttachments([]);
    intake.clearProblems();
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const history: ChatMessage[] = chat
      .filter((m) => !m.streaming && !m.error)
      .map((m) => ({ role: m.role, content: m.attachments?.length ? `${m.content}\n${attachmentHistoryNote(m.attachments.map((a) => a.name))}`.trim() : m.content }));

    const userMsg: ChatEntry = { id: crypto.randomUUID(), role: "user", content: text, ts: Date.now(), attachments: sent.length ? sent : undefined };
    const requestId = crypto.randomUUID();
    const assistantMsg: ChatEntry = { id: requestId, role: "assistant", content: "", ts: Date.now() + 1, streaming: true };

    setChat((prev) => [...prev, userMsg, assistantMsg]);
    api.startChat(requestId, text, history, opts.context, opts.productId, sent.length ? sent : undefined, choice);
  }

  function pickChoice(c: ChatChoice, o: ChatChoiceOption, requestId: string) {
    dismissChoice(requestId);
    send(o.label, { choiceId: c.id, optionId: o.id });
  }

  return { chat, draft, setDraft, send: () => send(), scrollRef, textareaRef, attachments, setAttachments, intake, busy, pickChoice };
}

// The message-composer row (textarea + Send) — shared between ChatPanel's
// own card and ProductDetailPage's merged one.
function ChatComposer({
  draft,
  setDraft,
  onSend,
  textareaRef,
  placeholder = "e.g. 'what's a PS5 Slim usually worth?' or 'learn about the Steam Deck OLED'",
  attachments,
  onRemoveAttachment,
  intake,
  busy,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  placeholder?: string;
  attachments?: ChatAttachment[];
  onRemoveAttachment?: (index: number) => void;
  intake?: ReturnType<typeof useImageIntake>;
  busy?: boolean;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
      onDrop={intake?.onDrop}
      onDragOver={(e) => intake && e.preventDefault()}
      style={{ display: "flex", flexDirection: "column", gap: 4, padding: 12, borderTop: "1px solid var(--border)" }}
    >
      {intake && attachments && onRemoveAttachment && <AttachmentBar attachments={attachments} problems={intake.problems} onRemove={onRemoveAttachment} />}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
      {intake && <AttachButton onFiles={(f) => void intake.addFiles(f)} disabled={busy} />}
      <textarea
        onPaste={intake?.onPaste}
        ref={textareaRef}
        rows={1}
        style={{ flex: 1, resize: "none", maxHeight: 120, overflowY: "auto", lineHeight: 1.4, padding: "8px 11px" }}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const el = e.target;
          el.style.height = "auto";
          el.style.height = `${el.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      <button className="primary" type="submit" disabled={busy || (!draft.trim() && !(attachments?.length ?? 0))}>
        Send
      </button>
      </div>
    </form>
  );
}

// Matches the deterministic "Searching..." acknowledgment chat.ts returns
// the moment add_search_item succeeds — no AI-authored text, so it gets its
// own look here too, same as the Dashboard's chat panel, since the same
// tool is reachable from this chat as well.
const SEARCH_ACK_RE = /^Searching\.\.\.$/;

function ChatRow({ entry, onStop, onPick, busy }: { entry: ChatEntry; onStop?: () => void; onPick?: (c: ChatChoice, o: ChatChoiceOption) => void; busy?: boolean }) {
  const isUser = entry.role === "user";
  const isSearchAck = !isUser && !entry.streaming && SEARCH_ACK_RE.test(entry.content);
  return (
    <div
      className="enter"
      style={{
        background: isUser ? "transparent" : "var(--bg-elevated)",
        borderBottom: "1px solid var(--border)",
        padding: "12px 16px",
        display: "flex",
        gap: 12,
      }}
    >
      {isUser ? <YouLabel /> : <ClynxAvatar size={24} glyph={isSearchAck ? "🔍" : undefined} />}
      <div style={{ flex: 1, fontSize: 15, lineHeight: 1.5, color: entry.error ? "var(--danger)" : "var(--text)", paddingTop: 2 }}>
        {isSearchAck ? (
          <>
            Searching
            <span className="typing-dots" style={{ marginLeft: 4 }}>
              <span />
              <span />
              <span />
            </span>
          </>
        ) : (
          entry.content
        )}
        {entry.streaming && entry.content && <span className="cursor-blink" />}
        {entry.attachments?.length ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
            {entry.attachments.map((a, i) => (
              <img key={i} src={a.dataUri} alt={a.name} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }} />
            ))}
          </div>
        ) : null}
        {!isUser && (
          <>
            <ChatStatusLine requestId={entry.id} waiting={entry.streaming && !entry.content} onStop={entry.streaming ? onStop : undefined} />
            {!entry.streaming && onPick && <ChatChoiceButtons requestId={entry.id} disabled={busy} onPick={onPick} />}
          </>
        )}
      </div>
    </div>
  );
}
