// "Add-ons" on a product's Library page (first version, FEATURE_ADDONS_SPEC P1). Things that can come WITH this product: switch one on to see what it might add to the estimate.
// Numbers are ROUGH (fixed weights, not measured from sold listings) and are labelled so; suggested add-ons found in listings start OFF; nothing here changes the product's own value
// or any alert. Provisional defaults while the owner's questions Z1-Z5 are open (not answered by anyone): suggestions start OFF until confirmed, Library page only (no scanner or alert use
// yet), no extra sold-price lookups (nothing is learned from sales in this version).
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ProductProfile } from "../../../main/types.js";
import { estimateAddonUplift, type Addon, type AddonRole } from "../../../main/addons.js";
import { api } from "../lib/api.js";

const usd = (n: number) => `$${Math.round(n)}`;

export function AddonsSection({ product }: { product: ProductProfile }) {
  const [addons, setAddons] = useState<Addon[]>([]);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [role, setRole] = useState<AddonRole>("bonus");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setAddons(await api.listAddons(product.id));
    } catch {
      setAddons([]);
    }
  }, [product.id]);
  useEffect(() => {
    void reload();
  }, [reload, product.updatedAt]);

  // what the product is worth without any add-on (the same figure the eBay VALUE panel leads with)
  const baseValue = product.ebayEstimatedValueUsd ?? product.ebayAvgSoldPriceUsd ?? null;
  const estimate = useMemo(() => estimateAddonUplift(baseValue, addons), [baseValue, addons]);

  async function run(action: () => Promise<Addon[]>) {
    setBusy(true);
    try {
      setAddons(await action());
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const n = name.trim();
    if (!n) return;
    const parsed = price.trim() === "" ? null : Number(price);
    await run(() => api.addAddon(product.id, { name: n, role, standaloneValueUsd: parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null, enabled: parsed !== null }));
    setName("");
    setPrice("");
  }

  const visible = addons.filter((a) => a.status !== "dismissed");
  const dismissed = addons.length - visible.length;
  const pill = (text: string, color: string) => (
    <span className="pill" style={{ fontSize: 11, padding: "1px 8px", color, borderColor: color, flexShrink: 0 }}>
      {text}
    </span>
  );

  return (
    <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }} data-testid="addons-section">
      <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)", marginBottom: 4 }}>🧰 Add-ons ({visible.length})</div>
      <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "0 0 8px" }}>
        Things that can come with this product, like a second controller or a storage card. Switch one on to see what it might add. Add-ons found in listings start switched off until you confirm them.
      </p>

      {visible.length === 0 && <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>None yet. Add one below, or Clynx will suggest the ones it sees in listings.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {visible.map((a) => (
          <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "6px 8px", background: "var(--bg-elevated)", borderRadius: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, flex: "1 1 220px", minWidth: 0 }} title={a.standaloneValueUsd === null ? "Give it a price to see what it adds" : undefined}>
              <input type="checkbox" checked={a.enabled} disabled={busy} onChange={(e) => void run(() => api.setAddonEnabled(a.id, e.target.checked))} />
              <span style={{ fontWeight: 600, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
            </label>
            {pill(a.role === "expected" ? "Usually included" : "Bonus", "var(--text-muted)")}
            {a.status === "suggested" && pill("suggested", "var(--warn)")}
            {a.timesSeen > 0 && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>seen in {a.timesSeen} listing{a.timesSeen === 1 ? "" : "s"}</span>}
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12.5, color: "var(--text-muted)" }}>
              sells alone for $
              <input
                type="number"
                min="0"
                step="1"
                defaultValue={a.standaloneValueUsd ?? ""}
                key={`${a.id}:${a.standaloneValueUsd ?? ""}`}
                placeholder="?"
                style={{ width: 70 }}
                onBlur={(e) => {
                  const v = e.target.value.trim() === "" ? null : Number(e.target.value);
                  if (v === a.standaloneValueUsd || (v !== null && !Number.isFinite(v))) return;
                  void run(() => api.updateAddon(a.id, { standaloneValueUsd: v }));
                }}
              />
            </label>
            {a.status === "suggested" && (
              <button className="icon" disabled={busy} onClick={() => void run(() => api.setAddonStatus(a.id, "confirmed"))}>
                Confirm
              </button>
            )}
            <button className="icon" disabled={busy} title="Hide it for good" onClick={() => void run(() => api.setAddonStatus(a.id, "dismissed"))}>
              Dismiss
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <input placeholder="Add an add-on, e.g. second controller" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: "1 1 220px", minWidth: 0 }} />
        <label style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          $
          <input type="number" min="0" step="1" placeholder="sells alone for" title="What it sells for on its own, in dollars" value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 150, marginLeft: 4 }} />
        </label>
        <select value={role} onChange={(e) => setRole(e.target.value === "expected" ? "expected" : "bonus")}>
          <option value="bonus">Bonus extra</option>
          <option value="expected">Usually included</option>
        </select>
        <button className="icon" disabled={busy || !name.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>

      {estimate.highUsd !== null && estimate.lowUsd !== null ? (
        <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--warn)" }} data-testid="addons-estimate">
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>
              With these add-ons: about +{usd(estimate.lowUsd)} to +{usd(estimate.highUsd)}
            </span>
            {pill("ROUGH ESTIMATE", "var(--warn)")}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 3 }}>
            {baseValue !== null ? `On top of the ${usd(baseValue)} estimate for the product alone (sale price, before eBay's cut). ` : ""}
            {estimate.why} No sold listings are behind this number yet, so treat it as a guess.
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: 8 }}>{estimate.why}</div>
      )}
      {dismissed > 0 && <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>{dismissed} dismissed add-on{dismissed === 1 ? "" : "s"} hidden.</div>}
    </div>
  );
}
