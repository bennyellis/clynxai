import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ChatAttachment, ChatMessage, DiscoveryEntry, DiscoveryThought, ProductProfile } from "../lib/api.js";
import { api } from "../lib/api.js";
import { DEFAULT_RESALE_SETTINGS, resaleSettingsFrom, type ResaleSettings } from "../../../main/resaleMath.js";
import { judgeProduct, type FlipLevel, type FlipVerdict } from "../../../main/productVerdict.js";

// The Database's Discovery tab. Left: a live feed of the products Clynx is looking into. Right: one window that holds Clynx's take on
// every one of them (is it worth flipping, and why or why not), with a box underneath to ask questions, attach photos or files, or
// hand it a new product to research. This is about the PRODUCTS (what they're worth and how they sell), never about particular
// listings or sellers: Discovery is where product knowledge is found, and the Library keeps what it found for looking up later.

const GREETING =
  "Hey, it's Clynx! This is my live feed: every product I look into shows up on the left, and on the right I tell you whether it's worth flipping and why. Ask me about any of them, drop in photos or a file, or tell me about a new product and I'll research it.";
const STARTERS = ["Research the Steam Deck OLED", "What does a used PS5 Slim usually sell for?", "What should I check before buying a used iPhone?"];

const MAX_IMAGES = 4;
const MAX_TEXT_FILES = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 300 * 1024;
const MAX_TEXT_CHARS = 12_000;
const TEXT_EXTENSIONS = /\.(txt|md|csv|tsv|json|log|html?|xml|ya?ml)$/i;
const EARLIER_LIMIT = 25;

// ---------- the conversation (kept at module level so a reply keeps streaming even if the user is on another tab)

interface ThreadMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  streaming?: boolean;
  error?: boolean;
  images?: ChatAttachment[];
  fileNames?: string[];
  // The product the question was about (shown on the card).
  about?: string;
}

let thread: ThreadMsg[] = [];
const subscribers = new Set<() => void>();
let wired = false;

function setThread(next: ThreadMsg[]): void {
  thread = next;
  subscribers.forEach((fn) => fn());
}

function patchMessage(id: string, patch: (m: ThreadMsg) => ThreadMsg): void {
  if (!thread.some((m) => m.id === id)) return;
  setThread(thread.map((m) => (m.id === id ? patch(m) : m)));
}

function wireChatListeners(): void {
  if (wired) return;
  wired = true;
  api.onChatChunk((id, delta) => patchMessage(id, (m) => ({ ...m, content: m.content + delta })));
  api.onChatDone((id, full) => patchMessage(id, (m) => ({ ...m, content: full, streaming: false })));
  api.onChatError((id, message) => patchMessage(id, (m) => ({ ...m, streaming: false, error: true, content: `Error: ${message}` })));
}

function useThread(): ThreadMsg[] {
  return useSyncExternalStore(
    (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    () => thread
  );
}

// ---------- helpers

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."));
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."));
    reader.readAsText(file);
  });
}

const money = (n: number) => `$${Math.round(n)}`;

const SOURCE_LABEL: Record<string, string> = {
  scanner: "Found while scanning",
  you: "You asked",
  refresh: "Re-checking",
  related: "Related product",
  alert: "Checking before an alert",
  bundle: "Part of a bundle",
  variant: "Broken / for-parts",
};

const LEVEL_LABEL: Record<FlipLevel, string> = { strong: "Worth flipping", decent: "Decent", thin: "Marginal", pass: "Pass", unknown: "No data yet" };
const LEVEL_COLOR: Record<FlipLevel, string> = {
  strong: "var(--success)",
  decent: "var(--accent-1)",
  thin: "var(--warn)",
  pass: "var(--danger)",
  unknown: "var(--text-dim)",
};

// A product from before this session (the live feed starts empty at launch): its saved notes stand in for the thoughts.
function earlierEntry(p: ProductProfile): DiscoveryEntry {
  const thoughts: DiscoveryThought[] = [];
  const summary = (p.aiSummary ?? "").replace(/[#*_`>]+/g, "").replace(/\s+/g, " ").trim();
  const failed = summary.startsWith("(Research failed");
  if (failed) {
    thoughts.push({ ts: p.updatedAt, kind: "warn", text: "My last attempt at researching this one didn't work out." });
  } else if (summary) {
    let excerpt = summary.slice(0, 420);
    if (summary.length > 420) {
      const stop = Math.max(excerpt.lastIndexOf(". "), excerpt.lastIndexOf("! "), excerpt.lastIndexOf("? "));
      excerpt = stop > 160 ? excerpt.slice(0, stop + 1) : `${excerpt.trimEnd()}…`;
    }
    thoughts.push({ ts: p.updatedAt, kind: "step", text: excerpt });
  }
  return {
    id: `earlier-${p.id}`,
    productId: p.id,
    name: p.name,
    source: "scanner",
    status: failed ? "failed" : "done",
    startedAt: p.updatedAt,
    finishedAt: p.updatedAt,
    thoughts,
  };
}

type Filter = "all" | "worth" | "pass" | "researching";

interface Focus {
  entryId: string;
  productId: string;
  name: string;
}

type StreamItem = { kind: "product"; ts: number; entry: DiscoveryEntry } | { kind: "chat"; ts: number; user: ThreadMsg; reply: ThreadMsg | null };

// ---------- the tab

export function DiscoveryTab({ products, onOpenProduct }: { products: ProductProfile[]; onOpenProduct: (id: string) => void }) {
  const messages = useThread();
  const [live, setLive] = useState<DiscoveryEntry[]>([]);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [settings, setSettings] = useState<ResaleSettings>(DEFAULT_RESALE_SETTINGS);
  const [now, setNow] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    wireChatListeners();
    let cancelled = false;
    api.getDiscoveryFeed().then((result) => {
      if (!cancelled) setLive(Array.isArray(result) ? result : []);
    });
    api.getConfig().then((config) => {
      if (!cancelled && config) setSettings(resaleSettingsFrom(config));
    });
    const off = api.onDiscoveryEntry((entry) => {
      setLive((prev) => [entry, ...prev.filter((e) => e.id !== entry.id)].sort((a, b) => b.startedAt - a.startedAt).slice(0, 40));
    });
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      off();
      clearInterval(tick);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  const entries = useMemo(() => {
    const liveProducts = new Set(live.map((e) => e.productId));
    const earlier = products
      .filter((p) => !liveProducts.has(p.id) && !p.loading && p.aiSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, EARLIER_LIMIT)
      .map(earlierEntry);
    return [...live, ...earlier];
  }, [live, products]);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const verdicts = useMemo(() => {
    const map = new Map<string, FlipVerdict>();
    for (const e of entries) {
      const p = productById.get(e.productId);
      if (p) map.set(e.id, judgeProduct(p, settings));
    }
    return map;
  }, [entries, productById, settings]);

  const researchingCount = live.filter((e) => e.status === "researching").length;

  function matchesFilter(e: DiscoveryEntry, f: Filter = filter): boolean {
    if (f === "all") return true;
    if (f === "researching") return e.status === "researching";
    const level = verdicts.get(e.id)?.level;
    if (f === "worth") return level === "strong" || level === "decent";
    return level === "pass" || level === "thin";
  }

  // The window's contents, newest first: Clynx's take on each product, and any conversation, in the order they happened.
  const stream = useMemo(() => {
    const items: StreamItem[] = [];
    for (const e of entries) if (matchesFilter(e)) items.push({ kind: "product", ts: e.startedAt, entry: e });
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== "user") continue;
      const next = messages[i + 1];
      items.push({ kind: "chat", ts: messages[i].ts, user: messages[i], reply: next && next.role === "assistant" ? next : null });
    }
    return items.sort((a, b) => b.ts - a.ts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, messages, filter, verdicts]);

  function jumpTo(entry: DiscoveryEntry) {
    if (!matchesFilter(entry)) setFilter("all");
    // After a filter change the card needs a moment to exist.
    setTimeout(() => {
      const scroller = scrollRef.current;
      const el = cardRefs.current.get(entry.id);
      if (!scroller || !el) return;
      scroller.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: "smooth" });
      setFlashId(entry.id);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashId(null), 1800);
    }, 30);
  }

  function selectEntry(entry: DiscoveryEntry) {
    setFocus({ entryId: entry.id, productId: entry.productId, name: entry.name });
    jumpTo(entry);
  }

  const counts = {
    worth: entries.filter((e) => matchesFilter(e, "worth")).length,
    pass: entries.filter((e) => matchesFilter(e, "pass")).length,
  };
  const productCards = stream.filter((i) => i.kind === "product").length;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 360px) 1fr", gap: 16, height: "100%", minHeight: 0 }}>
      {/* ---- left: the feed */}
      <div className="card" style={{ display: "flex", flexDirection: "column", padding: 0, overflow: "hidden", minHeight: 0 }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <strong>Live feed</strong>
          {researchingCount > 0 ? (
            <span className="pill" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="dot on" style={{ width: 6, height: 6 }} />
              {researchingCount} researching
            </span>
          ) : (
            <span style={{ fontSize: 12.5, color: "var(--text-dim)" }}>idle</span>
          )}
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          <FeedRow
            active={focus === null}
            onClick={() => {
              setFocus(null);
              scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
            }}
            thumb={<span style={{ fontSize: 20 }}>💬</span>}
            title="Ask Clynx"
            subtitle="A new product, or anything else"
          />
          {entries.length === 0 && (
            <div style={{ padding: "16px", color: "var(--text-dim)", fontSize: 14, lineHeight: 1.5 }}>
              Nothing yet. As soon as I start looking into a product (while scanning, or when you ask me to) it shows up here with my take on it.
            </div>
          )}
          {entries.map((entry) => {
            const p = productById.get(entry.productId);
            const researching = entry.status === "researching";
            const value = p?.ebayEstimatedValueUsd ?? null;
            return (
              <FeedRow
                key={entry.id}
                active={focus?.entryId === entry.id}
                onClick={() => selectEntry(entry)}
                thumb={
                  p?.imageUrl ? (
                    <img src={p.imageUrl} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  ) : (
                    <span style={{ fontSize: 18 }}>{researching ? "⚙️" : "📦"}</span>
                  )
                }
                title={entry.name}
                subtitle={
                  researching ? (
                    <span style={{ color: "var(--accent-1)" }}>
                      Looking into it
                      <span className="typing-dots" style={{ marginLeft: 4 }}>
                        <span />
                        <span />
                        <span />
                      </span>
                    </span>
                  ) : entry.status === "failed" ? (
                    <span style={{ color: "var(--warn)" }}>Didn't work out · {ago(entry.finishedAt ?? entry.startedAt, now)}</span>
                  ) : (
                    <>
                      {value !== null ? `Worth about ${money(value)} · ` : ""}
                      {ago(entry.finishedAt ?? entry.startedAt, now)}
                    </>
                  )
                }
                badge={entry.id.startsWith("earlier-") ? undefined : SOURCE_LABEL[entry.source]}
              />
            );
          })}
        </div>
      </div>

      {/* ---- right: Clynx's take on every product, plus the ask box */}
      <div className="card" style={{ display: "flex", flexDirection: "column", padding: 0, overflow: "hidden", minHeight: 0 }}>
        <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", minHeight: 64 }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 700, fontSize: 17 }}>Clynx's take</div>
            <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>Is each product worth flipping, and why or why not.</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(
              [
                ["all", `All (${entries.length})`],
                ["worth", `Worth flipping (${counts.worth})`],
                ["pass", `Not great (${counts.pass})`],
                ["researching", `Researching (${researchingCount})`],
              ] as Array<[Filter, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className="ghost"
                onClick={() => setFilter(key)}
                style={{
                  fontSize: 12.5,
                  padding: "4px 11px",
                  borderRadius: 999,
                  border: `1px solid ${filter === key ? "var(--accent-1)" : "var(--border)"}`,
                  color: filter === key ? "var(--text)" : "var(--text-muted)",
                  background: filter === key ? "var(--bg-card-hover)" : "transparent",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div ref={scrollRef} data-testid="take-scroll" style={{ flex: 1, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14, position: "relative" }}>
          {stream.map((item) =>
            item.kind === "product" ? (
              <ProductCard
                key={item.entry.id}
                entry={item.entry}
                product={productById.get(item.entry.productId) ?? null}
                verdict={verdicts.get(item.entry.id) ?? null}
                focused={focus?.entryId === item.entry.id}
                flash={flashId === item.entry.id}
                now={now}
                register={(el) => {
                  if (el) cardRefs.current.set(item.entry.id, el);
                  else cardRefs.current.delete(item.entry.id);
                }}
                onAsk={() => selectEntry(item.entry)}
                onOpenProduct={onOpenProduct}
              />
            ) : (
              <ChatCard key={item.user.id} user={item.user} reply={item.reply} />
            )
          )}
          {productCards === 0 && entries.length > 0 && <div style={{ color: "var(--text-dim)", fontSize: 14 }}>Nothing in this group right now.</div>}
          <ClynxBubble text={GREETING} />
        </div>

        <Composer
          focus={focus}
          onClearFocus={() => setFocus(null)}
          messages={messages}
          showStarters={messages.length === 0}
          onSent={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
        />
      </div>
    </div>
  );
}

function FeedRow({
  active,
  onClick,
  thumb,
  title,
  subtitle,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  thumb: React.ReactNode;
  title: string;
  subtitle: React.ReactNode;
  badge?: string;
}) {
  return (
    <button
      className="ghost"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        textAlign: "left",
        padding: "10px 16px",
        borderRadius: 0,
        borderBottom: "1px solid var(--border)",
        borderLeft: `3px solid ${active ? "var(--accent-1)" : "transparent"}`,
        background: active ? "var(--bg-card-hover)" : "transparent",
      }}
    >
      <div
        style={{
          flexShrink: 0,
          width: 44,
          height: 44,
          borderRadius: 10,
          overflow: "hidden",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {thumb}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 14.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>{subtitle}</div>
        {badge && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2, textTransform: "uppercase", letterSpacing: 0.4 }}>{badge}</div>}
      </div>
    </button>
  );
}

// ---------- one product's card: what Clynx thought while researching it, then its verdict

function ProductCard({
  entry,
  product,
  verdict,
  focused,
  flash,
  now,
  register,
  onAsk,
  onOpenProduct,
}: {
  entry: DiscoveryEntry;
  product: ProductProfile | null;
  verdict: FlipVerdict | null;
  focused: boolean;
  flash: boolean;
  now: number;
  register: (el: HTMLElement | null) => void;
  onAsk: () => void;
  onOpenProduct: (id: string) => void;
}) {
  const researching = entry.status === "researching";
  const isEarlier = entry.id.startsWith("earlier-");
  const level = verdict?.level ?? "unknown";
  const stats = product
    ? [
        product.ebayEstimatedValueUsd !== null ? { label: "Worth", value: money(product.ebayEstimatedValueUsd) } : null,
        product.ebayAvgSoldPriceUsd !== null && (product.ebayCompsSampleSize ?? 0) > 0
          ? { label: `Sold (${product.ebayCompsSampleSize})`, value: money(product.ebayAvgSoldPriceUsd + Math.max(0, product.ebayAvgShippingUsd ?? 0)) }
          : null,
        product.ebayActiveMedianUsd !== null ? { label: `Asking (${product.ebayActiveSampleSize ?? 0})`, value: money(product.ebayActiveMedianUsd) } : null,
        product.ebayAvgRunTimeDays !== null && (product.ebayCompsSampleSize ?? 0) > 0
          ? { label: "Sells in", value: product.ebayAvgRunTimeDays < 1 ? "<1 day" : `${product.ebayAvgRunTimeDays.toFixed(1)} days` }
          : null,
      ].filter((s): s is { label: string; value: string } => s !== null)
    : [];

  return (
    <div
      ref={register}
      data-testid="product-card"
      data-entry={entry.id}
      style={{
        background: "var(--bg-elevated)",
        border: `1px solid ${flash || focused ? "var(--accent-1)" : "var(--border)"}`,
        borderLeft: `4px solid ${researching ? "var(--accent-1)" : LEVEL_COLOR[level]}`,
        borderRadius: 14,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            flexShrink: 0,
            width: 52,
            height: 52,
            borderRadius: 10,
            overflow: "hidden",
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {product?.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: 20 }}>📦</span>}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div data-testid="card-name" style={{ fontWeight: 700, fontSize: 16.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</div>
          <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
            {researching ? "Researching right now" : entry.status === "failed" ? "Research didn't work out" : isEarlier ? "Researched before this session" : `Researched ${ago(entry.finishedAt ?? entry.startedAt, now)}`}
            {!isEarlier && ` · ${SOURCE_LABEL[entry.source]}`}
          </div>
        </div>
        {!researching && verdict && (
          <span
            data-testid="verdict-chip"
            style={{ flexShrink: 0, fontSize: 12.5, fontWeight: 700, padding: "4px 11px", borderRadius: 999, border: `1px solid ${LEVEL_COLOR[level]}`, color: LEVEL_COLOR[level] }}
          >
            {LEVEL_LABEL[level]}
          </span>
        )}
      </div>

      {stats.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {stats.map((s) => (
            <span key={s.label} className="pill">
              <span style={{ color: "var(--text-dim)" }}>{s.label}</span> <strong>{s.value}</strong>
            </span>
          ))}
        </div>
      )}

      {entry.thoughts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {isEarlier && <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>I wasn't thinking about this one during this session, so these are my saved notes.</div>}
          {entry.thoughts.map((t, i) => (
            <ThoughtBubble key={`${t.ts}-${i}`} thought={t} />
          ))}
        </div>
      )}

      {researching ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-dim)", fontSize: 14 }}>
          <span className="spinner-gear">⚙️</span>
          Still digging. I'll give my take once I've looked at the prices
          <span className="typing-dots">
            <span />
            <span />
            <span />
          </span>
        </div>
      ) : verdict ? (
        <VerdictBlock verdict={verdict} />
      ) : null}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="icon ghost" type="button" onClick={onAsk} style={{ fontSize: 13 }}>
          💬 Ask about this
        </button>
        {product && (
          <button className="icon ghost" type="button" onClick={() => onOpenProduct(product.id)} title="Open the saved copy of this product in the Library" style={{ fontSize: 13 }}>
            Open in Library →
          </button>
        )}
      </div>
    </div>
  );
}

function VerdictBlock({ verdict }: { verdict: FlipVerdict }) {
  const color = LEVEL_COLOR[verdict.level];
  const mark = (kind: "good" | "bad" | "info") => (kind === "good" ? "✓" : kind === "bad" ? "✗" : "•");
  const markColor = (kind: "good" | "bad" | "info") => (kind === "good" ? "var(--success)" : kind === "bad" ? "var(--danger)" : "var(--text-dim)");
  return (
    <div data-testid="verdict" style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontWeight: 700, fontSize: 15.5, color }}>{verdict.headline}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {verdict.reasons.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 8, fontSize: 14.5, lineHeight: 1.45 }}>
            <span style={{ flexShrink: 0, width: 14, textAlign: "center", color: markColor(r.kind), fontWeight: 700 }}>{mark(r.kind)}</span>
            <span>{r.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ClynxAvatar() {
  return (
    <div
      style={{
        flexShrink: 0,
        width: 26,
        height: 26,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        fontWeight: 700,
        background: "var(--border)",
        color: "var(--text-muted)",
      }}
    >
      C
    </div>
  );
}

function ClynxBubble({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexShrink: 0 }}>
      <ClynxAvatar />
      <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 14px", fontSize: 15, lineHeight: 1.5, maxWidth: "85%" }}>{text}</div>
    </div>
  );
}

function ThoughtBubble({ thought }: { thought: DiscoveryThought }) {
  const accent =
    thought.kind === "finding" ? "var(--success)" : thought.kind === "warn" ? "var(--warn)" : thought.kind === "reaction" ? "var(--accent-1)" : "var(--border)";
  return (
    <div className="enter" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <ClynxAvatar />
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderLeft: `3px solid ${accent}`,
          borderRadius: 12,
          padding: thought.kind === "reaction" ? "10px 14px" : "8px 13px",
          fontSize: thought.kind === "reaction" ? 16.5 : 14.5,
          lineHeight: 1.5,
          color: thought.kind === "start" ? "var(--text-muted)" : "var(--text)",
          maxWidth: "92%",
        }}
      >
        {thought.text}
      </div>
    </div>
  );
}

// ---------- a question and Clynx's answer, as one card in the same window

function ChatCard({ user, reply }: { user: ThreadMsg; reply: ThreadMsg | null }) {
  return (
    <div className="enter" style={{ display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
      <MessageRow msg={user} />
      {reply && <MessageRow msg={reply} />}
    </div>
  );
}

function MessageRow({ msg }: { msg: ThreadMsg }) {
  const isUser = msg.role === "user";
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexDirection: isUser ? "row-reverse" : "row" }}>
      {isUser ? null : <ClynxAvatar />}
      <div
        style={{
          background: isUser ? "var(--bg-card-hover)" : "var(--bg-elevated)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: "10px 14px",
          fontSize: 15,
          lineHeight: 1.5,
          maxWidth: "85%",
          whiteSpace: "pre-wrap",
          color: msg.error ? "var(--danger)" : "var(--text)",
        }}
      >
        {isUser && msg.about && <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>About {msg.about}</div>}
        {msg.images && msg.images.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: msg.content || msg.fileNames?.length ? 8 : 0 }}>
            {msg.images.map((img, i) => (
              <img key={i} src={img.dataUri} alt={img.name} title={img.name} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }} />
            ))}
          </div>
        )}
        {msg.fileNames && msg.fileNames.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: msg.content ? 8 : 0 }}>
            {msg.fileNames.map((n, i) => (
              <span key={i} className="pill">
                📄 {n}
              </span>
            ))}
          </div>
        )}
        {msg.content}
        {msg.streaming && !msg.content && (
          <span className="typing-dots">
            <span />
            <span />
            <span />
          </span>
        )}
        {msg.streaming && msg.content && <span className="cursor-blink" />}
      </div>
    </div>
  );
}

// ---------- the ask box

interface PendingText {
  name: string;
  text: string;
}

function Composer({
  focus,
  onClearFocus,
  messages,
  showStarters,
  onSent,
}: {
  focus: Focus | null;
  onClearFocus: () => void;
  messages: ThreadMsg[];
  showStarters: boolean;
  onSent: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ChatAttachment[]>([]);
  const [textFiles, setTextFiles] = useState<PendingText[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = messages.some((m) => m.streaming);

  async function addFiles(files: FileList | File[] | null) {
    if (!files || !files.length) return;
    setError(null);
    const nextImages: ChatAttachment[] = [];
    const nextText: PendingText[] = [];
    let problem: string | null = null;
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        if (images.length + nextImages.length >= MAX_IMAGES) {
          problem = `Up to ${MAX_IMAGES} photos per message.`;
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          problem = `"${file.name}" is too large (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB).`;
          continue;
        }
        try {
          nextImages.push({ dataUri: await readAsDataUri(file), name: file.name });
        } catch {
          problem = `Couldn't read "${file.name}".`;
        }
      } else if (file.type.startsWith("text/") || file.type === "application/json" || TEXT_EXTENSIONS.test(file.name)) {
        if (textFiles.length + nextText.length >= MAX_TEXT_FILES) {
          problem = `Up to ${MAX_TEXT_FILES} files per message.`;
          continue;
        }
        if (file.size > MAX_TEXT_FILE_BYTES) {
          problem = `"${file.name}" is too large (max ${MAX_TEXT_FILE_BYTES / 1024}KB of text).`;
          continue;
        }
        try {
          nextText.push({ name: file.name, text: await readAsText(file) });
        } catch {
          problem = `Couldn't read "${file.name}".`;
        }
      } else {
        problem = `I can read photos and text files (txt, csv, md, json). "${file.name}" is something else, so paste the part that matters into the box instead.`;
      }
    }
    if (nextImages.length) setImages((prev) => [...prev, ...nextImages]);
    if (nextText.length) setTextFiles((prev) => [...prev, ...nextText]);
    if (problem) setError(problem);
  }

  function send() {
    const text = draft.trim();
    if ((!text && !images.length && !textFiles.length) || busy) return;

    // The model sees the files' text inline; the window only shows their names.
    const fileBlocks = textFiles.map((f) => {
      const body = f.text.length > MAX_TEXT_CHARS ? `${f.text.slice(0, MAX_TEXT_CHARS)}\n[...cut off, the file is longer]` : f.text;
      return `Attached file "${f.name}":\n${body}`;
    });
    const fallback = !text ? (images.length ? "" : "Here's a file. What can you tell me from it?") : text;
    const message = [fallback, ...fileBlocks].filter(Boolean).join("\n\n");

    const history: ChatMessage[] = messages.filter((m) => !m.streaming && !m.error).map((m) => ({ role: m.role, content: m.content }));
    const requestId = crypto.randomUUID();
    const userMsg: ThreadMsg = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      ts: Date.now(),
      images: images.length ? images : undefined,
      fileNames: textFiles.length ? textFiles.map((f) => f.name) : undefined,
      about: focus?.name,
    };
    const replyMsg: ThreadMsg = { id: requestId, role: "assistant", content: "", ts: Date.now() + 1, streaming: true };
    setThread([...thread, userMsg, replyMsg]);

    api.startChat(requestId, message, history, "database", focus?.productId, images);
    setDraft("");
    setImages([]);
    setTextFiles([]);
    setError(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    onSent();
  }

  const placeholder = focus ? `Ask me about ${focus.name}, or attach photos and files…` : "Tell me a product to research, ask a question, or attach photos and files…";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        // Right side leaves room for the floating Clynx bubble, which would otherwise sit on top of Send.
        padding: "12px 68px 12px 12px",
        borderTop: "1px solid var(--border)",
        outline: dragging ? "2px dashed var(--accent-1)" : "none",
        outlineOffset: -4,
      }}
    >
      {showStarters && !focus && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {STARTERS.map((s) => (
            <button key={s} type="button" className="ghost" onClick={() => setDraft(s)} style={{ fontSize: 13, padding: "5px 11px", border: "1px solid var(--border)", borderRadius: 999 }}>
              {s}
            </button>
          ))}
        </div>
      )}
      {focus && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-muted)" }}>
          <span className="pill" data-testid="focus-chip" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            Asking about <strong>{focus.name}</strong>
            <button type="button" className="icon ghost" onClick={onClearFocus} title="Ask about something else" style={{ padding: "0 4px", fontSize: 14, lineHeight: 1 }}>
              ×
            </button>
          </span>
        </div>
      )}
      {(images.length > 0 || textFiles.length > 0 || error) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {images.map((a, i) => (
            <div key={`i${i}`} style={{ position: "relative" }}>
              <img src={a.dataUri} alt={a.name} title={a.name} style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)", display: "block" }} />
              <RemoveButton onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} />
            </div>
          ))}
          {textFiles.map((f, i) => (
            <span key={`f${i}`} className="pill" style={{ position: "relative", paddingRight: 24 }}>
              📄 {f.name}
              <RemoveButton onClick={() => setTextFiles((prev) => prev.filter((_, j) => j !== i))} inline />
            </span>
          ))}
          {error && <span style={{ fontSize: 12, color: "var(--warn)" }}>{error}</span>}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept="image/*,text/*,.txt,.md,.csv,.tsv,.json,.log,.html,.xml,.yml,.yaml"
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button type="button" className="icon ghost" title="Attach photos or text files" onClick={() => fileRef.current?.click()} style={{ fontSize: 18, padding: "7px 10px" }}>
          📎
        </button>
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
              send();
            }
          }}
        />
        <button className="primary" type="submit" disabled={busy || (!draft.trim() && !images.length && !textFiles.length)}>
          Send
        </button>
      </div>
    </form>
  );
}

function RemoveButton({ onClick, inline }: { onClick: () => void; inline?: boolean }) {
  return (
    <button
      type="button"
      className="icon ghost"
      onClick={onClick}
      title="Remove"
      style={{
        position: "absolute",
        top: inline ? "50%" : -7,
        right: inline ? 4 : -7,
        transform: inline ? "translateY(-50%)" : undefined,
        width: 20,
        height: 20,
        padding: 0,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-card)",
        border: "1px solid var(--border-strong)",
        fontSize: 12,
        lineHeight: 1,
      }}
    >
      ×
    </button>
  );
}
