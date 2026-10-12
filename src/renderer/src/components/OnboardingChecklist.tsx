import React, { useEffect, useState } from "react";
import type { Account, Config, ScrapeStatus } from "../lib/api.js";
import { api } from "../lib/api.js";
import { buildChecklist, type ChecklistStepId } from "../lib/onboarding.js";
import { Modal } from "./Modal.js";
import { NtfySetup } from "./NtfySetup.js";

const EXAMPLES = ["PlayStation 5", "Nintendo Switch", "iPhone 13", "Dyson V8"];

/**
 * "Get started" on the Dashboard: connect Facebook, choose where to look, add a first product, set up phone alerts. Each step is ticked from
 * the real state (not from clicks), explains itself, and has one button. Optional integrations are listed apart and marked optional. The
 * whole card can be hidden, and comes back from the Dashboard link or Config > Setup checklist.
 */
export function OnboardingChecklist({ accounts, statusMap, onGoToConfig }: { accounts: Account[]; statusMap: Record<string, ScrapeStatus>; onGoToConfig: () => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [open, setOpen] = useState<null | "product" | "phone">(null);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => {});
    const off = api.onConfigUpdated((next) => setConfig(next));
    return () => {
      off();
    };
  }, []);

  if (!config) return null;
  const model = buildChecklist({ config, accounts, statusMap });

  if (model.dismissed) {
    return (
      <div>
        <button className="icon ghost" onClick={() => api.updateOnboarding({ dismissed: false })} style={{ fontSize: 13 }}>
          Show the setup checklist
        </button>
      </div>
    );
  }

  const facebookAccount = accounts.find((a) => a.enabled) ?? accounts[0];

  async function connectFacebook() {
    if (!facebookAccount || connecting) return;
    setConnecting(true);
    setMessage("A Chrome window is opening. Log in to Facebook there; this tick appears by itself when you're in.");
    try {
      const ok = await api.login(facebookAccount.id);
      setMessage(ok ? null : "Clynx didn't see a login within 10 minutes. Press the button to try again.");
    } catch {
      setMessage("Clynx couldn't open Chrome. Make sure Google Chrome is installed, then try again.");
    } finally {
      setConnecting(false);
    }
  }

  const actionFor = (id: ChecklistStepId) => {
    switch (id) {
      case "facebook":
        return (
          <button className="primary" disabled={connecting || !facebookAccount} onClick={connectFacebook}>
            {connecting ? "Waiting for your login..." : "Open Facebook and log in"}
          </button>
        );
      case "location":
        return (
          <>
            <button className="primary" onClick={onGoToConfig}>
              Choose a city or state
            </button>
            <button className="icon" onClick={() => api.updateOnboarding({ locationChosen: true })}>
              Nationwide is fine
            </button>
          </>
        );
      case "product":
        return (
          <button className="primary" onClick={() => setOpen("product")}>
            Add a product
          </button>
        );
      case "phone":
        return (
          <>
            <button className="primary" onClick={() => setOpen("phone")}>
              Set up phone alerts
            </button>
            <button className="icon" onClick={() => api.updateOnboarding({ phoneSkipped: true })}>
              Skip for now
            </button>
          </>
        );
    }
  };

  return (
    <section className="card enter" aria-labelledby="onboarding-title" style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 id="onboarding-title" style={{ margin: 0, fontSize: 18 }}>
          Get started
        </h2>
        <span style={{ fontSize: 13.5, color: "var(--text-dim)" }} role="status">
          {model.doneCount} of {model.total} done
        </span>
      </div>

      {model.allDone && (
        <div role="status" style={{ padding: "10px 12px", borderRadius: 10, background: "var(--success-bg)", color: "var(--success)", fontSize: 14 }}>
          You're all set. Press <b>Start Scanner</b> above and Clynx starts looking. You can hide this checklist.
        </div>
      )}

      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        {model.steps.map((step, index) => (
          <li key={step.id} data-testid={`step-${step.id}`} data-done={step.done} style={{ display: "flex", gap: 12, alignItems: "flex-start", opacity: step.done ? 0.75 : 1 }}>
            <span
              aria-hidden="true"
              style={{
                flexShrink: 0,
                width: 24,
                height: 24,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                fontWeight: 700,
                border: `2px solid ${step.done ? "var(--success)" : "var(--border-strong)"}`,
                color: step.done ? "var(--success)" : "var(--text-muted)",
              }}
            >
              {step.done ? "✓" : index + 1}
            </span>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <b style={{ fontSize: 14.5 }}>{step.title}</b>
                {step.skippable && !step.done && <span className="pill" style={{ fontSize: 11.5 }}>Recommended</span>}
                <span style={{ fontSize: 12.5, color: step.done ? "var(--success)" : "var(--text-dim)" }}>{step.done ? "Done" : "To do"}</span>
              </div>
              <div style={{ fontSize: 13.5, color: "var(--text-muted)", lineHeight: 1.45 }}>{step.description}</div>
              {!step.done && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actionFor(step.id)}</div>}
            </div>
          </li>
        ))}
      </ol>

      {message && (
        <div role="status" style={{ fontSize: 13.5, color: "var(--text-muted)" }}>
          {message}
        </div>
      )}

      <details style={{ fontSize: 13.5 }}>
        <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>Optional extras (you can ignore these)</summary>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8, color: "var(--text-muted)", lineHeight: 1.45 }}>
          {model.extras.map((extra) => (
            <li key={extra.id}>
              <b>{extra.title}</b> <span className="pill" style={{ fontSize: 11.5 }}>Optional</span>
              <div>{extra.description}</div>
            </li>
          ))}
        </ul>
        <button className="icon ghost" onClick={onGoToConfig} style={{ marginTop: 8 }}>
          Open Config
        </button>
      </details>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="icon" onClick={() => api.updateOnboarding({ dismissed: true })}>
          Hide checklist
        </button>
        <span style={{ fontSize: 12.5, color: "var(--text-dim)" }}>You can bring it back any time from the Dashboard or Config &gt; Setup checklist.</span>
      </div>

      {open === "product" && <AddFirstProduct onClose={() => setOpen(null)} />}
      {open === "phone" && <PhoneStep config={config} onClose={() => setOpen(null)} />}
    </section>
  );
}

function AddFirstProduct({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e?: React.FormEvent) {
    e?.preventDefault();
    const product = name.trim();
    if (!product || busy) return;
    setBusy(true);
    setError(null);
    try {
      const match = await api.findMatchingProduct(product).catch(() => null);
      const max = Number(maxPrice.replace(/[^0-9.]/g, ""));
      const res = await api.searchForProducts([product], match?.id ?? null, null, Number.isFinite(max) && max > 0 ? max : null, false);
      if (res && res.ok === false) setError(res.message || "Clynx couldn't add that product.");
      else onClose();
    } catch {
      setError("Clynx couldn't add that product. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="What do you want to find?" onClose={onClose}>
      <form onSubmit={add} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label htmlFor="first-product">Product name</label>
        <input id="first-product" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. PlayStation 5" />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="Examples">
          {EXAMPLES.map((example) => (
            <button type="button" key={example} className="icon ghost" style={{ border: "1px solid var(--border)" }} onClick={() => setName(example)}>
              {example}
            </button>
          ))}
        </div>
        <label htmlFor="first-max">Most you'd pay (optional)</label>
        <input id="first-max" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} placeholder="e.g. 300" inputMode="decimal" />
        {error && (
          <div role="alert" style={{ color: "var(--danger)", fontSize: 13.5 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="icon" style={{ flex: 1 }} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" style={{ flex: 1 }} disabled={!name.trim() || busy}>
            {busy ? "Adding..." : "Add product"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PhoneStep({ config, onClose }: { config: Config; onClose: () => void }) {
  const [draft, setDraft] = useState({ server: config.ntfy.server, topic: config.ntfy.topic });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.saveNtfySettings(draft.server, draft.topic);
      if (!res.ok) setError(res.message ?? "That topic can't be saved.");
      else onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Deal alerts on your phone" onClose={onClose} width={560}>
      <NtfySetup server={draft.server} topic={draft.topic} onChange={setDraft} />
      {error && (
        <div role="alert" style={{ color: "var(--danger)", fontSize: 13.5 }}>
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="icon" style={{ flex: 1 }} onClick={onClose}>
          Not now
        </button>
        <button className="primary" style={{ flex: 1 }} disabled={busy || !draft.topic.trim()} onClick={save}>
          {busy ? "Saving..." : "Save"}
        </button>
      </div>
    </Modal>
  );
}
