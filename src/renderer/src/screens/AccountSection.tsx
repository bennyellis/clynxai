import React, { useCallback, useEffect, useState } from "react";
import type { BillingStatus } from "../../../main/types.js";
import { api } from "../lib/api.js";
import { describeSubscription } from "../lib/subscriptionText.js";

// Config > Account: plan and subscription status, upgrade / manage billing (opens the user's browser), password change, account deletion. The app never sees a card number: payment
// happens on the billing provider's own page. Everything shown comes from the server (the single source of truth for what a plan allows).

export function AccountSection({ onDeleted }: { onDeleted?: () => void }) {
  const [b, setB] = useState<BillingStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [del, setDel] = useState<{ open: boolean; password: string }>({ open: false, password: "" });

  const load = useCallback(() => {
    void api.account.getBilling().then(setB);
  }, []);
  useEffect(() => {
    load();
    // after the browser checkout / portal, the app is focused again: show the new state
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const run = async (f: () => Promise<{ ok: boolean; error?: string }>, success?: string) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await f();
      setNote(r.ok ? (success ?? null) : (r.error ?? "That did not work."));
      return r.ok;
    } finally {
      setBusy(false);
    }
  };

  if (b === undefined) return <p style={{ color: "var(--text-dim)", fontSize: 13 }}>Loading your account…</p>;
  if (b === null) {
    return <p data-testid="account-unavailable" style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>Your plan can't be shown right now: Clynx Cloud isn't reachable. Everything on this computer keeps working.</p>;
  }
  const d = describeSubscription(b);
  const hasLiveSub = b.subscription && ["trialing", "active", "canceling", "past_due_grace"].includes(b.subscription.phase);
  const lim = b.entitlements.aiRequestsPerDay ?? null;
  return (
    <div data-testid="account-section" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ border: `1px solid ${d.tone === "warn" ? "var(--warn)" : "var(--border)"}`, borderRadius: 12, padding: "14px 16px", background: d.tone === "warn" ? "var(--warn-bg)" : "var(--bg-card)" }}>
        <div data-testid="account-plan" style={{ fontWeight: 800, fontSize: 17 }}>{d.headline}</div>
        <div style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 4 }}>{d.detail}</div>
        <div data-testid="account-usage" style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 8 }}>
          AI requests today: {b.usage.aiRequestsToday}
          {lim !== null ? ` of ${lim}` : " (no daily limit)"} · Watches: {b.entitlements.maxWatches == null ? "unlimited" : `up to ${b.entitlements.maxWatches}`} · Devices: {b.entitlements.maxDevices == null ? "unlimited" : `up to ${b.entitlements.maxDevices}`}
        </div>
      </div>

      {!b.configured ? (
        <p data-testid="account-billing-off" style={{ margin: 0, fontSize: 13.5, color: "var(--text-dim)" }}>Paid plans aren't available on this server yet.</p>
      ) : (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {!hasLiveSub && (
            <>
              <button className="primary" data-testid="account-upgrade-monthly" disabled={busy} onClick={() => void run(() => api.account.startCheckout("pro_monthly"), "Finish in your browser; this page updates when you come back.")}>
                {b.trialDays > 0 && !b.subscription ? `Start ${b.trialDays}-day free trial (monthly)` : "Upgrade to Pro (monthly)"}
              </button>
              <button className="ghost" data-testid="account-upgrade-yearly" disabled={busy} onClick={() => void run(() => api.account.startCheckout("pro_yearly"), "Finish in your browser; this page updates when you come back.")}>
                Pro, yearly
              </button>
            </>
          )}
          {b.canManage && (
            <button className="ghost" data-testid="account-manage" disabled={busy} onClick={() => void run(() => api.account.openBillingPortal())}>
              Manage billing, payment method or cancel
            </button>
          )}
          <button className="ghost" onClick={load}>Refresh</button>
        </div>
      )}
      <div className="row" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="ghost" data-testid="account-website" onClick={() => void api.auth.openWebsite("account")}>
          Open my account on the website
        </button>
        <button className="ghost" onClick={() => void api.auth.openWebsite("devices")}>
          My devices
        </button>
      </div>
      {note && <div data-testid="account-note" style={{ color: "var(--text-muted)", fontSize: 14 }}>{note}</div>}

      <details>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>Change password</summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 360, marginTop: 8 }}>
          <input type="password" placeholder="Current password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <input type="password" placeholder="New password (8+ characters)" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <button
            className="ghost"
            disabled={busy || !pw.current || pw.next.length < 8}
            onClick={() => void run(() => api.account.changePassword(pw.current, pw.next), "Password changed. You were signed out everywhere; sign in again.").then((ok) => ok && setPw({ current: "", next: "" }))}
          >
            Change password
          </button>
        </div>
      </details>

      <details>
        <summary style={{ cursor: "pointer", fontWeight: 700, color: "var(--danger)" }}>Delete my account</summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 420, marginTop: 8 }}>
          <span style={{ fontSize: 13.5, color: "var(--text-muted)" }}>
            This removes your Clynx Cloud account and everything synced to it, and cancels a paid subscription. Data on this computer is not deleted.
          </span>
          {!del.open ? (
            <button className="ghost" style={{ color: "var(--danger)" }} onClick={() => setDel({ open: true, password: "" })}>Delete my account…</button>
          ) : (
            <>
              <input type="password" placeholder="Your password" value={del.password} onChange={(e) => setDel({ open: true, password: e.target.value })} />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="ghost" onClick={() => setDel({ open: false, password: "" })}>Cancel</button>
                <button className="danger-solid" disabled={busy || !del.password} onClick={() => void run(() => api.account.deleteAccount(del.password), "Your account was deleted.").then((ok) => ok && onDeleted?.())}>
                  Permanently delete
                </button>
              </div>
            </>
          )}
        </div>
      </details>
    </div>
  );
}
