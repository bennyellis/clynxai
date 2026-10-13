import React, { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { BackupSummary } from "../lib/api.js";

// Config > Account > Database backups: automatic safety copies of the Database (at most one a day, the newest few plus one per recent week are kept), a "Back up now"
// button, and Restore. A restore restarts Clynx and keeps the Database you had before next to the restored one, so nothing is lost by trying it.

const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);

export function BackupsSection({ enabled, onToggle }: { enabled: boolean; onToggle: (next: boolean) => void }) {
  const [s, setS] = useState<BackupSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.backups.list().then(setS);
  }, []);
  useEffect(load, [load]);

  const backupNow = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.backups.backupNow();
      setS(r);
      setNote(r.ok ? "Backup saved." : (r.error ?? "The backup did not work."));
    } finally {
      setBusy(false);
    }
  };
  const restore = async (name: string) => {
    setBusy(true);
    const r = await api.backups.restore(name);
    if (!r.ok) {
      setNote(r.error ?? "That backup could not be restored.");
      setBusy(false);
      setConfirm(null);
    }
    // on success the app restarts by itself
  };

  return (
    <div data-testid="backups-section" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
        <input type="checkbox" data-testid="backups-enabled" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        Back up my Database automatically
      </label>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="ghost" data-testid="backups-now" disabled={busy} onClick={() => void backupNow()}>
          Back up now
        </button>
        {s && <span style={{ fontSize: 13, color: "var(--text-dim)" }}>Saved in {s.folder}</span>}
      </div>
      {note && <div data-testid="backups-note" style={{ fontSize: 14, color: "var(--text-muted)" }}>{note}</div>}
      {s && s.backups.length === 0 && <div style={{ fontSize: 13.5, color: "var(--text-dim)" }}>No backups yet. The first one is taken a few minutes after Clynx starts.</div>}
      {s?.backups.map((b) => (
        <div key={b.name} data-testid="backup-row" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", fontSize: 14 }}>
          <span style={{ minWidth: 190 }}>{when(b.takenAt)}</span>
          <span style={{ color: "var(--text-dim)", minWidth: 70 }}>{size(b.bytes)}</span>
          {confirm === b.name ? (
            <>
              <span style={{ color: "var(--warn)" }}>Clynx will restart with this backup. Your current Database is kept.</span>
              <button className="ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
              <button className="danger-solid" data-testid="backup-restore-confirm" disabled={busy} onClick={() => void restore(b.name)}>Restore and restart</button>
            </>
          ) : (
            <button className="ghost" disabled={busy} onClick={() => setConfirm(b.name)}>Restore…</button>
          )}
        </div>
      ))}
    </div>
  );
}
