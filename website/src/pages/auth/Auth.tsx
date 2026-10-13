import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Field, Loading, Notice, usePageMeta } from "../../components/ui";
import { errorText, post } from "../../lib/api";
import { useAuth, type User } from "../../lib/auth";

interface SessionResponse {
  user: User;
  csrfToken: string;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="wrap">
      <div className="card auth-card">
        <h1 style={{ fontSize: "1.8rem" }}>{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function Login() {
  usePageMeta("Sign in", "Sign in to your Clynx account.");
  const { user, signedIn } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from ?? "/account";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (user) return <Navigate to={from} replace />;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<SessionResponse>("/web/login", { email, password });
      signedIn(r.user, r.csrfToken);
      nav(from, { replace: true });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return (
    <Card title="Sign in">
      <form className="form" onSubmit={submit}>
        <Field label="Email" htmlFor="email">
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password">
          <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
        <p className="muted" style={{ margin: 0 }}>
          <Link to="/forgot-password">Forgot your password?</Link> - New to Clynx? <Link to="/signup">Create an account</Link>
        </p>
      </form>
    </Card>
  );
}

export function Signup() {
  usePageMeta("Create an account", "Create a Clynx account to manage your subscription, devices and downloads.");
  const { user, signedIn } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (user) return <Navigate to="/account" replace />;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<SessionResponse>("/web/signup", { email, password, displayName: name || undefined });
      signedIn(r.user, r.csrfToken);
      nav("/account", { replace: true, state: { welcome: true } });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return (
    <Card title="Create your account">
      <p className="muted">The Windows beta works without an account. An account lets you manage a subscription, see your devices and download releases.</p>
      <form className="form" onSubmit={submit}>
        <Field label="Name (optional)" htmlFor="name">
          <input id="name" type="text" autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" htmlFor="email" hint="We send a confirmation link to this address.">
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters. A long phrase is better than a short complicated word.">
          <input id="password" type="password" autoComplete="new-password" required minLength={8} maxLength={200} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? "Creating..." : "Create account"}</button>
        <p className="fine" style={{ margin: 0 }}>
          By creating an account you agree to the <Link to="/legal/terms">terms</Link> and <Link to="/legal/privacy">privacy policy</Link> (both still drafts).
        </p>
        <p className="muted" style={{ margin: 0 }}>Already have an account? <Link to="/login">Sign in</Link></p>
      </form>
    </Card>
  );
}

export function ForgotPassword() {
  usePageMeta("Reset your password", "Ask for an email link to reset your Clynx password.");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/web/password/forgot", { email });
      setSent(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Reset your password">
      {sent ? (
        <Notice kind="ok" role="status">
          <strong>Check your email.</strong>
          <p style={{ margin: "8px 0 0" }} className="muted">If an account exists for that address, a reset link is on its way. It works for one hour. The message may take a few minutes and can land in spam.</p>
        </Notice>
      ) : (
        <form className="form" onSubmit={submit}>
          <Field label="Email" htmlFor="email">
            <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {error && <div className="error" role="alert">{error}</div>}
          <button className="btn primary" disabled={busy}>{busy ? "Sending..." : "Email me a reset link"}</button>
          <p className="muted" style={{ margin: 0 }}><Link to="/login">Back to sign in</Link></p>
        </form>
      )}
    </Card>
  );
}

export function ResetPassword() {
  usePageMeta("Choose a new password", "Choose a new password for your Clynx account.");
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== again) return setError("The two passwords do not match.");
    setBusy(true);
    setError(null);
    try {
      await post("/web/password/reset", { token, newPassword: password });
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  if (!token) return <Card title="Choose a new password"><div className="error" role="alert">This page needs the link from your email. <Link to="/forgot-password">Ask for a new one.</Link></div></Card>;
  return (
    <Card title="Choose a new password">
      {done ? (
        <Notice kind="ok" role="status">
          <strong>Your password was changed.</strong>
          <p style={{ margin: "8px 0 12px" }} className="muted">You were signed out everywhere, including the Clynx app. Sign in again with the new password.</p>
          <Link to="/login" className="btn primary">Sign in</Link>
        </Notice>
      ) : (
        <form className="form" onSubmit={submit}>
          <Field label="New password" htmlFor="pw" hint="At least 8 characters.">
            <input id="pw" type="password" autoComplete="new-password" required minLength={8} maxLength={200} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Repeat the new password" htmlFor="pw2">
            <input id="pw2" type="password" autoComplete="new-password" required minLength={8} maxLength={200} value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
          {error && <div className="error" role="alert">{error} {error.includes("expired") && <Link to="/forgot-password">Ask for a new link.</Link>}</div>}
          <button className="btn primary" disabled={busy}>{busy ? "Saving..." : "Change password"}</button>
        </form>
      )}
    </Card>
  );
}

/** Opened from the link in an email: uses the token once, then says what happened. */
function TokenPage({ title, endpoint, okText, after }: { title: string; endpoint: string; okText: string; after?: () => void }) {
  usePageMeta(title);
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<"working" | "ok" | "failed">("working");
  const [message, setMessage] = useState("");
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return; // a link can only be used once; React's dev double-run must not spend it twice
    ran.current = true;
    if (!token) {
      setState("failed");
      setMessage("This page needs the link from your email.");
      return;
    }
    post(endpoint, { token })
      .then(() => {
        setState("ok");
        after?.();
      })
      .catch((e) => {
        setState("failed");
        setMessage(errorText(e));
      });
  }, [token, endpoint, after]);
  return (
    <Card title={title}>
      {state === "working" && <Loading what="Checking your link" />}
      {state === "ok" && (
        <Notice kind="ok" role="status">
          <strong>{okText}</strong>
          <p style={{ margin: "12px 0 0" }}><Link to="/account" className="btn primary">Go to your account</Link></p>
        </Notice>
      )}
      {state === "failed" && (
        <div className="error" role="alert">
          {message} <Link to="/account">Open your account</Link> to ask for a new link.
        </div>
      )}
    </Card>
  );
}

export function VerifyEmail() {
  const { refresh } = useAuth();
  return <TokenPage title="Confirm your email" endpoint="/web/email/verify" okText="Your email address is confirmed." after={() => void refresh()} />;
}
export function ConfirmEmailChange() {
  const { refresh } = useAuth();
  return <TokenPage title="Confirm your new email" endpoint="/web/email/confirm-change" okText="Your email address was changed." after={() => void refresh()} />;
}
