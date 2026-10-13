import React, { useState } from "react";
import { api } from "../lib/api.js";

export function SupportReportButton() {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.support.saveReport();
      setNote(r.ok ? `Saved to ${r.path}` : (r.error ?? null));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <button className="ghost" data-testid="support-report" disabled={busy} onClick={() => void save()}>
        Save a support report…
      </button>
      {note && <span data-testid="support-report-note" style={{ fontSize: 13.5, color: "var(--text-muted)" }}>{note}</span>}
    </div>
  );
}
