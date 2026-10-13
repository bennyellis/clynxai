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
        {info.localMode ? "Local mode: everything stays on this computer. No Clynx Cloud account, plan or billing is used." : "Signed in to Clynx Cloud."}
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
