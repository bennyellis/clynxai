import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ChatAttachment, ChatChoice, ChatChoiceOption, ChatMessage, DiscoveryEntry, DiscoveryThought, ProductProfile } from "../lib/api.js";
import { ChatChoiceButtons, ChatStatusLine } from "../components/ChatExtras.js";
import { attachmentHistoryNote, prepareImages } from "../lib/chatAttachments.js";
import { dismissAllChoices, dismissChoice, forgetSteps } from "../lib/chatExtras.js";
import { api } from "../lib/api.js";
import { DEFAULT_RESALE_SETTINGS, resaleSettingsFrom, type ResaleSettings } from "../../../main/resaleMath.js";
import { judgeProduct, type FlipLevel, type FlipVerdict } from "../../../main/productVerdict.js";
import { automationStamp, buildAutomationStream, buildChatStream, channelOf, chatStamp, hasUnread, type Channel, type ChatTurn } from "../lib/discoveryStream.js";
import { useStickToBottom, type StickPosition } from "../lib/stickToBottom.js";

// The Database's Discovery tab. Left: a live feed of the products Clynx is looking into. Right: two separate channels. "Automation" holds
// Clynx's take on every product it looked into on its own (is it worth flipping, and why or why not); "Chat with Clynx" is the conversation,
// with a box underneath to ask questions, attach photos or files, or hand it a new product to research. Both read oldest first, newest last. This is about the PRODUCTS (what they're worth and how they sell), never about particular
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
  api.onChatDone((id, full) => {
    patchMessage(id, (m) => ({ ...m, content: full, streaming: false }));
    forgetSteps(id);
  });
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

// What this tab remembers while it is unmounted (another Database tab or screen is showing), so coming back finds it as it was left.
const ui: {
  live: DiscoveryEntry[];
  fetched: boolean;
  focus: Focus | null;
  filter: Filter;
  panel: Channel;
  wide: boolean;
  seen: Record<Channel, string> | null;
  chatPos: StickPosition | null;
  autoPos: StickPosition | null;
} = { live: [], fetched: false, focus: null, filter: "all", panel: "chat", wide: true, seen: null, chatPos: null, autoPos: null };
const resetters = new Set<() => void>();

// The Database's home (a second click on its sidebar icon) clears this tab's focus, filter and scroll too.
export function resetDiscoveryUi(): void {
  ui.focus = null;
  ui.filter = "all";
  ui.panel = "chat";
  ui.chatPos = null;
  ui.autoPos = null;
  resetters.forEach((fn) => fn());
}

// Below this width the two channels become tabs instead of sitting side by side.
const SIDE_BY_SIDE_MIN_PX = 760;

// ---------- the tab

export function DiscoveryTab({ products, onOpenProduct }: { products: ProductProfile[]; onOpenProduct: (id: string) => void }) {
  const messages = useThread();
  const [live, setLive] = useState<DiscoveryEntry[]>(ui.live);
  const [focus, setFocusState] = useState<Focus | null>(ui.focus);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [filter, setFilterState] = useState<Filter>(ui.filter);
  const [panel, setPanelState] = useState<Channel>(ui.panel);
  const [wide, setWide] = useState(ui.wide);
  const [focusNonce, setFocusNonce] = useState(0);
  const [settings, setSettings] = useState<ResaleSettings>(DEFAULT_RESALE_SETTINGS);
  const [now, setNow] = useState(() => Date.now());
  const workspaceRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatStick = useStickToBottom<HTMLDivElement>({ initial: ui.chatPos ?? undefined });
  const autoStick = useStickToBottom<HTMLDivElement>({ initial: ui.autoPos ?? undefined });
  // The mount effect below outlives the first render, so it reads the scrollers through a ref rather than closing over stale ones.
  const sticks = useRef({ chatStick, autoStick });
  sticks.current = { chatStick, autoStick };

  const setFocus = (next: Focus | null) => {
    ui.focus = next;
    setFocusState(next);
  };
  const setFilter = (next: Filter) => {
    ui.filter = next;
    setFilterState(next);
  };
  const setPanel = (next: Channel) => {
    ui.panel = next;
    setPanelState(next);
  };

  useEffect(() => {
    ui.live = live;
  }, [live]);

  useEffect(() => {
    wireChatListeners();
    let cancelled = false;
    api.getDiscoveryFeed().then((result) => {
      if (cancelled) return;
      const list = Array.isArray(result) ? result : [];
      // The very first load is history, not news: it must not light the unread dot of a hidden channel.
      if (!ui.fetched) {
        ui.fetched = true;
        const next = { chat: chatStamp(thread, list), automation: automationStamp(list) };
        ui.seen = next;
        setSeen(next);
      }
      setLive(list);
    });
    api.getConfig().then((config) => {
      if (!cancelled && config) setSettings(resaleSettingsFrom(config));
    });
    const off = api.onDiscoveryEntry((entry) => {
      setLive((prev) => [entry, ...prev.filter((e) => e.id !== entry.id)].sort((a, b) => b.startedAt - a.startedAt).slice(0, 40));
    });
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 30_000);
    const reset = () => {
      setFocusState(null);
      setFilterState("all");
      setPanelState("chat");
      sticks.current.chatStick.scrollToBottom();
      sticks.current.autoStick.scrollToBottom();
    };
    resetters.add(reset);
    return () => {
      cancelled = true;
      off();
      clearInterval(tick);
      resetters.delete(reset);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      ui.chatPos = sticks.current.chatStick.getPosition();
      ui.autoPos = sticks.current.autoStick.getPosition();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Side by side when the workspace is wide enough, tabs otherwise. Measured before paint so there is no flash of the wrong layout.
  useLayoutEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const measure = () => {
      const next = el.clientWidth >= SIDE_BY_SIDE_MIN_PX;
      ui.wide = next;
      setWide(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
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

  // The two channels, each oldest first (lib/discoveryStream.ts). The filter chips narrow the Automation channel only.
  const chatItems = useMemo(() => buildChatStream(messages, entries), [messages, entries]);
  const autoItems = useMemo(
    () => buildAutomationStream(entries, (e) => matchesFilter(e)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, filter, verdicts]
  );
  const autoEntries = useMemo(() => entries.filter((e) => channelOf(e) === "automation"), [entries]);

  // Unread dots: on the tab of a channel that is hidden (narrow layout) and has had something new since it was last in view.
  const chatSt = chatStamp(messages, entries);
  const autoSt = automationStamp(entries);
  const [seen, setSeen] = useState<Record<Channel, string>>(() => ui.seen ?? { chat: chatSt, automation: autoSt });
  const chatVisible = wide || panel === "chat";
  const autoVisible = wide || panel === "automation";
  useEffect(() => {
    setSeen((prev) => {
      const next = { chat: chatVisible ? chatSt : prev.chat, automation: autoVisible ? autoSt : prev.automation };
      if (next.chat === prev.chat && next.automation === prev.automation) return prev;
      ui.seen = next;
      return next;
    });
  }, [chatVisible, autoVisible, chatSt, autoSt]);
  const unread = { chat: !chatVisible && hasUnread(chatSt, seen.chat), automation: !autoVisible && hasUnread(autoSt, seen.automation) };

  function showPanel(channel: Channel) {
    setPanel(channel);
  }

  function jumpTo(entry: DiscoveryEntry) {
    const channel = channelOf(entry);
    if (channel === "automation" && !matchesFilter(entry)) setFilter("all");
    showPanel(channel);
    const stick = channel === "chat" ? chatStick : autoStick;
    stick.release();
    // After a filter or tab change the card needs a moment to exist and be laid out.
    setTimeout(() => {
      const scroller = stick.element;
      const el = cardRefs.current.get(entry.id);
      if (!scroller || !el) return;
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTo({ top: Math.max(0, top - 8), behavior: "smooth" });
      setFlashId(entry.id);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashId(null), 1800);
    }, 60);
  }

  // Click on the live feed list: look at that product's card and ask about it next.
  function selectEntry(entry: DiscoveryEntry) {
    setFocus({ entryId: entry.id, productId: entry.productId, name: entry.name });
    jumpTo(entry);
  }

  // "Ask about this" on a card: the question goes to the chat, so the conversation comes to the front and its box takes the cursor.
  function askAbout(entry: DiscoveryEntry) {
    setFocus({ entryId: entry.id, productId: entry.productId, name: entry.name });
    showPanel("chat");
    setFocusNonce((n) => n + 1);
  }

  function askClynx() {
    setFocus(null);
    showPanel("chat");
    chatStick.scrollToBottom();
    setFocusNonce((n) => n + 1);
  }

  const counts = {
    worth: autoEntries.filter((e) => matchesFilter(e, "worth")).length,
    pass: autoEntries.filter((e) => matchesFilter(e, "pass")).length,
  };
  const researchingAuto = autoEntries.filter((e) => e.status === "researching").length;
  const busy = messages.some((m) => m.streaming);

  const renderCard = (entry: DiscoveryEntry) => (
    <ProductCard
      key={`entry-${entry.id}`}
      entry={entry}
      product={productById.get(entry.productId) ?? null}
      verdict={verdicts.get(entry.id) ?? null}
      focused={focus?.entryId === entry.id}
      flash={flashId === entry.id}
      now={now}
      register={(el) => {
        if (el) cardRefs.current.set(entry.id, el);
        else cardRefs.current.delete(entry.id);
      }}
      onAsk={() => askAbout(entry)}
      onOpenProduct={onOpenProduct}
    />
  );

  const tabKeys = (e: React.KeyboardEvent) => {
    const order: Channel[] = ["automation", "chat"];
    const at = order.indexOf(panel);
    let next: Channel | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = order[(at + 1) % order.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = order[(at + order.length - 1) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (!next) return;
    e.preventDefault();
    setPanel(next);
    document.getElementById(`discovery-tab-${next}`)?.focus();
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 360px) minmax(0, 1fr)", gap: 16, height: "100%", minHeight: 0 }}>
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
            onClick={askClynx}
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

      {/* ---- right: two channels. Side by side when there is room, tabs when there is not. They scroll independently, and scanner activity
          never lands inside the conversation. */}
      <div ref={workspaceRef} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0, minHeight: 0 }}>
        {!wide && (
          <div role="tablist" aria-label="Discovery channels" onKeyDown={tabKeys} style={{ display: "flex", gap: 8 }}>
            {(
              [
                ["automation", "Automation"],
                ["chat", "Chat with Clynx"],
              ] as Array<[Channel, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                id={`discovery-tab-${id}`}
                role="tab"
                type="button"
                aria-selected={panel === id}
                aria-controls={`discovery-panel-${id}`}
                tabIndex={panel === id ? 0 : -1}
                className="ghost"
                onClick={() => setPanel(id)}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  padding: "9px 14px",
                  fontWeight: 600,
                  fontSize: 14.5,
                  borderRadius: 10,
                  border: `1px solid ${panel === id ? "var(--accent-1)" : "var(--border)"}`,
                  background: panel === id ? "var(--bg-card-hover)" : "transparent",
                  color: panel === id ? "var(--text)" : "var(--text-muted)",
                }}
              >
                {label}
                {unread[id] && <span className="dot on" role="img" aria-label="new activity" style={{ width: 8, height: 8 }} />}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: wide ? "minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1fr)", gap: 16, flex: 1, minHeight: 0 }}>
          {/* ---- Automation: what Clynx does on its own */}
          <section
            id="discovery-panel-automation"
            role={wide ? "region" : "tabpanel"}
            aria-label="Automation"
            aria-labelledby={wide ? undefined : "discovery-tab-automation"}
            className="card"
            style={{ display: wide || panel === "automation" ? "flex" : "none", flexDirection: "column", padding: 0, overflow: "hidden", minHeight: 0 }}
          >
            <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 17 }}>Automation</div>
                <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>What I find and look into on my own: is each product worth flipping, and why.</div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(
                  [
                    ["all", `All (${autoEntries.length})`],
                    ["worth", `Worth flipping (${counts.worth})`],
                    ["pass", `Not great (${counts.pass})`],
                    ["researching", `Researching (${researchingAuto})`],
                  ] as Array<[Filter, string]>
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className="ghost"
                    aria-pressed={filter === key}
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
            <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
              <div
                ref={autoStick.scrollRef}
                onScroll={autoStick.onScroll}
                data-testid="take-scroll"
                data-stick-bottom=""
                role="log"
                aria-label="Automation activity"
                aria-live="off"
                tabIndex={0}
                style={{ flex: 1, overflowY: "auto", padding: "16px 18px", position: "relative" }}
              >
                <div ref={autoStick.contentRef} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {autoItems.map((item) => renderCard(item.entry))}
                  {autoItems.length === 0 && (
                    <div style={{ color: "var(--text-dim)", fontSize: 14, lineHeight: 1.5 }}>
                      {autoEntries.length > 0 ? "Nothing in this group right now." : "Nothing yet. Products I look into while scanning show up here as they happen."}
                    </div>
                  )}
                </div>
              </div>
              {!autoStick.atBottom && <JumpToLatest label="Jump to latest activity" onClick={autoStick.scrollToBottom} />}
            </div>
          </section>

          {/* ---- Chat with Clynx: your messages, its replies, and research you asked for */}
          <section
            id="discovery-panel-chat"
            role={wide ? "region" : "tabpanel"}
            aria-label="Chat with Clynx"
            aria-labelledby={wide ? undefined : "discovery-tab-chat"}
            className="card"
            style={{ display: wide || panel === "chat" ? "flex" : "none", flexDirection: "column", padding: 0, overflow: "hidden", minHeight: 0 }}
          >
            <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", minHeight: 64 }}>
              <div style={{ fontWeight: 700, fontSize: 17 }}>Chat with Clynx</div>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>Ask about a product, or hand me a new one to research.</div>
            </div>
            <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
              <div
                ref={chatStick.scrollRef}
                onScroll={chatStick.onScroll}
                data-testid="chat-scroll"
                data-stick-bottom=""
                role="log"
                aria-label="Conversation with Clynx"
                aria-live="polite"
                aria-relevant="additions text"
                aria-busy={busy}
                tabIndex={0}
                style={{ flex: 1, overflowY: "auto", padding: "16px 18px", position: "relative" }}
              >
                <div ref={chatStick.contentRef} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <ClynxBubble text={GREETING} />
                  {chatItems.map((item) => (item.kind === "product" ? renderCard(item.entry) : <ChatCard key={item.key} turn={item.turn} />))}
                </div>
              </div>
              {!chatStick.atBottom && <JumpToLatest label="Jump to latest message" onClick={chatStick.scrollToBottom} />}
            </div>
            <Composer
              focus={focus}
              onClearFocus={() => setFocus(null)}
              messages={messages}
              showStarters={messages.length === 0}
              onSent={chatStick.scrollToBottom}
              focusNonce={focusNonce}
            />
          </section>
        </div>
      </div>
    </div>
  );
}

function JumpToLatest({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="icon"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{ position: "absolute", right: 18, bottom: 12, borderRadius: 999, padding: "6px 14px", fontSize: 13, border: "1px solid var(--border-strong)", background: "var(--bg-card)", boxShadow: "0 2px 10px rgba(0,0,0,0.25)" }}
    >
      ↓ Latest
    </button>
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

function ChatCard({ turn }: { turn: ChatTurn<ThreadMsg> }) {
  return (
    <div className="enter" style={{ display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
      {turn.user && <MessageRow msg={turn.user} />}
      {turn.reply && <MessageRow msg={turn.reply} />}
    </div>
  );
}

// The ask box registers how a button press is sent (the buttons live in the message card, the box owns the conversation).
let choiceSender: ((choice: ChatChoice, option: ChatChoiceOption, requestId: string) => void) | null = null;

function MessageRow({ msg }: { msg: ThreadMsg }) {
  const isUser = msg.role === "user";
  return (
    <div role="article" aria-label={isUser ? "You" : msg.error ? "Clynx (error)" : "Clynx"} style={{ display: "flex", gap: 10, alignItems: "flex-start", flexDirection: isUser ? "row-reverse" : "row" }}>
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
        {!isUser && (
          <>
            <ChatStatusLine requestId={msg.id} onStop={msg.streaming ? () => api.cancelChat(msg.id) : undefined} />
            {!msg.streaming && <ChatChoiceButtons requestId={msg.id} onPick={(c, o) => choiceSender?.(c, o, msg.id)} />}
          </>
        )}
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
  focusNonce,
}: {
  focus: Focus | null;
  onClearFocus: () => void;
  messages: ThreadMsg[];
  showStarters: boolean;
  onSent: () => void;
  // Bumped when something outside asks for the cursor to land in the box ("Ask about this", "Ask Clynx").
  focusNonce: number;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ChatAttachment[]>([]);
  const [textFiles, setTextFiles] = useState<PendingText[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = messages.some((m) => m.streaming);
  useEffect(() => {
    if (focusNonce > 0) textareaRef.current?.focus();
  }, [focusNonce]);

  async function addFiles(files: FileList | File[] | null) {
    if (!files || !files.length) return;
    setError(null);
    const nextImages: ChatAttachment[] = [];
    const nextText: PendingText[] = [];
    let problem: string | null = null;
    const imageFiles: File[] = [];
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        imageFiles.push(file);
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
    if (imageFiles.length) {
      // the shared pipeline: what the file really is, redrawn smaller (drops location data), kept inside the send budget
      const r = await prepareImages(imageFiles, images);
      if (r.added.length) setImages((prev) => [...prev, ...r.added]);
      if (r.problems.length) problem = [problem, ...r.problems].filter(Boolean).join(" ");
    }
    if (nextText.length) setTextFiles((prev) => [...prev, ...nextText]);
    if (problem) setError(problem);
  }

  function send(textOverride?: string, choice?: { choiceId: string; optionId: string }) {
    const text = (textOverride ?? draft).trim();
    if ((!text && !images.length && !textFiles.length) || busy) return;
    if (!choice) dismissAllChoices();

    // The model sees the files' text inline; the window only shows their names.
    const fileBlocks = textFiles.map((f) => {
      const body = f.text.length > MAX_TEXT_CHARS ? `${f.text.slice(0, MAX_TEXT_CHARS)}\n[...cut off, the file is longer]` : f.text;
      return `Attached file "${f.name}":\n${body}`;
    });
    const fallback = !text ? (images.length ? "" : "Here's a file. What can you tell me from it?") : text;
    const message = [fallback, ...fileBlocks].filter(Boolean).join("\n\n");

    const history: ChatMessage[] = messages
      .filter((m) => !m.streaming && !m.error)
      .map((m) => ({ role: m.role, content: m.images?.length ? `${m.content}\n${attachmentHistoryNote(m.images.map((a) => a.name))}`.trim() : m.content }));
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

    api.startChat(requestId, message, history, "database", focus?.productId, images, choice);
    if (textOverride === undefined) setDraft("");
    setImages([]);
    setTextFiles([]);
    setError(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    onSent();
  }

  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    choiceSender = (c, o, requestId) => {
      dismissChoice(requestId);
      sendRef.current(o.label, { choiceId: c.id, optionId: o.id });
    };
    return () => {
      choiceSender = null;
    };
  }, []);

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
