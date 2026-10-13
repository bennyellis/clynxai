import React, { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { BetaInfo } from "../lib/api.js";

// Config > Account (beta builds, and any build as "About"): which build this is, whether Chrome/Edge was found for scanning, and the tester's OWN API keys.
// Keys are saved to this computer only, are never shown again after saving, and are never part of a support report.

export function AboutBlock({ info }: { info: BetaInfo }) {
  return (
    <div data-testid="about-block" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
      <div>
        <strong data-testid="about-version">Clynx {info.version}</strong>
        {info.channel === "beta" && <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 800, padding: "2px 8px", borderRadius: 999, background: "var(--warn-bg)", color: "var(--warn)" }}>BETA</span>}
      </div>
      <div style={{ color: "var(--text-dim)" }}>
        Build {info.commit}
        {info.builtAt ? `, ${new Date(info.builtAt).toLocaleString()}` : ""}
      </div>
      <div style={{ color: "var(--text-dim)" }}>
        {info.localMode
          ? "Local mode: everything stays on this computer. No Clynx Cloud account, plan or billing is used, and AI and eBay need keys of your own."
          : info.apiSource === "own"
            ? "Cloud mode: signed in to Clynx Cloud, using the OpenAI and eBay keys saved on this computer."
            : "Cloud mode: signed in to Clynx Cloud. AI and eBay are provided by Clynx; you do not need any keys."}
      </div>
    </div>
  );
}

export function BrowserBlock({ info }: { info: BetaInfo }) {
  const b = info.browser;
  return (
    <div data-testid="browser-block" style={{ fontSize: 14, display: "flex", flexDirection: "column", gap: 6 }}>
      {b.ok ? (
        <div data-testid="browser-ok">
          <span style={{ fontWeight: 700 }}>Ready.</span> Clynx will scan with {b.using}
          {b.found.length > 1 ? ` (also found: ${b.found.filter((f) => f !== b.using).join(", ")})` : ""}.
        </div>
      ) : (
        <>
          <div data-testid="browser-missing" style={{ color: "var(--danger)", fontWeight: 700 }}>
            No supported browser found
          </div>
          <div style={{ color: "var(--text-muted)" }}>{b.instructions}</div>
          <div>
            <button className="ghost" onClick={() => window.open(b.downloadUrl)}>
              Get Google Chrome
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function KeysBlock({ info, onChanged }: { info: BetaInfo; onChanged: () => void }) {
  const [openai, setOpenai] = useState("");
  const [ebayId, setEbayId] = useState("");
  const [ebaySecret, setEbaySecret] = useState("");
  const [hasEbay, setHasEbay] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void api.hasEbayCredentials().then(setHasEbay);
  }, []);
  const saveOpenai = async () => {
    const r = await api.saveOpenAIKey(openai);
    setNote(r.ok ? (openai.trim() ? "Your OpenAI key was saved on this computer." : "Your OpenAI key was removed.") : (r.error ?? "That did not work."));
    if (r.ok) {
      setOpenai("");
      onChanged();
    }
  };
  const saveEbay = async () => {
    const r = await api.saveEbayCredentials(ebayId, ebaySecret);
    setNote(r.ok ? "Your eBay keys were saved on this computer." : (r.error ?? "That did not work."));
    if (r.ok) {
      setEbayId("");
      setEbaySecret("");
      setHasEbay(true);
    }
  };
  return (
    <div data-testid="keys-block" style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: 14 }}>
      <div style={{ color: "var(--text-muted)" }}>
        Clynx does not include any API keys. The AI parts of Clynx (judging listings, the assistant, product research) use <strong>your own</strong> OpenAI key, and OpenAI bills you directly for it. Without a key
        they simply do not run. Keys are stored only on this computer.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 460 }}>
        <strong>
          OpenAI API key{" "}
          {info.hasOpenAIKey ? <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>(a key is saved)</span> : <span style={{ color: "var(--warn)", fontWeight: 400 }}>(none yet)</span>}
        </strong>
        <input data-testid="openai-key" type="password" autoComplete="off" spellCheck={false} placeholder="sk-..." value={openai} onChange={(e) => setOpenai(e.target.value)} />
        <div style={{ display: "flex", gap: 8 }}>
          <button className="ghost" data-testid="openai-save" disabled={!openai.trim() && !info.hasOpenAIKey} onClick={() => void saveOpenai()}>
            {openai.trim() ? "Save key" : "Remove saved key"}
          </button>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 460 }}>
        <strong>
          eBay developer keys{" "}
          {hasEbay ? <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>(saved)</span> : <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>(optional: needed for eBay prices and eBay searches)</span>}
        </strong>
        <input data-testid="ebay-id" type="password" autoComplete="off" spellCheck={false} placeholder="App ID (Client ID)" value={ebayId} onChange={(e) => setEbayId(e.target.value)} />
        <input data-testid="ebay-secret" type="password" autoComplete="off" spellCheck={false} placeholder="Cert ID (Client Secret)" value={ebaySecret} onChange={(e) => setEbaySecret(e.target.value)} />
        <div>
          <button className="ghost" data-testid="ebay-save" disabled={!ebayId.trim() || !ebaySecret.trim()} onClick={() => void saveEbay()}>
            Save eBay keys
          </button>
        </div>
      </div>
      {note && (
        <div data-testid="keys-note" style={{ color: "var(--text-muted)" }}>
          {note}
        </div>
      )}
    </div>
  );
}

/** Cloud mode: AI and eBay come from Clynx. Keys saved from the beta are never deleted for you; the person moves off them, or deletes them, on purpose. */
export function CloudApisBlock({ info, onChanged }: { info: BetaInfo; onChanged: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = async (source: "shared" | "own") => {
    const r = await api.setApiSource(source);
    setNote(r.ok ? (source === "shared" ? "Using Clynx's shared AI and eBay. Your saved keys were kept but are not used." : "Using the keys saved on this computer.") : (r.error ?? "That did not work."));
    onChanged();
  };
  return (
    <div data-testid="cloud-apis" style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 14 }}>
      {info.apiSource === "shared" ? (
        <div data-testid="apis-shared">AI and eBay are provided by Clynx through your account. <strong>You do not need an OpenAI or eBay key.</strong> Usage is limited by your plan.</div>
      ) : (
        <div data-testid="apis-own">You are using the OpenAI and eBay keys saved on this computer (from the beta). Clynx also offers its own shared AI and eBay service with your account, so keys are optional.</div>
      )}
      {info.hasSavedKeys && (
        <div className="muted" style={{ color: "var(--text-muted)" }}>
          Keys (OpenAI and/or eBay) are saved on this computer. They stay here until you delete them.
        </div>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {info.apiSource === "own" && (
          <button className="ghost" data-testid="use-shared" onClick={() => void set("shared")}>
            Use Clynx's shared AI and eBay (keeps my keys saved)
          </button>
        )}
        {info.apiSource === "shared" && info.hasSavedKeys && (
          <button className="ghost" data-testid="use-own" onClick={() => void set("own")}>
            Use my own saved keys again
          </button>
        )}
        {info.hasSavedKeys && !confirmDelete && (
          <button className="ghost" data-testid="delete-keys" onClick={() => setConfirmDelete(true)}>
            Delete my saved keys...
          </button>
        )}
        {confirmDelete && (
          <>
            <span>Delete the OpenAI and eBay keys from this computer?</span>
            <button className="danger-solid" data-testid="delete-keys-confirm" onClick={async () => { await api.deleteSavedKeys(); setConfirmDelete(false); setNote("Your saved keys were deleted from this computer."); onChanged(); }}>Delete them</button>
            <button className="ghost" onClick={() => setConfirmDelete(false)}>Keep them</button>
          </>
        )}
      </div>
      {note && <div data-testid="apis-note" style={{ color: "var(--text-muted)" }}>{note}</div>}
    </div>
  );
}

export function LocalLogoutSection({ onLoggedOut }: { onLoggedOut: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>
      <div style={{ color: "var(--text-muted)" }}>Leaving local mode returns to the start screen. Your Database and settings stay on this computer and are there again when you come back.</div>
      <div>
        <button
          className="ghost"
          data-testid="leave-local"
          onClick={async () => {
            await api.auth.logout();
            onLoggedOut();
          }}
        >
          Leave local mode
        </button>
      </div>
    </div>
  );
}

export function useBetaInfo(): [BetaInfo | null, () => void] {
  const [info, setInfo] = useState<BetaInfo | null>(null);
  const load = useCallback(() => {
    void api.beta.info().then(setInfo);
  }, []);
  useEffect(load, [load]);
  return [info, load];
}
