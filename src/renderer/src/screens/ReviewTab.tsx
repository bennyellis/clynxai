import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditEvent, ReviewFinding, ReviewProposal, ReviewSnapshot } from "../lib/api.js";
import { api } from "../lib/api.js";

// Database > Review: possible problems in the Database, with the evidence for each and a suggestion. REVIEW-ONLY. Nothing on this screen changes a Database entry, a listing, a
// photo or a value; approving and rejecting are switched off until that has been validated (the buttons show why). There is no "approve all": a decision is about one suggestion.

type Category = ReviewFinding["category"];
const CATEGORY_LABELS: Record<Category, string> = {
  "incorrect-filing": "Incorrect filing",
  "suspected-duplicate": "Suspected duplicate",
  "generic-entry": "Generic entry",
  "ambiguous-identity": "Ambiguous identity",
  "suspicious-valuation": "Suspicious valuation",
  "disputed-alias": "Disputed alias",
};
const CATEGORY_HELP: Record<Category, string> = {
  "incorrect-filing": "A listing or photo is filed under an entry it does not seem to belong to.",
  "suspected-duplicate": "Two entries read as the same product.",
  "generic-entry": "A broad entry is holding items that name something more specific.",
  "ambiguous-identity": "Nothing filed under the entry shows what it is.",
  "suspicious-valuation": "A stored value may rest on too little, or on mixed products.",
  "disputed-alias": "A suggested alternative name or relation does not hold up.",
};
const ACTION_LABELS: Record<ReviewProposal["action"], string> = {
  "move-listing": "Move this listing to the better entry",
  "move-photo": "Move this photo to the better entry",
  "review-merge": "Decide which of the two entries to keep (nothing is merged automatically)",
  "clear-valuation": "Clear the stored value so it is researched again",
  "reject-alias-candidate": "Reject this suggested alternative name",
  "reject-relation-candidate": "Reject this suggested relation",
  "gather-evidence": "Gather evidence (no data changes)",
};
const ORDER: Category[] = ["incorrect-filing", "suspected-duplicate", "generic-entry", "suspicious-valuation", "ambiguous-identity", "disputed-alias"];
const PAGE = 40;

const badge = (text: string, color: string, bg: string, title?: string) => (
  <span title={title} style={{ fontSize: 12, fontWeight: 700, padding: "3px 9px", borderRadius: 999, color, background: bg, whiteSpace: "nowrap" }}>
    {text}
  </span>
);
const strengthBadge = (s: "confirmed" | "heuristic") =>
  s === "confirmed"
    ? badge("Confirmed evidence", "var(--success)", "var(--success-bg)", "Something checkable in your data")
    : badge("Heuristic suggestion", "var(--warn)", "var(--warn-bg)", "A lean or a rule of thumb, not proof");
const dateText = (t: number) => new Date(t).toLocaleString();

export function ReviewTab({ onOpenProduct }: { onOpenProduct: (id: string) => void }) {
  const [snap, setSnap] = useState<ReviewSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<Category | "all">("all");
  const [strength, setStrength] = useState<"all" | "confirmed" | "heuristic">("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<AuditEvent[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api.getIdentityReview().then((s) => {
      if (alive) {
        setSnap(s);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      setSnap(await api.runIdentityReview());
      setShown(PAGE);
      if (history) setHistory(await api.getIdentityReviewHistory());
    } catch (e) {
      setError((e as Error).message || "The review could not run.");
    } finally {
      setRunning(false);
    }
  }, [history]);

  const proposalsOf = useMemo(() => {
    const m = new Map<string, ReviewProposal>();
    for (const p of snap?.proposals ?? []) m.set(p.id, p);
    return m;
  }, [snap]);

  const counts = useMemo(() => {
    const c = new Map<Category, { n: number; confirmed: number }>();
    for (const f of snap?.findings ?? []) {
      const e = c.get(f.category) ?? { n: 0, confirmed: 0 };
      e.n++;
      if (f.strength === "confirmed") e.confirmed++;
      c.set(f.category, e);
    }
    return c;
  }, [snap]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rank = (f: ReviewFinding) => ORDER.indexOf(f.category) * 10 + (f.confidence === "high" ? 0 : f.confidence === "medium" ? 1 : 2);
    return (snap?.findings ?? [])
      .filter((f) => (category === "all" || f.category === category) && (strength === "all" || f.strength === strength) && (!q || f.product.toLowerCase().includes(q) || f.summary.toLowerCase().includes(q)))
      .sort((a, b) => rank(a) - rank(b) || a.product.localeCompare(b.product));
  }, [snap, category, strength, query]);

  const decide = async (p: ReviewProposal, decision: "approved" | "rejected" | "clear") => {
    const r = await api.decideIdentityReview(p.id, decision, null);
    setNotice(r.ok ? null : r.reason);
    if (r.ok) setSnap(await api.getIdentityReview());
    if (history) setHistory(await api.getIdentityReviewHistory());
  };

  const toggleHistory = async () => {
    setHistory(history ? null : await api.getIdentityReviewHistory());
  };

  const decisionsEnabled = snap?.decisionsEnabled === true;

  return (
    <div data-testid="review-tab" style={{ display: "flex", flexDirection: "column", gap: 14, minHeight: 0, flex: 1, overflowY: "auto", paddingRight: 4 }}>
      <div
        data-testid="review-banner"
        style={{ background: "var(--warn-bg)", border: "1px solid var(--warn)", borderRadius: 12, padding: "12px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", flexShrink: 0 }}
      >
        <strong style={{ color: "var(--warn)" }}>{decisionsEnabled ? "Review mode: decisions are recorded, nothing is applied" : "Review only"}</strong>
        <span style={{ color: "var(--text-muted)", fontSize: 14.5, flex: 1, minWidth: 260 }}>
          {decisionsEnabled
            ? "Approving or rejecting is saved as a note about one suggestion. The app never changes your Database from this screen."
            : "This screen changes nothing in your Database. Approving and rejecting are switched off until that has been validated, and there is no bulk approval."}
        </span>
        <button className="primary" data-testid="review-run" onClick={() => void run()} disabled={running}>
          {running ? "Reading the Database…" : snap ? "Run the review again" : "Run the review"}
        </button>
        <button className="ghost" data-testid="review-history-toggle" onClick={() => void toggleHistory()}>
          {history ? "Hide history" : "Audit history"}
        </button>
      </div>

      {error && <div style={{ color: "var(--danger)" }}>{error}</div>}
      {notice && <div data-testid="review-notice" style={{ color: "var(--warn)" }}>{notice}</div>}

      {history && (
        <div className="card" data-testid="review-history" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto", flexShrink: 0 }}>
          <strong>Audit history (newest first)</strong>
          {history.length === 0 && <span style={{ color: "var(--text-muted)" }}>Nothing recorded yet. Every review run, and every approval, rejection or refused attempt, is written here.</span>}
          {history.map((h, i) => (
            <div key={i} style={{ fontSize: 13.5, color: "var(--text-muted)" }}>
              <span style={{ color: "var(--text-dim)" }}>{dateText(h.at)}</span> · <strong style={{ color: "var(--text)" }}>{h.type.replace(/-/g, " ")}</strong>
              {h.type === "analysis-run" && ` · ${String(h.detail.findings)} findings, ${String(h.detail.proposals)} suggestions, changed nothing`}
              {h.type.startsWith("decision") && ` · ${String(h.detail.product ?? "")} ${h.detail.decision ? "· " + String(h.detail.decision) : ""} ${h.detail.reason ? "· " + String(h.detail.reason) : ""}`}
            </div>
          ))}
        </div>
      )}

      {loading && <div style={{ color: "var(--text-muted)" }}>Loading…</div>}
      {!loading && !snap && (
        <div className="card" style={{ padding: 20, color: "var(--text-muted)", flexShrink: 0 }}>
          The review reads your Database (it does not change it) and lists entries that may be filed wrongly, duplicated, too broad, unclear, or valued on weak evidence, with the
          reason for each. Press “Run the review” to start.
        </div>
      )}

      {snap && (
        <>
          <div style={{ color: "var(--text-muted)", fontSize: 14 }} data-testid="review-summary">
            {snap.counts.findings} finding(s) across {snap.counts.products} entries ({snap.counts.core} could put a wrong product or number in front of a decision) · {snap.counts.proposals} suggestion(s) · read at {dateText(snap.generatedAt)} in{" "}
            {Math.round(snap.durationMs)} ms · nothing was changed
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button className="ghost" onClick={() => { setCategory("all"); setShown(PAGE); }} style={{ fontWeight: category === "all" ? 800 : 500, borderBottom: category === "all" ? "2px solid var(--accent-1)" : "2px solid transparent" }}>
              All ({snap.findings.length})
            </button>
            {ORDER.filter((c) => counts.has(c)).map((c) => (
              <button
                key={c}
                className="ghost"
                title={CATEGORY_HELP[c]}
                data-testid={`review-filter-${c}`}
                onClick={() => { setCategory(c); setShown(PAGE); }}
                style={{ fontWeight: category === c ? 800 : 500, borderBottom: category === c ? "2px solid var(--accent-1)" : "2px solid transparent" }}
              >
                {CATEGORY_LABELS[c]} ({counts.get(c)!.n}
                {counts.get(c)!.confirmed ? `, ${counts.get(c)!.confirmed} confirmed` : ""})
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <select value={strength} onChange={(e) => { setStrength(e.target.value as typeof strength); setShown(PAGE); }} aria-label="Evidence strength">
              <option value="all">Confirmed and heuristic</option>
              <option value="confirmed">Confirmed evidence only</option>
              <option value="heuristic">Heuristic suggestions only</option>
            </select>
            <input placeholder="Search an entry" value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }} style={{ width: 200 }} />
          </div>

          {visible.length === 0 && <div style={{ color: "var(--text-muted)" }}>Nothing matches.</div>}
          {visible.slice(0, shown).map((f) => {
            const isOpen = open === f.id;
            return (
              <div key={f.id} className="card" data-testid="review-finding" data-category={f.category} data-strength={f.strength} style={{ padding: 0, overflow: "hidden", flexShrink: 0 }}>
                <button
                  className="ghost"
                  onClick={() => setOpen(isOpen ? null : f.id)}
                  aria-expanded={isOpen}
                  style={{ width: "100%", textAlign: "left", padding: "12px 16px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
                >
                  {badge(CATEGORY_LABELS[f.category], "var(--accent-1-text)", "var(--gradient-soft)", CATEGORY_HELP[f.category])}
                  {strengthBadge(f.strength)}
                  <strong style={{ fontSize: 15.5 }}>{f.product}</strong>
                  <span style={{ color: "var(--text-muted)", fontSize: 14, flex: 1, minWidth: 240 }}>{f.summary}</span>
                  <span style={{ color: "var(--text-dim)", fontSize: 12.5 }}>{f.confidence} confidence</span>
                </button>
                {isOpen && (
                  <div style={{ padding: "4px 16px 16px", display: "flex", flexDirection: "column", gap: 14, borderTop: "1px solid var(--border)" }}>
                    <div>
                      <div style={{ fontWeight: 700, margin: "10px 0 6px" }}>Evidence</div>
                      {f.evidence.length === 0 && <div style={{ color: "var(--text-muted)" }}>No filed material to quote: this is about what the entry lacks.</div>}
                      {f.evidence.map((e, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 14, margin: "3px 0" }}>
                          {strengthBadge(e.strength)}
                          <span style={{ color: "var(--text-muted)" }}>{e.text}</span>
                        </div>
                      ))}
                    </div>

                    <div>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>Existing and suggested, side by side</div>
                      <div data-testid="review-compare" style={{ display: "grid", gridTemplateColumns: "minmax(140px, 1fr) minmax(200px, 2fr) minmax(200px, 2fr)", gap: 1, background: "var(--border)", borderRadius: 10, overflow: "hidden", fontSize: 14 }}>
                        <div style={{ background: "var(--bg-elevated)", padding: "7px 10px", fontWeight: 700 }}>What</div>
                        <div style={{ background: "var(--bg-elevated)", padding: "7px 10px", fontWeight: 700 }}>Existing now</div>
                        <div style={{ background: "var(--bg-elevated)", padding: "7px 10px", fontWeight: 700 }}>Suggested</div>
                        {f.rows.map((r, i) => (
                          <React.Fragment key={i}>
                            <div style={{ background: "var(--bg-card)", padding: "7px 10px", color: "var(--text-muted)" }}>{r.label}</div>
                            <div style={{ background: "var(--bg-card)", padding: "7px 10px" }}>{r.existing}</div>
                            <div style={{ background: "var(--bg-card)", padding: "7px 10px", display: "flex", gap: 8, alignItems: "baseline" }}>
                              <span>{r.proposed ?? "no suggestion"}</span>
                              <span style={{ marginLeft: "auto" }}>{r.proposed ? strengthBadge(r.strength) : null}</span>
                            </div>
                          </React.Fragment>
                        ))}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <button className="ghost" onClick={() => onOpenProduct(f.productId)}>Open “{f.product}”</button>
                      {f.related.slice(0, 3).map((r) => r.id && <button key={r.id} className="ghost" onClick={() => onOpenProduct(r.id)}>Open “{r.name}”</button>)}
                    </div>

                    {f.proposalIds.length === 0 && <div style={{ color: "var(--text-muted)" }}>No correction is suggested for this one: it is listed so you can see it.</div>}
                    {f.proposalIds.map((pid) => {
                      const p = proposalsOf.get(pid);
                      if (!p) return null;
                      const d = snap.decisions[p.id];
                      return (
                        <div key={p.id} data-testid="review-proposal" style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                            <strong>{ACTION_LABELS[p.action]}</strong>
                            {strengthBadge(p.strength)}
                            <span style={{ color: "var(--text-dim)", fontSize: 13 }}>{p.confidence} confidence</span>
                          </div>
                          <div style={{ color: "var(--text-muted)", fontSize: 14 }}>{p.why}</div>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 4 }}>Exactly what would change if this were ever applied</div>
                            {p.preview.length === 0 ? (
                              <div data-testid="review-preview-none" style={{ color: "var(--text-muted)", fontSize: 14 }}>No stored data would change.</div>
                            ) : (
                              <table data-testid="review-preview" style={{ width: "100%", fontSize: 13.5, borderCollapse: "collapse" }}>
                                <thead>
                                  <tr style={{ textAlign: "left", color: "var(--text-dim)" }}>
                                    <th style={{ padding: "3px 8px" }}>Row</th>
                                    <th style={{ padding: "3px 8px" }}>Field</th>
                                    <th style={{ padding: "3px 8px" }}>Now</th>
                                    <th style={{ padding: "3px 8px" }}>After</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {p.preview.map((c, i) => (
                                    <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                                      <td style={{ padding: "4px 8px" }}>{c.rowLabel}</td>
                                      <td style={{ padding: "4px 8px", color: "var(--text-muted)" }}>{c.column}</td>
                                      <td style={{ padding: "4px 8px" }}>{c.from}</td>
                                      <td style={{ padding: "4px 8px", color: "var(--accent-1-text)" }}>{c.to}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <button
                              className="primary"
                              data-testid="review-approve"
                              disabled={!decisionsEnabled}
                              title={decisionsEnabled ? "Record that you approve this suggestion (nothing is changed in the Database)" : "Switched off: this screen is review-only until approvals have been validated"}
                              onClick={() => void decide(p, "approved")}
                            >
                              Approve
                            </button>
                            <button
                              className="ghost"
                              data-testid="review-reject"
                              disabled={!decisionsEnabled}
                              title={decisionsEnabled ? "Record that you reject this suggestion" : "Switched off: this screen is review-only until decisions have been validated"}
                              onClick={() => void decide(p, "rejected")}
                            >
                              Reject
                            </button>
                            {d && (
                              <span style={{ color: "var(--text-muted)", fontSize: 13.5 }}>
                                You {d.decision} this on {dateText(d.at)}.{" "}
                                <button className="ghost" onClick={() => void decide(p, "clear")} style={{ padding: "2px 8px" }}>Undo my decision</button>
                              </span>
                            )}
                            {!decisionsEnabled && <span style={{ color: "var(--text-dim)", fontSize: 13 }}>Approve and Reject are off in review-only mode.</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {visible.length > shown && (
            <button className="ghost" onClick={() => setShown(shown + PAGE)}>
              Show {Math.min(PAGE, visible.length - shown)} more ({visible.length - shown} left)
            </button>
          )}
        </>
      )}
    </div>
  );
}
