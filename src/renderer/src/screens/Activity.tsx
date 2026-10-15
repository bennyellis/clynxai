import { AiActivityPanel } from "../components/AiActivityPanel";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatAttachment, ChatMessage, EventStats, LogLine, MetricsSnapshot, ProductProfile, ScrapeStatus, StageStats } from "../lib/api.js";
import { api } from "../lib/api.js";
import { useStickToBottom } from "../lib/stickToBottom.js";
import {
  ACTIVITY_LEVEL_KEY,
  ACTIVITY_VIEW_KEY,
  buildActivityItems,
  buildAskPrompt,
  isRoutineSkip,
  parseActivityView,
  parseLevelFilter,
  type ActivityView,
  type AskableEvent,
  type LevelFilter,
} from "../lib/activityView.js";

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
// Stable, collision-free React keys for log lines. The old key was the
// timestamp plus the first 20 characters of the message, which two lines in
// the same millisecond (a burst of identical skips) could share — React then
// drops or mis-reuses rows. LogLine objects keep their identity for as long
// as they sit in the log, so a WeakMap hands each one a permanent id.
const logKeys = new WeakMap<LogLine, number>();
let nextLogKey = 1;
function logKey(line: LogLine): number {
  let key = logKeys.get(line);
  if (key === undefined) {
    key = nextLogKey++;
    logKeys.set(line, key);
  }
  return key;
}

function readSaved(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSaved(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not persisted: fine
  }
}

// Screen-reader-only (still read aloud, never drawn).
const SR_ONLY: React.CSSProperties = { position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 };

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Just for resolving a log line's productName to an id on click — not
  // rendered directly, so a plain fetch-once-plus-live-update is enough,
  // same pattern Database.tsx itself uses for its own product list.
  // Ids and names only: the whole library (with every photo) used to be loaded here at launch just to turn a name into an id.
  const [products, setProducts] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    api.listProductIndex().then(setProducts);
    const off = api.onProductUpdated((updated) => {
      setProducts((prev) => (prev.some((p) => p.id === updated.id) ? prev.map((p) => (p.id === updated.id ? { id: updated.id, name: updated.name } : p)) : [{ id: updated.id, name: updated.name }, ...prev]));
    });
    return () => {
      off();
    };
  }, []);

  // Stable identity (reads the latest products/callback through a ref) so the
  // memoized log rows below don't all re-render whenever this component does.
  const goToProductRef = useRef({ products, onGoToProduct });
  goToProductRef.current = { products, onGoToProduct };
  const goToProductByName = useCallback((name: string) => {
    const { products: list, onGoToProduct: go } = goToProductRef.current;
    const match = list.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (match) go(match.id);
  }, []);

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

  // Follow new lines only while the reader is parked at the bottom (lib/stickToBottom.ts). It used to scroll on every single new line,
  // which yanked the view away from anything the reader had scrolled up to read, and with a busy scan that is several times a second.
  const stick = useStickToBottom<HTMLDivElement>();

  // Which view is showing: the operational Activity Feed, the conversation with Clynx, or both interleaved (how this screen always worked).
  // The choice is remembered across launches; switching to Chat because you sent a message or asked about an event is not.
  const [view, setViewState] = useState<ActivityView>(() => parseActivityView(readSaved(ACTIVITY_VIEW_KEY)));
  // Beta 12: the screen has two sections: the log + conversation ("Activity") and "AI Activity" (API use, decisions, images and thoughts).
  const [section, setSectionState] = useState<"log" | "ai">(() => (readSaved("clynx.activity.section") === "ai" ? "ai" : "log"));
  function chooseSection(next: "log" | "ai") {
    setSectionState(next);
    try { window.localStorage.setItem("clynx.activity.section", next); } catch { /* a remembered choice is a convenience */ }
  }
  const [level, setLevelState] = useState<LevelFilter>(() => parseLevelFilter(readSaved(ACTIVITY_LEVEL_KEY)));
  function chooseView(next: ActivityView) {
    setViewState(next);
    writeSaved(ACTIVITY_VIEW_KEY, next);
  }
  function chooseLevel(next: LevelFilter) {
    setLevelState(next);
    writeSaved(ACTIVITY_LEVEL_KEY, next);
  }
  // A different view is a different list: start it at its newest end.
  const viewMounted = useRef(false);
  useEffect(() => {
    if (!viewMounted.current) {
      viewMounted.current = true;
      return;
    }
    stick.scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, level]);

  // Routine "skip (...)" lines are by far the most common thing in the log and
  // rarely worth reading; this hides them while keeping deals, warnings,
  // errors, research and chat. Remembered across launches.
  const [showRoutine, setShowRoutine] = useState(() => {
    try {
      return localStorage.getItem("clynx.activity.showRoutine") !== "0";
    } catch {
      return true;
    }
  });
  function toggleRoutine() {
    setShowRoutine((v) => {
      try {
        localStorage.setItem("clynx.activity.showRoutine", v ? "0" : "1");
      } catch {
        // not persisted — fine
      }
      return !v;
    });
  }

  // The rows for the current view, oldest first (lib/activityView.ts): log lines and AI narration are events, the rest is the conversation.
  const feed = useMemo(() => buildActivityItems(logs, chat, { view, showRoutine, level }), [logs, chat, view, showRoutine, level]);

  // The latest finished reply, read out by a screen reader whichever view is showing. The list itself stays quiet (aria-live off): a busy
  // scan would otherwise announce every line.
  const lastReply = useMemo(() => {
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i];
      if (m.role === "assistant" && !m.auto && !m.streaming && m.content) return m;
    }
    return null;
  }, [chat]);

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
    // Sending means you want the conversation: show it, and follow the reply as it streams in.
    if (view !== "chat") setViewState("chat");
    stick.scrollToBottom();

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

  // "Ask Clynx about this" on an event row: the chat opens with a ready-made question in the box. It is only a draft, never sent for you.
  const askAboutEvent = useCallback((event: AskableEvent) => {
    setViewState("chat");
    setDraft(buildAskPrompt(event, (ts) => new Date(ts).toLocaleString()));
    requestAnimationFrame(() => {
      const box = textareaRef.current;
      if (box) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
    });
  }, []);

  // The box grows with its text, including a draft that was filled in for you.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (draft) el.style.height = `${el.scrollHeight}px`;
  }, [draft, view]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, height: "100%" }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 28 }}>Activity</h1>
        <p style={{ color: "var(--text-muted)", margin: "4px 0 0" }}>
          The live scan log, plus Clynx: ask it anything about flipping, or tell it to search for something or change a setting.
        </p>
      </div>

      <div role="group" aria-label="Activity section" style={{ display: "flex", gap: 6 }}>
        {([["log", "Activity"], ["ai", "AI Activity"]] as Array<["log" | "ai", string]>).map(([id, label]) => (
          <button key={id} className="icon ghost" aria-pressed={section === id} onClick={() => chooseSection(id)}
            style={{ padding: "6px 16px", fontSize: 14, border: `1px solid ${section === id ? "var(--accent-1)" : "var(--border)"}`, color: section === id ? "var(--text)" : "var(--text-muted)", background: section === id ? "var(--bg-card-hover)" : "transparent" }}>
            {label}
          </button>
        ))}
      </div>

      {section === "ai" && <AiActivityPanel />}

      <div style={{ display: section === "ai" ? "none" : "contents" }}>
      <MetricsPanel />

      <div className="card" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 0, overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 10,
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <strong>Activity</strong>
            {narrating && (
              <span className="pill enter-fade" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span className="dot on" style={{ width: 6, height: 6 }} />
                narrating
              </span>
            )}
            <div role="group" aria-label="What to show" style={{ display: "flex", gap: 4 }}>
              {(
                [
                  ["all", "All"],
                  ["feed", "Activity Feed"],
                  ["chat", "Chat with Clynx"],
                ] as Array<[ActivityView, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className="ghost"
                  aria-pressed={view === id}
                  onClick={() => chooseView(id)}
                  style={{
                    fontSize: 12.5,
                    padding: "4px 11px",
                    borderRadius: 999,
                    border: `1px solid ${view === id ? "var(--accent-1)" : "var(--border)"}`,
                    color: view === id ? "var(--text)" : "var(--text-muted)",
                    background: view === id ? "var(--bg-card-hover)" : "transparent",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {status.currentSearch && (
              <span className="pill">
                {status.currentSearch} · location {status.locationIndex + 1} · {status.listingsThisCycle} checked
              </span>
            )}
            {view === "feed" && (
              <select aria-label="Which events to show" value={level} onChange={(e) => chooseLevel(parseLevelFilter(e.target.value))} style={{ fontSize: 12.5 }}>
                <option value="all">All events</option>
                <option value="issues">Warnings and errors</option>
                <option value="deals">Deals</option>
              </select>
            )}
            {view !== "chat" && (
              <button
                className="icon ghost"
                onClick={toggleRoutine}
              title={showRoutine ? "Hide the routine \"skip\" lines and keep deals, warnings and research" : "Show every line, including routine skips"}
              style={{ fontSize: 12.5 }}
            >
                {showRoutine ? "Hide skips" : "Show skips"}
              </button>
            )}
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
          <div
            ref={stick.scrollRef}
            onScroll={stick.onScroll}
            data-stick-bottom=""
            role="log"
            aria-label={view === "chat" ? "Conversation with Clynx" : view === "feed" ? "Activity Feed" : "Activity and conversation"}
            aria-live="off"
            tabIndex={0}
            style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}
          >
            <div ref={stick.contentRef} style={{ display: "flex", flexDirection: "column", minHeight: "100%", justifyContent: "flex-end" }}>
              {feed.length === 0 && (
                <div style={{ color: "var(--text-dim)", padding: "16px 18px" }}>
                  {view === "chat"
                    ? "Nothing here yet. Ask me anything below: I can track down a specific item, dig into what something really sells for, or help with anything else about reselling."
                    : view === "feed"
                      ? level !== "all" || !showRoutine
                        ? "No events match this filter."
                        : "No activity yet. Start the scanner from Dashboard, and what it finds will show up here as it happens."
                      : "No activity yet. Start the scanner from Dashboard, or just talk to me below: I can track down a specific item, dig into what something really sells for, or help with anything else about reselling. I'll chime in here as I find things too."}
                </div>
              )}
              {feed.map((item) =>
                item.kind === "log" ? (
                  <LogRowMemo
                    key={`log-${logKey(item.line)}`}
                    line={item.line}
                    onGoToProduct={goToProductByName}
                    onAsk={askAboutEvent}
                    isAnalyzing={(() => {
                      const m = item.line.message.match(/^Analyzing \d+ photo\(s\) for "(.+)"\.\.\.$/);
                      return !!m && analyzingTitles.has(m[1]);
                    })()}
                  />
                ) : (
                  <ChatRow key={item.entry.id} entry={item.entry} onAsk={askAboutEvent} />
                )
              )}
            </div>
          </div>
          {!stick.atBottom && (
            <button
              type="button"
              className="icon"
              onClick={stick.scrollToBottom}
              aria-label="Jump to the latest"
              title="Jump to the latest"
              style={{ position: "absolute", right: 18, bottom: 12, borderRadius: 999, padding: "6px 14px", fontSize: 13, border: "1px solid var(--border-strong)", background: "var(--bg-card)", boxShadow: "0 2px 10px rgba(0,0,0,0.25)" }}
            >
              ↓ Latest
            </button>
          )}
          <div aria-live="polite" aria-atomic="true" style={SR_ONLY}>
            {lastReply ? `Clynx: ${lastReply.content}` : ""}
          </div>
        </div>

        {/* The box belongs to the conversation, so it is hidden in the Activity Feed view (there is nothing to reply to there). */}
        <form
          hidden={view === "feed"}
          onSubmit={(e) => {
            e.preventDefault();
            sendChat();
          }}
          style={{ display: view === "feed" ? "none" : "flex", flexDirection: "column", gap: 8, padding: 14, borderTop: "1px solid var(--border)" }}
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
              placeholder="Talk to Clynx: 'is a used Series S worth flipping?', 'find me a Steam Deck OLED', or attach a photo of something you can't name"
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
    </div>
  );
}

// Per explicit instruction — a compact, collapsible pipeline-metrics panel:
// discovered/evaluated/unique/duplicate rates, dedup cache effectiveness,
// the vision queue, and per-stage latency (nav, extraction, scoring,
// vision, eBay, ...). Pull-based — polls metrics:snapshot every 2s rather
// than a push channel, since these numbers change on every single listing
// evaluation (see preload/index.ts's own doc comment on why). Collapsed by
// default so it doesn't compete with the actual Activity feed for
// attention; the Reset button clears counters to start a fresh
// before/after measurement window (see metrics.ts's resetMetrics).
function MetricsPanel() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [accountLabels, setAccountLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    function poll() {
      api.getMetricsSnapshot().then((s) => {
        if (!cancelled) setSnapshot(s);
      });
    }
    poll();
    const interval = setInterval(poll, 2000);
    api.listAccounts().then((accounts) => {
      if (!cancelled) setAccountLabels(Object.fromEntries(accounts.map((a) => [a.id, a.label])));
    });
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [open]);

  async function reset() {
    const s = await api.resetMetrics();
    setSnapshot(s);
  }

  function eventStat(name: string): EventStats | undefined {
    return snapshot?.events.find((e) => e.name === name);
  }
  function stageStat(name: string): StageStats | undefined {
    return snapshot?.stages.find((s) => s.stage === name);
  }

  const uniqueTotal = eventStat("unique")?.total ?? 0;
  const duplicateTotal = eventStat("duplicate")?.total ?? 0;
  const duplicateRate = uniqueTotal + duplicateTotal > 0 ? (duplicateTotal / (uniqueTotal + duplicateTotal)) * 100 : 0;
  const cacheHitTotal = eventStat("dedup_cache_hit")?.total ?? 0;
  const cacheMissTotal = eventStat("dedup_cache_miss")?.total ?? 0;
  const cacheHitRate = cacheHitTotal + cacheMissTotal > 0 ? (cacheHitTotal / (cacheHitTotal + cacheMissTotal)) * 100 : 0;

  const STAGE_ORDER = [
    "marketplace_navigation",
    "listing_extraction",
    "cheap_filters",
    "thumbnail_classification",
    "detail_page_load",
    "detail_extraction",
    "scoring_ai",
    "vision_analysis",
    "db_dedup_lookup",
    "dedup_cache_check",
    "ebay_lookup",
  ];

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 16px",
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>📊 Pipeline metrics</span>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{open ? "Hide ▲" : "Show ▼"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 16px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
          {!snapshot ? (
            <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>Loading...</p>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button className="icon ghost" style={{ fontSize: 12 }} onClick={reset}>
                  Reset counters
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
                <MetricTile label="Discovered/sec" value={(eventStat("discovered")?.perSec ?? 0).toFixed(2)} />
                <MetricTile label="Evaluated/sec" value={(eventStat("evaluated")?.perSec ?? 0).toFixed(2)} />
                <MetricTile label="Unique/sec" value={(eventStat("unique")?.perSec ?? 0).toFixed(2)} />
                <MetricTile label="Duplicate rate" value={`${duplicateRate.toFixed(0)}%`} />
                <MetricTile label="Dedup cache hit rate" value={`${cacheHitRate.toFixed(0)}%`} />
                <MetricTile label="Vision queue depth" value={String(snapshot.gauges.vision_queue_depth ?? 0)} />
                <MetricTile label="Vision jobs/sec" value={(eventStat("vision_completed")?.perSec ?? 0).toFixed(2)} />
                <MetricTile label="Avg vision latency" value={`${(stageStat("vision_analysis")?.avgMs ?? 0).toFixed(0)} ms`} />
              </div>

              {Object.keys(snapshot.perAccountEvents).length > 0 && (
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-dim)", margin: "2px 0 6px" }}>Per-account discovery rate</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {Object.entries(snapshot.perAccountEvents).map(([accountId, events]) => {
                      const evaluated = events.find((e) => e.name === "evaluated");
                      return (
                        <div key={accountId} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                          <span style={{ color: "var(--text-muted)" }}>{accountLabels[accountId] ?? accountId}</span>
                          <span>{(evaluated?.perSec ?? 0).toFixed(2)}/sec ({evaluated?.total ?? 0} total)</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-dim)", margin: "2px 0 6px" }}>Stage latency</div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
                        <th style={{ fontWeight: 600, padding: "2px 8px 2px 0" }}>Stage</th>
                        <th style={{ fontWeight: 600, padding: "2px 8px" }}>Count</th>
                        <th style={{ fontWeight: 600, padding: "2px 8px" }}>Avg</th>
                        <th style={{ fontWeight: 600, padding: "2px 8px" }}>p50</th>
                        <th style={{ fontWeight: 600, padding: "2px 8px" }}>p95</th>
                        <th style={{ fontWeight: 600, padding: "2px 8px" }}>Errors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {STAGE_ORDER.map((name) => {
                        const s = stageStat(name);
                        if (!s) return null;
                        return (
                          <tr key={name}>
                            <td style={{ padding: "2px 8px 2px 0" }}>{name}</td>
                            <td style={{ padding: "2px 8px" }}>{s.count}</td>
                            <td style={{ padding: "2px 8px" }}>{s.avgMs.toFixed(0)} ms</td>
                            <td style={{ padding: "2px 8px" }}>{s.p50Ms.toFixed(0)} ms</td>
                            <td style={{ padding: "2px 8px" }}>{s.p95Ms.toFixed(0)} ms</td>
                            <td style={{ padding: "2px 8px", color: s.errors ? "var(--danger)" : undefined }}>{s.errors}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "var(--bg-elevated)", borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{value}</div>
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
const LogRowMemo = React.memo(LogRow);

function LogRow({
  line,
  onGoToProduct,
  onAsk,
  isAnalyzing,
}: {
  line: LogLine;
  onGoToProduct: (name: string) => void;
  onAsk: (event: AskableEvent) => void;
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
    flex: 1,
    minWidth: 0,
    color: levelColor(line.level),
    fontFamily: "ui-monospace, monospace",
    fontSize: 11.5,
    fontWeight: isDeal || isGreenFlag ? 700 : 400,
    lineHeight: 1.4,
  };

  const content = (
    <>
      <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{new Date(line.ts).toLocaleTimeString()}</span>
      {/* Per explicit instruction — multiple Facebook accounts sharing this
          one timeline: a small label so it's clear which account's session
          produced this line, without splitting Activity into separate
          per-account feeds. Only set on lines that actually came from a
          scanner engine (see index.ts's createEngineForAccount) — chat/
          config-driven lines have no accountId and just omit this. */}
      {line.accountLabel && (
        <span
          className="pill"
          style={{ flexShrink: 0, fontSize: 10, textTransform: "none", color: "var(--text-muted)", background: "var(--bg-card)" }}
        >
          {line.accountLabel}
        </span>
      )}
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

  let row: React.ReactNode;
  if (line.listingUrl) {
    row = (
      <a href={line.listingUrl} target="_blank" rel="noreferrer" className={`${animClass} log-row-link`} style={rowStyle}>
        {content}
      </a>
    );
  } else if (line.productName) {
    row = (
      <div className={`${animClass} log-row-link`} style={rowStyle} onClick={() => onGoToProduct(line.productName!)}>
        {content}
      </div>
    );
  } else {
    row = (
      <div className={animClass} style={rowStyle}>
        {content}
      </div>
    );
  }
  // The action sits beside the row rather than inside it: a button cannot live inside the row's link.
  return (
    <div className="log-row-wrap">
      {row}
      <button type="button" className="icon ghost log-row-ask" onClick={() => onAsk(line)} title="Ask Clynx about this event" style={{ fontSize: 11, padding: "1px 8px" }}>
        Ask Clynx
      </button>
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

function ChatRow({ entry, onAsk }: { entry: ChatEntry; onAsk: (event: AskableEvent) => void }) {
  const isUser = entry.role === "user";
  const isDealNarration = entry.auto === "deal";
  const isBatchNarration = entry.auto === "batch";
  const isSearchAck = !isUser && !entry.streaming && SEARCH_ACK_RE.test(entry.content);

  return (
    <div
      className="enter"
      role="article"
      aria-label={isUser ? "You" : isDealNarration || isBatchNarration ? "Clynx (note)" : entry.error ? "Clynx (error)" : "Clynx"}
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
        {isUser ? "Y" : isSearchAck ? "🔍" : isDealNarration ? "✨" : isBatchNarration ? "🔭" : "C"}
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
      {/* Clynx's own narration is an event: it can be asked about like a log line. */}
      {(isDealNarration || isBatchNarration) && !entry.streaming && entry.content && (
        <button
          type="button"
          className="icon ghost"
          onClick={() => onAsk({ ts: entry.ts, level: isDealNarration ? "deal" : "info", message: entry.content })}
          title="Ask Clynx about this"
          style={{ alignSelf: "flex-start", flexShrink: 0, fontSize: 11, padding: "1px 8px" }}
        >
          Ask Clynx
        </button>
      )}
    </div>
  );
}
