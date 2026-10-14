import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { BetaInfo, ServerTestResult, StartupProblem } from "../lib/api.js";

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
      message: `Can't reach the Clynx server at ${apiUrl || "(no address entered)"}. Check that the server computer is on and Clynx Cloud is running (Docker Desktop open there), that this computer is on the same network, and that the address is right. Use Test connection to check.`,
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
  // "Test connection": checked before any password is sent. `testedUrl` is the address the last successful test was for.
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "fail"; result?: ServerTestResult }>({ state: "idle" });
  const [testedUrl, setTestedUrl] = useState<string | null>(null);
  const runTest = async (url: string): Promise<boolean> => {
    if (!url.trim()) {
      setTest({ state: "fail", result: { ok: false, error: "Enter the address of your Clynx server first.", stage: "address" } });
      return false;
    }
    setTest({ state: "testing" });
    const r = await api.cloud.testServer(url.trim());
    setTest({ state: r.ok ? "ok" : "fail", result: r });
    setTestedUrl(r.ok ? url.trim() : null);
    return r.ok;
  };
  const [email, setEmail] = useState(readLastEmail);
  // The server address is a technical detail most people never touch, so it
  // stays tucked away — and opens itself if the server can't be reached.
  const [showServer, setShowServer] = useState(!defaultApiUrl.trim());
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Beta builds lead with "use Clynx on this computer" and keep the Clynx Cloud form behind a link.
  const [beta, setBeta] = useState<BetaInfo | null>(null);
  const [showCloud, setShowCloud] = useState(false);
  const [importLocal, setImportLocal] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  useEffect(() => {
    void api.beta
      .info()
      .then((b) => {
        setBeta(b);
        // the sign-in form starts from the address this installation already uses (people who left local mode, or chose a server before)
        if (b.cloudApiUrl) setApiUrl((cur) => (cur === defaultApiUrl ? (b.cloudApiUrl as string) : cur));
        // nothing to start from (an installed build has no built-in server): the address box stays open while the person types it
        if (!(b.cloudApiUrl ?? "").trim() && !defaultApiUrl.trim()) setShowServer(true);
      })
      .catch(() => setBeta(null));
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

  // Registering on a private server needs an invitation code: find out before asking for it (the check also runs, and gates the password, on submit).
  useEffect(() => {
    if (mode !== "register" || !apiUrl.trim() || test.state !== "idle") return;
    const t = setTimeout(() => void runTest(apiUrl), 700); // (not on every keystroke)
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, apiUrl, test.state]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const trimmedUrl = apiUrl.trim() || defaultApiUrl;
      const trimmedEmail = email.trim();
      // never send a password to an address that has not answered as a Clynx server
      if (testedUrl !== trimmedUrl && !(await runTest(trimmedUrl))) {
        setShowServer(true);
        return;
      }
      const result =
        mode === "login"
          ? await api.auth.login(trimmedUrl, trimmedEmail, password, importLocal && !!beta?.localDataExists)
          : await api.auth.register(trimmedUrl, trimmedEmail, password, importLocal && !!beta?.localDataExists, inviteCode.trim() || undefined);
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
        {mode === "register" && test.state === "ok" && test.result?.ok && test.result.registration === "invite" && (
          <Field label="Invitation code">
            <input data-testid="invite-code-input" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} required />
            <span style={{ fontSize: 12.5, color: "var(--text-dim)" }}>This is a private server: the person who runs it gives you a one-time code.</span>
          </Field>
        )}
        {mode === "register" && test.state === "ok" && test.result?.ok && test.result.registration === "closed" && (
          <p data-testid="registration-closed" style={{ margin: 0, fontSize: 13.5, color: "var(--warn)" }}>This server is not creating new accounts. Ask the person who runs it, or log in if you already have one.</p>
        )}
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

        {beta?.localDataExists && (
          <label data-testid="import-local" style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13.5, lineHeight: 1.4 }}>
            <input type="checkbox" checked={importLocal} onChange={(e) => setImportLocal(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              Copy my local beta data (Database, settings and Facebook login) into this account. <span style={{ color: "var(--text-dim)" }}>It is copied, not moved: your local data stays where it is and you can go back to local mode at any time.</span>
            </span>
          </label>
        )}
        {showServer || !apiUrl.trim() ? (
          <Field label="Server address">
            <div style={{ display: "flex", gap: 8 }}>
              <input
                data-testid="server-url-input"
                style={{ flex: 1 }}
                value={apiUrl}
                onChange={(e) => {
                  setApiUrl(e.target.value);
                  setTestedUrl(null);
                  setTest({ state: "idle" });
                }}
                placeholder="http://192.168.1.20:8788"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="ghost" data-testid="server-test" disabled={test.state === "testing"} onClick={() => void runTest(apiUrl)}>
                {test.state === "testing" ? "Testing…" : "Test connection"}
              </button>
            </div>
            {!apiUrl.trim() && test.state === "idle" && (
              <span style={{ fontSize: 12.5, color: "var(--text-dim)" }}>Enter the address of your Clynx server (ask the person who runs it). On the same home network it looks like http://192.168.1.20:8788.</span>
            )}
            {test.state === "ok" && test.result?.ok && (
              <span data-testid="server-ok" style={{ fontSize: 13, color: "var(--good, #3ecf8e)" }}>
                ✓ Connected to {test.result.name}
                {test.result.serverVersion ? ` (version ${test.result.serverVersion})` : ""} in {test.result.latencyMs} ms.
                {test.result.services.sharedAi ? " Shared AI is available: no OpenAI key needed." : ""}
                {test.result.warnings.map((w, i) => (
                  <span key={i} style={{ display: "block", color: "var(--warn)" }}>{w}</span>
                ))}
              </span>
            )}
            {test.state === "fail" && test.result && !test.result.ok && (
              <span data-testid="server-fail" role="alert" style={{ fontSize: 13, color: "var(--danger)" }}>{test.result.error}</span>
            )}
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
