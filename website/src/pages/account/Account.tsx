import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet, useNavigate, useSearchParams } from "react-router-dom";
import { Field, Loading, Notice, usePageMeta } from "../../components/ui";
import { ApiError, del, errorText, get, patch, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { describeSubscription, formatDate, formatDateTime, limitText, type SubscriptionView } from "../../lib/format";

export function AccountLayout() {
  return (
    <div className="wrap portal">
      <nav className="side" aria-label="Account">
        <NavLink to="/account" end>Overview</NavLink>
        <NavLink to="/account/billing">Subscription</NavLink>
        <NavLink to="/account/devices">Devices and sessions</NavLink>
        <NavLink to="/account/profile">Profile and security</NavLink>
        <Link to="/download">Download Clynx</Link>
        <Link to="/support">Support</Link>
      </nav>
      <div className="stack">
        <Outlet />
      </div>
    </div>
  );
}

function VerifyBanner() {
  const { user } = useAuth();
  const [state, setState] = useState<"idle" | "sent" | "limit" | "error">("idle");
  if (!user || user.emailVerified) return null;
  return (
    <Notice kind="warn" role="status">
      <strong>Please confirm your email address.</strong>
      <p style={{ margin: "6px 0 10px" }} className="muted">We sent a link to {user.email}. Confirming lets us reach you about your account and is needed before subscribing once payments open.</p>
      <button
        className="btn small"
        onClick={async () => {
          try {
            await post("/web/email/resend");
            setState("sent");
          } catch (e) {
            setState(e instanceof ApiError && e.status === 429 ? "limit" : "error");
          }
        }}
      >
        Send the link again
      </button>
      {state === "sent" && <span className="muted" style={{ marginLeft: 12 }} role="status">Sent - check your inbox.</span>}
      {state === "limit" && <span className="muted" style={{ marginLeft: 12 }} role="status">Please wait a while before asking again.</span>}
      {state === "error" && <span className="muted" style={{ marginLeft: 12 }} role="status">That did not work. Try again later.</span>}
    </Notice>
  );
}

interface Billing {
  owner?: boolean;
  configured: boolean;
  plan: "free" | "pro";
  interval: "month" | "year" | null;
  trialEligible: boolean;
  trialDays: number;
  subscription: SubscriptionView | null;
  canManage: boolean;
  entitlements: { maxWatches: number | null; maxDevices: number | null; aiRequestsPerDay: number | null };
  usage: { aiRequestsToday: number };
}

export function Overview() {
  usePageMeta("Your account");
  const { user } = useAuth();
  const [b, setB] = useState<Billing | null>(null);
  const [support, setSupport] = useState<Array<{ id: string; subject: string; status: string; createdAt: string }>>([]);
  useEffect(() => {
    get<Billing>("/billing/status").then(setB).catch(() => setB(null));
    get<{ requests: typeof support }>("/support/requests/mine").then((r) => setSupport(r.requests)).catch(() => undefined);
  }, []);
  if (!user) return null;
  const d = b ? (b.owner ? { headline: "Owner — Full Access", detail: "Every feature and plan is included. No subscription or payment details are needed.", tone: "ok" as const } : describeSubscription(b.plan, b.subscription, b.interval)) : null;
  return (
    <>
      <h1 style={{ fontSize: "1.9rem" }}>Hello{user.displayName ? `, ${user.displayName}` : ""}</h1>
      <VerifyBanner />
      <section className="card">
        <h2 style={{ fontSize: "1.3rem" }}>Your plan</h2>
        {d && b ? (
          <>
            <p style={{ fontWeight: 800, fontSize: "1.2rem", margin: "0 0 4px" }} data-testid="plan-headline">{d.headline}</p>
            <p className="muted">{d.detail}</p>
            <p className="dim" style={{ fontSize: ".9rem" }}>
              AI requests today: {b.usage.aiRequestsToday} of {limitText(b.entitlements.aiRequestsPerDay)}
            </p>
            {!b.owner && <Link to="/account/billing" className="btn small">Manage subscription</Link>}
          </>
        ) : (
          <Loading />
        )}
      </section>
      <section className="card">
        <h2 style={{ fontSize: "1.3rem" }}>Get Clynx</h2>
        <p className="muted">Download the Windows app and sign in with this account, or use the beta without one.</p>
        <Link to="/download" className="btn primary small">Go to downloads</Link>
      </section>
      <section className="card">
        <h2 style={{ fontSize: "1.3rem" }}>Your support requests</h2>
        {support.length === 0 ? (
          <p className="muted">None yet. <Link to="/support#report">Contact support</Link></p>
        ) : (
          <ul className="list">
            {support.map((s) => (
              <li key={s.id}>
                <span>{s.subject}</span>
                <span className={`pill ${s.status === "resolved" ? "ok" : "warn"}`}>{s.status.replace("_", " ")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function BillingPage() {
  usePageMeta("Subscription");
  const [params] = useSearchParams();
  const returned = params.get("checkout");
  const [b, setB] = useState<Billing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const load = useCallback(async () => {
    const s = await get<Billing>("/billing/status");
    setB(s);
    return s;
  }, []);
  useEffect(() => {
    load().catch(() => setError("Your subscription could not be loaded."));
  }, [load]);

  // After checkout or a change the provider tells us by webhook, which can lag a moment: look again a few times.
  const settle = useCallback(
    async (changed: (s: Billing) => boolean) => {
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const s = await load().catch(() => null);
        if (s && changed(s)) return;
      }
    },
    [load]
  );
  useEffect(() => {
    if (returned === "success") {
      setInfo("Thanks - confirming your subscription with the payment provider...");
      void settle((s) => !!s.subscription).then(() => setInfo(null));
    }
  }, [returned, settle]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  const go = (url: string) => window.location.assign(url);

  if (!b) return error ? <div className="error" role="alert">{error}</div> : <Loading what="Loading your subscription" />;
  if (b.owner)
    return (
      <>
        <h1 style={{ fontSize: "1.9rem" }}>Subscription</h1>
        <section className="card" data-testid="owner-card">
          <p style={{ fontWeight: 800, fontSize: "1.3rem", margin: "0 0 4px" }} data-testid="plan-headline">Owner — Full Access</p>
          <p className="muted">This account has every feature and every plan without a subscription. There is nothing to pay and no payment details to enter. The same applies in the Clynx app.</p>
          <p className="dim" style={{ fontSize: ".9rem" }}>Safety limits on spending and request rates still apply to every account, including this one (see Console &rarr; Spending and safety).</p>
        </section>
      </>
    );
  const d = describeSubscription(b.plan, b.subscription, b.interval);
  const live = !!b.subscription && ["trialing", "active", "canceling", "past_due_grace"].includes(b.subscription.phase);
  const onYearly = b.interval === "year";
  const past = b.subscription?.phase === "past_due_grace" || b.subscription?.phase === "past_due_lapsed";

  return (
    <>
      <h1 style={{ fontSize: "1.9rem" }}>Subscription</h1>
      {returned === "cancelled" && <Notice role="status">Checkout was cancelled. You were not charged.</Notice>}
      {info && <Notice role="status">{info}</Notice>}
      {error && <div className="error" role="alert">{error}</div>}
      <VerifyBanner />
      <section className={`card`}>
        <p style={{ fontWeight: 800, fontSize: "1.25rem", margin: "0 0 4px" }} data-testid="plan-headline">{d.headline}</p>
        <p className={d.tone === "warn" ? "" : "muted"} style={d.tone === "warn" ? { color: "#fde68a" } : undefined} data-testid="plan-detail">{d.detail}</p>
        <p className="dim" style={{ fontSize: ".9rem" }}>
          Limits on this plan: {limitText(b.entitlements.maxWatches)} Watches, {limitText(b.entitlements.maxDevices)} computers, {limitText(b.entitlements.aiRequestsPerDay)} AI requests a day (used today: {b.usage.aiRequestsToday}).
        </p>
      </section>

      {past && (
        <Notice kind="warn" role="alert">
          <strong>Your last payment did not go through.</strong>
          <p style={{ margin: "6px 0 10px" }} className="muted">Update your payment method to keep Pro. Nothing is deleted if it lapses; the account simply returns to Free.</p>
          <button className="btn primary small" disabled={busy !== null} onClick={() => void run("portal", async () => go((await post<{ url: string }>("/billing/portal")).url))}>Update payment method</button>
        </Notice>
      )}

      {!b.configured && <Notice kind="warn">Payments are not open yet, so there is nothing to subscribe to. The free plan and the beta are available now.</Notice>}

      {b.configured && !live && (
        <section className="card" aria-labelledby="sub-h">
          <h2 id="sub-h" style={{ fontSize: "1.3rem" }}>{b.trialEligible && b.trialDays > 0 ? `Start your ${b.trialDays}-day free trial` : "Subscribe to Pro"}</h2>
          <p className="muted">
            {b.trialEligible && b.trialDays > 0 ? `You are not charged until the trial ends, and you can cancel before then. A trial is offered once per account.` : "Pro is billed until you cancel."} Prices are shown on the <Link to="/pricing">pricing page</Link>.
          </p>
          <div className="row">
            <button className="btn primary" disabled={busy !== null} onClick={() => void run("monthly", async () => go((await post<{ url: string }>("/billing/checkout", { plan: "pro_monthly" })).url))}>
              {busy === "monthly" ? "Opening checkout..." : "Monthly billing"}
            </button>
            <button className="btn" disabled={busy !== null} onClick={() => void run("yearly", async () => go((await post<{ url: string }>("/billing/checkout", { plan: "pro_yearly" })).url))}>
              {busy === "yearly" ? "Opening checkout..." : "Annual billing"}
            </button>
          </div>
        </section>
      )}

      {b.configured && live && (
        <section className="card">
          <h2 style={{ fontSize: "1.3rem" }}>Change your subscription</h2>
          <div className="row">
            {!past && (
              <button
                className="btn"
                disabled={busy !== null}
                onClick={() =>
                  void run("switch", async () => {
                    await post("/billing/change-plan", { plan: onYearly ? "pro_monthly" : "pro_yearly" });
                    setInfo("Switching your billing interval...");
                    await settle((s) => s.interval !== b.interval);
                    setInfo(null);
                  })
                }
              >
                {busy === "switch" ? "Switching..." : onYearly ? "Switch to monthly billing" : "Switch to annual billing"}
              </button>
            )}
            {b.canManage && (
              <button className="btn ghost" disabled={busy !== null} onClick={() => void run("portal", async () => go((await post<{ url: string }>("/billing/portal")).url))}>
                Payment method and invoices
              </button>
            )}
            {b.subscription?.cancelAtPeriodEnd ? (
              <button
                className="btn"
                disabled={busy !== null}
                onClick={() =>
                  void run("resume", async () => {
                    await post("/billing/resume");
                    await settle((s) => !s.subscription?.cancelAtPeriodEnd);
                  })
                }
              >
                {busy === "resume" ? "Resuming..." : "Resume subscription"}
              </button>
            ) : (
              <button className="btn danger" disabled={busy !== null} onClick={() => setConfirmCancel(true)}>
                Cancel subscription
              </button>
            )}
          </div>
          <p className="fine">Switching between monthly and annual is prorated by the payment provider and never interrupts access. Cancelling keeps Pro until the end of the period you have paid for.</p>
          {confirmCancel && (
            <Notice kind="warn" role="alertdialog">
              <strong>Cancel your subscription?</strong>
              <p style={{ margin: "6px 0 12px" }} className="muted">
                Pro stays until {formatDate(b.subscription?.currentPeriodEnd ?? b.subscription?.trialEnd ?? null)}, and then your account returns to Free. You can resume until then.
              </p>
              <div className="row">
                <button
                  className="btn danger"
                  disabled={busy !== null}
                  onClick={() =>
                    void run("cancel", async () => {
                      await post("/billing/cancel");
                      setConfirmCancel(false);
                      await settle((s) => !!s.subscription?.cancelAtPeriodEnd);
                    })
                  }
                >
                  {busy === "cancel" ? "Cancelling..." : "Yes, cancel at the end of the period"}
                </button>
                <button className="btn ghost" onClick={() => setConfirmCancel(false)}>Keep my subscription</button>
              </div>
            </Notice>
          )}
        </section>
      )}
      <p className="fine">Terms: <Link to="/legal/subscription">subscription and cancellation</Link> - <Link to="/legal/refunds">refunds</Link> (drafts).</p>
    </>
  );
}

interface Device { id: string; platform: string; clientVersion: string; lastSeenAt: string | null; createdAt: string }
interface WebSession { id: string; userAgent: string | null; createdAt: string; lastSeenAt: string; current: boolean }

export function DevicesPage() {
  usePageMeta("Devices and sessions");
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [sessions, setSessions] = useState<WebSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = useCallback(() => {
    get<{ devices: Device[] }>("/devices").then((r) => setDevices(r.devices)).catch((e) => setError(errorText(e)));
    get<{ sessions: WebSession[] }>("/web/sessions").then((r) => setSessions(r.sessions)).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      setConfirm(null);
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      <h1 style={{ fontSize: "1.9rem" }}>Devices and sessions</h1>
      {error && <div className="error" role="alert">{error}</div>}
      <section className="card">
        <h2 style={{ fontSize: "1.3rem" }}>Computers signed in to Clynx</h2>
        <p className="muted">Each computer where the Clynx app is signed in to this account. Removing one signs that computer out; it must sign in again to sync.</p>
        {!devices ? <Loading /> : devices.length === 0 ? <p className="muted">No computers yet. The Windows beta can be used without an account; sign in from the app to see it here.</p> : (
          <ul className="list" data-testid="device-list">
            {devices.map((d) => (
              <li key={d.id}>
                <span>
                  <strong>{d.platform}</strong> - Clynx {d.clientVersion}
                  <br />
                  <span className="dim" style={{ fontSize: ".88rem" }}>Last active {formatDateTime(d.lastSeenAt)} - added {formatDate(d.createdAt)}</span>
                </span>
                {confirm === d.id ? (
                  <span className="row">
                    <button className="btn danger small" onClick={() => void act(() => del(`/devices/${d.id}`))}>Yes, sign it out</button>
                    <button className="btn ghost small" onClick={() => setConfirm(null)}>Cancel</button>
                  </span>
                ) : (
                  <button className="btn small" onClick={() => setConfirm(d.id)}>Remove</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <h2 style={{ fontSize: "1.3rem" }}>Browsers signed in to this website</h2>
        {!sessions ? <Loading /> : (
          <ul className="list" data-testid="session-list">
            {sessions.map((s) => (
              <li key={s.id}>
                <span>
                  {s.current && <span className="pill ok" style={{ marginRight: 8 }}>this browser</span>}
                  <span style={{ fontSize: ".92rem" }}>{(s.userAgent ?? "Unknown browser").slice(0, 70)}</span>
                  <br />
                  <span className="dim" style={{ fontSize: ".88rem" }}>Last active {formatDateTime(s.lastSeenAt)}</span>
                </span>
                {!s.current && <button className="btn small" onClick={() => void act(() => del(`/web/sessions/${s.id}`))}>Sign out</button>}
              </li>
            ))}
          </ul>
        )}
        {sessions && sessions.length > 1 && (
          <p><button className="btn small" onClick={() => void act(() => post("/web/sessions/revoke-others"))}>Sign out all other browsers</button></p>
        )}
      </section>
    </>
  );
}

export function ProfilePage() {
  usePageMeta("Profile and security");
  const { user, refresh, logout } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState(user?.displayName ?? "");
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string; where: string } | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [emailPw, setEmailPw] = useState("");
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [delPw, setDelPw] = useState("");
  const [delText, setDelText] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  if (!user) return null;
  const say = (where: string, kind: "success" | "error", text: string) => setMsg({ where, kind, text });
  const Msg = ({ where }: { where: string }) => (msg?.where === where ? <div className={msg.kind === "error" ? "error" : "success"} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</div> : null);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    try {
      await patch("/web/profile", { displayName: name });
      await refresh();
      say("name", "success", "Saved.");
    } catch (err) {
      say("name", "error", errorText(err));
    }
  }
  async function changeEmail(e: FormEvent) {
    e.preventDefault();
    try {
      await post("/web/email/change", { newEmail, password: emailPw });
      setNewEmail("");
      setEmailPw("");
      say("email", "success", `We sent a confirmation link to ${newEmail}. Your address changes when you open it.`);
    } catch (err) {
      say("email", "error", errorText(err));
    }
  }
  async function changePassword(e: FormEvent) {
    e.preventDefault();
    try {
      await post("/me/password", { currentPassword: curPw, newPassword: newPw });
      await logout();
      nav("/login", { replace: true });
    } catch (err) {
      say("password", "error", err instanceof ApiError && err.status === 401 ? "The current password is not right." : errorText(err));
    }
  }
  async function deleteAccount(e: FormEvent) {
    e.preventDefault();
    try {
      await del("/me", { password: delPw, confirm: "DELETE" });
      await logout();
      nav("/", { replace: true });
    } catch (err) {
      say("delete", "error", err instanceof ApiError && err.status === 401 ? "That password is not right." : errorText(err));
    }
  }
  return (
    <>
      <h1 style={{ fontSize: "1.9rem" }}>Profile and security</h1>
      <VerifyBanner />
      <section className="card">
        <h2 style={{ fontSize: "1.3rem" }}>Account</h2>
        <dl className="kv"><dt>Email</dt><dd>{user.email} {user.emailVerified ? <span className="pill ok">confirmed</span> : <span className="pill warn">not confirmed</span>}</dd><dt>Member since</dt><dd>{formatDate(user.createdAt)}</dd></dl>
        <form className="form" onSubmit={saveName} style={{ marginTop: 16 }}>
          <Field label="Name" htmlFor="p-name"><input id="p-name" type="text" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Msg where="name" />
          <div><button className="btn small">Save name</button></div>
        </form>
      </section>
      <section className="card">
        <h2 style={{ fontSize: "1.3rem" }}>Change email address</h2>
        <form className="form" onSubmit={changeEmail}>
          <Field label="New email" htmlFor="p-new-email" hint="The address only changes after you confirm it from that inbox."><input id="p-new-email" type="email" required value={newEmail} onChange={(e) => setNewEmail(e.target.value)} /></Field>
          <Field label="Your password" htmlFor="p-email-pw"><input id="p-email-pw" type="password" required autoComplete="current-password" value={emailPw} onChange={(e) => setEmailPw(e.target.value)} /></Field>
          <Msg where="email" />
          <div><button className="btn small">Send confirmation</button></div>
        </form>
      </section>
      <section className="card">
        <h2 style={{ fontSize: "1.3rem" }}>Change password</h2>
        <p className="muted">Changing your password signs you out everywhere, including the Clynx app.</p>
        <form className="form" onSubmit={changePassword}>
          <Field label="Current password" htmlFor="p-cur"><input id="p-cur" type="password" required autoComplete="current-password" value={curPw} onChange={(e) => setCurPw(e.target.value)} /></Field>
          <Field label="New password" htmlFor="p-new" hint="At least 8 characters."><input id="p-new" type="password" required minLength={8} maxLength={200} autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} /></Field>
          <Msg where="password" />
          <div><button className="btn small">Change password</button></div>
        </form>
      </section>
      <section className="card">
        <h2 style={{ fontSize: "1.3rem" }}>Your data</h2>
        <p className="muted">Download a copy of what we store about your account (profile, devices, subscription summary, Watches, product entries and support requests) as a JSON file. Passwords and secrets are never included.</p>
        <a className="btn small" href="/web/export" download="clynx-account-export.json">Download my data</a>
      </section>
      <section className="card" style={{ borderColor: "rgba(248,113,113,.4)" }}>
        <h2 style={{ fontSize: "1.3rem" }}>Delete account</h2>
        <p className="muted">This permanently deletes your account and everything stored for it on our servers, and cancels any subscription first. Data on your own computer is not touched.</p>
        {!showDelete ? (
          <button className="btn danger small" onClick={() => setShowDelete(true)}>Delete my account...</button>
        ) : (
          <form className="form" onSubmit={deleteAccount}>
            <Field label="Your password" htmlFor="d-pw"><input id="d-pw" type="password" required autoComplete="current-password" value={delPw} onChange={(e) => setDelPw(e.target.value)} /></Field>
            <Field label='Type DELETE to confirm' htmlFor="d-confirm"><input id="d-confirm" type="text" autoComplete="off" value={delText} onChange={(e) => setDelText(e.target.value)} /></Field>
            <Msg where="delete" />
            <div className="row">
              <button className="btn danger small" disabled={delText !== "DELETE" || !delPw}>Permanently delete</button>
              <button type="button" className="btn ghost small" onClick={() => setShowDelete(false)}>Cancel</button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
