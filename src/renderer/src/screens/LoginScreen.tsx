import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { BetaInfo, StartupProblem } from "../lib/api.js";

// Multi-user login migration — blocks the ENTIRE app until authenticated
// (see App.tsx, which renders this instead of everything else until
// api.auth.getSession() reports authenticated). Server URL defaults to
// whatever the install last used successfully (see index.ts's
// app-settings.json / auth:getSession), so a second computer on the LAN
// just needs to type the first computer's address once — plain
// email + password after that, same as any other login/register form.
// Matches Config.tsx's existing dark-card design language (.card, Field,
// button.primary/ghost) rather than inventing a new look.
// "fetch failed" / "ECONNREFUSED" is what a failed network request looks like
// when the Clynx server simply isn't running (most often: Docker Desktop
// isn't open, so the cloud containers are down). Raw, it reads like the app
// is broken; this says what's actually wrong and what to do.
function friendlyLoginError(raw: string, apiUrl: string): { message: string; unreachable: boolean } {
  if (/fetch failed|failed to fetch|econnrefused|enotfound|network|timed out|timeout|socket/i.test(raw)) {
    return {
      message: `Can't reach the Clynx server at ${apiUrl}. If you run it with Docker, make sure Docker Desktop is open and its containers are running, then try again.`,
      unreachable: true,
    };
  }
  return { message: raw, unreachable: false };
}

function readLastEmail(): string {
  try {
    return localStorage.getItem("clynx.lastEmail") ?? "";
  } catch {
    return "";
  }
}

export function LoginScreen({
  defaultApiUrl,
  onAuthenticated,
  startupProblem = null,
  onRetry,
}: {
  defaultApiUrl: string;
  onAuthenticated: () => void;
  // Opening the user's data failed (damaged database that could not be moved aside, full disk, locked file): explained here.
  startupProblem?: StartupProblem | null;
  onRetry?: () => void;
}) {
  const [problem, setProblem] = useState<StartupProblem | null>(startupProblem);
  useEffect(() => setProblem(startupProblem), [startupProblem]);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [apiUrl, setApiUrl] = useState(defaultApiUrl);
  const [email, setEmail] = useState(readLastEmail);
  // The server address is a technical detail most people never touch, so it
  // stays tucked away — and opens itself if the server can't be reached.
  const [showServer, setShowServer] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Beta builds lead with "use Clynx on this computer" and keep the Clynx Cloud form behind a link.
  const [beta, setBeta] = useState<BetaInfo | null>(null);
  const [showCloud, setShowCloud] = useState(false);
  useEffect(() => {
    void api.beta.info().then(setBeta).catch(() => setBeta(null));
  }, []);

  async function startLocal() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.auth.startLocal();
      if (!r.ok && r.startupProblem) {
        setProblem(r.startupProblem);
        return;
      }
      if (!r.ok) {
        setError(r.error ?? "Clynx could not start.");
        return;
      }
      onAuthenticated();
    } catch (err) {
      setError((err as Error).message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const trimmedUrl = apiUrl.trim() || defaultApiUrl;
      const trimmedEmail = email.trim();
      const result =
        mode === "login"
          ? await api.auth.login(trimmedUrl, trimmedEmail, password)
          : await api.auth.register(trimmedUrl, trimmedEmail, password);
      if (!result.ok && result.startupProblem) {
        setProblem(result.startupProblem);
        return;
      }
      if (!result.ok) {
        const friendly = friendlyLoginError(result.error ?? (mode === "login" ? "Login failed." : "Registration failed."), trimmedUrl);
        setError(friendly.message);
        if (friendly.unreachable) setShowServer(true);
        return;
      }
      try {
        localStorage.setItem("clynx.lastEmail", trimmedEmail);
      } catch {
        // not remembered — fine
      }
      onAuthenticated();
    } catch (err) {
      const friendly = friendlyLoginError((err as Error).message || "Something went wrong.", apiUrl.trim() || defaultApiUrl);
      setError(friendly.message);
      if (friendly.unreachable) setShowServer(true);
    } finally {
      setBusy(false);
    }
  }

  if (beta?.localModeAllowed && !showCloud) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", zIndex: 1 }}>
        <div className="card" data-testid="beta-welcome" style={{ width: 440, padding: 28, display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 26 }}>
              Clynx <span style={{ fontSize: 13, fontWeight: 800, padding: "2px 8px", borderRadius: 999, background: "var(--warn-bg)", color: "var(--warn)", verticalAlign: "middle" }}>BETA {beta.version}</span>
            </h1>
            <p style={{ color: "var(--text-muted)", margin: "8px 0 0", fontSize: 14, lineHeight: 1.5 }}>
              Welcome to the Clynx beta. There is no account to create: Clynx runs on this computer with its own empty Database and your own Facebook login. Plans and billing are not part of the beta.
            </p>
          </div>
          {problem && (
            <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 10, border: "1px solid var(--danger)", background: "var(--danger-bg)" }}>
              <strong style={{ color: "var(--danger)" }}>{problem.title}</strong>
              <span style={{ fontSize: 13.5, lineHeight: 1.5 }}>{problem.message}</span>
              {problem.folder && (
                <div>
                  <button type="button" className="icon ghost" onClick={() => api.showDataFolder()}>
                    Show data folder
                  </button>
                </div>
              )}
            </div>
          )}
          {!beta.browser.ok && (
            <div role="alert" data-testid="beta-no-browser" style={{ padding: 12, borderRadius: 10, border: "1px solid var(--warn)", fontSize: 13.5, lineHeight: 1.5 }}>
              <strong>Google Chrome or Microsoft Edge is needed for scanning.</strong> {beta.browser.instructions}
            </div>
          )}
          {error && <p style={{ margin: 0, fontSize: 13.5, color: "var(--danger)", background: "var(--danger-bg)", padding: "8px 10px", borderRadius: 8 }}>{error}</p>}
          <button type="button" className="primary" data-testid="start-local" disabled={busy} onClick={() => void startLocal()}>
            {busy ? "Starting..." : "Start Clynx"}
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={() => setShowCloud(true)} style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
            I have a Clynx Cloud account
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", zIndex: 1 }}>
      <form
        onSubmit={submit}
        className="card"
        style={{ width: 380, padding: 28, display: "flex", flexDirection: "column", gap: 16 }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 26 }}>Clynx</h1>
          <p style={{ color: "var(--text-muted)", margin: "6px 0 0", fontSize: 14 }}>
            {mode === "login" ? "Log in to your Clynx account." : "Create a Clynx account."}
          </p>
        </div>

        {problem && (
          <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 10, border: "1px solid var(--danger)", background: "var(--danger-bg)" }}>
            <strong style={{ color: "var(--danger)" }}>{problem.title}</strong>
            <span style={{ fontSize: 13.5, lineHeight: 1.5 }}>{problem.message}</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="icon"
                onClick={() => {
                  setProblem(null);
                  (onRetry ?? onAuthenticated)();
                }}
              >
                Try again
              </button>
              {problem.folder && (
                <button type="button" className="icon ghost" onClick={() => api.showDataFolder()}>
                  Show data folder
                </button>
              )}
            </div>
          </div>
        )}

        <Field label="Email">
          <input
            type="email"
            autoFocus={!email}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            autoFocus={!!email}
            required
            minLength={8}
          />
        </Field>

        {showServer ? (
          <Field label="Server URL">
            <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder={defaultApiUrl} autoComplete="off" spellCheck={false} />
          </Field>
        ) : (
          <button
            type="button"
            className="ghost"
            onClick={() => setShowServer(true)}
            style={{ alignSelf: "flex-start", fontSize: 12.5, padding: "2px 6px", color: "var(--text-dim)" }}
          >
            Advanced: server address
          </button>
        )}

        {error && (
          <p
            style={{
              margin: 0,
              fontSize: 13.5,
              color: "var(--danger)",
              background: "var(--danger-bg)",
              padding: "8px 10px",
              borderRadius: 8,
            }}
          >
            {error}
          </p>
        )}

        <button type="submit" className="primary" disabled={busy}>
          {busy ? (mode === "login" ? "Logging in..." : "Registering...") : mode === "login" ? "Log in" : "Register"}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => {
            setMode((m) => (m === "login" ? "register" : "login"));
            setError(null);
          }}
        >
          {mode === "login" ? "Need an account? Register" : "Already have an account? Log in"}
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label>{label}</label>
      {children}
    </div>
  );
}
