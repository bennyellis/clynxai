import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { Field, Loading, Notice, usePageMeta } from "../../components/ui";
import { api, del, errorText, get, patch, post } from "../../lib/api";
import { formatBytes, formatDate, formatDateTime } from "../../lib/format";

// The administration console. The server re-checks the administrator role on every call; hiding a page here is only a courtesy.

export function ConsoleLayout() {
  usePageMeta("Console");
  return (
    <div className="wrap portal">
      <nav className="side" aria-label="Console">
        <div className="group">Administration</div>
        <NavLink to="/console" end>Overview</NavLink>
        <NavLink to="/console/users">Customers</NavLink>
        <NavLink to="/console/beta">Beta testers</NavLink>
        <NavLink to="/console/releases">Releases</NavLink>
        <NavLink to="/console/support">Support</NavLink>
        <NavLink to="/console/health">Service health</NavLink>
        <NavLink to="/console/audit">Audit log</NavLink>
      </nav>
      <div className="stack">
        <Outlet />
      </div>
    </div>
  );
}

function useLoad<T>(url: string): [T | null, string | null, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    get<T>(url).then((d) => { setData(d); setError(null); }).catch((e) => setError(errorText(e)));
  }, [url, n]);
  return [data, error, () => setN((x) => x + 1)];
}

const Err = ({ e }: { e: string | null }) => (e ? <div className="error" role="alert">{e}</div> : null);

interface Overview {
  users: number; verifiedUsers: number; signupsLast7Days: number; betaTesters: number; devices: number; openSupportRequests: number; downloadsLast30Days: number;
  subscriptions: { active: number; trialing: number; pastDue: number; cancelingAtPeriodEnd: number; byStatus: Array<{ status: string; n: number }> };
  signupsByDay: Array<{ day: string; signups: number }>;
}

export function ConsoleOverview() {
  const [o, e] = useLoad<Overview>("/admin/overview");
  if (e) return <Err e={e} />;
  if (!o) return <Loading />;
  const max = Math.max(1, ...o.signupsByDay.map((d) => d.signups));
  const stat = (label: string, v: number | string) => (
    <div className="card stat"><b data-testid={`stat-${label}`}>{v}</b><span>{label}</span></div>
  );
  return (
    <>
      <h1 style={{ fontSize: "1.9rem" }}>Overview</h1>
      <div className="grid c4">
        {stat("customers", o.users)}
        {stat("confirmed emails", o.verifiedUsers)}
        {stat("joined (7 days)", o.signupsLast7Days)}
        {stat("beta testers", o.betaTesters)}
        {stat("active subscriptions", o.subscriptions.active)}
        {stat("on trial", o.subscriptions.trialing)}
        {stat("payment problems", o.subscriptions.pastDue)}
        {stat("cancelling", o.subscriptions.cancelingAtPeriodEnd)}
        {stat("registered computers", o.devices)}
        {stat("open support requests", o.openSupportRequests)}
        {stat("downloads (30 days)", o.downloadsLast30Days)}
      </div>
      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>Sign-ups, last 14 days</h2>
        <div className="bars" role="img" aria-label={`Sign-ups per day: ${o.signupsByDay.map((d) => d.signups).join(", ")}`}>
          {o.signupsByDay.map((d) => (
            <div key={d.day} title={`${d.day}: ${d.signups}`} style={{ height: `${Math.max(3, (d.signups / max) * 100)}%` }} />
          ))}
        </div>
        <p className="fine">Aggregate counts only. No usage is tracked per person beyond what is needed to run the service.</p>
      </section>
    </>
  );
}

interface UserRow { id: string; email: string; displayName: string | null; role: string; isBetaTester: boolean; emailVerified: boolean; disabled: boolean; createdAt: string; subscriptionStatus: string | null; interval: string | null; devices: number }

export function ConsoleUsers({ betaOnly = false }: { betaOnly?: boolean }) {
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const url = `/admin/users?${betaOnly ? "beta=1&" : ""}search=${encodeURIComponent(applied)}`;
  const [data, e] = useLoad<{ users: UserRow[] }>(url);
  const nav = useNavigate();
  return (
    <>
      <h1 style={{ fontSize: "1.9rem" }}>{betaOnly ? "Beta testers" : "Customers"}</h1>
      <form className="row" onSubmit={(ev) => { ev.preventDefault(); setApplied(search); }} role="search">
        <input type="search" aria-label="Search by email or name" placeholder="Search by email or name" value={search} onChange={(ev) => setSearch(ev.target.value)} style={{ maxWidth: 340 }} />
        <button className="btn small">Search</button>
      </form>
      <Err e={e} />
      {!data ? <Loading /> : (
        <div className="table-scroll">
          <table className="data" data-testid="users-table">
            <thead><tr><th>Email</th><th>Joined</th><th>Subscription</th><th>Computers</th><th>Flags</th></tr></thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className="click" tabIndex={0} onClick={() => nav(`/console/users/${u.id}`)} onKeyDown={(ev) => ev.key === "Enter" && nav(`/console/users/${u.id}`)}>
                  <td>{u.email}{u.displayName ? <span className="dim"> ({u.displayName})</span> : null}</td>
                  <td>{formatDate(u.createdAt)}</td>
                  <td>{u.subscriptionStatus ? `${u.subscriptionStatus}${u.interval ? ` / ${u.interval}` : ""}` : "-"}</td>
                  <td>{u.devices}</td>
                  <td>
                    {u.role === "admin" && <span className="pill">admin</span>} {u.isBetaTester && <span className="pill ok">beta</span>} {!u.emailVerified && <span className="pill warn">unconfirmed</span>} {u.disabled && <span className="pill bad">disabled</span>}
                  </td>
                </tr>
              ))}
              {data.users.length === 0 && <tr><td colSpan={5} className="muted">Nobody found.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface UserDetail {
  user: UserRow;
  subscription: { status: string; interval: string | null; currentPeriodEnd: string | null; trialEnd: string | null; cancelAtPeriodEnd: boolean; pastDueSince: string | null } | null;
  devices: Array<{ id: string; platform: string; clientVersion: string; lastSeenAt: string | null }>;
  supportRequests: Array<{ id: string; category: string; subject: string; status: string; createdAt: string }>;
  usage: { aiRequestsLast7Days: number };
}

export function ConsoleUserDetail() {
  const { id } = useParams();
  const [d, e, reload] = useLoad<UserDetail>(`/admin/users/${id}`);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); reload(); } catch (x) { setErr(errorText(x)); }
  };
  if (e) return <Err e={e} />;
  if (!d) return <Loading />;
  const u = d.user;
  return (
    <>
      <p><Link to="/console/users">&larr; All customers</Link></p>
      <h1 style={{ fontSize: "1.7rem" }}>{u.email}</h1>
      <Err e={err} />
      <section className="card">
        <dl className="kv">
          <dt>Name</dt><dd>{u.displayName ?? "-"}</dd>
          <dt>Joined</dt><dd>{formatDateTime(u.createdAt)}</dd>
          <dt>Email confirmed</dt><dd>{u.emailVerified ? "Yes" : "No"}</dd>
          <dt>Role</dt><dd>{u.role}</dd>
          <dt>Subscription</dt><dd>{d.subscription ? `${d.subscription.status}${d.subscription.interval ? ` (${d.subscription.interval}ly)` : ""}${d.subscription.cancelAtPeriodEnd ? " - cancelling" : ""}; period ends ${formatDate(d.subscription.currentPeriodEnd)}` : "None"}</dd>
          <dt>AI requests (7 days)</dt><dd>{d.usage.aiRequestsLast7Days}</dd>
        </dl>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn small" onClick={() => void act(() => post(`/admin/users/${u.id}/beta`, { value: !u.isBetaTester }))}>{u.isBetaTester ? "Remove from beta testers" : "Add to beta testers"}</button>
          {u.role !== "admin" && (
            <button className={`btn small ${u.disabled ? "" : "danger"}`} onClick={() => void act(() => post(`/admin/users/${u.id}/disabled`, { value: !u.disabled }))}>{u.disabled ? "Re-enable account" : "Disable account and sign out everywhere"}</button>
          )}
        </div>
      </section>
      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>Computers</h2>
        {d.devices.length === 0 ? <p className="muted">None.</p> : (
          <ul className="list">{d.devices.map((v) => <li key={v.id}><span>{v.platform} - Clynx {v.clientVersion}</span><span className="dim">last active {formatDateTime(v.lastSeenAt)}</span></li>)}</ul>
        )}
      </section>
      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>Support requests</h2>
        {d.supportRequests.length === 0 ? <p className="muted">None.</p> : (
          <ul className="list">{d.supportRequests.map((s) => <li key={s.id}><span>{s.subject}</span><span className="pill">{s.status.replace("_", " ")}</span></li>)}</ul>
        )}
      </section>
      <p className="fine">Passwords, session secrets and tokens are never shown here, and Clynx Cloud does not receive Facebook cookies or browsing sessions at all.</p>
    </>
  );
}

interface AdminRelease { id: string; version: string; channel: string; status: string; notes: string; knownIssues: string; fileName: string | null; sha256: string | null; sizeBytes: number | null; createdAt: string; publishedAt: string | null; createdBy: string | null; downloads: number }

export function ConsoleReleases() {
  const [data, e, reload] = useLoad<{ releases: AdminRelease[] }>("/admin/releases");
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  const [channel, setChannel] = useState<"beta" | "stable">("beta");
  const [notes, setNotes] = useState("");
  const [issues, setIssues] = useState("");
  const [confirmText, setConfirmText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setErr(null);
    setInfo(null);
    try { await fn(); if (ok) setInfo(ok); reload(); } catch (x) { setErr(errorText(x)); } finally { setBusy(null); }
  };
  const create = (ev: FormEvent) => {
    ev.preventDefault();
    void run("create", async () => { await post("/admin/releases", { version, channel, notes, knownIssues: issues }); setVersion(""); setNotes(""); setIssues(""); }, "Draft created. Upload the installer next.");
  };
  const upload = (r: AdminRelease, file: File | undefined) => {
    if (!file) return;
    void run(`up-${r.id}`, () => api("PUT", `/admin/releases/${r.id}/file?name=${encodeURIComponent(file.name)}`, undefined, { raw: file, headers: { "Content-Type": "application/octet-stream" } }), `Uploaded ${file.name}. The server computed its SHA-256.`);
  };
  const verify = (r: AdminRelease) =>
    void run(`ver-${r.id}`, async () => {
      const v = await get<{ ok: boolean; recorded: string | null; actual: string | null }>(`/admin/releases/${r.id}/verify`);
      setInfo(v.ok ? `Verified: the stored file matches its checksum for ${r.version}.` : `MISMATCH for ${r.version}: recorded ${v.recorded} but the stored file is ${v.actual ?? "missing"}.`);
    });

  return (
    <>
      <h1 style={{ fontSize: "1.9rem" }}>Releases</h1>
      <Notice>Nothing is ever published automatically. A release goes draft &rarr; (upload) &rarr; approved &rarr; published, and publishing needs you to type the version number. Only published releases appear on the Download page.</Notice>
      <Err e={e ?? err} />
      {info && <div className="success" role="status">{info}</div>}
      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>New draft</h2>
        <form className="form" onSubmit={create} style={{ maxWidth: 640 }}>
          <div className="row">
            <Field label="Version" htmlFor="r-version"><input id="r-version" type="text" required placeholder="0.3.0-beta.1" value={version} onChange={(x) => setVersion(x.target.value)} /></Field>
            <Field label="Channel" htmlFor="r-channel"><select id="r-channel" value={channel} onChange={(x) => setChannel(x.target.value as "beta" | "stable")}><option value="beta">beta</option><option value="stable">stable</option></select></Field>
          </div>
          <Field label="Release notes" htmlFor="r-notes"><textarea id="r-notes" value={notes} onChange={(x) => setNotes(x.target.value)} /></Field>
          <Field label="Known issues" htmlFor="r-issues"><textarea id="r-issues" value={issues} onChange={(x) => setIssues(x.target.value)} /></Field>
          <div><button className="btn primary small" disabled={busy === "create"}>Create draft</button></div>
        </form>
      </section>
      {!data ? <Loading /> : data.releases.map((r) => (
        <section className="card" key={r.id} data-testid={`release-${r.version}`}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ fontSize: "1.2rem", margin: 0 }}>{r.version} <span className="pill">{r.channel}</span> <span className={`pill ${r.status === "published" ? "ok" : r.status === "withdrawn" ? "bad" : "warn"}`}>{r.status}</span></h2>
            <span className="dim">{r.downloads} downloads</span>
          </div>
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>File</dt><dd>{r.fileName ? `${r.fileName} (${formatBytes(r.sizeBytes)})` : "not uploaded"}</dd>
            <dt>SHA-256</dt><dd className="mono">{r.sha256 ?? "-"}</dd>
            <dt>Created</dt><dd>{formatDateTime(r.createdAt)}{r.createdBy ? ` by ${r.createdBy}` : ""}</dd>
            <dt>Published</dt><dd>{formatDateTime(r.publishedAt)}</dd>
          </dl>
          <div className="row" style={{ marginTop: 14 }}>
            {r.status === "draft" && (
              <>
                <label className="btn small" style={{ cursor: "pointer" }}>
                  {busy === `up-${r.id}` ? "Uploading..." : r.fileName ? "Replace installer" : "Upload installer"}
                  <input type="file" accept=".exe,.msi,.zip" hidden onChange={(x) => upload(r, x.target.files?.[0])} />
                </label>
                <button className="btn small" disabled={!r.sha256 || busy !== null} onClick={() => void run(`ap-${r.id}`, () => post(`/admin/releases/${r.id}/approve`), "Approved. It is still NOT public.")}>Approve</button>
                <button className="btn small ghost danger" onClick={() => void run(`del-${r.id}`, () => del(`/admin/releases/${r.id}`))}>Delete draft</button>
              </>
            )}
            {r.sha256 && <button className="btn small ghost" onClick={() => verify(r)}>Re-check checksum</button>}
            {r.status === "approved" && (
              <>
                <input type="text" aria-label={`Type ${r.version} to publish`} placeholder={`type ${r.version} to publish`} value={confirmText[r.id] ?? ""} onChange={(x) => setConfirmText({ ...confirmText, [r.id]: x.target.value })} style={{ maxWidth: 240 }} />
                <button className="btn primary small" disabled={(confirmText[r.id] ?? "") !== r.version || busy !== null} onClick={() => void run(`pub-${r.id}`, () => post(`/admin/releases/${r.id}/publish`, { confirmVersion: confirmText[r.id] }), `${r.version} is now public.`)}>Publish</button>
              </>
            )}
            {(r.status === "approved" || r.status === "published") && <button className="btn small ghost danger" onClick={() => void run(`wd-${r.id}`, () => post(`/admin/releases/${r.id}/withdraw`), "Withdrawn. It is no longer public.")}>Withdraw</button>}
            {r.status === "published" && r.channel === "beta" && <button className="btn small" onClick={() => void run(`pr-${r.id}`, () => post(`/admin/releases/${r.id}/promote`), "A stable DRAFT was created. Approve and publish it separately.")}>Promote to stable (draft)</button>}
          </div>
        </section>
      ))}
    </>
  );
}

interface SupportRow { id: string; email: string; category: string; subject: string; message: string; diagnostics: string | null; status: string; adminNote: string; createdAt: string }

export function ConsoleSupport() {
  const [filter, setFilter] = useState("open");
  const [data, e, reload] = useLoad<{ requests: SupportRow[] }>(`/admin/support${filter ? `?status=${filter}` : ""}`);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const update = useCallback(async (id: string, body: { status?: string; adminNote?: string }) => {
    setErr(null);
    try { await patch(`/admin/support/${id}`, body); reload(); } catch (x) { setErr(errorText(x)); }
  }, [reload]);
  return (
    <>
      <h1 style={{ fontSize: "1.9rem" }}>Support requests</h1>
      <div className="toggle" role="group" aria-label="Filter">
        {["open", "in_progress", "resolved", ""].map((f) => <button key={f || "all"} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f ? f.replace("_", " ") : "all"}</button>)}
      </div>
      <Err e={e ?? err} />
      {!data ? <Loading /> : data.requests.length === 0 ? <p className="muted">Nothing here.</p> : data.requests.map((r) => (
        <section className="card" key={r.id} data-testid="support-item">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{r.subject}</strong>
            <span className="pill">{r.category}</span>
          </div>
          <p className="dim" style={{ fontSize: ".9rem" }}>{r.email} - {formatDateTime(r.createdAt)} - ref {r.id}</p>
          <p style={{ whiteSpace: "pre-wrap" }}>{r.message}</p>
          {r.diagnostics && <details><summary>Attached support report</summary><pre className="code" style={{ maxHeight: 260 }}>{r.diagnostics}</pre></details>}
          <Field label="Internal note (not shown to the customer)" htmlFor={`n-${r.id}`}>
            <textarea id={`n-${r.id}`} value={notes[r.id] ?? r.adminNote} onChange={(x) => setNotes({ ...notes, [r.id]: x.target.value })} style={{ minHeight: 70 }} />
          </Field>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={() => void update(r.id, { adminNote: notes[r.id] ?? r.adminNote })}>Save note</button>
            {r.status !== "in_progress" && <button className="btn small ghost" onClick={() => void update(r.id, { status: "in_progress" })}>Mark in progress</button>}
            {r.status !== "resolved" && <button className="btn small ghost" onClick={() => void update(r.id, { status: "resolved" })}>Mark resolved</button>}
            {r.status === "resolved" && <button className="btn small ghost" onClick={() => void update(r.id, { status: "open" })}>Reopen</button>}
          </div>
        </section>
      ))}
    </>
  );
}

interface Health { checks: { database: string; redis: string; queue: unknown }; uptimeSec: number; requests: number; errors5xx: number; email: { mode: string; queued: number; failed: number }; billing: { configured: boolean; provider: string; failedWebhookEventsLast24h: number; eventsLast24h: number }; entitlementsEnforced: boolean; publicUrl: string }

export function ConsoleHealth() {
  const [h, e, reload] = useLoad<Health>("/admin/health");
  if (e) return <Err e={e} />;
  if (!h) return <Loading />;
  const ok = (v: string) => <span className={`pill ${v === "ok" ? "ok" : "bad"}`}>{v}</span>;
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}><h1 style={{ fontSize: "1.9rem" }}>Service health</h1><button className="btn small" onClick={reload}>Refresh</button></div>
      <section className="card">
        <dl className="kv">
          <dt>Database</dt><dd>{ok(h.checks.database)}</dd>
          <dt>Redis</dt><dd>{ok(h.checks.redis)}</dd>
          <dt>Job queue</dt><dd className="mono">{typeof h.checks.queue === "string" ? h.checks.queue : JSON.stringify(h.checks.queue)}</dd>
          <dt>Uptime</dt><dd>{Math.round(h.uptimeSec / 60)} minutes</dd>
          <dt>Requests / server errors</dt><dd>{h.requests} / {h.errors5xx}</dd>
          <dt>Public address</dt><dd className="mono">{h.publicUrl}</dd>
        </dl>
      </section>
      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>Email</h2>
        <p>Mode: <strong>{h.email.mode}</strong>. Queued: {h.email.queued}. Failed: <span className={h.email.failed ? "pill bad" : ""}>{h.email.failed}</span>.</p>
        {h.email.mode.startsWith("captured") && <Notice kind="warn">No email provider is configured, so confirmation and reset emails are recorded but NOT delivered.</Notice>}
      </section>
      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>Billing</h2>
        <p>Provider: <strong>{h.billing.provider}</strong>. Webhook events in the last 24 hours: {h.billing.eventsLast24h}; failed: <span className={h.billing.failedWebhookEventsLast24h ? "pill bad" : ""}>{h.billing.failedWebhookEventsLast24h}</span>. Plan limits enforced: <strong>{h.entitlementsEnforced ? "yes" : "no"}</strong>.</p>
      </section>
    </>
  );
}

export function ConsoleAudit() {
  const [data, e] = useLoad<{ entries: Array<{ id: number; adminEmail: string; action: string; target: string | null; detail: unknown; createdAt: string }> }>("/admin/audit");
  if (e) return <Err e={e} />;
  if (!data) return <Loading />;
  return (
    <>
      <h1 style={{ fontSize: "1.9rem" }}>Audit log</h1>
      <div className="table-scroll">
        <table className="data">
          <thead><tr><th>When</th><th>Administrator</th><th>Action</th><th>Target</th></tr></thead>
          <tbody>{data.entries.map((a) => <tr key={a.id}><td>{formatDateTime(a.createdAt)}</td><td>{a.adminEmail}</td><td>{a.action}</td><td className="mono">{a.target ?? "-"}</td></tr>)}</tbody>
        </table>
      </div>
    </>
  );
}
