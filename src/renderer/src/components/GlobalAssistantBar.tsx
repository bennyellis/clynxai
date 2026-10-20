import React, { useEffect, useRef, useState } from "react";
import type { ChatAttachment, ChatChoice, ChatChoiceOption, ChatMessage } from "../lib/api.js";
import { api } from "../lib/api.js";
import { AttachButton, AttachmentBar, ChatChoiceButtons, ChatStatusLine, useImageIntake } from "./ChatExtras.js";
import { attachmentHistoryNote } from "../lib/chatAttachments.js";
import { dismissAllChoices, dismissChoice, forgetSteps } from "../lib/chatExtras.js";

// Per explicit instruction — a persistent assistant reachable from anywhere
// in the app, not just Dashboard/Database's own separate chats, with full
// admin privileges (see chat.ts's GLOBAL_TOOL_NAMES — the union of
// Dashboard's controls and Database's research_product). Rendered once in
// App.tsx, outside the per-screen content, so its own conversation and
// open/minimized state survive switching screens exactly like everything
// else in this app already does. Not shown on Activity, which already IS a
// full-page assistant — a second one floating on top of it would just be a
// redundant, competing chat box.
//
// The assistant here is Clynx itself (see clynxPersona.ts): a passionate
// reselling expert with a personality, not a command console. This bar is
// its own small, self-contained chat implementation rather than reusing
// Database.tsx's useDatabaseChat hook (that hook isn't exported/shared, and
// this bar's needs diverge enough that duplicating the ~30 lines of
// streaming wiring was simpler and lower-risk than refactoring a hook two
// other call sites already depend on).
interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  error?: boolean;
  // Beta 13: photos the person attached to this message (shown as previews; the model's history keeps a short note instead of the pixels).
  attachments?: ChatAttachment[];
}

const MINIMIZED_STORAGE_KEY = "globalAssistantMinimized";

const WELCOME =
  "Hey, I'm Clynx! I live in this app, so I can hunt for deals, change settings, look things up and talk flipping with you. What are you after?";

const STARTERS = ["Is a used Series S worth flipping?", "What should I check before buying a used iPhone?", "What are you searching for right now?"];

// A speech bubble drawn so its bounding box is exactly the viewBox (x 2..22, y 3..21 inside a 24x24 box), which is what makes it sit
// dead center in a round button: the 💬 emoji it replaces has uneven built-in padding and always looked off to one side.
function ClynxBubbleIcon({ size = 26 }: { size?: number }) {
  return (
    <svg
      className="clynx-bubble-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      <path d="M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-4 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="currentColor" />
      <circle cx="8" cy="10" r="1.3" fill="rgba(0,0,0,0.38)" />
      <circle cx="12" cy="10" r="1.3" fill="rgba(0,0,0,0.38)" />
      <circle cx="16" cy="10" r="1.3" fill="rgba(0,0,0,0.38)" />
    </svg>
  );
}

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
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const intake = useImageIntake(attachments, setAttachments);
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
      forgetSteps(requestId);
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
  }, [chat.length, chat[chat.length - 1]?.content]);

  const busy = chat.some((m) => m.streaming);

  function sendText(raw: string, choice?: { choiceId: string; optionId: string }) {
    const text = raw.trim();
    if ((!text && !attachments.length) || busy) return;
    const sent = attachments;
    if (!choice) dismissAllChoices();
    setDraft("");
    setAttachments([]);
    intake.clearProblems();

    // Earlier pictures are remembered as a short note (their pixels are not re-sent), so "the photo" still means something in a follow-up.
    const history: ChatMessage[] = chat
      .filter((m) => !m.streaming && !m.error)
      .map((m) => ({ role: m.role, content: m.attachments?.length ? `${m.content}\n${attachmentHistoryNote(m.attachments.map((a) => a.name))}`.trim() : m.content }));
    const userMsg: ChatEntry = { id: crypto.randomUUID(), role: "user", content: text, attachments: sent.length ? sent : undefined };
    const requestId = crypto.randomUUID();
    const assistantMsg: ChatEntry = { id: requestId, role: "assistant", content: "", streaming: true };

    setChat((prev) => [...prev, userMsg, assistantMsg]);
    api.startChat(requestId, text, history, "global", undefined, sent.length ? sent : undefined, choice);
  }

  function pickChoice(c: ChatChoice, o: ChatChoiceOption, requestId: string) {
    dismissChoice(requestId);
    sendText(o.label, { choiceId: c.id, optionId: o.id });
  }

  if (minimized) {
    return (
      <button
        onClick={() => setMinimizedPersisted(false)}
        title="Talk to Clynx"
        aria-label="Talk to Clynx"
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          width: 52,
          height: 52,
          borderRadius: "50%",
          background: "var(--primary-fill)",
          backgroundSize: "200% auto",
          border: "none",
          color: "var(--on-primary-fill)",
          // Flex-centered with no padding: the icon sits exactly in the middle of the circle.
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          boxShadow: "var(--shadow-glow)",
          cursor: "pointer",
          zIndex: 900,
        }}
      >
        <ClynxBubbleIcon size={26} />
      </button>
    );
  }

  const bubble = (m: ChatEntry) => {
    const mine = m.role === "user";
    return (
      <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}>
        <div
          style={{
            maxWidth: "88%",
            padding: "8px 11px",
            borderRadius: mine ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
            background: mine ? "var(--primary-fill)" : "var(--bg-elevated)",
            color: m.error ? "var(--danger)" : mine ? "var(--on-primary-fill)" : "var(--text)",
            border: mine ? "none" : "1px solid var(--border)",
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {m.attachments?.length ? (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: m.content ? 6 : 0 }}>
              {m.attachments.map((a, i) => (
                <img key={i} src={a.dataUri} alt={a.name} style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 6 }} />
              ))}
            </div>
          ) : null}
          {m.content}
          {!mine && m.id !== "welcome" && (
            <>
              <ChatStatusLine requestId={m.id} waiting={m.streaming && !m.content} onStop={m.streaming ? () => api.cancelChat(m.id) : undefined} />
              {!m.streaming && <ChatChoiceButtons requestId={m.id} disabled={busy} onPick={(c, o) => pickChoice(c, o, m.id)} />}
            </>
          )}
        </div>
      </div>
    );
  };

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
        // Floats over the page, so it stays solid (a see-through chat window
        // would show the page's text through its own).
        background: "var(--bg-card)",
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
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: "var(--primary-fill)",
              color: "var(--on-primary-fill)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <ClynxBubbleIcon size={16} />
          </div>
          <div style={{ lineHeight: 1.2 }}>
            <div style={{ fontWeight: 800, fontSize: 14 }}>Clynx</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              <span style={{ color: "var(--success)" }}>●</span> your flipping partner
            </div>
          </div>
        </div>
        <button
          className="icon ghost"
          title="Hide"
          onClick={() => setMinimizedPersisted(true)}
          style={{ width: 24, height: 24, padding: 0, borderRadius: "50%", fontSize: 14, lineHeight: 1 }}
        >
          –
        </button>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
        {chat.length === 0 && (
          <>
            {bubble({ id: "welcome", role: "assistant", content: WELCOME })}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
              {STARTERS.map((s) => (
                <button key={s} className="pill" style={{ cursor: "pointer", fontSize: 12, padding: "5px 10px", background: "transparent" }} onClick={() => sendText(s)}>
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
        {chat.map(bubble)}
      </div>

      <div style={{ padding: 10, borderTop: "1px solid var(--border)", flexShrink: 0, display: "flex", flexDirection: "column", gap: 4 }} onDrop={intake.onDrop} onDragOver={(e) => e.preventDefault()}>
        <AttachmentBar attachments={attachments} problems={intake.problems} onRemove={(i) => setAttachments((a) => a.filter((_, j) => j !== i))} />
        <div style={{ display: "flex", gap: 6 }}>
          <AttachButton onFiles={(f) => void intake.addFiles(f)} disabled={busy} />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendText(draft)}
            onPaste={intake.onPaste}
            placeholder="Ask Clynx anything..."
            style={{ flex: 1, background: "var(--bg-elevated)" }}
          />
          <button className="icon" disabled={busy || (!draft.trim() && !attachments.length)} onClick={() => sendText(draft)}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
