import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ChatAttachment, ChatMessage, LogLine, ProductProfile, ScrapeStatus } from "../lib/api.js";
import { api } from "../lib/api.js";

// Same cap vision.ts already applies when downloading a listing's own
// photos — keeping this consistent rather than inventing a different limit
// for a user-attached image.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
// Bounded so one message can't balloon into a huge multi-image request —
// a handful of angles of the same item is the realistic use case, not a
// whole folder.
const MAX_ATTACHMENTS = 4;

function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."));
    reader.readAsDataURL(file);
  });
}

function levelColor(level: LogLine["level"]): string {
  if (level === "error") return "var(--danger)";
  // "greenFlag" shares the same yellow token as "warn" — a real value
  // judgment ("skip" grey vs "greenFlag" yellow vs "deal" green), not a
  // caution — but it's the same color deliberately, both mean "look at
  // this one yourself."
  if (level === "warn" || level === "greenFlag") return "var(--warn)";
  if (level === "deal") return "var(--success)";
  return "var(--text-muted)";
}

interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  streaming?: boolean;
  error?: boolean;
  auto?: "deal" | "batch"; // set when the AI generated this on its own, not in reply to the user
  // Only ever set on the user's own message, and only for display — the
  // actual bytes already went out with the request that created this entry,
  // this is just so the sent photo stays visible in the Activity feed.
  attachments?: ChatAttachment[];
}

type FeedItem = { kind: "log"; ts: number; line: LogLine } | { kind: "chat"; ts: number; entry: ChatEntry };

// Per explicit instruction — Activity used to be a card embedded directly
// in Dashboard; it's now this screen's whole reason for existing. Still
// uses chat context "dashboard" (unchanged — see chat.ts's
// allowedToolNames), so a user chatting from HERE can still change
// Dashboard settings (filters, search items, start/stop the scanner, the
// theme, anything else update_config covers) exactly the same way they
// always could — moving the UI to its own page never touched what tools
// this conversation can call. Dashboard.tsx itself stays fully mounted the
// whole time (see App.tsx's display:none screen-switching), so its own
// Start/Stop/Filters controls are completely unaffected by which screen is
// currently in front — this page just no longer shows them alongside the
// feed.
export function Activity({
  status,
  logs,
  onGoToProduct,
}: {
  status: ScrapeStatus;
  logs: LogLine[];
  // Per explicit instruction — a log line about a specific product (see
  // types.ts's LogLine.productName) should jump straight to that product's
  // own Database page, the same navigation Feed's Research button already
  // uses. Takes a product ID (App.tsx's existing goToProduct) — this
  // component resolves the log line's plain name against the live products
  // list itself (see the products state/effect below) before calling it.
  onGoToProduct: (productId: string) => void;
}) {
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [narrating, setNarrating] = useState(false);
  // Per explicit instruction — lets the user attach a photo of a product
  // they don't know the name of and have the assistant identify it (see
  // chat.ts's streamChat/buildDashboardSystemPrompt). Pending until sent —
  // cleared once the message actually goes out.
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const feedScrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Just for resolving a log line's productName to an id on click — not
  // rendered directly, so a plain fetch-once-plus-live-update is enough,
  // same pattern Database.tsx itself uses for its own product list.
  const [products, setProducts] = useState<ProductProfile[]>([]);

  useEffect(() => {
    api.listProducts().then(setProducts);
    const off = api.onProductUpdated((updated) => {
      setProducts((prev) => (prev.some((p) => p.id === updated.id) ? prev.map((p) => (p.id === updated.id ? updated : p)) : [updated, ...prev]));
    });
    return () => {
      off();
    };
  }, []);

  function goToProductByName(name: string) {
    const match = products.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (match) onGoToProduct(match.id);
  }

  async function handleFilesSelected(files: FileList | null) {
    if (!files || !files.length) return;
    setAttachError(null);
    const incoming = Array.from(files);
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setAttachError(`Up to ${MAX_ATTACHMENTS} photos per message.`);
      return;
    }
    const toRead = incoming.slice(0, room);
    if (incoming.length > toRead.length) {
      setAttachError(`Up to ${MAX_ATTACHMENTS} photos per message — only added the first ${toRead.length}.`);
    }
    const results: ChatAttachment[] = [];
    for (const file of toRead) {
      if (!file.type.startsWith("image/")) {
        setAttachError(`"${file.name}" isn't an image — only photos can be analyzed.`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachError(`"${file.name}" is too large (max ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB).`);
        continue;
      }
      try {
        const dataUri = await readFileAsDataUri(file);
        results.push({ dataUri, name: file.name });
      } catch {
        setAttachError(`Couldn't read "${file.name}".`);
      }
    }
    if (results.length) setAttachments((prev) => [...prev, ...results]);
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  useEffect(() => {
    const offChunk = api.onChatChunk((requestId, delta) => {
      setChat((prev) => prev.map((m) => (m.id === requestId ? { ...m, content: m.content + delta } : m)));
    });
    const offDone = api.onChatDone((requestId, full) => {
      // Synced from the final `full` string, not just left as whatever the
      // streamed chunks built up — the main process can decide the actual
      // reply should be a deterministic line (e.g. "Searching for X...")
      // that never went out as chunks at all.
      setChat((prev) => prev.map((m) => (m.id === requestId ? { ...m, content: full, streaming: false } : m)));
    });
    const offError = api.onChatError((requestId, message) => {
      setChat((prev) =>
        prev.map((m) => (m.id === requestId ? { ...m, streaming: false, error: true, content: `Error: ${message}` } : m))
      );
    });
    // The real follow-up to a "Searching..." bubble, once the chat-triggered
    // search actually finishes. Usually replaces that placeholder outright
    // so the bubble goes straight from "Searching..." to what actually
    // happened — but if add_search_item shared its turn with another tool
    // call (e.g. also toggling general-deal detection), the model wrote its
    // own multi-part reply instead of the plain placeholder, so this appends
    // rather than blowing that text away.
    const offSearchUpdate = api.onSearchUpdate((requestId, message) => {
      setChat((prev) =>
        prev.map((m) => (m.id === requestId ? { ...m, content: m.content === "Searching..." ? message : `${m.content}\n\n${message}` } : m))
      );
    });

    const offNarrStart = api.onNarrationStart((requestId, kind) => {
      setNarrating(true);
      setChat((prev) => [...prev, { id: requestId, role: "assistant", content: "", ts: Date.now(), streaming: true, auto: kind }]);
    });
    const offNarrChunk = api.onNarrationChunk((requestId, delta) => {
      setChat((prev) => prev.map((m) => (m.id === requestId ? { ...m, content: m.content + delta } : m)));
    });
    const offNarrDone = api.onNarrationDone((requestId) => {
      setNarrating(false);
      setChat((prev) => prev.map((m) => (m.id === requestId ? { ...m, streaming: false } : m)));
    });
    const offNarrError = api.onNarrationError((requestId) => {
      setNarrating(false);
      // Best-effort commentary — on failure just drop the empty bubble
      // rather than showing an error for something the user never asked for.
      setChat((prev) => prev.filter((m) => m.id !== requestId));
    });

    return () => {
      offChunk();
      offDone();
      offError();
      offSearchUpdate();
      offNarrStart();
      offNarrChunk();
      offNarrDone();
      offNarrError();
    };
  }, []);

  useEffect(() => {
    feedScrollRef.current?.scrollTo({ top: feedScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [logs.length, chat]);

  // Chronological merge — chat messages, AI narration, and raw activity
  // log lines all interleaved in the order they actually happened, rather
  // than split across two panels.
  const feed: FeedItem[] = useMemo(() => {
    const items: FeedItem[] = [
      ...logs.map((line): FeedItem => ({ kind: "log", ts: line.ts, line })),
      ...chat.map((entry): FeedItem => ({ kind: "chat", ts: entry.ts, entry })),
    ];
    items.sort((a, b) => a.ts - b.ts);
    return items;
  }, [logs, chat]);

  // Per explicit instruction — "add animations for when the ai is
  // Analyzing something, maybe a spinning gear." An "Analyzing..." line is
  // "in progress" for as long as this SAME title's later "...done" line
  // hasn't shown up yet in the log — both are fixed, known message shapes
  // from scrapeEngine.ts's runPhotoAnalysis. Recomputed on every new log
  // line, so a row's spinner disappears the instant its matching "done"
  // line lands.
  const analyzingTitles = useMemo(() => {
    const started = new Set<string>();
    const finished = new Set<string>();
    for (const line of logs) {
      const startMatch = line.message.match(/^Analyzing \d+ photo\(s\) for "(.+)"\.\.\.$/);
      if (startMatch) started.add(startMatch[1]);
      const doneMatch = line.message.match(/^Photo analysis for "(.+)" done\.?/);
      if (doneMatch) finished.add(doneMatch[1]);
    }
    const inProgress = new Set<string>();
    for (const title of started) if (!finished.has(title)) inProgress.add(title);
    return inProgress;
  }, [logs]);

  function sendChat() {
    const text = draft.trim();
    // A photo alone is a complete message — "what is this?" is implicit —
    // so this only bails when there's truly nothing to send.
    if (!text && !attachments.length) return;
    setDraft("");
    setAttachments([]);
    setAttachError(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const history: ChatMessage[] = chat
      .filter((m) => !m.streaming && !m.error)
      .map((m) => ({ role: m.role, content: m.content }));

    const userMsg: ChatEntry = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      ts: Date.now(),
      attachments: attachments.length ? attachments : undefined,
    };
    const requestId = crypto.randomUUID();
    const assistantMsg: ChatEntry = { id: requestId, role: "assistant", content: "", ts: Date.now() + 1, streaming: true };

    setChat((prev) => [...prev, userMsg, assistantMsg]);
    api.startChat(requestId, text, history, "dashboard", undefined, attachments);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, height: "100%" }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22 }}>Activity</h1>
        <p style={{ color: "var(--text-muted)", margin: "4px 0 0" }}>
          Everything the scanner finds, plus the same assistant from Dashboard — ask it to search for something, change a
          setting, or anything else, right from here.
        </p>
      </div>

      <div className="card" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 0, overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <strong>Activity</strong>
            {narrating && (
              <span className="pill enter-fade" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span className="dot on" style={{ width: 6, height: 6 }} />
                narrating
              </span>
            )}
          </div>
          {status.currentSearch && (
            <span className="pill">
              {status.currentSearch} · location {status.locationIndex + 1} · {status.listingsThisCycle} checked
            </span>
          )}
        </div>

        <div ref={feedScrollRef} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {feed.length === 0 && (
            <div style={{ color: "var(--text-dim)", padding: "16px 18px" }}>
              No activity yet. Start the scanner from Dashboard, or ask the assistant below to track down a specific item,
              look up what something sells for, or anything else about reselling — it'll chime in here as it finds things
              too.
            </div>
          )}
          {feed.map((item) =>
            item.kind === "log" ? (
              <LogRow
                key={`log-${item.ts}-${item.line.message.slice(0, 20)}`}
                line={item.line}
                onGoToProduct={goToProductByName}
                isAnalyzing={(() => {
                  const m = item.line.message.match(/^Analyzing \d+ photo\(s\) for "(.+)"\.\.\.$/);
                  return !!m && analyzingTitles.has(m[1]);
                })()}
              />
            ) : (
              <ChatRow key={item.entry.id} entry={item.entry} />
            )
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendChat();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14, borderTop: "1px solid var(--border)" }}
        >
          {/* Per explicit instruction — lets the user show the assistant a
              photo of a product they don't know the name of. Pending
              attachments preview above the input, same "remove before you
              commit to it" pattern as everything else in this app. */}
          {(attachments.length > 0 || attachError) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              {attachments.map((a, i) => (
                <div key={i} style={{ position: "relative" }}>
                  <img
                    src={a.dataUri}
                    alt={a.name}
                    title={a.name}
                    style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)", display: "block" }}
                  />
                  <button
                    type="button"
                    className="icon ghost"
                    onClick={() => removeAttachment(i)}
                    title="Remove"
                    style={{
                      position: "absolute",
                      top: -7,
                      right: -7,
                      width: 22,
                      height: 22,
                      padding: 0,
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "var(--bg-card)",
                      border: "1px solid var(--border-strong)",
                      fontSize: 13,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              {attachError && <span style={{ fontSize: 11.5, color: "var(--warn)" }}>{attachError}</span>}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                handleFilesSelected(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="icon ghost"
              title="Attach a photo"
              onClick={() => fileInputRef.current?.click()}
              style={{ padding: "9px 12px" }}
            >
              📎
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              style={{ flex: 1, resize: "none", maxHeight: 160, overflowY: "auto", lineHeight: 1.4, padding: "9px 12px" }}
              placeholder="Message the assistant — e.g. 'find me a Steam Deck OLED', or attach a photo of something you don't know the name of"
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
                  sendChat();
                }
              }}
            />
            <button className="primary" type="submit" disabled={!draft.trim() && !attachments.length}>
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// A raw activity-log line — compact monospace, deliberately understated so
// it doesn't visually compete with ChatRow entries (see below) even at
// high volume (a nationwide location rotation produces a lot of these).
// Per explicit instruction, each event LEVEL gets its own brief animation
// as it first appears (see global.css's log-row-* classes) instead of
// every line sharing the one plain fade.
// A tiny gear, spun continuously (see global.css's spinner-gear) while an
// "Analyzing..." line's matching "...done" line hasn't shown up yet —
// deliberately a plain, un-hover-animated gear (unlike Sidebar's own,
// which bursts on hover) since this one's whole point is signaling
// "in progress" on its own, without needing interaction.
function AnalyzingGearIcon() {
  return (
    <svg
      className="spinner-gear"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// A raw activity-log line — compact monospace, deliberately understated so
// it doesn't visually compete with ChatRow entries even at high volume.
// Per explicit instruction, the WHOLE row is clickable whenever there's
// somewhere to go: an external Facebook listing (listingUrl — set on
// essentially every per-listing line now, see types.ts) or an in-app
// product page (productName — resolved against the live products list by
// the caller's onGoToProduct). A line with neither (a status/summary line
// with no specific listing or product behind it) stays plain text — there's
// nowhere honest to send a click.
function LogRow({
  line,
  onGoToProduct,
  isAnalyzing,
}: {
  line: LogLine;
  onGoToProduct: (name: string) => void;
  isAnalyzing: boolean;
}) {
  const isDeal = line.level === "deal";
  const isGreenFlag = line.level === "greenFlag";
  const animClass =
    line.level === "deal"
      ? "log-row-deal"
      : line.level === "greenFlag"
        ? "log-row-greenFlag"
        : line.level === "error"
          ? "log-row-error"
          : line.level === "warn"
            ? "log-row-warn"
            : "enter-fade";

  const rowStyle: React.CSSProperties = {
    display: "flex",
    gap: 10,
    alignItems: "baseline",
    padding: "3px 18px",
    color: levelColor(line.level),
    fontFamily: "ui-monospace, monospace",
    fontSize: 11.5,
    fontWeight: isDeal || isGreenFlag ? 700 : 400,
    lineHeight: 1.4,
  };

  const content = (
    <>
      <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{new Date(line.ts).toLocaleTimeString()}</span>
      {isAnalyzing && <AnalyzingGearIcon />}
      <span>{line.message}</span>
      {line.listingUrl && (
        <span className="log-row-link-hint" style={{ color: "inherit" }}>
          View listing ↗
        </span>
      )}
      {!line.listingUrl && line.productName && (
        <span className="log-row-link-hint" style={{ color: "inherit" }}>
          Open in Database →
        </span>
      )}
    </>
  );

  if (line.listingUrl) {
    return (
      <a href={line.listingUrl} target="_blank" rel="noreferrer" className={`${animClass} log-row-link`} style={rowStyle}>
        {content}
      </a>
    );
  }
  if (line.productName) {
    return (
      <div className={`${animClass} log-row-link`} style={rowStyle} onClick={() => onGoToProduct(line.productName!)}>
        {content}
      </div>
    );
  }
  return (
    <div className={animClass} style={rowStyle}>
      {content}
    </div>
  );
}

// Full-width, alternating-background rows (ChatGPT-style) instead of
// floating capped-width bubbles — kept deliberately larger/more prominent
// than LogRow above so a chat message or narration still reads clearly as
// its own thing even interleaved with a wall of activity log lines.
// Matches the deterministic "Searching..." acknowledgment chat.ts returns
// the moment add_search_item succeeds — no AI-authored text, so it gets its
// own look (magnifying glass + animated dots) instead of reading like a
// normal streamed reply.
const SEARCH_ACK_RE = /^Searching\.\.\.$/;

function ChatRow({ entry }: { entry: ChatEntry }) {
  const isUser = entry.role === "user";
  const isDealNarration = entry.auto === "deal";
  const isBatchNarration = entry.auto === "batch";
  const isSearchAck = !isUser && !entry.streaming && SEARCH_ACK_RE.test(entry.content);

  return (
    <div
      className="enter"
      style={{
        background: isUser ? "transparent" : "var(--bg-elevated)",
        borderBottom: "1px solid var(--border)",
        padding: "14px 18px",
        display: "flex",
        gap: 12,
      }}
    >
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
          background: isUser ? "var(--gradient-soft)" : isDealNarration ? "var(--success-bg)" : "var(--border)",
          color: isUser ? "var(--text)" : "var(--text-muted)",
        }}
      >
        {isUser ? "Y" : isSearchAck ? "🔍" : isDealNarration ? "✨" : isBatchNarration ? "🔭" : "AI"}
      </div>
      <div style={{ flex: 1, fontSize: 13.5, lineHeight: 1.55, color: entry.error ? "var(--danger)" : "var(--text)", paddingTop: 3 }}>
        {entry.attachments && entry.attachments.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: entry.content ? 8 : 0 }}>
            {entry.attachments.map((a, i) => (
              <img
                key={i}
                src={a.dataUri}
                alt={a.name}
                title={a.name}
                style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }}
              />
            ))}
          </div>
        )}
        {isSearchAck ? (
          <>
            {entry.content.replace(/\.\.\.$/, "")}
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
