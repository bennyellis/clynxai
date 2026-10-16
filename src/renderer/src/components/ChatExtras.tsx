import React, { useEffect, useRef, useState } from "react";
import type { ChatAttachment, ChatChoice, ChatChoiceOption } from "../lib/api.js";
import { api } from "../lib/api.js";
import { dismissChoice, useChatExtras } from "../lib/chatExtras.js";
import { problemSteps, runningSteps, statusText } from "../lib/chatStatus.js";
import { prepareImages } from "../lib/chatAttachments.js";

// Beta 13: the pieces every chat shares - live progress with elapsed time, a Stop button, a question's buttons, and picture attachments. Each chat screen keeps its own message
// list and layout; these are dropped into it.

/** "Researching eBay… 8s", ticking locally from the real start time. Shows nothing when nothing is running; a step that failed stays visible in a warning colour. */
export function ChatStatusLine({ requestId, onStop }: { requestId: string; onStop?: () => void }) {
  const { steps } = useChatExtras();
  const mine = steps[requestId];
  const running = runningSteps(mine);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running.length) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running.length]);
  const problems = problemSteps(mine);
  const notices = (mine ?? []).filter((s) => s.kind === "notice");
  if (!running.length && !problems.length && !notices.length) return null;
  return (
    <>
    <div data-testid="chat-status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-dim)", marginTop: 4, flexWrap: "wrap" }}>
      {running.length > 0 && (
        <>
          <span className="typing-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>{statusText(mine, now)}</span>
          {onStop && (
            <button className="icon ghost" style={{ padding: "0 8px", fontSize: 12 }} onClick={onStop} title="Stop this reply">
              ■ Stop
            </button>
          )}
        </>
      )}
      {problems.map((p) => (
        <span key={p.id} style={{ color: "var(--warn)" }}>
          {p.label}: {p.detail ?? "didn't finish"}
        </span>
      ))}
    </div>
    {notices.length > 0 && (
      <details data-testid="chat-web-activity" open={running.length > 0} style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
        <summary style={{ cursor: "pointer" }}>Web activity ({notices.length})</summary>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {notices.map((n) => (
            <li key={n.id} style={{ color: n.ok === false ? "var(--warn)" : undefined }}>{n.label}</li>
          ))}
        </ul>
      </details>
    )}
    </>
  );
}

/** The buttons of a question. Picking one sends it as the person's answer (typed text stays available in the box). */
export function ChatChoiceButtons({ requestId, onPick, disabled }: { requestId: string; onPick: (choice: ChatChoice, option: ChatChoiceOption) => void; disabled?: boolean }) {
  const { choices } = useChatExtras();
  const choice = choices[requestId];
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => setPicked([]), [choice?.id]);
  useEffect(() => {
    if (!choice) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= choice.options.length && !disabled && !choice.multi) onPick(choice, choice.options[n - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choice, disabled, onPick]);
  if (!choice) return null;
  return (
    <div data-testid="chat-choices" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
      <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{choice.question}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {choice.options.map((o, i) => {
          const on = picked.includes(o.id);
          return (
            <button
              key={o.id}
              className={o.kind === "destructive" ? "danger-solid" : o.kind === "cancel" ? "icon ghost" : "icon"}
              disabled={disabled}
              title={o.detail}
              style={on ? { outline: "2px solid var(--accent-1)" } : undefined}
              onClick={() => {
                if (choice.multi) setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]));
                else onPick(choice, o);
              }}
            >
              {i < 9 ? `${i + 1}. ` : ""}
              {o.label}
            </button>
          );
        })}
        {choice.multi && picked.length > 0 && (
          <button
            className="primary"
            onClick={() => onPick(choice, { id: picked.join(","), label: choice.options.filter((o) => picked.includes(o.id)).map((o) => o.label).join(", ") })}
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}

/** Previews of the pictures about to be sent, each with a remove button. */
export function AttachmentBar({ attachments, onRemove, problems }: { attachments: ChatAttachment[]; onRemove: (index: number) => void; problems?: string[] }) {
  if (!attachments.length && !(problems?.length)) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "4px 0" }}>
      {attachments.map((a, i) => (
        <div key={i} style={{ position: "relative" }} title={a.name}>
          <img src={a.dataUri} alt={a.name} style={{ width: 54, height: 54, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }} />
          <button className="icon" onClick={() => onRemove(i)} title="Remove this photo" style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, padding: 0, borderRadius: "50%", fontSize: 11, lineHeight: "18px" }}>
            ✕
          </button>
        </div>
      ))}
      {problems?.map((p, i) => (
        <span key={i} style={{ fontSize: 12, color: "var(--warn)" }}>
          {p}
        </span>
      ))}
    </div>
  );
}

/** The attach button plus paste / drop handling for a text box. `onFiles` receives only what became usable; problems are reported through `onProblems`. */
export function useImageIntake(current: ChatAttachment[], set: (next: ChatAttachment[]) => void) {
  const [problems, setProblems] = useState<string[]>([]);
  const currentRef = useRef(current);
  currentRef.current = current;
  async function addFiles(files: File[]) {
    if (!files.length) return;
    const r = await prepareImages(files, currentRef.current);
    if (r.added.length) set([...currentRef.current, ...r.added]);
    setProblems(r.problems);
  }
  return {
    problems,
    clearProblems: () => setProblems([]),
    addFiles,
    onPaste: (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    onDrop: (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
      }
    },
  };
}

export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <button className="icon ghost" type="button" disabled={disabled} title="Attach photos" onClick={() => ref.current?.click()}>
        📎
      </button>
    </>
  );
}

export { api as chatApi, dismissChoice };
