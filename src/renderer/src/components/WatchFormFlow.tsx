import React, { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import type { ProductProfile, Watch, WatchPlatform } from "../lib/api.js";
import { Modal } from "./Modal.js";
import { EbayLogo, FacebookLogo } from "./ListingSourceMarks.js";
import { US_STATES } from "../screens/Config.js";
import {
  FACEBOOK_RADIUS_OPTIONS_MILES,
  WATCH_INTERVAL_OPTIONS_MINUTES,
  DEFAULT_WATCH_INTERVAL_MINUTES,
  formatWatchInterval,
  snapToFacebookRadius,
  snapToWatchInterval,
} from "../../../main/watchOptions.js";

// Per explicit instruction — "reuse Clynx's existing Database product
// identification/confirmation system where appropriate." Built as its own
// component (copy-adapting the shape of Dashboard.tsx's pendingMatch/
// pendingPrice two-modal flow) rather than extracting Dashboard's own flow
// into a shared one — lower risk for this first pass; worth revisiting once
// both flows are stable.
//
// Per explicit instruction — "when the user creates a new Watch, first
// prompt them with which platform they want to search on": every NEW Watch
// starts at the platform step (Facebook / eBay logo buttons), whatever entry
// point opened the flow. The platform decides which conditions menu the last
// step shows:
//   - Facebook: a list of things to look out for (one or several), min price,
//     max price and a location (ZIP/city, state or whole country) are required;
//     how often to check (default 15 min) is a choice, and when two or more
//     Facebook accounts are logged in it asks which of them to use. Radius
//     (ZIP/city only), profit, discount and listing age stay optional.
//   - eBay: min price and max price are required; a minimum seller rating
//     (%) is the one optional extra. No location — eBay is searched
//     nationwide.
// There is no "is this what you meant?" confirmation. After the platform:
//   - Facebook goes straight to the setup screen, where the things to watch for are typed in;
//   - eBay asks for its one phrase first (skipped when it is already known: an edit, a
//     Database product's "👁 Watch" button, or a Search For pill's promotion), then the
//     setup screen. A phrase that matches a Database product is linked to it quietly.
//   - Editing an existing Watch opens the setup screen directly (its platform is fixed — see
//     types.ts's WatchPlatform).
export interface WatchFormInitial {
  name?: string;
  searchPhrase?: string;
  linkedProductId?: string | null;
  linkedProductName?: string | null;
  minPriceUsd?: number | null;
  maxPriceUsd?: number | null;
}

type Step = "platform" | "phrase" | "conditions";
type FieldErrors = Partial<Record<"terms" | "minPrice" | "maxPrice" | "location" | "rating" | "accounts", string>>;

// One thing a Facebook Watch looks out for, as the form edits it. linkedProductName
// is only known for a link made in this session (it is just a label for the chip).
interface TermDraft {
  phrase: string;
  linkedProductId: string | null;
  linkedProductName: string | null;
}

const MAX_TERMS = 20;

// The small ✕ / 🔗 buttons inside a term chip: plain glyphs, not full-size buttons.
const CHIP_BUTTON: React.CSSProperties = {
  background: "none",
  border: "none",
  boxShadow: "none",
  padding: 0,
  minWidth: 0,
  height: "auto",
  lineHeight: 1,
  fontSize: 14,
  color: "inherit",
  cursor: "pointer",
};

// A Facebook account as the "which accounts" prompt shows it.
interface AccountChoice {
  id: string;
  label: string;
  loggedIn: boolean;
}

const PLATFORM_NAMES: Record<WatchPlatform, string> = { facebook: "Facebook Marketplace", ebay: "eBay" };

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

  const [platform, setPlatform] = useState<WatchPlatform>(watch?.platform ?? "facebook");
  const [step, setStep] = useState<Step>(isEdit ? "conditions" : "platform");
  // True once the flow has reached the conditions step. Picking a different
  // platform from there ("Change") goes straight back to conditions rather
  // than making the user re-answer the phrase and identity questions.
  const reachedConditions = useRef(isEdit);
  const [phraseDraft, setPhraseDraft] = useState(initial?.searchPhrase ?? "");

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
  const [minRatingDraft, setMinRatingDraft] = useState(numToDraft(watch?.minSellerRatingPercent));
  const [locationMode, setLocationMode] = useState<Watch["locationMode"]>(watch?.locationMode ?? "city");
  const [stateDraft, setStateDraft] = useState(watch?.selectedState ?? "");
  const [cityDraft, setCityDraft] = useState(watch?.selectedCityOrZip ?? "");
  const [radiusDraft, setRadiusDraft] = useState(String(snapToFacebookRadius(watch?.searchRadiusMiles)));
  // Facebook Watches: the things being watched for, how often, and with which accounts.
  const [terms, setTerms] = useState<TermDraft[]>(() => {
    if (watch) return watch.terms.map((t) => ({ phrase: t.phrase, linkedProductId: t.linkedProductId, linkedProductName: null }));
    if (initial?.searchPhrase) {
      return [{ phrase: initial.searchPhrase, linkedProductId: initial.linkedProductId ?? null, linkedProductName: initial.linkedProductName ?? null }];
    }
    return [];
  });
  const [termDraft, setTermDraft] = useState("");
  const [intervalDraft, setIntervalDraft] = useState(String(snapToWatchInterval(watch?.checkIntervalMinutes ?? DEFAULT_WATCH_INTERVAL_MINUTES)));
  const [accounts, setAccounts] = useState<AccountChoice[]>([]);
  const [chosenAccountIds, setChosenAccountIds] = useState<string[]>(watch?.accountIds ?? []);
  const [saving, setSaving] = useState(false);
  // Required fields only show their errors once the user has tried to save,
  // so an untouched form isn't a wall of red.
  const [attempted, setAttempted] = useState(false);

  // eBay Watches are only searched while "Search eBay" is on in Config and API
  // credentials exist, so say so up front instead of letting a Watch quietly
  // never run. Null until known, so nothing flashes in the meantime.
  const [ebayReady, setEbayReady] = useState<{ enabled: boolean; credentials: boolean } | null>(null);
  useEffect(() => {
    if (platform !== "ebay") return;
    let cancelled = false;
    Promise.all([api.getConfig(), api.hasEbayCredentials()])
      .then(([cfg, credentials]) => {
        if (!cancelled) setEbayReady({ enabled: cfg.ebay?.enabled ?? false, credentials });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [platform]);

  // Which Facebook accounts exist and which are logged in, for the "which accounts" prompt.
  useEffect(() => {
    if (platform !== "facebook") return;
    let cancelled = false;
    Promise.all([api.getConfig(), api.getEngineStatusMap()])
      .then(([cfg, statuses]) => {
        if (cancelled) return;
        const list = cfg.accounts.map((a) => ({ id: a.id, label: a.label, loggedIn: statuses[a.id]?.loggedIn === true }));
        setAccounts(list);
        // A new Watch starts with every logged-in account ticked; an existing one keeps what it had
        // (nothing saved = "any", shown as every logged-in account ticked).
        setChosenAccountIds((current) => {
          if (current.length) return current;
          const loggedIn = list.filter((a) => a.loggedIn).map((a) => a.id);
          return loggedIn.length ? loggedIn : list.map((a) => a.id);
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [platform]);
  // The prompt appears whenever there is a choice to make: two or more Facebook accounts set up (logged in or not: a Watch
  // can be pinned to an account that isn't logged in yet, and it simply waits for it).
  const askWhichAccounts = platform === "facebook" && accounts.length >= 2;

  // Adds what was typed as a new thing to watch for, and (quietly) links it to a Database
  // product when one matches, so the profit/discount conditions have a price to go on. The
  // link shows on the chip and can be removed there.
  function addTerm() {
    const phrase = termDraft.trim();
    if (!phrase) return;
    setTermDraft("");
    if (terms.length >= MAX_TERMS || terms.some((t) => t.phrase.toLowerCase() === phrase.toLowerCase())) return;
    setTerms((current) => [...current, { phrase, linkedProductId: null, linkedProductName: null }]);
    api
      .findMatchingProduct(phrase)
      .then((match) => {
        if (!match) return;
        setTerms((current) => current.map((t) => (t.phrase === phrase && !t.linkedProductId ? { ...t, linkedProductId: match.id, linkedProductName: match.name } : t)));
      })
      .catch(() => {});
  }
  const removeTerm = (phrase: string) => setTerms((current) => current.filter((t) => t.phrase !== phrase));
  const unlinkTerm = (phrase: string) => setTerms((current) => current.map((t) => (t.phrase === phrase ? { ...t, linkedProductId: null, linkedProductName: null } : t)));

  function pickPlatform(next: WatchPlatform) {
    setPlatform(next);
    setAttempted(false);
    // The two platforms keep their own wording of "what to watch for": carry it across a switch.
    if (next === "ebay" && !searchPhrase.trim() && terms.length) {
      setSearchPhrase(terms[0].phrase);
      setLinkedProductId(terms[0].linkedProductId);
    }
    if (next === "facebook" && !terms.length && searchPhrase.trim()) {
      setTerms([{ phrase: searchPhrase.trim(), linkedProductId, linkedProductName }]);
    }
    // A Facebook Watch takes all its terms on the setup screen itself. An eBay Watch asks for its
    // one phrase first, unless it is already known (an edit, a Database product, a Search For pill).
    if (next === "facebook" || reachedConditions.current || identityAlreadyKnown || initial?.searchPhrase) {
      reachedConditions.current = true;
      setStep("conditions");
    } else {
      setStep("phrase");
    }
  }

  function submitPhrase() {
    const trimmed = phraseDraft.trim();
    if (!trimmed) return;
    setSearchPhrase(trimmed);
    setName(trimmed);
    reachedConditions.current = true;
    setStep("conditions");
    // If the Database already has this product, the Watch is linked to it quietly (no
    // confirmation step): its known pricing then backs the profit/discount conditions.
    api
      .findMatchingProduct(trimmed)
      .then((match) => {
        if (!match) return;
        setLinkedProductId(match.id);
        setLinkedProductName(match.name);
      })
      .catch(() => {});
  }

  // The things to look out for including any text still sitting in the box (a user who types a
  // product and clicks Create without pressing Enter shouldn't lose it).
  function termsWithPendingDraft(): TermDraft[] {
    const phrase = termDraft.trim();
    if (!phrase || terms.length >= MAX_TERMS || terms.some((t) => t.phrase.toLowerCase() === phrase.toLowerCase())) return terms;
    return [...terms, { phrase, linkedProductId: null, linkedProductName: null }];
  }

  function validate(termList: TermDraft[] = terms): FieldErrors {
    const errors: FieldErrors = {};
    const min = parseDraft(minPriceDraft);
    const max = parseDraft(maxPriceDraft);
    if (min === null) errors.minPrice = "Required";
    else if (min < 0) errors.minPrice = "Can't be negative";
    if (max === null) errors.maxPrice = "Required";
    else if (max < 0) errors.maxPrice = "Can't be negative";
    else if (min !== null && min >= 0 && max < min) errors.maxPrice = "Must be at least the min price";

    if (platform === "facebook") {
      if (!termList.length) errors.terms = "Add at least one thing to look out for";
      if (askWhichAccounts && !chosenAccountIds.some((id) => accounts.some((a) => a.id === id))) errors.accounts = "Choose at least one account";
      if (locationMode === "city" && !cityDraft.trim()) errors.location = "Enter a ZIP code or city";
      if (locationMode === "state" && !stateDraft) errors.location = "Choose a state";
    } else if (minRatingDraft.trim()) {
      const rating = Number(minRatingDraft);
      if (!Number.isFinite(rating) || rating < 0 || rating > 100) errors.rating = "Enter a percentage from 0 to 100";
    }
    return errors;
  }

  const errors = attempted ? validate(termsWithPendingDraft()) : {};

  async function save() {
    // (a Facebook Watch's name/phrase come from its terms)
    if (saving || (platform === "ebay" ? !searchPhrase.trim() : false)) return;
    setAttempted(true);
    const finalTerms = termsWithPendingDraft();
    if (Object.keys(validate(finalTerms)).length > 0) return;
    setSaving(true);
    try {
      const isEbay = platform === "ebay";
      // A Facebook Watch's terms replace the single phrase; the first one doubles as it.
      const termPayload = isEbay ? undefined : finalTerms.map((t) => ({ phrase: t.phrase, linkedProductId: t.linkedProductId }));
      const phrase = isEbay ? searchPhrase.trim() : finalTerms[0].phrase;
      const payload = {
        name: name.trim() || (isEbay ? phrase : finalTerms.map((t) => t.phrase).join(", ").slice(0, 60)),
        searchPhrase: phrase,
        linkedProductId: isEbay ? linkedProductId : finalTerms[0].linkedProductId,
        ...(termPayload ? { terms: termPayload, checkIntervalMinutes: Number(intervalDraft) } : {}),
        // Only sent when the prompt was shown: otherwise a new Watch uses any account, and an
        // existing one keeps the accounts it already has.
        ...(!isEbay && askWhichAccounts ? { accountIds: chosenAccountIds.filter((id) => accounts.some((a) => a.id === id)) } : {}),
        minPriceUsd: parseDraft(minPriceDraft),
        maxPriceUsd: parseDraft(maxPriceDraft),
        // Profit/discount/age are Facebook's menu; the eBay menu doesn't ask
        // for them, so they're stored empty.
        minProfitUsd: isEbay ? null : parseDraft(minProfitDraft),
        minDiscountPercent: isEbay ? null : parseDraft(minDiscountDraft),
        maxListingAgeMinutes: isEbay ? null : parseDraft(maxAgeDraft),
        minSellerRatingPercent: isEbay ? parseDraft(minRatingDraft) : null,
        // eBay has no location: the main process stores it as "country".
        locationMode: isEbay ? ("country" as const) : locationMode,
        selectedState: !isEbay && locationMode === "state" ? stateDraft || null : null,
        selectedCityOrZip: !isEbay && locationMode === "city" ? cityDraft.trim() || null : null,
        // Only a ZIP/city search has a radius; a state or whole-country Watch uses a fixed one.
        searchRadiusMiles: !isEbay && locationMode === "city" ? parseDraft(radiusDraft) : null,
      };
      const saved = isEdit ? await api.updateWatch(watch!.id, payload) : await api.createWatch({ ...payload, platform });
      if (saved) onSaved(saved);
    } finally {
      setSaving(false);
    }
  }

  if (step === "platform") {
    return (
      <Modal title="Where should Clynx watch?" onClose={onClose}>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>Pick the marketplace this Watch should keep an eye on.</p>
        <div style={{ display: "flex", gap: 12 }}>
          <button type="button" className="platform-pick" aria-label="Watch on Facebook Marketplace" onClick={() => pickPlatform("facebook")}>
            <FacebookLogo size={60} />
            <span className="platform-pick-note">Local listings near you</span>
          </button>
          <button type="button" className="platform-pick" aria-label="Watch on eBay" onClick={() => pickPlatform("ebay")}>
            <EbayLogo height={46} />
            <span className="platform-pick-note">Nationwide, shipped</span>
          </button>
        </div>
        <button className="icon ghost" onClick={onClose}>
          Cancel
        </button>
      </Modal>
    );
  }

  if (step === "phrase") {
    return (
      <Modal title="What should Clynx watch for?" onClose={onClose}>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>
          Enter a product or search phrase — Clynx will keep looking for it on {PLATFORM_NAMES[platform]} over time, even
          when the Scanner isn't running.
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
          <button className="icon ghost" style={{ flex: 1 }} onClick={() => setStep("platform")}>
            Back
          </button>
          <button className="primary" style={{ flex: 1 }} disabled={!phraseDraft.trim()} onClick={submitPhrase}>
            Next
          </button>
        </div>
      </Modal>
    );
  }

  // step === "conditions"
  const isEbay = platform === "ebay";
  return (
    <Modal title={isEdit ? `Edit "${watch!.name}"` : "Set up this Watch"} onClose={onClose} width={450}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {isEbay ? <EbayLogo height={22} /> : <FacebookLogo size={22} />}
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{PLATFORM_NAMES[platform]} Watch</span>
        {!isEdit && (
          <button type="button" className="icon ghost" style={{ fontSize: 12, padding: "3px 10px" }} onClick={() => setStep("platform")}>
            Change
          </button>
        )}
        {isEbay && linkedProductName && (
          <div className="pill" style={{ fontSize: 12.5 }}>
            🔗 Linked to "{linkedProductName}"
          </div>
        )}
      </div>

      {isEbay && ebayReady && (!ebayReady.enabled || !ebayReady.credentials) && (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--warn)" }}>
          {!ebayReady.enabled
            ? 'eBay searching is turned off — switch on "Search eBay" in Config → eBay Marketplace, or this Watch won\'t run.'
            : "eBay API credentials aren't set up yet (EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env) — this Watch won't run until they are."}
        </p>
      )}

      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={(isEbay ? searchPhrase : terms.map((t) => t.phrase).join(", ")) || "Watch name"} />
      </Field>
      {isEbay ? (
        <Field label="Search phrase">
          <input value={searchPhrase} onChange={(e) => setSearchPhrase(e.target.value)} placeholder="e.g. Xbox Series X" />
        </Field>
      ) : (
        <Field
          label="Look out for"
          group
          error={errors.terms}
          hint="Clynx watches for any of these. Add as many as you like, one at a time."
        >
          {terms.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {terms.map((t) => (
                <span key={t.phrase} className="pill" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, padding: "4px 6px 4px 10px" }}>
                  {t.linkedProductId && (
                    <button
                      type="button"
                      style={CHIP_BUTTON}
                      title={t.linkedProductName ? `Linked to "${t.linkedProductName}" in the Database — click to unlink` : "Linked to a Database product — click to unlink"}
                      onClick={() => unlinkTerm(t.phrase)}
                    >
                      🔗
                    </button>
                  )}
                  {t.phrase}
                  <button type="button" style={CHIP_BUTTON} aria-label={`Stop watching for ${t.phrase}`} onClick={() => removeTerm(t.phrase)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{ flex: 1, minWidth: 0 }}
              value={termDraft}
              aria-invalid={!!errors.terms}
              placeholder={terms.length ? "Add another product…" : "e.g. PS5, then press Enter"}
              onChange={(e) => setTermDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addTerm();
                }
              }}
            />
            <button type="button" className="icon" onClick={addTerm} disabled={!termDraft.trim()}>
              Add
            </button>
          </div>
        </Field>
      )}

      <SectionLabel>Required</SectionLabel>
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Min price ($)" error={errors.minPrice} grow>
          <input
            type="number"
            min={0}
            value={minPriceDraft}
            aria-invalid={!!errors.minPrice}
            onChange={(e) => setMinPriceDraft(e.target.value)}
          />
        </Field>
        <Field label="Max price ($)" error={errors.maxPrice} grow>
          <input
            type="number"
            min={0}
            value={maxPriceDraft}
            aria-invalid={!!errors.maxPrice}
            onChange={(e) => setMaxPriceDraft(e.target.value)}
          />
        </Field>
      </div>

      {!isEbay && (
        <Field label="Location" error={errors.location} group>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button type="button" className={locationMode === "city" ? "seg on" : "seg"} onClick={() => setLocationMode("city")}>
              ZIP / City
            </button>
            <button type="button" className={locationMode === "state" ? "seg on" : "seg"} onClick={() => setLocationMode("state")}>
              State
            </button>
            <button type="button" className={locationMode === "country" ? "seg on" : "seg"} onClick={() => setLocationMode("country")}>
              Whole country
            </button>
          </div>
          {locationMode === "city" && (
            <input
              value={cityDraft}
              aria-invalid={!!errors.location}
              onChange={(e) => setCityDraft(e.target.value)}
              placeholder='A ZIP code, or a city like "Austin, Texas"'
            />
          )}
          {locationMode === "state" && (
            <select value={stateDraft} aria-invalid={!!errors.location} onChange={(e) => setStateDraft(e.target.value)}>
              <option value="">Choose a state…</option>
              {US_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      {!isEbay && (
        <>
          <SectionLabel>Schedule</SectionLabel>
          <Field label="Check every">
            <select value={intervalDraft} onChange={(e) => setIntervalDraft(e.target.value)}>
              {WATCH_INTERVAL_OPTIONS_MINUTES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {formatWatchInterval(minutes)}
                </option>
              ))}
            </select>
          </Field>
          {askWhichAccounts && (
            <Field
              label="Which Facebook account should this Watch search on?"
              group
              error={errors.accounts}
              hint="Pick one account, or several to take turns. If an account is in the middle of a scan, the Watch pauses the scan, does its check, and the scan carries on afterwards. An account that isn't logged in yet is fine: the Watch waits for it."
            >
              {accounts.map((a) => (
                <label
                  key={a.id}
                  style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, fontSize: 14, fontWeight: 500, color: "var(--text)" }}
                >
                  <input
                    type="checkbox"
                    style={{ width: 18, height: 18, padding: 0, cursor: "pointer" }}
                    checked={chosenAccountIds.includes(a.id)}
                    onChange={(e) => setChosenAccountIds((current) => (e.target.checked ? [...new Set([...current, a.id])] : current.filter((id) => id !== a.id)))}
                  />
                  {a.label}
                  <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{a.loggedIn ? "logged in" : "not logged in"}</span>
                </label>
              ))}
            </Field>
          )}
        </>
      )}

      <SectionLabel>Optional</SectionLabel>
      {isEbay ? (
        <Field label="Minimum seller rating (%)" error={errors.rating} hint="eBay's positive-feedback percentage. Leave blank to allow any seller.">
          <input
            type="number"
            min={0}
            max={100}
            step="any"
            value={minRatingDraft}
            aria-invalid={!!errors.rating}
            onChange={(e) => setMinRatingDraft(e.target.value)}
            placeholder="e.g. 98"
            style={{ width: 130 }}
          />
        </Field>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {locationMode === "city" && (
              <Field label="Radius (mi)" grow>
                {/* Only the radii Facebook's own location dialog offers: no custom value. */}
                <select value={radiusDraft} onChange={(e) => setRadiusDraft(e.target.value)}>
                  {FACEBOOK_RADIUS_OPTIONS_MILES.map((miles) => (
                    <option key={miles} value={miles}>
                      {miles} {miles === 1 ? "mile" : "miles"}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Max listing age (min)" grow>
              <input type="number" min={0} value={maxAgeDraft} onChange={(e) => setMaxAgeDraft(e.target.value)} />
            </Field>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Field label="Min. estimated profit ($)" grow>
              <input type="number" min={0} value={minProfitDraft} onChange={(e) => setMinProfitDraft(e.target.value)} />
            </Field>
            <Field label="Min. discount (%)" grow>
              <input type="number" min={0} max={100} value={minDiscountDraft} onChange={(e) => setMinDiscountDraft(e.target.value)} />
            </Field>
          </div>
          {(parseDraft(minProfitDraft) !== null || parseDraft(minDiscountDraft) !== null) && !linkedProductId && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--warn)" }}>
              Profit/discount conditions work best linked to a Database product with known pricing — without one, Clynx
              may not have a reliable price to judge against yet.
            </p>
          )}
        </>
      )}

      {attempted && Object.keys(errors).length > 0 && (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--danger)" }}>Fill in the highlighted fields to continue.</p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button className="icon ghost" style={{ flex: 1 }} onClick={onClose}>
          Cancel
        </button>
        <button className="primary" style={{ flex: 1 }} disabled={(isEbay && !searchPhrase.trim()) || saving} onClick={save}>
          {saving ? "Saving…" : isEdit ? "Save changes" : "Create Watch"}
        </button>
      </div>
    </Modal>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 4, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" }}>
      {children}
    </div>
  );
}

// One labelled form row: label on top, the control(s) under it, then either
// the validation error (when there is one) or the muted hint. `group` is for
// a row holding several controls (the location buttons + input): a <label>
// would forward a click on its text to the first button inside it, so that
// one is a plain <div> styled like a label instead.
function Field({
  label,
  error,
  hint,
  grow,
  group,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  grow?: boolean;
  group?: boolean;
  children: React.ReactNode;
}) {
  const style: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, flex: grow ? 1 : undefined, minWidth: grow ? 0 : undefined };
  const body = (
    <>
      {group ? <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: "0.02em", textTransform: "uppercase", color: "var(--text-muted)" }}>{label}</span> : label}
      {children}
      {error ? (
        <span style={{ fontSize: 12, fontWeight: 500, textTransform: "none", letterSpacing: 0, color: "var(--danger)" }}>{error}</span>
      ) : hint ? (
        <span style={{ fontSize: 12, fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "var(--text-dim)" }}>{hint}</span>
      ) : null}
    </>
  );
  return group ? <div style={{ ...style, gap: 6 }}>{body}</div> : <label style={style}>{body}</label>;
}

function numToDraft(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : String(n);
}

function parseDraft(v: string): number | null {
  if (!v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
