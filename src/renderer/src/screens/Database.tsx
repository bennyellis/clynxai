import React, { useEffect, useMemo, useRef, useState } from "react";
import type { BlacklistedImage, BlacklistTerm, ChatContext, ChatMessage, ProductImage, ProductProfile } from "../lib/api.js";
import { api } from "../lib/api.js";
import { Modal } from "../components/Modal.js";
import { useLightbox } from "../components/ImageLightbox.js";
import { ThumbnailSizeSlider, useThumbnailSize } from "../components/ThumbnailSize.js";
import { playTabSwitchSound } from "../lib/sound.js";

// Per explicit instruction — the Database screen is now three clearly
// separated sections instead of one long scrolling page: Research (the
// assistant chat), Library (researched products already in the Database),
// and Blacklist (both the term list and the image gallery). Local to this
// component, not App.tsx's own screen routing, and survives a switch away
// to another top-level screen and back the same way every other bit of
// this screen's own state already does (Database itself never unmounts —
// see App.tsx).
type DatabaseTab = "research" | "library" | "blacklist";

const GREETING =
  'This is the Database. Here, if you need information about a specific product or need the AI to learn more about a specific product (e.g. average sale price, special instructions for that specific product, etc.), type your inquiry into this box.';

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

function buildFamilyTree(products: ProductProfile[]): FamilyNode[] {
  const roots: FamilyNode[] = [];
  for (const p of products) {
    if (!p.family) continue;
    const segments = p.family
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
type LibrarySortBy = "recent" | "priceDesc" | "priceAsc" | "az";

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
  requestedProductId,
  onRequestedProductHandled,
}: {
  // Set by App.tsx when the Feed's Research button asks to jump straight to
  // one product's own page — per explicit instruction, more convenient than
  // landing on the grid and having to find/click it. undefined when this
  // screen is used standalone (kept optional rather than required so this
  // component doesn't strictly depend on App.tsx's navigation plumbing).
  requestedProductId?: string | null;
  onRequestedProductHandled?: () => void;
} = {}) {
  const [tab, setTab] = useState<DatabaseTab>("research");
  const [products, setProducts] = useState<ProductProfile[]>([]);
  // null = show every category (the old behavior). Clicking a category pill
  // below jumps straight to just that section instead of making the user
  // scroll past every other category to find it.
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Set the instant a product tile is clicked — swaps the whole screen to a
  // dedicated detail page for that one product (see ProductDetailPage
  // below), per explicit instruction, rather than expanding inline.
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [showClearAllDialog, setShowClearAllDialog] = useState(false);
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
  const [librarySortBy, setLibrarySortBy] = useState<LibrarySortBy>("recent");
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
  const [viewingPath, setViewingPath] = useState<{ category: string; segments: string[] } | null>(null);
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

  useEffect(() => {
    api.listProducts().then(setProducts);
    const off = api.onProductUpdated((updated) => {
      // Upsert, not update-only — a product created from chat (research_product)
      // never went through a local list-append, so its very first
      // "products:updated" event is the only chance to add it to this
      // screen's list rather than silently no-op on an unknown id.
      setProducts((prev) => (prev.some((p) => p.id === updated.id) ? prev.map((p) => (p.id === updated.id ? updated : p)) : [updated, ...prev]));
    });
    return () => {
      off();
    };
  }, []);

  // Per explicit instruction — a representative photo for a FOLDER-level
  // grouping ("Xbox > Games", "Xbox > Accessories") rather than the
  // family's own brand logo or an arbitrary member's photo — see
  // ensureGroupThumbnail in index.ts and FamilyTile below. Keyed by the
  // lowercased full path, matching store.ts's group_thumbnails table.
  const [groupThumbnails, setGroupThumbnails] = useState<Record<string, string>>({});
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
      const cat = p.category || "Other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(p);
    }
    const categories = [...map.keys()].sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a);
      const bi = CATEGORY_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    return categories.map((category) => {
      const items = map.get(category)!;
      const tree = buildFamilyTree(items);
      const ungrouped = items.filter((p) => !p.family);
      return { category, items, tree, ungrouped };
    });
  }, [products]);

  // Falls back to "show everything" if the selected category disappears
  // (its last product got deleted) rather than silently showing nothing.
  useEffect(() => {
    if (activeCategory && !grouped.some((g) => g.category === activeCategory)) setActiveCategory(null);
  }, [grouped, activeCategory]);

  // Same idea for a folder view left open when its last member gets
  // deleted (or reassigned elsewhere by a fresh research pass) — falls
  // back out to the category grid rather than showing an empty folder.
  useEffect(() => {
    if (!viewingPath) return;
    const tree = grouped.find((g) => g.category === viewingPath.category)?.tree ?? [];
    if (!findFamilyNode(tree, viewingPath.segments)) setViewingPath(null);
  }, [grouped, viewingPath]);

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

  // Falls back to the grid if the open product gets deleted out from under
  // the detail page (e.g. deleted from another window) rather than showing
  // a detail page for a product that no longer exists.
  useEffect(() => {
    if (selectedProductId && !selectedProduct) setSelectedProductId(null);
  }, [selectedProductId, selectedProduct]);

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
        onBack={() => setSelectedProductId(null)}
        onRefresh={() => refresh(selectedProduct.id)}
        onDelete={() => remove(selectedProduct.id)}
        onSaveEdit={(patch) => saveEdit(selectedProduct.id, patch)}
        onPickThumbnail={() => pickThumbnail(selectedProduct.id)}
      />
    );
  }

  const TAB_LABELS: Record<DatabaseTab, string> = { research: "Research", library: "Library", blacklist: "Blacklist" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, height: "100%" }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 30 }}>Database</h1>
        <p style={{ color: "var(--text-muted)", margin: "6px 0 0", fontSize: 15 }}>
          Build a knowledge profile for a product once, reuse it every time scoring runs into it.
        </p>
      </div>

      {/* Per explicit instruction — three clearly separated sections
          instead of one long scrolling page: Research (talk to the
          assistant about products), Library (products already researched),
          Blacklist (both the term list and the image gallery). */}
      <div style={{ display: "flex", gap: 8, borderBottom: "1px solid var(--border)" }}>
        {(Object.keys(TAB_LABELS) as DatabaseTab[]).map((t) => (
          <button
            key={t}
            className="ghost"
            onClick={() => {
              if (tab !== t) playTabSwitchSound();
              setTab(t);
            }}
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
            {t === "research" ? "💬 " : t === "library" ? "📚 " : "🚫 "}
            {TAB_LABELS[t]}
            {t === "library" && products.length > 0 ? ` (${products.length})` : ""}
          </button>
        ))}
      </div>

      {tab === "research" && (
        <div style={{ flex: 1, minHeight: 0 }}>
          <ChatPanel />
        </div>
      )}

      {tab === "library" && (
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 18, paddingRight: 4 }}>
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
              <button className="primary" onClick={() => setShowAddProductDialog(true)}>
                + Add product
              </button>
              <button className="danger" disabled={clearing || !products.length} onClick={() => setShowClearAllDialog(true)}>
                {clearing ? "Clearing..." : "Clear all"}
              </button>
            </div>
          </div>

          {products.length === 0 && (
            <div className="card" style={{ color: "var(--text-dim)" }}>
              No products yet — ask the assistant on the Research tab to look one up, or it'll pick up products on
              its own while scanning.
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
                  sortBy={librarySortBy}
                  avgSoldPriceAcrossLibrary={avgSoldPriceAcrossLibrary}
                  onNavigate={(segments) => setViewingPath(segments.length ? { category: viewingPath.category, segments } : null)}
                  onOpenProduct={setSelectedProductId}
                  onSearchProduct={searchProduct}
                  onDeleteProduct={remove}
                  onTogglePrioritized={togglePrioritized}
                />
              );
            })()
          ) : (
            <>
              {grouped.length > 1 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <CategoryPill label={`All (${products.length})`} active={activeCategory === null} onClick={() => setActiveCategory(null)} />
                  {grouped.map(({ category, items }) => (
                    <CategoryPill
                      key={category}
                      label={`${category} (${items.length})`}
                      active={activeCategory === category}
                      onClick={() => setActiveCategory(activeCategory === category ? null : category)}
                    />
                  ))}
                </div>
              )}

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
                            previewImages={getCategoryPreviewImages(tree, ungrouped, groupThumbnails)}
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

          {showClearAllDialog && (
            <Modal title="Clear the whole Database?" onClose={() => setShowClearAllDialog(false)}>
              <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.5 }}>
                Delete all {products.length} researched product{products.length === 1 ? "" : "s"} and their photo
                galleries? This can't be undone. Your Blacklist and Blacklisted Images are separate and won't be
                touched.
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
                For a product you already know — no AI research runs on it. Clicking Create opens a file picker for an
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
// one when the general-deal AI recognizes an off-topic listing — those show
// a 🤖 marker so the user can tell which ones weren't their own doing and
// remove any that turn out too broad.
function BlacklistSection() {
  const [terms, setTerms] = useState<BlacklistTerm[]>([]);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    api.listBlacklistTerms().then(setTerms);
    const off = api.onBlacklistUpdated(setTerms);
    return () => {
      off();
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
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {terms.map((t) => (
            <span
              key={t.term}
              className="pill"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 4px 4px 10px" }}
            >
              {t.term}
              {t.source === "ai" && <span title="Auto-added by the scanner">🤖</span>}
              <button
                className="icon ghost"
                title="Remove"
                onClick={() => remove(t.term)}
                style={{ padding: "0 4px", fontSize: 14, lineHeight: 1, color: "var(--text-dim)" }}
              >
                ×
              </button>
            </span>
          ))}
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
        Listings the AI skipped after recognizing the photo itself as an ineligible category (a vehicle, real estate,
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
            The AI flagged this as "{pending.category ?? "unrecognized"}" — {pending.reason ?? "no reason given"}. Was it wrong?
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

// Clickable category filter — same active/inactive treatment as the
// Sidebar's nav buttons (gradient-soft fill + strong border when selected)
// so it reads as consistent with the rest of the app rather than a one-off.
function CategoryPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className="ghost"
      onClick={onClick}
      style={{
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 14,
        background: active ? "var(--gradient-soft)" : "transparent",
        border: `1px solid ${active ? "var(--border-strong)" : "var(--border)"}`,
        color: active ? "var(--text)" : "var(--text-muted)",
      }}
    >
      {label}
    </button>
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
  onOpen,
}: {
  family: string;
  items: ProductProfile[];
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
  const logo = isTopLevel ? (items.find((p) => p.familyLogoUrl)?.familyLogoUrl ?? null) : null;
  // Per explicit instruction — "do that for all items that have multiple
  // versions of the same product type, such as different games, different
  // console models/editions": when there's no single brand logo to show
  // instead, collage together up to 4 of this folder's OWN member photos
  // — the actual different games/editions inside it — rather than just
  // whichever one happened to be first.
  const previewImages = logo
    ? [logo]
    : (() => {
        const images: string[] = [];
        if (groupThumbnailUrl) images.push(groupThumbnailUrl);
        for (const p of items) {
          if (images.length >= 4) break;
          if (p.imageUrl && !images.includes(p.imageUrl)) images.push(p.imageUrl);
        }
        return images;
      })();
  return (
    <div
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
      title={`Open ${family} (${items.length} item${items.length === 1 ? "" : "s"})`}
    >
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <CollageImage images={previewImages} isLogo={!!logo} />
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
        📁 {family}
      </div>
    </div>
  );
}

// Per explicit instruction — Library's own home page used to lay out every
// category's full contents inline, one below the next, forcing a long
// scroll just to see what's there. Now each category is ONE tile here
// (click to drill into its own tree/ungrouped grid, same as a FamilyTile
// drilling into a folder), with a genuine photo COLLAGE — up to 4 of its
// own top-level families' representative images tiled together (e.g. a
// "Video Games & Consoles" tile combining the Xbox/PlayStation/Nintendo/
// Razer logos into one square) — rather than a single arbitrary photo, so
// the tile itself hints at everything actually inside it.
function familyRepresentativeImage(node: FamilyNode, groupThumbnails: Record<string, string>): string | null {
  const items = collectAllItems(node);
  const logo = items.find((p) => p.familyLogoUrl)?.familyLogoUrl ?? null;
  return logo ?? groupThumbnails[node.path.toLowerCase()] ?? items.find((p) => p.imageUrl)?.imageUrl ?? null;
}

function getCategoryPreviewImages(tree: FamilyNode[], ungrouped: ProductProfile[], groupThumbnails: Record<string, string>): string[] {
  const images: string[] = [];
  for (const node of tree) {
    if (images.length >= 4) break;
    const img = familyRepresentativeImage(node, groupThumbnails);
    if (img) images.push(img);
  }
  if (images.length < 4) {
    for (const p of ungrouped) {
      if (images.length >= 4) break;
      if (p.imageUrl) images.push(p.imageUrl);
    }
  }
  return images;
}

function CategoryTile({
  category,
  count,
  previewImages,
  onOpen,
}: {
  category: string;
  count: number;
  previewImages: string[];
  onOpen: () => void;
}) {
  return (
    <div
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
        <CollageImage images={previewImages} emptyIcon="🗂️" />
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
      <div
        style={{
          padding: "8px 10px",
          fontSize: 14.5,
          fontWeight: 700,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          borderTop: "1px solid var(--border-strong)",
        }}
      >
        🗂️ {category}
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
  sortBy,
  avgSoldPriceAcrossLibrary,
  onNavigate,
  onOpenProduct,
  onSearchProduct,
  onDeleteProduct,
  onTogglePrioritized,
}: {
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
          ← Back to {segments.length > 1 ? segments[segments.length - 2] : category}
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
                {seg}
              </span>
            </React.Fragment>
          ))}
        </div>
        <span style={{ fontSize: 14, color: "var(--text-dim)" }}>({totalCount})</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${librarySize}px, 1fr))`, gap: 14 }}>
        {sortFamilyNodes(node.children, sortBy).map((child) => (
          <FamilyTile
            key={child.segment}
            family={child.segment}
            items={collectAllItems(child)}
            groupThumbnailUrl={groupThumbnails[child.path.toLowerCase()] ?? null}
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
          title={product.prioritized ? "Prioritized — click to unmark" : "Mark as prioritized (noteworthy to the AI)"}
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
function ProductImageGallery({ productId, productName }: { productId: string; productName: string }) {
  const [images, setImages] = useState<ProductImage[]>([]);
  const [adding, setAdding] = useState(false);
  const [settingThumbnailId, setSettingThumbnailId] = useState<string | null>(null);
  // Per explicit instruction — every photo in the app is clickable to zoom
  // in, except Library's tile grid and Feed's listing cards; the zoomed
  // view is also where the "ask about this image"/feedback panel lives.
  const lightbox = useLightbox();

  const refresh = React.useCallback(() => {
    api.listProductImages(productId).then(setImages);
  }, [productId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function add() {
    setAdding(true);
    try {
      const added = await api.addProductImage(productId);
      if (added) setImages((prev) => [added, ...prev]);
    } finally {
      setAdding(false);
    }
  }

  async function remove(imageId: string) {
    await api.deleteProductImage(imageId);
    setImages((prev) => prev.filter((i) => i.id !== imageId));
  }

  // Per explicit instruction — "give the user the option to use the images
  // from the reference photos while changing a listing's thumbnail." The
  // product's own imageUrl updates via the products:updated broadcast this
  // triggers (see index.ts), picked up by Database.tsx's own listener —
  // nothing to do here beyond firing the request and showing a busy state.
  async function useAsThumbnail(img: ProductImage) {
    setSettingThumbnailId(img.id);
    try {
      await api.setThumbnailFromImage(productId, img.imageData);
    } finally {
      setSettingThumbnailId(null);
    }
  }

  return (
    <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>📸 Reference photos ({images.length})</div>
        <button className="icon ghost" style={{ fontSize: 13 }} disabled={adding} onClick={add}>
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
            <div key={img.id} style={{ position: "relative", width: 64, height: 64 }} title={img.sourceTitle ?? undefined}>
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
                    onFeedbackApplied: refresh,
                  })
                }
                style={{ width: 64, height: 64, borderRadius: 8, objectFit: "cover", border: "1px solid var(--border)", cursor: "zoom-in" }}
              />
              <button
                className="icon"
                title="Use as this product's thumbnail"
                disabled={settingThumbnailId === img.id}
                onClick={() => useAsThumbnail(img)}
                style={{
                  position: "absolute",
                  bottom: -7,
                  left: -7,
                  width: 22,
                  height: 22,
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "50%",
                  background: "rgba(20,18,28,0.72)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  fontSize: 14,
                }}
              >
                ⭐
              </button>
              <button
                className="icon"
                title="Delete this reference photo"
                onClick={() => remove(img.id)}
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
    </div>
  );
}

// The "separate page" a product tile opens into — full details, editable
// name/writeup, and the SAME Database chat (not a new per-product thread)
// so research can keep going without leaving this product's page.
function ProductDetailPage({
  product,
  onBack,
  onRefresh,
  onDelete,
  onSaveEdit,
  onPickThumbnail,
}: {
  product: ProductProfile;
  onBack: () => void;
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
  // Collapsed by default — this log can get long fast (every relevant
  // listing appends to it) and was taking up a lot of page space by
  // default before this.
  const [notesExpanded, setNotesExpanded] = useState(false);
  // Per explicit instruction — a manual "research eBay comps again" button
  // on this page. Busy state disables the button mid-request; message
  // shows the result inline (success or failure) until the next click.
  // The product prop itself refreshes via the products:updated broadcast
  // the IPC handler sends on success (same mechanism every other edit on
  // this page uses), so there's nothing to do here on success besides
  // clearing busy/showing the message.
  const [ebayCompsBusy, setEbayCompsBusy] = useState(false);
  const [ebayCompsMessage, setEbayCompsMessage] = useState<string | null>(null);

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
  const { chat, draft, setDraft, send, scrollRef, textareaRef } = useDatabaseChat({ showGreeting: false, context: "product", productId: product.id });
  // Per explicit instruction — every photo in the app is clickable to zoom
  // in, except Library's tile grid and Feed's listing cards; this page's
  // own main thumbnail isn't the Library grid, so it gets one.
  const lightbox = useLightbox();

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
          <div style={{ display: "flex", gap: 18, padding: 18, borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
              {product.imageUrl ? (
                <img
                  src={product.imageUrl}
                  alt=""
                  onClick={() =>
                    lightbox.open(product.imageUrl!, { subjectName: product.name, kind: "thumbnail", productId: product.id })
                  }
                  style={{ width: 160, height: 160, borderRadius: 12, objectFit: "cover", border: "1px solid var(--border)", cursor: "zoom-in" }}
                  onError={(e) => {
                    (e.currentTarget as HTMLElement).style.visibility = "hidden";
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 160,
                    height: 160,
                    borderRadius: 12,
                    border: "1px solid var(--border)",
                    background: "var(--bg-elevated)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 40,
                    color: "var(--text-dim)",
                  }}
                >
                  <span className="floaty">📦</span>
                </div>
              )}
              <button className="icon ghost" style={{ fontSize: 13 }} onClick={onPickThumbnail}>
                Change thumbnail
              </button>
              <label
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-muted)" }}
                title="When checked, Refresh/research will never replace this photo"
              >
                <input
                  type="checkbox"
                  checked={product.keepThumbnail}
                  onChange={(e) => onSaveEdit({ keepThumbnail: e.target.checked })}
                />
                Keep thumbnail
              </label>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minWidth: 0 }}>
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

              {product.loading ? (
                <div className="pill" style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="typing-dots">
                    <span />
                    <span />
                    <span />
                  </span>
                  researching product...
                </div>
              ) : (
                <>
                  {/* Per explicit instruction — the AI's own big research
                      writeup (aiSummary) is no longer shown or editable
                      here at all: it's the AI's own working knowledge about
                      the product (identification details, common
                      scams/problems, etc.), not something that belongs in
                      the user's own view of their Database. What stays
                      below is real, deal-relevant signal instead — actual
                      observations from listings the scanner has seen. */}
                  {product.observedNotes && (
                    <div className="card enter-fade" style={{ padding: 10, background: "var(--bg-elevated)", fontSize: 14 }}>
                      <button
                        className="icon ghost"
                        onClick={() => setNotesExpanded((v) => !v)}
                        style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "var(--text)", padding: 0 }}
                      >
                        <span style={{ transform: notesExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s ease", display: "inline-block" }}>
                          ▸
                        </span>
                        👁 Learned from real listings while scanning
                      </button>
                      {notesExpanded && (
                        <div style={{ color: "var(--text-muted)", whiteSpace: "pre-wrap", lineHeight: 1.5, marginTop: 8 }}>
                          {product.observedNotes.split("\n---\n").join("\n")}
                        </div>
                      )}
                    </div>
                  )}
                  {product.lookoutNotes && (
                    <div className="card enter-fade" style={{ padding: 10, background: "var(--bg-elevated)", fontSize: 14 }}>
                      <div style={{ fontWeight: 600, marginBottom: 4, color: "var(--text)" }}>🔎 Watching for, in real listings</div>
                      <div style={{ color: "var(--text-muted)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                        {product.lookoutNotes.split("\n---\n").join("\n")}
                      </div>
                    </div>
                  )}
                  {!product.observedNotes && !product.lookoutNotes && (
                    <div style={{ fontSize: 14, color: "var(--text-dim)" }}>Nothing to show yet.</div>
                  )}
                </>
              )}
            </div>
          </div>

          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)", marginBottom: 8 }}>💰 Desired price to pay</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14, color: "var(--text-muted)" }}>
                Desired price to pay ($)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="e.g. 150"
                  value={desiredPriceDraft}
                  onChange={(e) => setDesiredPriceDraft(e.target.value)}
                  style={{ width: 130 }}
                />
              </label>
              <button className="icon" onClick={saveResaleInfo}>
                Save
              </button>
            </div>
            <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "8px 0 0" }}>
              What YOU consider worth paying for this specific product — trains the AI toward it, and (with the hard
              cap below) can enforce it directly. The average sale price and typical time to sell now come from real
              eBay comps automatically (see below), not a manual entry.
            </p>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 14.5,
                marginTop: 10,
                color: product.desiredPriceUsd === null ? "var(--text-dim)" : "var(--text)",
                cursor: product.desiredPriceUsd === null ? "not-allowed" : "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={product.hardCapAtDesiredPrice}
                disabled={product.desiredPriceUsd === null}
                onChange={(e) => toggleHardCap(e.target.checked)}
              />
              Hard cap at desired price — skip any listing recognized as this product priced any higher, no matter how good the discount looks
            </label>
            {product.desiredPriceUsd === null && (
              <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "4px 0 0" }}>Set and save a desired price above to enable this.</p>
            )}
          </div>

          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>📊 eBay sold comps (watchcount.com)</div>
              <button className="icon" disabled={ebayCompsBusy} onClick={refreshEbayComps}>
                {ebayCompsBusy ? "Researching…" : product.ebayCompsCheckedAt !== null ? "Research again" : "Research now"}
              </button>
            </div>
            {ebayCompsMessage && (
              <p style={{ fontSize: 13.5, color: "var(--text-muted)", margin: "0 0 10px" }}>{ebayCompsMessage}</p>
            )}
            {product.ebayCompsCheckedAt === null ? (
              !ebayCompsMessage && (
                <p style={{ fontSize: 14, color: "var(--text-dim)", margin: 0 }}>
                  Not checked yet — click "Research now" to search WatchCount.com for this product's sold eBay comps.
                </p>
              )
            ) : (
              <>
              {product.ebayAvgSoldPriceUsd === null || !product.ebayCompsSampleSize ? (
                <p style={{ fontSize: 14, color: "var(--text-dim)", margin: 0 }}>
                  Checked eBay's sold listings but didn't find any comps confidently matching this exact product (special
                  editions/different bundles get filtered out, not counted).
                </p>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Avg. sold price</div>
                      <div style={{ fontSize: 21, fontWeight: 700 }}>
                        ${product.ebayAvgSoldPriceUsd.toFixed(0)}
                        {product.ebayAvgShippingUsd !== null && (
                          <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-muted)" }}>
                            {" "}
                            {product.ebayAvgShippingUsd === 0 ? "+ free shipping" : `+ $${product.ebayAvgShippingUsd.toFixed(2)} shipping`}
                          </span>
                        )}
                      </div>
                    </div>
                    {product.ebayAvgRunTimeDays !== null && (
                      <div>
                        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Avg. time to sell</div>
                        <div style={{ fontSize: 21, fontWeight: 700 }}>
                          {product.ebayAvgRunTimeDays < 1
                            ? `${(product.ebayAvgRunTimeDays * 24).toFixed(1)}h`
                            : `${product.ebayAvgRunTimeDays.toFixed(1)}d`}
                        </div>
                      </div>
                    )}
                    <div>
                      <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Based on</div>
                      <div style={{ fontSize: 21, fontWeight: 700 }}>
                        {product.ebayCompsSampleSize} comp{product.ebayCompsSampleSize === 1 ? "" : "s"}
                      </div>
                    </div>
                  </div>
                  {/* Per explicit instruction — "sells fairly quickly (<7 days
                      ideally), that's a great sign." Deliberately just this one
                      factual signal (not also comparing against a specific
                      Facebook listing's price, which this general product page
                      has no single one of) — the fuller "underpriced AND sells
                      fast" call already happens per-listing via the app's
                      normal deal scoring. */}
                  {product.ebayAvgRunTimeDays !== null && product.ebayAvgRunTimeDays < 7 && (
                    <div
                      style={{
                        marginTop: 10,
                        padding: "8px 10px",
                        borderRadius: 8,
                        background: "var(--success-bg)",
                        color: "var(--success)",
                        fontSize: 14,
                        fontWeight: 600,
                      }}
                    >
                      🔥 Sells in under a week on eBay — good resale velocity for this one.
                    </div>
                  )}
                </>
              )}
              <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "8px 0 0" }}>
                Checked {new Date(product.ebayCompsCheckedAt).toLocaleDateString()} — recomputed automatically whenever this
                product's research runs again.
              </p>
              </>
            )}
          </div>

          <ProductImageGallery productId={product.id} productName={product.name} />

          {chat.map((entry) => (
            <ChatRow key={entry.id} entry={entry} />
          ))}
        </div>

        <ChatComposer
          draft={draft}
          setDraft={setDraft}
          onSend={send}
          textareaRef={textareaRef}
          placeholder={`e.g. 'be on the lookout for games' or 'refresh the research on this'`}
        />
      </div>
      {lightbox.node}
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
function useDatabaseChat(opts: { showGreeting: boolean; context: ChatContext; productId?: string }) {
  const [chat, setChat] = useState<ChatEntry[]>(
    opts.showGreeting ? [{ id: "greeting", role: "assistant", content: GREETING, ts: Date.now() }] : []
  );
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const offChunk = api.onChatChunk((requestId, delta) => {
      setChat((prev) => prev.map((m) => (m.id === requestId ? { ...m, content: m.content + delta } : m)));
    });
    const offDone = api.onChatDone((requestId, full) => {
      setChat((prev) => prev.map((m) => (m.id === requestId ? { ...m, content: full, streaming: false } : m)));
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

  function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const history: ChatMessage[] = chat
      .filter((m) => m.id !== "greeting" && !m.streaming && !m.error)
      .map((m) => ({ role: m.role, content: m.content }));

    const userMsg: ChatEntry = { id: crypto.randomUUID(), role: "user", content: text, ts: Date.now() };
    const requestId = crypto.randomUUID();
    const assistantMsg: ChatEntry = { id: requestId, role: "assistant", content: "", ts: Date.now() + 1, streaming: true };

    setChat((prev) => [...prev, userMsg, assistantMsg]);
    api.startChat(requestId, text, history, opts.context, opts.productId);
  }

  return { chat, draft, setDraft, send, scrollRef, textareaRef };
}

// The message-composer row (textarea + Send) — shared between ChatPanel's
// own card and ProductDetailPage's merged one.
function ChatComposer({
  draft,
  setDraft,
  onSend,
  textareaRef,
  placeholder = "e.g. 'what's a PS5 Slim usually worth?' or 'learn about the Steam Deck OLED'",
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  placeholder?: string;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
      style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--border)", alignItems: "flex-end" }}
    >
      <textarea
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
      <button className="primary" type="submit" disabled={!draft.trim()}>
        Send
      </button>
    </form>
  );
}

// The main Database screen's standalone chat card — greeting included.
function ChatPanel() {
  const { chat, draft, setDraft, send, scrollRef, textareaRef } = useDatabaseChat({ showGreeting: true, context: "database" });

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", padding: 0, overflow: "hidden", height: 440 }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
        {chat.map((entry) => (
          <ChatRow key={entry.id} entry={entry} />
        ))}
      </div>
      <ChatComposer draft={draft} setDraft={setDraft} onSend={send} textareaRef={textareaRef} />
    </div>
  );
}

// Matches the deterministic "Searching..." acknowledgment chat.ts returns
// the moment add_search_item succeeds — no AI-authored text, so it gets its
// own look here too, same as the Dashboard's chat panel, since the same
// tool is reachable from this chat as well.
const SEARCH_ACK_RE = /^Searching\.\.\.$/;

function ChatRow({ entry }: { entry: ChatEntry }) {
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
      <div
        style={{
          flexShrink: 0,
          width: 24,
          height: 24,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          fontWeight: 700,
          background: isUser ? "var(--gradient-soft)" : "var(--border)",
          color: isUser ? "var(--text)" : "var(--text-muted)",
        }}
      >
        {isUser ? "Y" : isSearchAck ? "🔍" : "AI"}
      </div>
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
        {entry.streaming && !entry.content && (
          <span className="typing-dots">
            <span />
            <span />
            <span />
          </span>
        )}
        {entry.streaming && entry.content && <span className="cursor-blink" />}
      </div>
    </div>
  );
}
