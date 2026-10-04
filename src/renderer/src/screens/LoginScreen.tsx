import React, { useState } from "react";
import { api } from "../lib/api.js";

// Multi-user login migration — blocks the ENTIRE app until authenticated
// (see App.tsx, which renders this instead of everything else until
// api.auth.getSession() reports authenticated). Server URL defaults to
// whatever the install last used successfully (see index.ts's
// app-settings.json / auth:getSession), so a second computer on the LAN
// just needs to type the first computer's address once — plain
// email + password after that, same as any other login/register form.
// Matches Config.tsx's existing dark-card design language (.card, Field,
// button.primary/ghost) rather than inventing a new look.
export function LoginScreen({
  defaultApiUrl,
  onAuthenticated,
}: {
  defaultApiUrl: string;
  onAuthenticated: () => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [apiUrl, setApiUrl] = useState(defaultApiUrl);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      if (!result.ok) {
        setError(result.error ?? (mode === "login" ? "Login failed." : "Registration failed."));
        return;
      }
      onAuthenticated();
    } catch (err) {
      setError((err as Error).message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
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

        <Field label="Server URL">
          <input
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            placeholder={defaultApiUrl}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
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
            required
            minLength={8}
          />
        </Field>

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
