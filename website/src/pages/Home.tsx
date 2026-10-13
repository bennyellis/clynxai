import { Link } from "react-router-dom";
import { Icon, Notice, Reveal, Shot, usePageMeta } from "../components/ui";

export default function Home() {
  usePageMeta("Clynx - spot underpriced Marketplace listings", "Clynx scans Facebook Marketplace on your own computer, works out what each listing is, estimates what it could resell for, and alerts you when the numbers look worth a look. Windows beta.");
  return (
    <>
      <section className="hero">
        <div className="wrap hero-grid">
          <div>
            <span className="badge">
              <i /> Windows beta - invitation-friendly, free to try
            </span>
            <h1>
              Spot underpriced listings.
              <br />
              <span className="grad-text">Know what they could resell for.</span>
            </h1>
            <p className="lead">
              Clynx scans Facebook Marketplace on your own computer, works out what each listing actually is, estimates its resale value, and tells you when the numbers look worth a closer look.
            </p>
            <div className="row">
              <Link to="/download" className="btn primary">
                Get the Windows beta
              </Link>
              <a href="#how" className="btn ghost">
                See how it works
              </a>
            </div>
            <p className="fine">Needs Windows 10 or 11 and Google Chrome or Microsoft Edge. Estimates are guides, not guarantees.</p>
          </div>
          <div className="float">
            <Shot src="/screens/dashboard.png" alt="The Clynx dashboard showing the scanner running, recent deals and the setup checklist" title="Clynx - Dashboard" width={1280} height={860} priority caption="Real application, sample data." />
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <div className="wrap">
          <Reveal>
            <span className="eyebrow">How it works</span>
            <h2>From a crowded feed to a short list worth your time</h2>
          </Reveal>
          <div className="grid c4" style={{ marginTop: 28 }}>
            {[
              ["Scan", "Clynx browses Marketplace the way you would, in your own Chrome or Edge, signed in as you. It paces itself and you choose where it looks."],
              ["Identify", "Each listing is matched to a product in your Database, including the exact model, so a game is not mistaken for its console."],
              ["Value", "It compares the asking price with what that product has sold for, then subtracts fees to show the profit you could expect."],
              ["Alert", "When a listing clears your rules, you get a notification on your PC and, if you like, on your phone."],
            ].map(([t, d], i) => (
              <Reveal key={t} className="card hover">
                <div className="step-n">{i + 1}</div>
                <h3>{t}</h3>
                <p className="muted">{d}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section tight">
        <div className="wrap">
          <Reveal>
            <span className="eyebrow">What you get</span>
            <h2>The tools a reseller actually checks</h2>
          </Reveal>
          <div className="grid c3" style={{ marginTop: 28 }}>
            {[
              ["scan", "Marketplace scanning", "Browses your chosen areas and searches in your own browser session. Your Facebook login never leaves your computer."],
              ["tag", "Product identification", "Recognises the specific product and variant in a listing, handles bundles of several items, and flags broken or for-parts listings."],
              ["chart", "Estimated resale values", "Uses sold-price data and your own Database. Every estimate shows how it was reached and how much data stands behind it."],
              ["calc", "Profit calculation", "Subtracts selling fees from the estimated sale price and compares it with the asking price against your minimum-profit rule."],
              ["db", "Your product Database", "Products, photos, notes and values in one place you can edit. Automatic backups and one-click restore keep it safe."],
              ["bell", "Watches and alerts", "Tell Clynx exactly what to look out for, with price, profit and age limits. Get notified on Windows and on your phone."],
            ].map(([ic, t, d]) => (
              <Reveal key={t} className="card hover">
                <Icon name={ic} />
                <h3>{t}</h3>
                <p className="muted">{d}</p>
              </Reveal>
            ))}
          </div>
          <p style={{ marginTop: 22 }}>
            <Link to="/features">Read about every feature &rarr;</Link>
          </p>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <Reveal className="feature-row">
            <div className="feature-text">
              <span className="eyebrow">Deal discovery</span>
              <h2>Every deal comes with its reasons</h2>
              <p className="lead">A star rating, the product Clynx thinks it is, what it usually sells for, and the profit after fees. You see why a listing was flagged, so you can agree or disagree in seconds.</p>
              <ul className="checks">
                <li>Marks listings as a deal, worth a look, or skipped, with the reason</li>
                <li>Shows the Database product it matched and how sure it is</li>
                <li>Learns from the listings you mark as interesting or not</li>
              </ul>
            </div>
            <Shot src="/screens/feed.png" alt="The Clynx Feed with listings, prices, star ratings and estimated profit" title="Clynx - Feed" width={1280} height={860} caption="Real application, sample data." />
          </Reveal>
          <Reveal className="feature-row rev">
            <div className="feature-text">
              <span className="eyebrow">Your Database</span>
              <h2>A product library that is yours</h2>
              <p className="lead">Clynx builds a Database of the products you care about, with photos, notes and sold-price values. Edit anything, review suggested corrections, and restore a backup if something goes wrong.</p>
              <ul className="checks">
                <li>Starts empty on every computer; nothing is shared unless you sign in</li>
                <li>Daily safety backups, kept on your PC</li>
                <li>Matching safeguards you can leave off until you trust them</li>
              </ul>
            </div>
            <Shot src="/screens/database.png" alt="The Clynx product Database with product photos and values" title="Clynx - Database" width={1280} height={860} caption="Real application, sample data." />
          </Reveal>
          <Reveal className="feature-row">
            <div className="feature-text">
              <span className="eyebrow">Watches</span>
              <h2>Tell it what to wait for</h2>
              <p className="lead">Set up a Watch for a specific item and your limits. When a matching listing appears, Clynx notifies you on your PC and, optionally, your phone.</p>
              <ul className="checks">
                <li>Price, profit, discount and listing-age limits</li>
                <li>Windows notifications, plus phone alerts through the free ntfy app</li>
                <li>Pause or remove a Watch at any time</li>
              </ul>
            </div>
            <Shot src="/screens/watch.png" alt="The Clynx Watch screen listing watches with their limits" title="Clynx - Watch" width={1280} height={860} caption="Real application, sample data." />
          </Reveal>
        </div>
      </section>

      <section className="section tight">
        <div className="wrap">
          <div className="grid c2">
            <Reveal className="card">
              <Icon name="lock" />
              <h3>Private by design</h3>
              <p className="muted">Scanning, your Database and your Facebook login all stay on your computer. You can use the beta with no account. If you add your own OpenAI key, listing text is sent to OpenAI to be judged; Clynx tells you exactly what leaves your PC.</p>
            </Reveal>
            <Reveal className="card">
              <Icon name="shield" />
              <h3>Honest about its limits</h3>
              <p className="muted">Values are estimates built from past sales and can be wrong. Facebook can change its pages or restrict accounts that use automation. Clynx does not buy, message sellers or promise earnings.</p>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <Reveal>
            <Notice>
              <h2 style={{ marginTop: 0 }}>Try the Windows beta</h2>
              <p className="muted" style={{ maxWidth: "60ch" }}>The beta runs entirely on your computer with no account and no payment. Add your own OpenAI key if you want Clynx to judge listings. Tell us what works and what does not.</p>
              <div className="row">
                <Link to="/download" className="btn primary">
                  Download the beta
                </Link>
                <Link to="/pricing" className="btn ghost">
                  See plans
                </Link>
              </div>
            </Notice>
          </Reveal>
        </div>
      </section>
    </>
  );
}
