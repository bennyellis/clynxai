import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { Field, Loading, Notice, usePageMeta } from "../../components/ui";
import { api, del, errorText, get, patch, post, put } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { copyText, formatBytes, formatDate, formatDateTime } from "../../lib/format";

// The administration console. The server re-checks the administrator role on every call; hiding a page here is only a courtesy.

export function ConsoleLayout() {
  usePageMeta("Console");
  const { user } = useAuth();
  return (
    <div className="wrap portal">
      <nav className="side" aria-label="Console">
        <div className="group">Administration</div>
        <NavLink to="/console" end>Overview</NavLink>
        <NavLink to="/console/users">Customers</NavLink>
        <NavLink to="/console/beta">Beta testers</NavLink>
        <NavLink to="/console/releases">Releases</NavLink>
        <NavLink to="/console/invites">Invitations</NavLink>
        <NavLink to="/console/support">Support</NavLink>
        <NavLink to="/console/health">Service health</NavLink>
        <NavLink to="/console/spending">Spending and safety</NavLink>
        {user?.role === "owner" && <NavLink to="/console/integrations">API integrations</NavLink>}
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
  deviceVersions?: Array<{ version: string; devices: number; lastSeenAt: string }>;
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
      {o.deviceVersions && o.deviceVersions.length > 0 && (
        <section className="card" data-testid="device-versions">
          <h2 style={{ fontSize: "1.2rem" }}>Which version computers are running (seen in the last 14 days)</h2>
          <table className="table"><thead><tr><th>Version</th><th>Computers</th><th>Last seen</th></tr></thead><tbody>
            {o.deviceVersions.map((v) => <tr key={v.version}><td>{v.version}</td><td>{v.devices}</td><td>{formatDateTime(v.lastSeenAt)}</td></tr>)}
          </tbody></table>
          <p className="fine">After you publish a release, this is how you watch it reach the computers: they report their version about every 30 seconds while Clynx is open. A computer that is closed updates the next time it is opened.</p>
        </section>
      )}
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
                    {u.role === "admin" && <span className="pill">admin</span>} {u.role === "owner" && <span className="pill ok">owner</span>} {u.isBetaTester && <span className="pill ok">beta</span>} {!u.emailVerified && <span className="pill warn">unconfirmed</span>} {u.disabled && <span className="pill bad">disabled</span>}
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

interface AdminRelease { id: string; version: string; channel: string; status: string; notes: string; knownIssues: string; fileName: string | null; sha256: string | null; sizeBytes: number | null; createdAt: string; publishedAt: string | null; createdBy: string | null; downloads: number; hasUpdateManifest?: boolean; requiredAt?: string | null; requiredDeadline?: string | null }

interface InviteRow { id: string; email: string | null; note: string; createdAt: string; expiresAt: string; usedAt: string | null; usedBy: string | null; revokedAt: string | null; status: "open" | "used" | "expired" | "revoked" }

export function ConsoleInvites() {
  const [data, e, reload] = useLoad<{ invites: InviteRow[]; registration: string; access: string }>("/admin/invites");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [hours, setHours] = useState("72");
  const [fresh, setFresh] = useState<{ code: string; expiresAt: string; email: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const create = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setErr(null);
    setFresh(null);
    try {
      const r = await post<{ code: string; expiresAt: string }>("/admin/invites", { email: email.trim() || undefined, note: note.trim() || undefined, hours: Number(hours) || 72 });
      setFresh({ code: r.code, expiresAt: r.expiresAt, email: email.trim() });
      setEmail("");
      setNote("");
      reload();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 style={{ fontSize: "1.9rem" }}>Invitations</h1>
      <Notice>
        {data?.registration === "invite" ? "This server is invitation-only: nobody can create an account without a code from this page." : data?.registration === "closed" ? "Registration is closed: not even a code creates an account." : "Registration is OPEN on this server: anyone who can reach it can create an account (codes are not required). Set REGISTRATION=invite to require them."}
        {" "}Access is <strong>{data?.access === "private" ? "private (sign-in required for everything)" : "open"}</strong>.
      </Notice>
      <Err e={e ?? err} />
      {fresh && (
        <div className="success" role="status" data-testid="new-invite">
          <strong>Invitation code (shown only now):</strong>
          <div style={{ margin: "8px 0" }}><code className="code" data-testid="invite-code">{fresh.code}</code></div>
          <div className="row">
            <button className="btn small" onClick={async () => { setCopied(await copyText(fresh.code)); setTimeout(() => setCopied(false), 2000); }}>{copied ? "Copied" : "Copy code"}</button>
            <span className="muted">Valid until {formatDateTime(fresh.expiresAt)}{fresh.email ? `, only for ${fresh.email}` : ""}. Send it privately; it works once.</span>
          </div>
        </div>
      )}
      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>New invitation</h2>
        <form className="form" onSubmit={create} style={{ maxWidth: 560 }}>
          <Field label="Only for this email (optional)" htmlFor="i-email"><input id="i-email" type="email" placeholder="tester@example.com" value={email} onChange={(x) => setEmail(x.target.value)} /></Field>
          <div className="row">
            <Field label="Note (optional, only you see it)" htmlFor="i-note"><input id="i-note" type="text" maxLength={200} value={note} onChange={(x) => setNote(x.target.value)} /></Field>
            <Field label="Valid for (hours)" htmlFor="i-hours"><input id="i-hours" type="number" min={1} max={720} value={hours} onChange={(x) => setHours(x.target.value)} /></Field>
          </div>
          <div><button className="btn primary small" disabled={busy}>Create invitation</button></div>
        </form>
      </section>
      <section className="card">
        <h2 style={{ fontSize: "1.2rem" }}>All invitations</h2>
        {!data ? <Loading /> : data.invites.length === 0 ? <p className="muted">None yet.</p> : (
          <div className="table-scroll">
            <table className="compare">
              <thead><tr><th scope="col">Status</th><th scope="col">For</th><th scope="col">Note</th><th scope="col">Created</th><th scope="col">Expires</th><th scope="col">Used by</th><th scope="col"></th></tr></thead>
              <tbody>
                {data.invites.map((i) => (
                  <tr key={i.id} data-testid={`invite-${i.status}`}>
                    <td><span className={`pill ${i.status === "open" ? "ok" : i.status === "used" ? "" : "bad"}`}>{i.status}</span></td>
                    <td>{i.email ?? "anyone with the code"}</td>
                    <td>{i.note || "-"}</td>
                    <td>{formatDateTime(i.createdAt)}</td>
                    <td>{formatDateTime(i.expiresAt)}</td>
                    <td>{i.usedBy ?? "-"}</td>
                    <td>{i.status === "open" && <button className="btn small ghost danger" onClick={async () => { try { await del(`/admin/invites/${i.id}`); reload(); } catch (x) { setErr(errorText(x)); } }}>Revoke</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

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
  const [reqHours, setReqHours] = useState<Record<string, string>>({});
  const { user } = useAuth();
  // Only the Owner may change releases (the server enforces it); an administrator sees them but not the buttons.
  const isOwner = user?.role === "owner";

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
  // Automatic updates: the manifest is signed OFFLINE with the update private key (which never touches this server); this page only downloads the unsigned text and uploads the signed result.
  const downloadTemplate = (r: AdminRelease) =>
    void run(`tpl-${r.id}`, async () => {
      const t = await get<{ manifest: unknown; configured: boolean }>(`/admin/releases/${r.id}/update-manifest-template`);
      const blob = new Blob([JSON.stringify(t.manifest, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `manifest-${r.version}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setInfo(t.configured ? `Saved manifest-${r.version}.json. Sign it offline, then upload the signed file here.` : "Saved the manifest, but this server has no UPDATE_PUBLIC_KEY, so it will refuse the signed file until one is configured.");
    });
  const uploadSigned = async (r: AdminRelease, file: File | undefined) => {
    if (!file) return;
    void run(`sig-${r.id}`, async () => {
      let body: unknown;
      try { body = JSON.parse(await file.text()); } catch { throw new Error("That file is not a signed manifest (expected JSON with manifest and signature)."); }
      await put(`/admin/releases/${r.id}/update-manifest`, body);
    }, `The signed manifest for ${r.version} was verified and stored. ${r.status === "published" ? "Desktop apps on this channel will now be offered it." : "It is offered once the release is published."}`);
  };
  const verify = (r: AdminRelease) =>
    void run(`ver-${r.id}`, async () => {
      const v = await get<{ ok: boolean; recorded: string | null; actual: string | null }>(`/admin/releases/${r.id}/verify`);
      setInfo(v.ok ? `Verified: the stored file matches its checksum for ${r.version}.` : `MISMATCH for ${r.version}: recorded ${v.recorded} but the stored file is ${v.actual ?? "missing"}.`);
    });

  return (
    <>
      <h1 style={{ fontSize: "1.9rem" }}>Releases</h1>
      <Notice>Nothing is ever published automatically. A release goes draft &rarr; (upload) &rarr; approved &rarr; published, and publishing needs you to type the version number. Only published releases appear on the Download page. Once published, installed apps update by themselves; "Require this update" makes it compulsory by a deadline.{!isOwner && " Only the Owner can create, approve, publish, withdraw or require a release; you can look at them here."}</Notice>
      <Err e={e ?? err} />
      {info && <div className="success" role="status">{info}</div>}
      {isOwner && <section className="card">
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
      </section>}
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
            {r.requiredDeadline && <><dt>Required</dt><dd data-testid={`required-${r.version}`}><span className="pill warn">required</span> by {formatDateTime(r.requiredDeadline)} (apps that are online install it by then)</dd></>}
          </dl>
          <div className="row" style={{ marginTop: 14 }}>
            {r.sha256 && <button className="btn small ghost" onClick={() => verify(r)}>Re-check checksum</button>}
            {isOwner && r.status === "published" && r.hasUpdateManifest && !r.requiredDeadline && (
              <>
                <input type="number" min={1} max={1440} aria-label={`Hours until ${r.version} is required`} value={reqHours[r.id] ?? "72"} onChange={(x) => setReqHours({ ...reqHours, [r.id]: x.target.value })} style={{ maxWidth: 90 }} />
                <button className="btn small" disabled={busy !== null} onClick={() => void run(`req-${r.id}`, () => post(`/admin/releases/${r.id}/require`, { hours: Number(reqHours[r.id] ?? "72") }), "Marked as required. Apps that are online will install it within that time (waiting for an idle moment until then).")}>Require this update (hours)</button>
              </>
            )}
            {isOwner && r.requiredDeadline && <button className="btn small ghost" disabled={busy !== null} onClick={() => void run(`unreq-${r.id}`, () => del(`/admin/releases/${r.id}/require`), "No longer required.")}>Lift the requirement</button>}
            {isOwner && r.status === "draft" && (
              <>
                <label className="btn small" style={{ cursor: "pointer" }}>
                  {busy === `up-${r.id}` ? "Uploading..." : r.fileName ? "Replace installer" : "Upload installer"}
                  <input type="file" accept=".exe,.msi,.zip" hidden onChange={(x) => upload(r, x.target.files?.[0])} />
                </label>
                <button className="btn small" disabled={!r.sha256 || busy !== null} onClick={() => void run(`ap-${r.id}`, () => post(`/admin/releases/${r.id}/approve`), "Approved. It is still NOT public.")}>Approve</button>
                <button className="btn small ghost danger" onClick={() => void run(`del-${r.id}`, () => del(`/admin/releases/${r.id}`))}>Delete draft</button>
              </>
            )}
            {isOwner && r.status === "approved" && (
              <>
                <input type="text" aria-label={`Type ${r.version} to publish`} placeholder={`type ${r.version} to publish`} value={confirmText[r.id] ?? ""} onChange={(x) => setConfirmText({ ...confirmText, [r.id]: x.target.value })} style={{ maxWidth: 240 }} />
                <button className="btn primary small" disabled={(confirmText[r.id] ?? "") !== r.version || busy !== null} onClick={() => void run(`pub-${r.id}`, () => post(`/admin/releases/${r.id}/publish`, { confirmVersion: confirmText[r.id] }), `${r.version} is now public.`)}>Publish</button>
              </>
            )}
            {isOwner && (r.status === "approved" || r.status === "published") && <button className="btn small ghost danger" onClick={() => void run(`wd-${r.id}`, () => post(`/admin/releases/${r.id}/withdraw`), "Withdrawn. It is no longer public.")}>Withdraw</button>}
            {r.sha256 && r.status !== "withdrawn" && (
              <>
                {isOwner && <button className="btn small ghost" onClick={() => downloadTemplate(r)} title="Download the unsigned update manifest to sign offline">Manifest to sign</button>}
                {isOwner && <label className="btn small ghost" style={{ cursor: "pointer" }} title="Upload the manifest you signed offline">
                  {busy === `sig-${r.id}` ? "Checking..." : r.hasUpdateManifest ? "Replace signed manifest" : "Upload signed manifest"}
                  <input type="file" accept=".json" hidden onChange={(x) => void uploadSigned(r, x.target.files?.[0])} />
                </label>}
                <span className={`pill ${r.hasUpdateManifest ? "ok" : ""}`}>{r.hasUpdateManifest ? "auto-update ready" : "no auto-update"}</span>
              </>
            )}
            {isOwner && r.status === "published" && r.channel === "beta" && <button className="btn small" onClick={() => void run(`pr-${r.id}`, () => post(`/admin/releases/${r.id}/promote`), "A stable DRAFT was created. Approve and publish it separately.")}>Promote to stable (draft)</button>}
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
