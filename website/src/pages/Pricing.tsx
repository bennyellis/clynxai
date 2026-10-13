import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Faq, Loading, Notice, Reveal, usePageMeta } from "../components/ui";
import { ApiError, errorText, get, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { limitText } from "../lib/format";

interface Entitlements {
  maxWatches: number | null;
  maxDevices: number | null;
  maxSearchItems: number | null;
  aiResearchEnabled: boolean;
  aiRequestsPerDay: number | null;
  aiImagesPerDay: number | null;
}
interface PublicPlans {
  pricesApproved: boolean;
  trialDays: number;
  billingAvailable: boolean;
  limitsEnforced: boolean;
  plans: Array<{ id: "free" | "pro"; name: string; price: { monthly: string | null; yearly: string | null }; intervals?: { monthly: boolean; yearly: boolean }; entitlements: Entitlements }>;
}
interface Status {
  plan: "free" | "pro";
  trialEligible: boolean;
  subscription: unknown | null;
}

export default function Pricing() {
  usePageMeta("Pricing", "Clynx plans: a free plan, and Clynx Pro with higher limits. Monthly and annual billing, a free trial, and cancel any time. Prices are not final.");
  const { user } = useAuth();
  const nav = useNavigate();
  const [plans, setPlans] = useState<PublicPlans | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [interval, setIntervalChoice] = useState<"monthly" | "yearly">("monthly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<PublicPlans>("/plans/public").then(setPlans).catch(() => setError("The plans could not be loaded. Please try again."));
  }, []);
  useEffect(() => {
    if (user) get<Status>("/billing/status").then(setStatus).catch(() => setStatus(null));
    else setStatus(null);
  }, [user]);

  async function subscribe() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ url: string }>("/billing/checkout", { plan: interval === "yearly" ? "pro_yearly" : "pro_monthly" });
      window.location.assign(r.url);
    } catch (e) {
      if (e instanceof ApiError && e.code === "already_subscribed") nav("/account/billing");
      else setError(errorText(e));
      setBusy(false);
    }
  }

  if (!plans) return <div className="wrap section">{error ? <div className="error" role="alert">{error}</div> : <Loading what="Loading plans" />}</div>;
  const free = plans.plans.find((p) => p.id === "free")!;
  const pro = plans.plans.find((p) => p.id === "pro")!;
  const proPrice = interval === "yearly" ? pro.price.yearly : pro.price.monthly;
  const yearlyOffered = pro.intervals?.yearly !== false;

  const rows: Array<[string, (e: Entitlements) => string]> = [
    ["Watches", (e) => limitText(e.maxWatches)],
    ["Computers signed in", (e) => limitText(e.maxDevices)],
    ["Search terms per Watch", (e) => limitText(e.maxSearchItems)],
    ["AI assistance requests per day", (e) => limitText(e.aiRequestsPerDay)],
    ["AI image requests per day", (e) => limitText(e.aiImagesPerDay)],
  ];

  return (
    <div className="wrap section">
      <span className="eyebrow">Pricing</span>
      <h1 style={{ fontSize: "clamp(2rem,4.5vw,3rem)" }}>Simple plans. Start free.</h1>
      <p className="lead">The Windows beta is free and needs no account. These are the plans planned for signed-in accounts.</p>

      {!plans.pricesApproved && (
        <div style={{ marginTop: 18 }}>
          <Notice kind="warn">
            <strong>Prices are not final.</strong> The amounts below are placeholders until the plans are approved. Nothing on this page can charge you unless you complete a checkout, and checkout is not open to the public yet.
          </Notice>
        </div>
      )}
      {!plans.limitsEnforced && (
        <p className="fine">Plan limits shown here describe the planned plans. They are not being enforced during the beta.</p>
      )}

      <div style={{ margin: "26px 0" }}>
        <div className="toggle" role="group" aria-label="Billing interval">
          <button aria-pressed={interval === "monthly"} onClick={() => setIntervalChoice("monthly")}>
            Monthly
          </button>
          <button aria-pressed={interval === "yearly"} onClick={() => setIntervalChoice("yearly")} disabled={!yearlyOffered}>
            Annual
          </button>
        </div>
      </div>

      {error && <div className="error" role="alert" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="grid c2" style={{ maxWidth: 860 }}>
        <Reveal className="card plan">
          <h2 style={{ fontSize: "1.5rem" }}>Free</h2>
          <div className="price">$0</div>
          <p className="muted">Everything you need to try Clynx on one or two computers.</p>
          <ul className="checks">
            <li>Marketplace scanning and the product Database</li>
            <li>Up to {limitText(free.entitlements.maxWatches)} Watches and {limitText(free.entitlements.maxDevices)} computers</li>
            <li>{limitText(free.entitlements.aiRequestsPerDay)} AI assistance requests per day</li>
          </ul>
          {user ? (
            <Link to="/account" className="btn ghost">
              Your account
            </Link>
          ) : (
            <Link to="/signup" className="btn ghost">
              Create a free account
            </Link>
          )}
        </Reveal>

        <Reveal className="card plan pro">
          <h2 style={{ fontSize: "1.5rem" }}>Clynx Pro</h2>
          {proPrice ? <div className="price">{proPrice}</div> : <div className="price placeholder" data-testid="price-placeholder">[PRICE TO BE ANNOUNCED - {interval === "yearly" ? "annual" : "monthly"}]</div>}
          <p className="muted">For people who watch many items and use Clynx on several computers.</p>
          <ul className="checks">
            <li>{limitText(pro.entitlements.maxWatches)} Watches and {limitText(pro.entitlements.maxDevices)} computers</li>
            <li>Up to {limitText(pro.entitlements.aiRequestsPerDay)} AI assistance requests per day</li>
            {plans.trialDays > 0 && <li>{plans.trialDays}-day free trial for new subscribers (once per account)</li>}
            <li>Cancel any time; Pro stays until the end of the period you paid for</li>
          </ul>
          {!user ? (
            <Link to="/signup" className="btn primary">
              Create an account to start
            </Link>
          ) : status?.plan === "pro" || status?.subscription ? (
            <Link to="/account/billing" className="btn primary">
              Manage your subscription
            </Link>
          ) : (
            <button className="btn primary" onClick={() => void subscribe()} disabled={busy || !plans.billingAvailable}>
              {!plans.billingAvailable ? "Payments are not open yet" : busy ? "Opening checkout..." : status?.trialEligible && plans.trialDays > 0 ? `Start ${plans.trialDays}-day free trial` : "Subscribe"}
            </button>
          )}
        </Reveal>
      </div>

      <h2 style={{ marginTop: 56 }}>Compare plans</h2>
      <div className="table-scroll">
        <table className="compare">
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col">Free</th>
              <th scope="col">Pro</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, fn]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{fn(free.entitlements)}</td>
                <td>{fn(pro.entitlements)}</td>
              </tr>
            ))}
            <tr>
              <td>Marketplace scanning, product Database, backups</td>
              <td>Included</td>
              <td>Included</td>
            </tr>
            <tr>
              <td>Free trial</td>
              <td>-</td>
              <td>{plans.trialDays > 0 ? `${plans.trialDays} days, once per account` : "Not offered"}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 56 }}>Changing or cancelling</h2>
      <div className="stack" style={{ maxWidth: 800 }}>
        <Faq q="How do I upgrade or downgrade?">
          <p>Sign in and open <Link to="/account/billing">Account &rarr; Subscription</Link>. You can switch between monthly and annual billing there; the payment provider prorates the difference. Moving from Pro to Free is done by cancelling (below).</p>
        </Faq>
        <Faq q="How does the free trial work?">
          <p>New subscribers can start with a free trial. You are not charged until it ends, and you can cancel before then without paying. A trial is offered once per account.</p>
        </Faq>
        <Faq q="How do I cancel?">
          <p>Cancel from <Link to="/account/billing">Account &rarr; Subscription</Link> at any time. Pro stays active until the end of the period you already paid for, and then your account returns to Free. You can resume before that date.</p>
        </Faq>
        <Faq q="What happens if a payment fails?">
          <p>You get a grace period to update your payment method and keep Pro. If the payment is still failing when the grace period ends, the account returns to the Free plan. Nothing is deleted.</p>
        </Faq>
        <Faq q="Refunds?">
          <p>See the <Link to="/legal/refunds">refund policy</Link> (a draft until approved).</p>
        </Faq>
      </div>
    </div>
  );
}
