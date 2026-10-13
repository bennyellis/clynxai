import type { ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { SITE, usePageMeta } from "../../components/ui";

// DRAFT legal documents. They describe what the software actually does today, with every decision that belongs to the owner or to a lawyer left as a marked [PLACEHOLDER].
// They have NOT been reviewed by a lawyer and must not be published as-is.

const P = ({ children }: { children: ReactNode }) => <p>{children}</p>;
const PH = ({ children }: { children: ReactNode }) => <mark style={{ background: "rgba(251,191,36,.2)", color: "#fde68a", padding: "0 4px", borderRadius: 4 }}>[{children}]</mark>;

interface Doc {
  title: string;
  description: string;
  body: ReactNode;
}

const DOCS: Record<string, Doc> = {
  privacy: {
    title: "Privacy Policy",
    description: "Draft privacy policy for Clynx: what is collected, why, who receives it, how long it is kept, and your choices.",
    body: (
      <>
        <P>Last updated: <PH>DATE - set when approved</PH>. Controller: {SITE.companyLegalName}, {SITE.companyAddress}. Contact: <PH>PRIVACY CONTACT EMAIL</PH>.</P>
        <h2>1. The short version</h2>
        <P>The Windows beta works on your computer with no account. It sends nothing to us automatically. If you create an account, we store the information listed below to run it. We do not sell personal information and we do not use advertising or analytics trackers on this website.</P>
        <h2>2. Information we collect</h2>
        <h3>On this website</h3>
        <ul>
          <li><strong>Account:</strong> email address, name (optional), a salted hash of your password (never the password), whether your email is confirmed, and the date you joined.</li>
          <li><strong>Sessions:</strong> a random session identifier (stored in a cookie, and as a hash on our server), the browser name you used and when you last used it, so you can see and end your sign-ins.</li>
          <li><strong>Devices:</strong> when you sign in from the Clynx app we record the computer type, app version and last activity so you can see and remove devices.</li>
          <li><strong>Subscription:</strong> your plan, status, billing interval and renewal dates. Card details are entered on our payment provider's pages and never reach our servers.</li>
          <li><strong>Support:</strong> what you write in a support request and any support report you attach.</li>
          <li><strong>Downloads:</strong> one counter per release per day. We do not keep your IP address or browser details for downloads.</li>
          <li><strong>Server logs:</strong> short-lived technical logs (request paths, status codes, errors) used to keep the service running. <PH>RETENTION PERIOD - to be decided</PH></li>
        </ul>
        <h3>In the Clynx app</h3>
        <ul>
          <li>Your Database, settings, scanned listings and your Facebook login are stored <strong>on your computer</strong>. We do not receive them in local mode.</li>
          <li>If you sign in to a Clynx account, the app can sync your Watches, product entries and feedback to your account. <PH>CONFIRM FINAL SYNC SCOPE BEFORE PUBLISHING</PH></li>
          <li>If you use your own OpenAI key, listing text and photos are sent from your computer to OpenAI. If you use eBay keys, searches go to eBay. Those companies' own privacy policies apply.</li>
        </ul>
        <h2>3. Why we use it</h2>
        <P>To provide your account and subscription, to keep the service secure (for example by limiting sign-in attempts), to answer support requests, and to understand in aggregate how many people download each release. <PH>LEGAL BASIS FOR EACH PURPOSE - for a lawyer, if GDPR applies</PH></P>
        <h2>4. Who receives it</h2>
        <ul>
          <li><strong>Payment provider:</strong> Stripe, for subscriptions. <PH>CONFIRM PROVIDER AND ITS ROLE</PH></li>
          <li><strong>Email delivery provider:</strong> <PH>PROVIDER NAME - not chosen yet</PH>, for confirmation and reset emails.</li>
          <li><strong>Hosting provider:</strong> <PH>PROVIDER NAME AND REGION - not chosen yet</PH>.</li>
        </ul>
        <h2>5. Your choices and rights</h2>
        <ul>
          <li>Download a copy of your account data and delete your account yourself from <Link to="/account/profile">Account &rarr; Profile</Link>. Deleting an account cancels its subscription and removes its data from our servers. <PH>BACKUP RETENTION AFTER DELETION - to be decided</PH></li>
          <li>Change your name or email, and end any browser session or device, from your account.</li>
          <li>Ask questions or make requests at <PH>PRIVACY CONTACT EMAIL</PH>.</li>
        </ul>
        <h2>6. Cookies</h2>
        <P>See the <Link to="/legal/cookies">cookie policy</Link>. We use one essential cookie to keep you signed in.</P>
        <h2>7. Children</h2>
        <P>Clynx is not meant for people under <PH>MINIMUM AGE - to be decided</PH>.</P>
        <h2>8. Changes</h2>
        <P>We will post changes here and, for material changes, tell account holders by email.</P>
      </>
    ),
  },
  terms: {
    title: "Terms of Service",
    description: "Draft terms of service for the Clynx website, software and beta.",
    body: (
      <>
        <P>Last updated: <PH>DATE</PH>. These terms are between you and {SITE.companyLegalName} ("we"). <PH>GOVERNING LAW AND COURTS - for a lawyer</PH></P>
        <h2>1. The service</h2>
        <P>Clynx is software that helps you find and value Marketplace listings, and a website where you can manage an account. The Windows beta is provided free, as is, and may change or stop.</P>
        <h2>2. Your account</h2>
        <P>Keep your password private. You are responsible for activity on your account. You must give a real email address you control.</P>
        <h2>3. Acceptable use</h2>
        <ul>
          <li>Use Clynx lawfully and respect the terms of the sites it reads. <strong>Facebook's terms restrict automated access.</strong> You decide whether to use Clynx with your account and you accept the risk, including a limit or suspension of your Facebook account.</li>
          <li>Do not use Clynx to harass others, to misrepresent items, or to overload any service.</li>
          <li>Do not attempt to bypass limits, security checks or plan restrictions.</li>
        </ul>
        <h2>4. Estimates, not advice</h2>
        <P>Values, profit figures and deal ratings are automated estimates from incomplete data. They may be wrong. They are not financial advice and not a promise of profit. Check every listing yourself before you buy.</P>
        <h2>5. Third parties</h2>
        <P>Clynx works with services we do not control (Facebook, eBay, OpenAI, ntfy, Stripe). They may change or restrict access at any time. Where you supply your own keys, you pay those providers directly under their terms.</P>
        <h2>6. Subscriptions</h2>
        <P>Paid plans are described in the <Link to="/legal/subscription">subscription and cancellation terms</Link> and the <Link to="/legal/refunds">refund policy</Link>.</P>
        <h2>7. Our software and your data</h2>
        <P><PH>LICENCE TO USE THE SOFTWARE - for a lawyer</PH>. You keep your data. You give us only the permissions needed to run the features you use.</P>
        <h2>8. Warranty and liability</h2>
        <P><PH>DISCLAIMER OF WARRANTY AND LIMITATION OF LIABILITY - must be drafted by a lawyer for your jurisdiction</PH></P>
        <h2>9. Ending</h2>
        <P>You can stop using Clynx and delete your account at any time. We may suspend accounts that break these terms. <PH>NOTICE PERIOD - to be decided</PH></P>
        <h2>10. Contact</h2>
        <P><PH>CONTACT DETAILS</PH></P>
      </>
    ),
  },
  subscription: {
    title: "Subscription and Cancellation Terms",
    description: "Draft subscription and cancellation terms: billing, trials, plan changes, failed payments and cancelling Clynx Pro.",
    body: (
      <>
        <P>Last updated: <PH>DATE</PH>. These terms describe how paid plans work as the software is built today. Amounts and plan names are not final.</P>
        <h2>1. Plans and prices</h2>
        <P>Plans, limits and prices are shown on the <Link to="/pricing">pricing page</Link>. <PH>PRICES, CURRENCY AND TAXES - to be approved by the owner</PH>. Prices shown at checkout apply.</P>
        <h2>2. Billing</h2>
        <P>Subscriptions renew automatically each month or year until cancelled. Payment is handled by our payment provider; we never see your card number. <PH>PAYMENT METHODS - to be decided</PH></P>
        <h2>3. Free trial</h2>
        <P>New subscribers may get a free trial (currently configured as <PH>TRIAL LENGTH</PH> days). A trial is offered once per account. You are charged when the trial ends unless you cancel before then.</P>
        <h2>4. Changing plan</h2>
        <P>You can switch between monthly and annual billing from your account. The payment provider prorates the difference. Plan changes take effect immediately and never interrupt access.</P>
        <h2>5. Cancelling</h2>
        <P>You can cancel at any time from <Link to="/account/billing">Account &rarr; Subscription</Link>. Pro stays active until the end of the period you have already paid for, then the account returns to Free. You can resume before the period ends. Cancelling does not delete your data.</P>
        <h2>6. Failed payments</h2>
        <P>If a renewal payment fails you have a grace period (currently <PH>GRACE DAYS</PH> days) to update your payment method and keep Pro. If it is still unpaid when the grace period ends, the account returns to Free. Nothing is deleted.</P>
        <h2>7. Changes to plans or prices</h2>
        <P><PH>HOW AND WHEN PRICE CHANGES ARE NOTIFIED - to be decided with a lawyer</PH></P>
      </>
    ),
  },
  refunds: {
    title: "Refund Policy",
    description: "Draft refund policy for Clynx subscriptions.",
    body: (
      <>
        <P>Last updated: <PH>DATE</PH>.</P>
        <P><strong>No refund policy has been decided yet.</strong> This page is a placeholder so the structure is ready. The owner needs to choose the policy and a lawyer needs to check it against consumer law where customers live.</P>
        <h2>Points to decide</h2>
        <ul>
          <li>Refunds for a first payment, and within how many days: <PH>DECISION</PH></li>
          <li>Refunds for renewals charged by mistake or after a missed cancellation: <PH>DECISION</PH></li>
          <li>Prorated refunds when switching plans or cancelling mid-period: <PH>DECISION</PH></li>
          <li>Statutory rights that cannot be waived in some countries: <PH>FOR A LAWYER</PH></li>
          <li>How to ask: through the <Link to="/support#report">support form</Link>, choosing "Billing".</li>
        </ul>
      </>
    ),
  },
  cookies: {
    title: "Cookie Policy",
    description: "Draft cookie policy: Clynx uses one essential cookie to keep you signed in and no advertising or analytics cookies.",
    body: (
      <>
        <P>Last updated: <PH>DATE</PH>.</P>
        <h2>What we use</h2>
        <table className="data">
          <thead>
            <tr><th>Cookie</th><th>Purpose</th><th>Lasts</th><th>Type</th></tr>
          </thead>
          <tbody>
            <tr><td className="mono">clynx_sid (named __Host-clynx_sid on https)</td><td>Keeps you signed in on this website. It contains a random identifier, not your details. It cannot be read by scripts on the page (HttpOnly) and is only sent to this site.</td><td>Up to 14 days, or until you sign out</td><td>Strictly necessary</td></tr>
          </tbody>
        </table>
        <h2>What we do not use</h2>
        <P>No advertising cookies, no third-party analytics, no tracking pixels and no social-media widgets. Because the only cookie is strictly necessary for the sign-in you ask for, a cookie consent banner is not shown. <PH>A LAWYER SHOULD CONFIRM THIS FOR YOUR AUDIENCE - if you later add analytics or marketing tools, a consent mechanism is required</PH></P>
        <h2>Other storage</h2>
        <P>The payment provider's checkout pages, which you visit when you subscribe, set their own cookies under their own policy.</P>
      </>
    ),
  },
};

export default function Legal() {
  const { doc } = useParams();
  const d = doc ? DOCS[doc] : undefined;
  usePageMeta(d?.title ?? "Legal", d?.description);
  if (!d) return <Navigate to="/legal/privacy" replace />;
  return (
    <div className="wrap section prose" style={{ maxWidth: 880 }}>
      <div className="draft-banner" role="note">
        DRAFT - NOT LEGAL ADVICE. This document has not been reviewed by a lawyer and must be reviewed, completed and approved before it is published. Items in [square brackets] are decisions still to be made.
      </div>
      <h1 style={{ fontSize: "clamp(1.9rem,4vw,2.6rem)" }}>{d.title}</h1>
      <nav aria-label="Legal documents" className="row" style={{ margin: "10px 0 26px" }}>
        {Object.entries(DOCS).map(([k, v]) => (
          <Link key={k} to={`/legal/${k}`} className={`pill ${k === doc ? "ok" : ""}`}>
            {v.title}
          </Link>
        ))}
      </nav>
      {d.body}
    </div>
  );
}
