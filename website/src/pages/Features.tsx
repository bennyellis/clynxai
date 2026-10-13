import { Link } from "react-router-dom";
import { Icon, Notice, Reveal, usePageMeta } from "../components/ui";

const SECTIONS: Array<{ id: string; icon: string; title: string; intro: string; points: string[] }> = [
  {
    id: "scanning",
    icon: "scan",
    title: "Marketplace scanning",
    intro: "Clynx reads Facebook Marketplace through a real browser on your own computer, signed in with your own account, and collects the listings that match the places and searches you choose.",
    points: [
      "Uses Google Chrome or Microsoft Edge that is already on your PC; Clynx does not ship its own browser",
      "You choose the area (a city, a state or wider) and the searches or categories to browse",
      "Paces itself with pauses between pages rather than hammering the site",
      "Tells you in plain words when Facebook logs you out, shows a security check, or the connection drops, instead of failing silently",
      "Facebook offers no public listing feed for this and its terms restrict automated access. You use Clynx at your own risk, and it never tries to get around a Facebook check",
    ],
  },
  {
    id: "identification",
    icon: "tag",
    title: "Universal product identification",
    intro: "A listing title like \"PS5 slim w/ 2 games\" has to become a specific product before it can be valued. Clynx matches listings against a Database of products and their variants.",
    points: [
      "Tells similar products apart: a console versus a game for it, one model versus the next",
      "Breaks a bundle into its parts and values each, leaving out items that are hard to sell",
      "Recognises broken and for-parts listings and treats them as a separate variant",
      "Optional matching safeguards that can withhold a price when a match is clearly wrong; off until you turn them on",
      "Works best with your own OpenAI key, which lets Clynx research products it has not seen. Without a key it still matches products already in your Database",
    ],
  },
  {
    id: "values",
    icon: "chart",
    title: "Estimated resale values",
    intro: "Each product's value comes from what similar items have actually sold for, not from asking prices.",
    points: [
      "Uses sold-price data you provide access to (for example eBay developer keys) and what is already in your Database",
      "Shows the sample size, so an estimate based on three sales looks different from one based on thirty",
      "Filters out look-alikes (accessories, different capacities, parts-only) before averaging",
      "Always an estimate: markets move and your sale may differ",
    ],
  },
  {
    id: "profit",
    icon: "calc",
    title: "Profit calculations",
    intro: "A low price is only interesting if there is something left after the costs of selling.",
    points: [
      "Subtracts selling fees from the estimated sale price using your own fee percentage",
      "Compares the result with the asking price and your minimum profit rule",
      "Explains the arithmetic in the deal's reasoning, so you can check it",
      "Assumptions (fees, shipping) are settings you can change",
    ],
  },
  {
    id: "database",
    icon: "db",
    title: "Database management",
    intro: "The Database is the memory behind everything else, and it belongs to you.",
    points: [
      "Starts empty on a new computer; grows as you add products or let Clynx research them",
      "Edit names, notes, photos and values; merge duplicates; review suggested corrections one at a time",
      "Automatic verified backups (about once a day) and one-click restore that keeps the data you are replacing",
      "Stored on your PC; if you later sign in to a Clynx account, syncing is something you choose",
    ],
  },
  {
    id: "watches",
    icon: "bell",
    title: "Watch alerts",
    intro: "A Watch is a standing request: look for this, within these limits, and tell me.",
    points: [
      "Limits for price, profit, discount, listing age and seller rating",
      "Windows desktop notifications while Clynx is running",
      "Optional phone alerts through the free ntfy app, using a private topic only you know",
      "Pause, edit or delete a Watch at any time; each Watch lists what it has matched",
    ],
  },
  {
    id: "discovery",
    icon: "star",
    title: "Deal discovery",
    intro: "Not every cheap listing is a deal. Clynx sorts what it finds.",
    points: [
      "Star ratings with a one-line reason: solid deal, worth a look, or skipped",
      "A \"hidden gems\" check for listings that include extra valuable items the title does not mention",
      "Learns from your thumbs-up and thumbs-down on listings",
      "A discovery feed shows what Clynx is looking at and thinking about as it works",
    ],
  },
  {
    id: "performance",
    icon: "bolt",
    title: "Performance and automation",
    intro: "Clynx is built to run in the background without making your PC feel slow.",
    points: [
      "Performance modes (Auto, Visual, Balanced, Performance) that change only how the app looks, never what it finds",
      "Runs on a schedule, recovers by itself from a closed browser or a dropped connection, and restarts cleanly",
      "A built-in save-credits mode keeps AI use to the essentials",
      "A support report you can save and send, with secrets removed, when something is wrong",
    ],
  },
];

export default function Features() {
  usePageMeta("Features", "Marketplace scanning, product identification, estimated resale values, profit calculation, a product Database, Watch alerts and deal discovery - how each part of Clynx works and what its limits are.");
  return (
    <div className="wrap section">
      <span className="eyebrow">Features</span>
      <h1 style={{ fontSize: "clamp(2rem,4.5vw,3rem)" }}>What Clynx does, and what it does not</h1>
      <p className="lead">Each part below describes how it really works today in the Windows beta, including its limits.</p>

      <div className="grid c2" style={{ marginTop: 34 }}>
        {SECTIONS.map((s) => (
          <Reveal key={s.id} className="card" >
            <div id={s.id}>
              <Icon name={s.icon} />
              <h2 style={{ fontSize: "1.45rem" }}>{s.title}</h2>
              <p className="muted">{s.intro}</p>
              <ul className="checks">
                {s.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          </Reveal>
        ))}
      </div>

      <section style={{ marginTop: 48 }}>
        <Notice kind="warn">
          <strong>What Clynx does not do.</strong> It does not buy anything, message sellers, or list items for you. It does not guarantee that a flagged listing is a real deal or that you will make a profit. It cannot promise that Facebook will keep allowing automated
          browsing. It is independent software and is not affiliated with Facebook, Meta, eBay, OpenAI or Stripe.
        </Notice>
        <div className="row" style={{ marginTop: 22 }}>
          <Link to="/download" className="btn primary">
            Get the Windows beta
          </Link>
          <Link to="/pricing" className="btn ghost">
            Plans and limits
          </Link>
        </div>
      </section>
    </div>
  );
}
