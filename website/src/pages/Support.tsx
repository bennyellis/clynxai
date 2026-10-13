import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Faq, Field, Notice, usePageMeta } from "../components/ui";
import { errorText, get, post } from "../lib/api";
import { useAuth } from "../lib/auth";

const CATEGORIES: Array<[string, string]> = [
  ["install", "Installing or starting Clynx"],
  ["scanner", "Scanning or Facebook login"],
  ["billing", "Billing or my subscription"],
  ["account", "My account"],
  ["bug", "Something else is broken"],
  ["other", "Something else"],
];

export function BugReportForm({ defaultCategory = "bug" }: { defaultCategory?: string }) {
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState(defaultCategory);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [diagnostics, setDiagnostics] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (user && !email) setEmail(user.email);
  }, [user, email]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ reference: string }>("/support/requests", { email, category, subject, message, diagnostics: diagnostics.trim() || undefined });
      setDone(r.reference);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  if (done)
    return (
      <Notice kind="ok" role="status">
        <strong>Thank you - we have your message.</strong>
        <p style={{ margin: "8px 0 0" }} className="muted">
          Your reference is <span className="mono" data-testid="support-reference">{done}</span>. We reply to {email}. A confirmation email is on its way.
        </p>
      </Notice>
    );
  return (
    <form className="form" onSubmit={submit} style={{ maxWidth: 640 }} aria-describedby={error ? "support-error" : undefined}>
      <Field label="Your email" htmlFor="s-email" hint="We reply here.">
        <input id="s-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </Field>
      <Field label="What is it about?" htmlFor="s-cat">
        <select id="s-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Short summary" htmlFor="s-subject">
        <input id="s-subject" type="text" required minLength={3} maxLength={150} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Field>
      <Field label="What happened?" htmlFor="s-message" hint="What you were doing, what you expected, what happened instead. Never include passwords or API keys.">
        <textarea id="s-message" required minLength={10} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} />
      </Field>
      <Field label="Support report (optional)" htmlFor="s-diag" hint="In the app: Config > Account > Report a bug > Save a support report. Open the file and paste it here. It has passwords, keys and cookies removed.">
        <textarea id="s-diag" maxLength={40000} value={diagnostics} onChange={(e) => setDiagnostics(e.target.value)} style={{ minHeight: 90 }} />
      </Field>
      {error && (
        <div className="error" role="alert" id="support-error">
          {error}
        </div>
      )}
      <div>
        <button className="btn primary" disabled={busy}>
          {busy ? "Sending..." : "Send to support"}
        </button>
      </div>
    </form>
  );
}

export default function Support() {
  usePageMeta("Support", "Answers to common questions, troubleshooting for installing Clynx and for the scanner, account and billing help, and a form to report a bug or contact support.");
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    get<{ supportEmail?: string }>("/plans/public").then((r) => setEmail(r.supportEmail ?? null)).catch(() => setEmail(null));
  }, []);
  return (
    <div className="wrap section">
      <span className="eyebrow">Support</span>
      <h1 style={{ fontSize: "clamp(2rem,4.5vw,3rem)" }}>How can we help?</h1>

      <div className="grid c2" style={{ marginTop: 28, alignItems: "start" }}>
        <section>
          <h2>Frequently asked questions</h2>
          <Faq q="Do I need an account?">
            <p>Not for the Windows beta. It runs on your computer with its own empty Database. An account is for the planned subscription, syncing between computers and managing billing.</p>
          </Faq>
          <Faq q="Does Clynx work without an OpenAI key?">
            <p>Partly. It collects listings and prices those that match a product already in your Database. Judging other listings, researching new products and the assistant need your own OpenAI key (OpenAI bills you directly). Add it in Config &rarr; Account &rarr; Your API keys.</p>
          </Faq>
          <Faq q="Is it safe for my Facebook account?">
            <p>Clynx drives your own browser at a slow pace and never tries to get around a Facebook check. Facebook's terms restrict automated access, and it can ask you to verify your identity or limit an account. Use it at your own risk, ideally with an account you can afford to have restricted.</p>
          </Faq>
          <Faq q="What does Clynx send over the internet?">
            <p>Facebook pages (through your own browser). If you add an OpenAI key, listing text and photos go to OpenAI to be judged. If you add eBay keys, searches go to eBay. If you set up phone alerts, the alert text goes to ntfy.sh under your private topic. Nothing is sent to us automatically.</p>
          </Faq>
          <Faq q="Where is my data and how do I delete it?">
            <p>In <span className="mono">%APPDATA%\Clynx</span>. Uninstalling keeps it; delete the folder for a complete removal. For an online account, <Link to="/account/profile">delete it from your profile</Link> or export your data first.</p>
          </Faq>
          <Faq q="Are the values guaranteed?">
            <p>No. They are estimates from past sales and can be wrong. Check a listing yourself before you buy.</p>
          </Faq>
        </section>

        <section>
          <h2>Troubleshooting</h2>
          <Faq q="Windows says 'Unknown publisher' when I run the installer">
            <p>Beta installers are not yet code-signed, so SmartScreen warns about every unsigned download. Check the SHA-256 on the <Link to="/download">download page</Link>, then choose More info &rarr; Run anyway.</p>
          </Faq>
          <Faq q="Clynx says it needs Google Chrome">
            <p>Clynx scans through Chrome or Microsoft Edge. Edge is part of Windows 10/11; if both are missing, install Chrome from google.com/chrome and restart Clynx.</p>
          </Faq>
          <Faq q="The scanner finds nothing or says it is logged out">
            <p>Open the Dashboard and use the button on the notice ("Open Facebook") to log in again in the window that opens. If Facebook shows a security check, complete it yourself in that window; Clynx will not do it for you. "Found 0 listings" can also mean Facebook changed its page layout: save a support report and send it to us.</p>
          </Faq>
          <Faq q="Listings are collected but nothing is judged">
            <p>That is what happens without an OpenAI key. A yellow notice on the Dashboard says so. Add your key in Config &rarr; Account &rarr; Your API keys.</p>
          </Faq>
          <Faq q="I lost my Database or something looks wrong">
            <p>Config &rarr; Account &rarr; Database backups lists the automatic backups. Press Restore on the one you want; Clynx keeps the data you are replacing.</p>
          </Faq>
          <Faq q="I cannot sign in or I forgot my password">
            <p><Link to="/forgot-password">Reset your password</Link>. After a reset every sign-in is ended and you sign in again with the new password. If you never received an email, check spam, then ask support.</p>
          </Faq>
          <Faq q="Billing questions">
            <p>Manage payment methods, switch between monthly and annual, or cancel from <Link to="/account/billing">Account &rarr; Subscription</Link>. For anything else, use the form below and choose "Billing".</p>
          </Faq>
        </section>
      </div>

      <section id="report" style={{ marginTop: 52 }}>
        <h2>Report a bug or contact support</h2>
        <p className="muted" style={{ maxWidth: "62ch" }}>
          Include what you were doing and what happened. For scanner or install problems, attach a support report from the app: it lists versions and settings with secrets removed, and never contains listings, photos, passwords, keys or cookies.
        </p>
        <BugReportForm />
      </section>

      <section id="contact" style={{ marginTop: 40 }}>
        <h2>Other ways to reach us</h2>
        <p className="muted">
          Email: <span className="mono" data-testid="support-email">{email ?? "support address to be announced"}</span>
          {email?.endsWith(".invalid") && <span className="pill warn" style={{ marginLeft: 8 }}>placeholder</span>}
        </p>
      </section>
    </div>
  );
}
