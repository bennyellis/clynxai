import React, { useState } from "react";
import { api } from "../lib/api.js";
import { Modal } from "../components/Modal.js";
import { RESET_CONFIRM_WORD, RESET_ERASES, RESET_KEEPS } from "../../../main/resetText.js";

// Config > Account > Reset Clynx. Returns this user's Clynx on this computer to a freshly installed state (the sign-in stays). It makes a safety backup first, says exactly what goes and
// what stays, and needs the word RESET typed. Clynx restarts by itself when it is done.

export function ResetClynxSection({ cloudSignedIn }: { cloudSignedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [alsoFacebook, setAlsoFacebook] = useState(false);
  const [alsoCloud, setAlsoCloud] = useState(cloudSignedIn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const ready = typed.trim() === RESET_CONFIRM_WORD && !busy;
  async function go() {
    setBusy(true);
    setError(null);
    const r = await api.resetClynx({ confirm: typed.trim(), alsoFacebook, alsoCloud: cloudSignedIn && alsoCloud });
    setBusy(false);
    if (r.ok) setDone(r.backupFolder ?? "");
    else setError(r.error ?? "The reset did not work.");
  }
  const close = () => {
    if (busy || done !== null) return;
    setOpen(false);
    setTyped("");
    setError(null);
  };

  return (
    <div data-testid="reset-clynx" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ margin: 0, fontSize: 14.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Start over: Clynx forgets everything it learned and goes back to a freshly installed state. You stay signed in. A safety backup is made first.
      </p>
      <div>
        <button className="danger" data-testid="reset-clynx-open" onClick={() => setOpen(true)}>
          Reset Clynx…
        </button>
      </div>
      {open && (
        <Modal title={done !== null ? "Clynx was reset" : "Reset Clynx?"} onClose={close} width={560}>
          {done !== null ? (
            <>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>Everything was reset. Clynx is restarting now.</p>
              {done && <p style={{ margin: 0, fontSize: 13.5, color: "var(--text-dim)", lineHeight: 1.5 }}>A copy of what you had is saved in {done}. To go back, use Config &gt; Account &gt; Database backups.</p>}
            </>
          ) : (
            <>
              <div style={{ fontSize: 14.5, lineHeight: 1.5 }}>
                <strong style={{ color: "var(--danger)" }}>This erases:</strong>
                <ul style={{ margin: "4px 0 10px", paddingLeft: 20 }}>
                  {RESET_ERASES.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
                <strong>This keeps:</strong>
                <ul style={{ margin: "4px 0 6px", paddingLeft: 20 }}>
                  {RESET_KEEPS.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14 }}>
                <input type="checkbox" data-testid="reset-facebook" checked={alsoFacebook} onChange={(e) => setAlsoFacebook(e.target.checked)} />
                <span>Also remove my saved Facebook logins (I will log in to Facebook again)</span>
              </label>
              {cloudSignedIn && (
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14 }}>
                  <input type="checkbox" data-testid="reset-cloud" checked={alsoCloud} onChange={(e) => setAlsoCloud(e.target.checked)} />
                  <span>
                    Also remove my synced products, Watches and corrections from Clynx Cloud. <strong>Other computers on this account lose them too.</strong> If this is off, the next sync brings them back.
                  </span>
                </label>
              )}
              <div style={{ fontSize: 14 }}>
                Type <strong>{RESET_CONFIRM_WORD}</strong> to confirm:
              </div>
              <input data-testid="reset-type" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={RESET_CONFIRM_WORD} onKeyDown={(e) => e.key === "Enter" && ready && void go()} />
              {error && <div data-testid="reset-error" style={{ color: "var(--danger)", fontSize: 13.5 }}>{error}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <button className="icon" style={{ flex: 1 }} disabled={busy} onClick={close}>
                  Cancel
                </button>
                <button className="danger-solid" data-testid="reset-go" style={{ flex: 1 }} disabled={!ready} onClick={() => void go()}>
                  {busy ? "Backing up and resetting…" : "Reset Clynx"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
