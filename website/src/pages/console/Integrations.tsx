import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Field, Loading, Notice, usePageMeta } from "../../components/ui";
import { del, errorText, get, post, put } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";

// Owner-only: the company-managed OpenAI and eBay credentials. Secrets are WRITE-ONLY here: they are typed once, sent to the server over the signed-in session, and never shown again.
// The page shows only a masked identifier, the connection state and when the credential was last verified.

interface Status {
  provider: "openai" | "ebay";
  state: "connected" | "not_configured" | "revoked" | "error";
  source: "vault" | "environment" | "none";
  masked: Record<string, string>;
  version: number | null;
  lastVerifiedAt: string | null;
  lastVerifyOk: boolean | null;
  lastVerifyError: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}
interface Overview {
  vaultConfigured: boolean;
  integrations: Status[];
  events: Array<{ provider: string; action: string; ok: boolean; detail: string | null; createdAt: string; by: string | null }>;
}

const LABEL: Record<string, string> = { openai: "OpenAI", ebay: "eBay" };
const STATE_PILL: Record<string, [string, string]> = { connected: ["ok", "Connected"], error: ["bad", "Needs attention"], revoked: ["bad", "Revoked"], not_configured: ["warn", "Not configured"] };

function Card({ s, vaultOk, onChanged }: { s: Status; vaultOk: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [ruName, setRuName] = useState("");
  const [env, setEnv] = useState<"PRODUCTION" | "SANDBOX">("PRODUCTION");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState("");
  const [showRevoke, setShowRevoke] = useState(false);
  const [pill, text] = STATE_PILL[s.state];

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setMsg(null);
    try {
      const t = await fn();
      if (t) setMsg({ kind: "success", text: t });
      onChanged();
    } catch (e) {
      setMsg({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    await run("save", async () => {
      const body = s.provider === "openai" ? { apiKey } : { clientId, clientSecret, environment: env, ...(ruName ? { ruName } : {}) };
      const r = await put<{ rotated: boolean; version: number }>(`/admin/integrations/${s.provider}`, body);
      setApiKey("");
      setClientSecret("");
      setClientId("");
      setEditing(false);
      return r.rotated ? `Replaced. The new credential is in use from the next request (version ${r.version}). The old one was erased.` : "Saved. Press Verify to check that it works.";
    });
  }

  return (
    <section className="card" data-testid={`integration-${s.provider}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: "1.3rem", margin: 0 }}>{LABEL[s.provider]}</h2>
        <span className={`pill ${pill}`} data-testid={`state-${s.provider}`}>{text}</span>
      </div>
      <dl className="kv" style={{ marginTop: 14 }}>
        <dt>Source</dt>
        <dd>{s.source === "vault" ? "Saved in the console (encrypted on the server)" : s.source === "environment" ? "The server's environment settings (read-only here)" : "None"}</dd>
        <dt>Identifier</dt>
        <dd className="mono" data-testid={`masked-${s.provider}`}>
          {Object.keys(s.masked).length === 0 ? "-" : Object.entries(s.masked).map(([k, v]) => `${k}: ${v}`).join("  |  ")}
        </dd>
        <dt>Last verified</dt>
        <dd>
          {s.lastVerifiedAt ? formatDateTime(s.lastVerifiedAt) : "never"}
          {s.lastVerifyOk === false && s.lastVerifyError ? <span className="dim"> - last check failed: {s.lastVerifyError}</span> : null}
        </dd>
        <dt>Changed</dt>
        <dd>{s.updatedAt ? `${formatDateTime(s.updatedAt)}${s.updatedBy ? ` by ${s.updatedBy}` : ""} (version ${s.version})` : "-"}</dd>
      </dl>
      {msg && <div className={msg.kind} role={msg.kind === "error" ? "alert" : "status"} style={{ marginBottom: 12 }}>{msg.text}</div>}
      <div className="row">
        <button className="btn small" disabled={busy !== null || !vaultOk} onClick={() => setEditing(!editing)}>{s.state === "connected" && s.source === "vault" ? "Replace (rotate)" : "Enter credentials"}</button>
        <button className="btn small ghost" disabled={busy !== null || s.state === "not_configured" || s.state === "revoked"} onClick={() => void run("verify", async () => {
          const r = await post<{ ok: boolean; error: string | null }>(`/admin/integrations/${s.provider}/verify`);
          if (!r.ok) throw new Error(r.error ?? "Verification failed");
          return "Verified: the provider accepted the credential.";
        })}>{busy === "verify" ? "Checking..." : "Verify now"}</button>
        {s.state !== "not_configured" && s.state !== "revoked" && s.source === "vault" && (
          <button className="btn small ghost danger" disabled={busy !== null} onClick={() => setShowRevoke(!showRevoke)}>Revoke</button>
        )}
      </div>
      {editing && (
        <form className="form" onSubmit={save} style={{ marginTop: 16 }} autoComplete="off">
          {s.provider === "openai" ? (
            <Field label="OpenAI API key" htmlFor="oa-key" hint="Shown only as you type. After saving it cannot be displayed again, only replaced.">
              <input id="oa-key" type="password" autoComplete="off" spellCheck={false} required placeholder="sk-..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </Field>
          ) : (
            <>
              <Field label="App ID (client id)" htmlFor="eb-id">
                <input id="eb-id" type="password" autoComplete="off" spellCheck={false} required value={clientId} onChange={(e) => setClientId(e.target.value)} />
              </Field>
              <Field label="Cert ID (client secret)" htmlFor="eb-secret">
                <input id="eb-secret" type="password" autoComplete="off" spellCheck={false} required value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
              </Field>
              <Field label="RuName (only needed to let customers connect their own eBay account)" htmlFor="eb-ru">
                <input id="eb-ru" type="text" autoComplete="off" spellCheck={false} value={ruName} onChange={(e) => setRuName(e.target.value)} />
              </Field>
              <Field label="Environment" htmlFor="eb-env">
                <select id="eb-env" value={env} onChange={(e) => setEnv(e.target.value as "PRODUCTION" | "SANDBOX")}>
                  <option value="PRODUCTION">Production</option>
                  <option value="SANDBOX">Sandbox (testing)</option>
                </select>
              </Field>
            </>
          )}
          <div className="row">
            <button className="btn primary small" disabled={busy === "save"}>{busy === "save" ? "Saving..." : "Save"}</button>
            <button type="button" className="btn ghost small" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      )}
      {showRevoke && (
        <Notice kind="warn" role="alertdialog">
          <strong>Revoke the {LABEL[s.provider]} credential?</strong>
          <p className="muted" style={{ margin: "6px 0 10px" }}>It is erased from the server and every customer feature that depends on it stops at once. The server's environment settings are not used as a way back in.</p>
          <div className="row">
            <input type="text" aria-label="Type REVOKE" placeholder="type REVOKE" value={confirmRevoke} onChange={(e) => setConfirmRevoke(e.target.value)} style={{ maxWidth: 200 }} />
            <button className="btn danger small" disabled={confirmRevoke !== "REVOKE" || busy !== null} onClick={() => void run("revoke", async () => { await del(`/admin/integrations/${s.provider}`, { confirm: "REVOKE" }); setShowRevoke(false); setConfirmRevoke(""); return "Revoked."; })}>Revoke</button>
          </div>
        </Notice>
      )}
    </section>
  );
}

export function ConsoleIntegrations() {
  usePageMeta("API integrations");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    get<Overview>("/admin/integrations").then((d) => { setData(d); setError(null); }).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  if (error) return <div className="error" role="alert">{error}</div>;
  if (!data) return <Loading />;
  return (
    <>
      <h1 style={{ fontSize: "1.9rem" }}>API integrations</h1>
      <Notice>
        These are Clynx's own OpenAI and eBay accounts, shared by every subscribed customer through this server: customers never enter or see a key. Credentials are stored encrypted, shown only as a masked identifier, and can be changed only by the Owner. Spending is limited under <strong>Spending and safety</strong>.
      </Notice>
      {!data.vaultConfigured && (
        <Notice kind="bad" role="alert">
          <strong>The server has no encryption key, so credentials cannot be saved.</strong> Set <span className="mono">CREDENTIALS_ENCRYPTION_KEY</span> (32 random bytes, base64) in the server environment and restart. Until then only credentials set in the server environment can be used.
        </Notice>
      )}
      {data.integrations.map((s) => <Card key={s.provider} s={s} vaultOk={data.vaultConfigured} onChanged={load} />)}
      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>Recent changes</h2>
        {data.events.length === 0 ? <p className="muted">Nothing yet.</p> : (
          <ul className="list">
            {data.events.map((e, i) => (
              <li key={i}>
                <span>{LABEL[e.provider] ?? e.provider}: {e.action}{e.by ? ` by ${e.by}` : ""}{!e.ok && e.detail ? ` - ${e.detail}` : ""}</span>
                <span className="dim">{formatDateTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="fine">The history records what was done, never a credential.</p>
      </section>
    </>
  );
}

interface Controls {
  paidApiEnabled: boolean; disabledReason: string | null; globalDailyUsd: number; globalMonthlyUsd: number; userDailyUsdFree: number; userDailyUsdPro: number; ownerDailyUsd: number;
  maxConcurrentUser: number; maxConcurrentGlobal: number; ebayDailyCallsGlobal: number; ebayDailyCallsFree: number; ebayDailyCallsPro: number; ebayDailyCallsOwner: number;
  abuseRequestsPer10Min: number; abuseRefusalsPer10Min: number; abuseBlockMinutes: number;
}
interface Spending {
  note: string;
  controls: Controls;
  today: { estimatedUsd: number; limitUsd: number };
  month: { estimatedUsd: number; limitUsd: number };
  ebayCallsToday: { calls: number; limit: number };
  topCustomersToday: Array<{ id: string; email: string; role: string; requests: number; estimatedUsd: number }>;
  byModelToday: Array<{ model: string; requests: number; estimatedUsd: number }>;
  openAbuseFlags: Array<{ id: number; userId: string; email: string; reason: string; detail: string | null; createdAt: string }>;
}

const FIELDS: Array<[keyof Controls, string, string]> = [
  ["globalDailyUsd", "Whole service, per day (USD)", "Total estimated AI spending allowed across all customers each day."],
  ["globalMonthlyUsd", "Whole service, per month (USD)", "The monthly ceiling."],
  ["userDailyUsdFree", "Each Free customer, per day (USD)", "No single Free customer can spend more than this."],
  ["userDailyUsdPro", "Each Pro customer, per day (USD)", ""],
  ["ownerDailyUsd", "The Owner, per day (USD)", "The Owner has no plan limits but is still held to a safety ceiling."],
  ["maxConcurrentUser", "Simultaneous AI requests per customer", ""],
  ["maxConcurrentGlobal", "Simultaneous AI requests overall", ""],
  ["ebayDailyCallsGlobal", "eBay calls per day, whole service", ""],
  ["ebayDailyCallsFree", "eBay calls per day, each Free customer", ""],
  ["ebayDailyCallsPro", "eBay calls per day, each Pro customer", ""],
  ["ebayDailyCallsOwner", "eBay calls per day, Owner", ""],
  ["abuseRequestsPer10Min", "Abuse: requests per 10 minutes before a block", ""],
  ["abuseRefusalsPer10Min", "Abuse: refused requests per 10 minutes before a block", ""],
  ["abuseBlockMinutes", "Abuse: length of a block (minutes)", ""],
];

export function ConsoleSpending() {
  usePageMeta("Spending and safety");
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  const [d, setD] = useState<Spending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const load = useCallback(() => {
    get<Spending>("/admin/spending").then((x) => { setD(x); setError(null); }).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    setError(null);
    try { await fn(); setMsg(ok); load(); } catch (e) { setError(errorText(e)); }
  };
  if (!d) return error ? <div className="error" role="alert">{error}</div> : <Loading />;
  const c = d.controls;
  const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
  return (
    <>
      <h1 style={{ fontSize: "1.9rem" }}>Spending and safety</h1>
      {error && <div className="error" role="alert">{error}</div>}
      {msg && <div className="success" role="status">{msg}</div>}
      <section className="card" style={c.paidApiEnabled ? undefined : { borderColor: "var(--bad)" }}>
        <h2 style={{ fontSize: "1.2rem" }}>Emergency stop</h2>
        {c.paidApiEnabled ? (
          <>
            <p className="muted">Everything is running. The stop switch pauses ALL paid operations (AI and eBay) for every customer, including the Owner, within seconds.</p>
            <div className="row">
              <input type="text" aria-label="Reason" placeholder="reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ maxWidth: 280 }} />
              <button className="btn danger" data-testid="emergency-stop" onClick={() => void act(() => post("/admin/controls/emergency-stop", { reason: reason || undefined }), "Paid operations are STOPPED.")}>Stop all paid operations</button>
            </div>
          </>
        ) : (
          <>
            <p data-testid="stopped"><strong style={{ color: "var(--bad)" }}>STOPPED</strong> - {c.disabledReason ?? "emergency stop"}. Customers see that AI and eBay features are paused.</p>
            {isOwner ? <button className="btn primary" onClick={() => void act(() => post("/admin/controls/resume"), "Paid operations resumed.")}>Resume paid operations</button> : <p className="muted">Only the Owner can resume.</p>}
          </>
        )}
      </section>

      <div className="grid c3">
        <div className="card stat"><b>${d.today.estimatedUsd.toFixed(2)}</b><span>estimated today of ${d.today.limitUsd.toFixed(2)} ({pct(d.today.estimatedUsd, d.today.limitUsd)}%)</span></div>
        <div className="card stat"><b>${d.month.estimatedUsd.toFixed(2)}</b><span>estimated this month of ${d.month.limitUsd.toFixed(2)} ({pct(d.month.estimatedUsd, d.month.limitUsd)}%)</span></div>
        <div className="card stat"><b>{d.ebayCallsToday.calls}</b><span>eBay calls today of {d.ebayCallsToday.limit}</span></div>
      </div>
      <p className="fine">{d.note}</p>

      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>Who is using it today</h2>
        {d.topCustomersToday.length === 0 ? <p className="muted">No AI use yet today.</p> : (
          <div className="table-scroll"><table className="data"><thead><tr><th>Customer</th><th>Requests</th><th>Estimated cost</th></tr></thead>
            <tbody>{d.topCustomersToday.map((u) => <tr key={u.id}><td>{u.email} {u.role !== "user" && <span className="pill">{u.role}</span>}</td><td>{u.requests}</td><td>${u.estimatedUsd.toFixed(4)}</td></tr>)}</tbody></table></div>
        )}
        {d.byModelToday.length > 0 && <p className="fine">By model: {d.byModelToday.map((m) => `${m.model} ${m.requests} (${"$"}${m.estimatedUsd.toFixed(4)})`).join(", ")}</p>}
      </section>

      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>Abuse flags</h2>
        {d.openAbuseFlags.length === 0 ? <p className="muted">None open.</p> : (
          <ul className="list">
            {d.openAbuseFlags.map((f) => (
              <li key={f.id}>
                <span>{f.email}: {f.reason.replace("_", " ")} <span className="dim">{f.detail}</span></span>
                <button className="btn small" onClick={() => void act(() => post(`/admin/abuse/${f.userId}/clear`), "Cleared; the customer can use the service again.")}>Clear and unblock</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>Limits</h2>
        {!isOwner && <p className="muted">Only the Owner can change these.</p>}
        <form
          className="form"
          style={{ maxWidth: 560 }}
          onSubmit={(e) => {
            e.preventDefault();
            const patch = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== "").map(([k, v]) => [k, Number(v)]));
            void act(() => put("/admin/controls", patch), "Limits saved.");
            setDraft({});
          }}
        >
          {FIELDS.map(([k, label, hint]) => (
            <Field key={k} label={label} htmlFor={`c-${k}`} hint={hint || undefined}>
              <input id={`c-${k}`} type="number" min={0} step="any" disabled={!isOwner} placeholder={String(c[k])} value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
            </Field>
          ))}
          {isOwner && <div><button className="btn primary small" disabled={Object.values(draft).every((v) => v === "")}>Save limits</button></div>}
        </form>
      </section>
    </>
  );
}
