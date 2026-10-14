import React, { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { UpdateInfo } from "../lib/api.js";

// Config > Account > Updates. Updates come from the Clynx server you are signed in to, are checked against the publisher's signature and checksums, and install only when you click.
// Your data (Database, settings, Facebook login, keys) is not touched by an update. In local mode there is no server, so updating is a manual download.

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function UpdatesSection({ localMode }: { localMode: boolean }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmBack, setConfirmBack] = useState(false);

  const load = useCallback(() => {
    void api.updates.getStatus().then(setInfo).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    return api.updates.onStatus(setInfo);
  }, [load]);

  if (localMode) {
    return (
      <div data-testid="updates-local" style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.5 }}>
        You are using local mode, which does not contact any server, so Clynx does not check for updates by itself. To update, install the newer Clynx installer over this one: your data stays where it is.
      </div>
    );
  }
  if (!info) return <p style={{ color: "var(--text-dim)", fontSize: 13 }}>Loading…</p>;

  const s = info.status;
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await f();
    } finally {
      setBusy(false);
      load();
    }
  };
  const statusText = (() => {
    switch (s.state) {
      case "disabled":
        return s.reason;
      case "checking":
        return "Checking for updates…";
      case "up-to-date":
        return `Clynx ${info.currentVersion} is up to date.`;
      case "available":
        return `Clynx ${s.version} is available (${fmtSize(s.size)}).`;
      case "downloading":
        return `Downloading Clynx ${s.version}… ${s.total ? Math.round((s.received / s.total) * 100) : 0}%`;
      case "ready":
        return `Clynx ${s.version} was downloaded and checked. Ready to install.`;
      case "installing":
        return `Installing Clynx ${s.version}… Clynx will close and reopen.`;
      case "error":
        return s.message;
      default:
        return info.lastCheckedAt ? `Last checked ${new Date(info.lastCheckedAt).toLocaleTimeString()}.` : "Not checked yet.";
    }
  })();

  return (
    <div data-testid="updates-section" style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 14 }}>
      <div>
        <div style={{ fontWeight: 700 }}>
          You have Clynx <span data-testid="updates-current">{info.currentVersion}</span> <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>({info.channel} updates)</span>
        </div>
        <div data-testid="updates-status" style={{ color: s.state === "error" ? "var(--warn)" : "var(--text-muted)", marginTop: 4 }}>
          {statusText}
        </div>
        {(s.state === "available" || s.state === "ready") && s.notes && <pre style={{ whiteSpace: "pre-wrap", margin: "8px 0 0", fontFamily: "inherit", color: "var(--text-muted)" }}>{s.notes}</pre>}
        {info.lastFailure && <div style={{ color: "var(--warn)", marginTop: 6 }}>{info.lastFailure}</div>}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="ghost" data-testid="updates-check" disabled={busy || s.state === "downloading" || s.state === "installing"} onClick={() => void act(() => api.updates.check())}>
          Check for updates
        </button>
        {s.state === "available" && (
          <button className="primary" data-testid="updates-download" disabled={busy} onClick={() => void act(() => api.updates.download())}>
            Download Clynx {s.version}
          </button>
        )}
        {s.state === "ready" && (
          <button
            className="primary"
            data-testid="updates-install"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await api.updates.install();
                if (!r.ok) setNote(r.error ?? "The update could not be installed.");
              })
            }
          >
            Restart and install
          </button>
        )}
        {info.canRollback && !confirmBack && (
          <button className="ghost" data-testid="updates-rollback" disabled={busy} onClick={() => setConfirmBack(true)}>
            Go back to {info.rollbackVersion}…
          </button>
        )}
      </div>
      {confirmBack && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span>Go back to Clynx {info.rollbackVersion}? Your data stays as it is; Clynx closes and reopens.</span>
          <button
            className="danger-solid"
            data-testid="updates-rollback-confirm"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setConfirmBack(false);
                const r = await api.updates.rollback();
                if (!r.ok) setNote(r.error ?? "Could not go back.");
              })
            }
          >
            Go back
          </button>
          <button className="ghost" onClick={() => setConfirmBack(false)}>Cancel</button>
        </div>
      )}
      {note && <div data-testid="updates-note" style={{ color: "var(--warn)" }}>{note}</div>}

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontWeight: 700 }}>When a new version appears</span>
          <select data-testid="updates-mode" value={info.mode} onChange={(e) => void act(() => api.updates.setMode(e.target.value as "off" | "notify" | "download"))}>
            <option value="download">Download it in the background, then ask me to install</option>
            <option value="notify">Only tell me</option>
            <option value="off">Do not check by itself</option>
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontWeight: 700 }}>Updates from</span>
          <select data-testid="updates-channel" value={info.channel} onChange={(e) => void act(() => api.updates.setChannel(e.target.value as "beta" | "stable"))}>
            <option value="beta">Beta (earlier access, more changes)</option>
            <option value="stable">Stable</option>
          </select>
        </label>
      </div>
      <div style={{ color: "var(--text-dim)", fontSize: 12.5 }}>
        Every update is checked against the publisher's signature and its checksums before it can be installed; one that fails is ignored. You can always install a newer installer by hand instead.
      </div>
    </div>
  );
}
