import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loading, Notice, usePageMeta } from "../components/ui";
import { get } from "../lib/api";
import { copyText, formatBytes, formatDate } from "../lib/format";

export interface PublicRelease {
  id: string;
  version: string;
  channel: "beta" | "stable";
  platform: string;
  notes: string;
  knownIssues: string;
  fileName: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  publishedAt: string | null;
  downloadUrl: string | null;
}

/** "0.3.0-beta.2" -> "Clynx Beta 2"; any other version -> "Clynx <version>". */
export function releaseTitle(r: Pick<PublicRelease, "version" | "channel">): string {
  const m = /-beta\.(\d+)(?:\.\d+)?$/.exec(r.version);
  return m ? `Clynx Beta ${m[1]}` : `Clynx ${r.version}`;
}

export default function Download() {
  usePageMeta("Download Clynx for Windows", "Download the Clynx Windows beta: latest version, SHA-256 checksum, system requirements, installation steps, release notes and known issues.");
  const [channel, setChannel] = useState<"beta" | "stable">("beta");
  const [latest, setLatest] = useState<PublicRelease | null | undefined>(undefined);
  const [history, setHistory] = useState<PublicRelease[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedAddr, setCopiedAddr] = useState(false);
  // the address a computer should type into Clynx: the one this page was opened from
  const serverAddress = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    setLatest(undefined);
    setError(null);
    get<{ release: PublicRelease | null }>(`/releases/latest?channel=${channel}`).then((r) => setLatest(r.release)).catch(() => setError("The release information could not be loaded."));
    get<{ releases: PublicRelease[] }>(`/releases?channel=${channel}`).then((r) => setHistory(r.releases)).catch(() => setHistory([]));
  }, [channel]);

  return (
    <div className="wrap section">
      <span className="eyebrow">Download</span>
      <h1 style={{ fontSize: "clamp(2rem,4.5vw,3rem)" }}>Clynx for Windows</h1>
      <p className="lead">Windows 10 or 11 (64-bit). You are seeing this page because you are signed in to a private beta; only approved testers can download the installer.</p>

      <div className="toggle" role="group" aria-label="Release channel" style={{ margin: "18px 0 26px" }}>
        <button aria-pressed={channel === "beta"} onClick={() => setChannel("beta")}>
          Beta
        </button>
        <button aria-pressed={channel === "stable"} onClick={() => setChannel("stable")}>
          Stable
        </button>
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {latest === undefined && !error && <Loading what="Looking for the latest release" />}

      {latest === null && (
        <Notice kind="warn" role="status">
          <strong data-testid="no-release">No {channel} release is available to download yet.</strong>
          <p style={{ margin: "8px 0 0" }} className="muted">
            Releases are published only after they have been tested and approved. The first beta is being prepared. <Link to="/support#contact">Ask to be told when it is ready</Link>.
          </p>
        </Notice>
      )}

      {latest && (
        <div className="card" data-testid="release-card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <h2 style={{ marginBottom: 4 }} data-testid="release-title">
                {releaseTitle(latest)} <span className="pill warn">{latest.channel}</span> <span className="muted" style={{ fontSize: "0.9rem", fontWeight: 500 }}>version {latest.version}</span>
              </h2>
              <p className="muted" style={{ margin: 0 }}>
                Published {formatDate(latest.publishedAt)} - {formatBytes(latest.sizeBytes)} - {latest.platform === "win32-x64" ? "Windows x64" : latest.platform}
              </p>
            </div>
            {latest.downloadUrl && (
              <a className="btn primary" href={latest.downloadUrl} data-testid="download-button">
                Download {latest.fileName}
              </a>
            )}
          </div>
          {latest.sha256 && (
            <div style={{ marginTop: 20 }}>
              <h3>SHA-256 checksum</h3>
              <code className="code" data-testid="sha256">{latest.sha256}</code>
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className="btn small ghost"
                  onClick={async () => {
                    setCopied(await copyText(latest.sha256 ?? ""));
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? "Copied" : "Copy checksum"}
                </button>
              </div>
              <p className="muted" style={{ marginTop: 12 }}>To check your download, run this in PowerShell in the folder where it was saved. The value it prints must match the one above:</p>
              <code className="code">Get-FileHash .\{latest.fileName} -Algorithm SHA256</code>
            </div>
          )}
        </div>
      )}

      <div className="grid c2" style={{ marginTop: 26 }}>
        <section className="card">
          <h2 style={{ fontSize: "1.35rem" }}>System requirements</h2>
          <ul className="checks">
            <li>Windows 10 or 11, 64-bit</li>
            <li>About 600 MB of free disk space</li>
            <li>Google Chrome or Microsoft Edge (Edge comes with Windows 10/11)</li>
            <li>A Facebook account you are happy to use (your own login stays on your PC)</li>
            <li>Optional: your own OpenAI API key, so Clynx can judge listings</li>
          </ul>
        </section>
        <section className="card">
          <h2 style={{ fontSize: "1.35rem" }}>Installing</h2>
          <ol className="muted" style={{ paddingLeft: 20, margin: 0 }}>
            <li>Download the installer and check its checksum (below).</li>
            <li>Run it. <strong>Windows will warn "Unknown publisher"</strong> (see below). Choose More info, then Run anyway.</li>
            <li>Open Clynx and click <strong>I have a Clynx Cloud account</strong>.</li>
            <li>Under <strong>Server address</strong> enter the address shown here, click <strong>Test connection</strong>, then sign in (or register with your invitation code).</li>
            <li>Connect Facebook and follow the Get started checklist.</li>
          </ol>
        </section>
      </div>

      <section className="card" style={{ marginTop: 26 }} data-testid="server-address-card">
        <h2 style={{ fontSize: "1.35rem" }}>Your Clynx server address</h2>
        <p className="muted" style={{ marginTop: 0 }}>Type this into Clynx (sign-in screen, Server address) on each computer. It is encrypted (https) and works from anywhere you can open this page.</p>
        <code className="code" data-testid="server-address">{serverAddress}</code>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn small ghost"
            onClick={async () => {
              setCopiedAddr(await copyText(serverAddress));
              setTimeout(() => setCopiedAddr(false), 2000);
            }}
          >
            {copiedAddr ? "Copied" : "Copy address"}
          </button>
        </div>
      </section>

      <div style={{ marginTop: 26 }}>
        <Notice kind="warn">
          <strong>About the Windows warning.</strong> Beta installers are not yet signed with a code-signing certificate, so Windows SmartScreen shows "Windows protected your PC". That is expected for an unsigned program, not a sign of a problem with this file; the checksum above lets you confirm it is the file we published. Only run installers you downloaded from this page.
        </Notice>
      </div>

      {latest && (
        <div className="grid c2" style={{ marginTop: 26 }}>
          <section className="card">
            <h2 style={{ fontSize: "1.35rem" }}>Release notes</h2>
            <div className="prose" style={{ whiteSpace: "pre-wrap" }} data-testid="release-notes">{latest.notes || "No notes for this release."}</div>
          </section>
          <section className="card">
            <h2 style={{ fontSize: "1.35rem" }}>Known issues</h2>
            <div className="prose" style={{ whiteSpace: "pre-wrap" }} data-testid="known-issues">{latest.knownIssues || "None listed."}</div>
          </section>
        </div>
      )}

      <section style={{ marginTop: 36 }}>
        <h2>Your data, updating and uninstalling</h2>
        <ul className="checks">
          <li>Your Database, settings and Facebook login live in <code className="mono">%APPDATA%\Clynx</code> on your computer.</li>
          <li>Updates: when you are signed in to this server, Clynx finds newer signed versions by itself, downloads and checks them, and installs only when you click <em>Restart and install</em>. You can always run a newer installer over the old one instead. Your data is kept either way.</li>
          <li>Uninstalling removes the program but keeps that data folder. Delete the folder yourself for a complete removal.</li>
        </ul>
      </section>

      {history.length > 1 && (
        <section style={{ marginTop: 36 }}>
          <h2>Earlier {channel} releases</h2>
          <div className="table-scroll">
            <table className="compare">
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Published</th>
                  <th scope="col">Size</th>
                  <th scope="col">Download</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td>{r.version}</td>
                    <td>{formatDate(r.publishedAt)}</td>
                    <td>{formatBytes(r.sizeBytes)}</td>
                    <td>{r.downloadUrl ? <a href={r.downloadUrl}>{r.fileName}</a> : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="fine" style={{ marginTop: 28 }}>
        Download counts are kept as a single number per release per day. We do not store your address or browser details. See the <Link to="/legal/privacy">privacy policy</Link> (draft).
      </p>
    </div>
  );
}
