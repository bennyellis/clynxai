import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { ProductProfile, Watch } from "../lib/api.js";
import { Modal } from "./Modal.js";
import { US_STATES } from "../screens/Config.js";

// Per explicit instruction — "reuse Clynx's existing Database product
// identification/confirmation system where appropriate." Built as its own
// component (copy-adapting the shape of Dashboard.tsx's pendingMatch/
// pendingPrice two-modal flow) rather than extracting Dashboard's own flow
// into a shared one — lower risk for this first pass; worth revisiting once
// both flows are stable. Three possible entry points, each skipping
// whatever it already knows for certain:
//   - "+ Create Watch" on the Watch screen: nothing known, starts at the
//     "what should Clynx watch for?" text step.
//   - Database's product-page "👁 Watch" button: identity is already
//     certain (this exact product), so `initial.linkedProductId` is set and
//     the identity-confirm step is skipped entirely — jumps straight to
//     conditions, prefilled with the product's own known pricing as
//     editable suggestions, never silently imposed.
//   - Dashboard's Search-For pill "👁 Watch" promotion: the phrase (and any
//     linkedProductId/price range already set on that Search For item) is
//     already known from when it was first added — same skip.
//   - Editing an existing Watch: starts directly at conditions; the raw
//     name/phrase stay editable there without re-running identity-confirm.
export interface WatchFormInitial {
  name?: string;
  searchPhrase?: string;
  linkedProductId?: string | null;
  linkedProductName?: string | null;
  minPriceUsd?: number | null;
  maxPriceUsd?: number | null;
}

type Step = "phrase" | "identity" | "conditions";

export function WatchFormFlow({
  watch,
  initial,
  onClose,
  onSaved,
}: {
  watch?: Watch;
  initial?: WatchFormInitial;
  onClose: () => void;
  onSaved: (watch: Watch) => void;
}) {
  const isEdit = !!watch;
  const identityAlreadyKnown = isEdit || initial?.linkedProductId !== undefined;

  const [step, setStep] = useState<Step>(() => {
    if (isEdit) return "conditions";
    if (identityAlreadyKnown) return "conditions";
    if (initial?.searchPhrase) return "identity";
    return "phrase";
  });
  const [phraseDraft, setPhraseDraft] = useState(initial?.searchPhrase ?? "");
  const [resolving, setResolving] = useState(false);

  // Identity-confirm state — same shape as Dashboard.tsx's pendingMatch.
  const [identityCandidate, setIdentityCandidate] = useState<{ product: ProductProfile | null; imageUrl: string | null } | null>(null);

  // Conditions step state.
  const [name, setName] = useState(watch?.name ?? initial?.name ?? initial?.searchPhrase ?? "");
  const [searchPhrase, setSearchPhrase] = useState(watch?.searchPhrase ?? initial?.searchPhrase ?? "");
  const [linkedProductId, setLinkedProductId] = useState<string | null>(watch?.linkedProductId ?? initial?.linkedProductId ?? null);
  const [linkedProductName, setLinkedProductName] = useState<string | null>(initial?.linkedProductName ?? null);
  const [minPriceDraft, setMinPriceDraft] = useState(numToDraft(watch?.minPriceUsd ?? initial?.minPriceUsd));
  const [maxPriceDraft, setMaxPriceDraft] = useState(numToDraft(watch?.maxPriceUsd ?? initial?.maxPriceUsd));
  const [minProfitDraft, setMinProfitDraft] = useState(numToDraft(watch?.minProfitUsd));
  const [minDiscountDraft, setMinDiscountDraft] = useState(numToDraft(watch?.minDiscountPercent));
  const [maxAgeDraft, setMaxAgeDraft] = useState(numToDraft(watch?.maxListingAgeMinutes));
  const [locationMode, setLocationMode] = useState<Watch["locationMode"]>(watch?.locationMode ?? "city");
  const [stateDraft, setStateDraft] = useState(watch?.selectedState ?? "");
  const [cityDraft, setCityDraft] = useState(watch?.selectedCityOrZip ?? "");
  const [radiusDraft, setRadiusDraft] = useState(numToDraft(watch?.searchRadiusMiles ?? 30));
  const [saving, setSaving] = useState(false);

  // Per explicit instruction — "reuse the exact existing Database product
  // identification/confirmation system": findMatchingProduct first (a real
  // Database hit), findReferenceImage as the web-sourced fallback — same
  // two-call sequence Dashboard.tsx's handleAddClick already uses, run the
  // moment this step becomes active instead of waiting on a button click,
  // since the phrase is already known by the time we get here.
  useEffect(() => {
    if (step !== "identity") return;
    let cancelled = false;
    setResolving(true);
    (async () => {
      const match = await api.findMatchingProduct(phraseDraft).catch(() => null);
      if (cancelled) return;
      if (match?.imageUrl) {
        setIdentityCandidate({ product: match, imageUrl: match.imageUrl });
        setResolving(false);
        return;
      }
      const referenceImageUrl = await api.findReferenceImage(phraseDraft).catch(() => null);
      if (cancelled) return;
      setIdentityCandidate({ product: null, imageUrl: referenceImageUrl });
      setResolving(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the identity step itself starts, not on every phraseDraft keystroke
  }, [step]);

  function submitPhrase() {
    const trimmed = phraseDraft.trim();
    if (!trimmed) return;
    setSearchPhrase(trimmed);
    setName(trimmed);
    setStep("identity");
  }

  function confirmIdentity(confirmed: boolean) {
    if (confirmed && identityCandidate?.product) {
      setLinkedProductId(identityCandidate.product.id);
      setLinkedProductName(identityCandidate.product.name);
    } else {
      setLinkedProductId(null);
      setLinkedProductName(null);
    }
    setIdentityCandidate(null);
    setStep("conditions");
  }

  async function save() {
    if (!searchPhrase.trim() || saving) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim() || searchPhrase.trim(),
        searchPhrase: searchPhrase.trim(),
        linkedProductId,
        minPriceUsd: parseDraft(minPriceDraft),
        maxPriceUsd: parseDraft(maxPriceDraft),
        minProfitUsd: parseDraft(minProfitDraft),
        minDiscountPercent: parseDraft(minDiscountDraft),
        maxListingAgeMinutes: parseDraft(maxAgeDraft),
        locationMode,
        selectedState: locationMode === "state" ? stateDraft || null : null,
        selectedCityOrZip: locationMode === "city" ? cityDraft.trim() || null : null,
        searchRadiusMiles: parseDraft(radiusDraft),
      };
      const saved = isEdit ? await api.updateWatch(watch!.id, payload) : await api.createWatch(payload);
      if (saved) onSaved(saved);
    } finally {
      setSaving(false);
    }
  }

  if (step === "phrase") {
    return (
      <Modal title="What should Clynx watch for?" onClose={onClose}>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>
          Enter a product or search phrase — Clynx will keep looking for it over time, even when the Scanner isn't
          running.
        </p>
        <input
          autoFocus
          placeholder="e.g. Xbox Series X"
          value={phraseDraft}
          onChange={(e) => setPhraseDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitPhrase();
            }
          }}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button className="icon ghost" style={{ flex: 1 }} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" style={{ flex: 1 }} disabled={!phraseDraft.trim()} onClick={submitPhrase}>
            Next
          </button>
        </div>
      </Modal>
    );
  }

  if (step === "identity") {
    return (
      <Modal title="Is this what you meant?" onClose={onClose}>
        {resolving ? (
          <div style={{ padding: "24px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 14 }}>Looking it up…</div>
        ) : (
          <>
            {identityCandidate?.imageUrl ? (
              <img
                src={identityCandidate.imageUrl}
                alt=""
                style={{ width: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 10, background: "var(--bg-elevated)", display: "block" }}
              />
            ) : (
              <div
                style={{
                  width: "100%",
                  height: 160,
                  borderRadius: 10,
                  background: "var(--bg-elevated)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 40,
                }}
              >
                📦
              </div>
            )}
            <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.5 }}>
              {identityCandidate?.product ? (
                <>
                  Already have "{identityCandidate.product.name}" in the Database. Linking this Watch to it means
                  matching benefits from its reference photos, variants, and known pricing.
                </>
              ) : identityCandidate?.imageUrl ? (
                <>
                  Nothing in the Database yet for "{phraseDraft}" — here's a reference photo pulled from the web.
                  Confirm it looks right.
                </>
              ) : (
                <>Nothing in the Database yet for "{phraseDraft}", and couldn't find a reference photo either — just confirming.</>
              )}
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="icon" style={{ flex: 1 }} onClick={() => confirmIdentity(false)}>
                No, something else
              </button>
              <button className="primary" style={{ flex: 1 }} onClick={() => confirmIdentity(true)}>
                Yes, that's it
              </button>
            </div>
          </>
        )}
      </Modal>
    );
  }

  // step === "conditions"
  return (
    <Modal title={isEdit ? `Edit "${watch!.name}"` : "Set up this Watch"} onClose={onClose}>
      {linkedProductName && (
        <div className="pill" style={{ alignSelf: "flex-start", fontSize: 12.5 }}>
          🔗 Linked to "{linkedProductName}"
        </div>
      )}
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13.5, color: "var(--text-muted)" }}>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={searchPhrase || "Watch name"} />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13.5, color: "var(--text-muted)" }}>
        Search phrase
        <input value={searchPhrase} onChange={(e) => setSearchPhrase(e.target.value)} placeholder="e.g. Xbox Series X" />
      </label>

      <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--text-dim)" }}>
        Every condition below is optional — leave anything blank to not check it.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--text-muted)" }}>
          Max price ($)
          <input type="number" min={0} value={maxPriceDraft} onChange={(e) => setMaxPriceDraft(e.target.value)} style={{ width: 110 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--text-muted)" }}>
          Min price ($)
          <input type="number" min={0} value={minPriceDraft} onChange={(e) => setMinPriceDraft(e.target.value)} style={{ width: 110 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--text-muted)" }}>
          Min. estimated profit ($)
          <input type="number" min={0} value={minProfitDraft} onChange={(e) => setMinProfitDraft(e.target.value)} style={{ width: 150 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--text-muted)" }}>
          Min. discount (%)
          <input type="number" min={0} max={100} value={minDiscountDraft} onChange={(e) => setMinDiscountDraft(e.target.value)} style={{ width: 110 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--text-muted)" }}>
          Max listing age (min)
          <input type="number" min={0} value={maxAgeDraft} onChange={(e) => setMaxAgeDraft(e.target.value)} style={{ width: 130 }} />
        </label>
      </div>
      {(parseDraft(minProfitDraft) !== null || parseDraft(minDiscountDraft) !== null) && !linkedProductId && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--warn)" }}>
          Profit/discount conditions work best linked to a Database product with known pricing — without one, Clynx
          may not have a reliable price to judge against yet.
        </p>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
        <select value={locationMode} onChange={(e) => setLocationMode(e.target.value as Watch["locationMode"])}>
          <option value="country">Whole country</option>
          <option value="state">State</option>
          <option value="city">City/ZIP code</option>
        </select>
        {locationMode === "state" && (
          <select value={stateDraft} onChange={(e) => setStateDraft(e.target.value)} style={{ minWidth: 160 }}>
            <option value="">Choose a state…</option>
            {US_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        {locationMode === "city" && (
          <input
            value={cityDraft}
            onChange={(e) => setCityDraft(e.target.value)}
            placeholder='e.g. "Austin, Texas" or a ZIP code'
            style={{ minWidth: 180 }}
          />
        )}
        {locationMode !== "country" && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-muted)" }}>
            Radius (mi)
            <input type="number" min={1} value={radiusDraft} onChange={(e) => setRadiusDraft(e.target.value)} style={{ width: 70 }} />
          </label>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button className="icon ghost" style={{ flex: 1 }} onClick={onClose}>
          Cancel
        </button>
        <button className="primary" style={{ flex: 1 }} disabled={!searchPhrase.trim() || saving} onClick={save}>
          {saving ? "Saving…" : isEdit ? "Save changes" : "Create Watch"}
        </button>
      </div>
    </Modal>
  );
}

function numToDraft(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : String(n);
}

function parseDraft(v: string): number | null {
  if (!v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
