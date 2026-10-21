import React, { useEffect, useState } from "react";
import type { ProductProfile } from "../../../main/types.js";
import { api } from "../lib/api.js";

/** Two plain lines on a product page: where the entry came from, and (when it has them) the note that several colour names were folded into it because colour does not move the price. */
export function ProductNotes({ product }: { product: ProductProfile }) {
  const [origin, setOrigin] = useState<{ reason: string; detail: string | null; at: number } | null>(null);
  const [learned, setLearned] = useState<Array<{ attribute: string; value: string; count: number; source: string; ignored: boolean }>>([]);
  const reloadLearned = () => void api.learnedFacts(product.id).then(setLearned).catch(() => undefined);
  const [aliases, setAliases] = useState<Array<{ alias: string; source: string }>>([]);
  const [newAlias, setNewAlias] = useState("");
  const [aliasError, setAliasError] = useState("");
  const reloadAliases = () => void api.productAliasList(product.id).then(setAliases).catch(() => undefined);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.productSoldStats>> | null>(null);
  const [folded, setFolded] = useState<{ colours: string[]; names: string[]; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    api.learnedFacts(product.id).then((l) => live && setLearned(l)).catch(() => undefined);
    api.productAliasList(product.id).then((a) => live && setAliases(a)).catch(() => undefined);
    api.productSoldStats(product.id).then((x) => live && setStats(x)).catch(() => undefined);
    api.productOrigin(product.id).then((o) => live && setOrigin(o)).catch(() => undefined);
    api.productFoldedNotice(product.id).then((f) => live && setFolded(f)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [product.id, product.updatedAt]);

  return (
    <div style={{ padding: "10px 18px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: "var(--text-muted)" }} data-testid="product-notes">
      {folded && (
        <div>
          <strong style={{ color: "var(--text)" }}>Colours share this entry.</strong> {folded.text} Names kept: {folded.names.slice(0, 6).map((n) => `“${n}”`).join(", ")}.
        </div>
      )}
      <details>
        <summary style={{ cursor: "pointer", color: "var(--text)" }}>Other names for this ({aliases.length})</summary>
        <div style={{ marginTop: 4 }}>Anything you add here finds this entry, in the scanner, chat and search. Names Clynx kept (old names, official names, how sellers type it) are listed too.</div>
        <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {aliases.map((a) => (
            <span key={a.alias} className="pill" style={{ fontSize: 11.5, padding: "1px 8px" }}>
              {a.alias}
              <button className="icon ghost" aria-label={`Remove ${a.alias}`} style={{ padding: "0 4px", marginLeft: 2 }} onClick={() => void api.productAliasRemove(product.id, a.alias).then(reloadAliases)}>×</button>
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <input value={newAlias} onChange={(e) => setNewAlias(e.target.value)} placeholder="Add another name" aria-label="Add another name" style={{ flex: 1, minWidth: 0 }} />
          <button className="icon" disabled={!newAlias.trim()} onClick={() => void api.productAliasAdd(product.id, newAlias).then((r) => { setAliasError(r.ok ? "" : (r.error ?? "That name is already there.")); if (r.ok) setNewAlias(""); reloadAliases(); })}>Add</button>
        </div>
        {aliasError && <div style={{ color: "var(--danger)", marginTop: 4 }}>{aliasError}</div>}
      </details>
      {stats && stats.count > 0 && (
        <div data-testid="sold-stats">
          <strong style={{ color: "var(--text)" }}>Sold:</strong> {stats.count} accepted sale{stats.count === 1 ? "" : "s"}
          {stats.medianUsd !== null ? `, middle price $${Math.round(stats.medianUsd)}` : ""}
          {stats.medianDeliveredUsd !== null ? ` ($${Math.round(stats.medianDeliveredUsd)} with shipping)` : ""}
          {stats.count30 !== null ? `; ${stats.count30} in 30 days, ${stats.count90} in 90 days` : ""}
          {stats.avgDaysToSell !== null ? `; takes about ${stats.avgDaysToSell < 1 ? "under a day" : `${stats.avgDaysToSell.toFixed(1)} days`} to sell` : ""}
          {stats.sellThrough !== null ? `; ${Math.round(stats.sellThrough * 100)}% of what is listed has sold` : "; sell-through unknown"}.
          {stats.note ? <span style={{ opacity: 0.85 }}> {stats.note}</span> : null}
        </div>
      )}
      {learned.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", color: "var(--text)" }}>What listings say this comes in ({learned.filter((l) => !l.ignored).length})</summary>
          <div style={{ marginTop: 4 }}>
            Read from eBay item specifics (how many listings used each). Whether a detail changes the price is decided later from sales; a value that is not real can be hidden.
          </div>
          {(["colour", "capacity", "edition"] as const).map((attr) => {
            const rows = learned.filter((l) => l.attribute === attr);
            return rows.length === 0 ? null : (
              <div key={attr} style={{ marginTop: 4 }}>
                <strong style={{ color: "var(--text)" }}>{attr === "colour" ? "Colours" : attr === "capacity" ? "Sizes" : "Editions"}:</strong>{" "}
                {rows.map((l) => (
                  <span key={l.value} style={{ marginRight: 8, opacity: l.ignored ? 0.5 : 1, textDecoration: l.ignored ? "line-through" : "none" }}>
                    {l.value} ({l.count}){" "}
                    <button className="icon ghost" style={{ padding: "0 4px", fontSize: 11 }} onClick={() => void api.ignoreLearnedFact(product.id, l.attribute, l.value, !l.ignored).then(reloadLearned)}>
                      {l.ignored ? "use again" : "not real"}
                    </button>
                  </span>
                ))}
              </div>
            );
          })}
        </details>
      )}
      {origin && origin.reason !== "unspecified" && (
        <div>
          Added: {origin.reason}
          {origin.detail ? ` (${origin.detail.length > 90 ? `${origin.detail.slice(0, 90)}…` : origin.detail})` : ""}, {new Date(origin.at).toLocaleDateString()}.
        </div>
      )}
    </div>
  );
}
