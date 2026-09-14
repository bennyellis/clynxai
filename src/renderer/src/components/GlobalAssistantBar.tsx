import React, { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../lib/api.js";
import { api } from "../lib/api.js";

// Per explicit instruction — a persistent assistant reachable from anywhere
// in the app, not just Dashboard/Database's own separate chats, with full
// admin privileges (see chat.ts's GLOBAL_TOOL_NAMES — the union of
// Dashboard's controls and Database's research_product). Rendered once in
// App.tsx, outside the per-screen content, so its own conversation and
// open/minimized state survive switching screens exactly like everything
// else in this app already does. Not shown on Dashboard itself, which
// already IS a full-page assistant — a second one floating on top of it
// would just be a redundant, competing chat box.
//
// Deliberately its own small, self-contained chat implementation rather
// than reusing Database.tsx's useDatabaseChat hook — that hook isn't
// exported/shared, and this bar's needs (no greeting, no product scoping,
// needs onSearchUpdate for add_search_item's deferred follow-up the way
// Dashboard's own chat does) diverge enough that duplicating the ~30 lines
// of streaming wiring was simpler and lower-risk than refactoring a hook
// two other call sites already depend on.
interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  error?: boolean;
}

const MINIMIZED_STORAGE_KEY = "globalAssistantMinimized";

export function GlobalAssistantBar() {
  // Per-viewer display preference (like ThumbnailSize's own localStorage
  // use), not app state — persists across restarts, but "hide" here always
  // means "collapse to the small bubble," never a dead end with no way
  // back (see the collapsed-state button below).
  const [minimized, setMinimized] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MINIMIZED_STORAGE_KEY) !== "open";
    } catch {
      return true;
    }
  });
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  function setMinimizedPersisted(value: boolean) {
    setMinimized(value);
    try {
      localStorage.setItem(MINIMIZED_STORAGE_KEY, value ? "closed" : "open");
    } catch {
      // best-effort — a private window or blocked storage just means the
      // open/closed choice doesn't survive a reload, nothing worth
      // surfacing an error for.
    }
  }

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
    // add_search_item is in this bar's tool set (see GLOBAL_TOOL_NAMES) —
    // same deferred "search actually finished" follow-up Dashboard's own
    // chat listens for, needed here for the same reason.
    const offSearchUpdate = api.onSearchUpdate((requestId, message) => {
      setChat((prev) =>
        prev.map((m) =>
          m.id === requestId ? { ...m, content: m.content === "Searching..." ? message : `${m.content}\n\n${message}` } : m
        )
      );
    });
    return () => {
      offChunk();
      offDone();
      offError();
      offSearchUpdate();
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.length]);

  function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");

    const history: ChatMessage[] = chat.filter((m) => !m.streaming && !m.error).map((m) => ({ role: m.role, content: m.content }));
    const userMsg: ChatEntry = { id: crypto.randomUUID(), role: "user", content: text };
    const requestId = crypto.randomUUID();
    const assistantMsg: ChatEntry = { id: requestId, role: "assistant", content: "", streaming: true };

    setChat((prev) => [...prev, userMsg, assistantMsg]);
    api.startChat(requestId, text, history, "global");
  }

  if (minimized) {
    return (
      <button
        onClick={() => setMinimizedPersisted(false)}
        title="Open the assistant"
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          width: 52,
          height: 52,
          borderRadius: "50%",
          background: "var(--gradient)",
          backgroundSize: "200% auto",
          border: "none",
          color: "white",
          fontSize: 22,
          boxShadow: "var(--shadow-glow)",
          cursor: "pointer",
          zIndex: 900,
        }}
      >
        💬
      </button>
    );
  }

  return (
    <div
      className="card enter"
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        width: 360,
        maxWidth: "calc(100vw - 48px)",
        maxHeight: "70vh",
        display: "flex",
        flexDirection: "column",
        padding: 0,
        overflow: "hidden",
        border: "1px solid var(--border-strong)",
        boxShadow: "0 24px 60px rgba(0, 0, 0, 0.5)",
        zIndex: 900,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 13 }}>💬 Assistant</div>
        <button
          className="icon ghost"
          title="Hide"
          onClick={() => setMinimizedPersisted(true)}
          style={{ width: 24, height: 24, padding: 0, borderRadius: "50%", fontSize: 14, lineHeight: 1 }}
        >
          –
        </button>
      </div>

      {chat.length > 0 && (
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
          {chat.map((m) => (
            <div
              key={m.id}
              style={{
                fontSize: 12.5,
                lineHeight: 1.5,
                color: m.error ? "var(--danger)" : "var(--text)",
              }}
            >
              <span style={{ fontWeight: 700, color: "var(--text-dim)" }}>{m.role === "user" ? "You: " : "Assistant: "}</span>
              {m.content || (m.streaming ? "..." : "")}
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 6,
          padding: 10,
          borderTop: chat.length > 0 ? "1px solid var(--border)" : "none",
          flexShrink: 0,
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask or tell me to change anything..."
          style={{ flex: 1, background: "var(--bg-elevated)" }}
        />
        <button className="icon" disabled={!draft.trim()} onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}
