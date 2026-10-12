import React, { useEffect, useState } from "react";
import type { AppNotice, ScrapeStatus } from "../lib/api.js";
import { api } from "../lib/api.js";
import { Modal } from "./Modal.js";

/** The notices Clynx is currently showing (damaged files, Facebook logged out, a scan that keeps failing), live. */
export function useNotices(): AppNotice[] {
  const [notices, setNotices] = useState<AppNotice[]>([]);
  useEffect(() => {
    let alive = true;
    api.listNotices().then((list) => alive && setNotices(list)).catch(() => {});
    const off = api.onNotices((list) => setNotices(list));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return notices;
}

const SEVERITY_COLOR: Record<AppNotice["severity"], string> = {
  error: "var(--danger)",
  warning: "var(--warn)",
  info: "var(--text-muted)",
};

/**
 * Problems that need the user, with a button that fixes or explains each. They stay until the problem is fixed (or, for the ones
 * that are only information, until dismissed). Same card look as the rest of the Dashboard.
 */
export function NoticesPanel({ notices, statusMap }: { notices: AppNotice[]; statusMap: Record<string, ScrapeStatus> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRecover, setConfirmRecover] = useState(false);
  if (notices.length === 0) return null;

  async function act(notice: AppNotice) {
    if (notice.action === "recover-database") {
      setConfirmRecover(true);
      return;
    }
    setBusy(notice.id);
    try {
      if (notice.action === "dismiss") await api.dismissNotice(notice.id);
      else if (notice.action === "open-facebook-login" && notice.accountId) await api.login(notice.accountId);
      else if (notice.action === "retry-scanner" && notice.accountId) {
        // Running: end the pause between attempts and try right now. Stopped: start it.
        if (statusMap[notice.accountId]?.running) await api.skipEngineWait(notice.accountId);
        else await api.startEngine(notice.accountId);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {notices.map((notice) => (
        <div
          key={notice.id}
          role="alert"
          className="card enter"
          style={{ borderColor: SEVERITY_COLOR[notice.severity], display: "flex", flexDirection: "column", gap: 8, padding: 16 }}
        >
          <div style={{ fontWeight: 700, color: SEVERITY_COLOR[notice.severity] }}>{notice.title}</div>
          <div style={{ fontSize: 13.5, lineHeight: 1.5, color: "var(--text)" }}>{notice.message}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon" disabled={busy === notice.id} onClick={() => act(notice)} style={{ borderColor: SEVERITY_COLOR[notice.severity], color: SEVERITY_COLOR[notice.severity], fontWeight: 600 }}>
              {busy === notice.id ? "Working..." : notice.actionLabel}
            </button>
            {notice.action !== "dismiss" && notice.severity !== "error" && (
              <button className="icon ghost" onClick={() => api.dismissNotice(notice.id)}>
                Dismiss
              </button>
            )}
          </div>
        </div>
      ))}
      {confirmRecover && (
        <Modal title="Start with a fresh database?" onClose={() => setConfirmRecover(false)}>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>
            Clynx will close and reopen. Your current database is <b>kept</b> as a separate file in your Clynx data folder (nothing is deleted), and
            Clynx starts with an empty Database, Library and Feed. Your settings and Watches are not affected.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon" style={{ flex: 1 }} onClick={() => setConfirmRecover(false)}>
              Cancel
            </button>
            <button className="danger-solid" style={{ flex: 1 }} onClick={() => api.recoverDatabase()}>
              Back up and start fresh
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
