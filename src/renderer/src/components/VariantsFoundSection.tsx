// "Versions & add-ons Clynx found" on a product's Library page: every name research turned up, with its status, so nothing is silently dropped. Added = it has its own Database entry;
// Suggestion = only one source names it (it becomes an entry when a second source or a listing confirms it); Waiting = found, not yet checked (a background worker goes through them);
// Rejected = a source says it is not official. Read-only; no animation.
import React, { useCallback, useEffect, useState } from "react";
import type { ProductProfile } from "../../../main/types.js";
import type { StoredCandidate } from "../../../main/store.js";
import { api } from "../lib/api.js";

const LABEL: Record<StoredCandidate["status"], { text: string; color: string; hint: string }> = {
  added: { text: "Added", color: "var(--success)", hint: "has its own entry in the Database" },
  suggestion: { text: "Suggestion", color: "var(--warn)", hint: "only one source names it, so it is not an entry yet" },
  queued: { text: "Waiting", color: "var(--text-dim)", hint: "found, not yet checked" },
  checking: { text: "Checking", color: "var(--accent-1-text)", hint: "being checked now" },
  rejected: { text: "Rejected", color: "var(--danger)", hint: "a source says it is not official" },
  skipped: { text: "Skipped", color: "var(--text-dim)", hint: "already in the Database" },
};

/** How many rows are shown before the rest fold away. */
const SHOWN_AT_FIRST = 8;
const SOURCE_WORD: Record<string, string> = { ebay_specifics: "eBay listings", catalogue: "web catalogues", listing: "a scanned listing", memory: "the model's memory (hint)", user: "you" };

export function VariantsFoundSection({ product }: { product: ProductProfile }) {
  const [rows, setRows] = useState<StoredCandidate[]>([]);
  const reload = useCallback(async () => {
    try {
      setRows(await api.listFoundCandidates(product.id));
    } catch {
      setRows([]);
    }
  }, [product.id]);
  useEffect(() => {
    void reload();
  }, [reload, product.updatedAt]);

  if (rows.length === 0) return null;
  const group = (kind: "variant" | "addon", title: string) => {
    const list = rows.filter((r) => r.kind === kind);
    if (list.length === 0) return null;
    const waiting = list.filter((r) => r.status === "queued").length;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)" }}>
          {title} ({list.length}){waiting > 0 ? ` · ${waiting} waiting to be checked` : ""}
        </div>
        {list.slice(0, SHOWN_AT_FIRST).map((r) => row(r))}
        {list.length > SHOWN_AT_FIRST && (
          <details>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-dim)" }}>Show {list.length - SHOWN_AT_FIRST} more</summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>{list.slice(SHOWN_AT_FIRST).map((r) => row(r))}</div>
          </details>
        )}
      </div>
    );
  };
  const row = (r: StoredCandidate) => {
          const l = LABEL[r.status];
          return (
            <div key={`${r.kind}:${r.key}`} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 14 }}>
              <span className="pill" style={{ fontSize: 11, padding: "1px 8px", color: l.color, borderColor: l.color, flexShrink: 0 }} title={l.hint}>
                {l.text}
              </span>
              <span style={{ fontWeight: 500 }}>{r.name}</span>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                {r.sources.map((s) => SOURCE_WORD[s] ?? s).join(" + ")}
                {r.note ? ` · ${r.note}` : ""}
              </span>
            </div>
          );
  };
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, padding: "14px 16px", border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-card)" }}>
      <h3 style={{ margin: 0, fontSize: 16 }}>Versions and add-ons Clynx found</h3>
      {group("variant", "Versions")}
      {group("addon", "Add-ons")}
    </section>
  );
}
