import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Loading, SITE } from "./ui";

export function Header() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <header className="site-header">
      <div className="wrap">
        <Link to="/" className="brand" aria-label="Clynx home">
          <img src="/clynx-mark.png" alt="" width={34} height={34} />
          Clynx
        </Link>
        <button className="btn small ghost menu-btn" aria-expanded={open} aria-controls="main-nav" onClick={() => setOpen(!open)}>
          Menu
        </button>
        <nav id="main-nav" className={`nav ${open ? "open" : ""}`} aria-label="Main">
          <NavLink to="/features">Features</NavLink>
          <NavLink to="/pricing">Pricing</NavLink>
          <NavLink to="/download">Download</NavLink>
          <NavLink to="/support">Support</NavLink>
          {user === undefined ? null : user ? (
            <>
              {(user.role === "admin" || user.role === "owner") && <NavLink to="/console">Console</NavLink>}
              <NavLink to="/account">Account</NavLink>
              <button className="link" onClick={() => void logout()}>
                Sign out
              </button>
            </>
          ) : (
            <>
              <NavLink to="/login">Sign in</NavLink>
              <Link to="/signup" className="btn primary small">
                Join the beta
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="footer-grid">
          <div>
            <Link to="/" className="brand">
              <img src="/clynx-mark.png" alt="" width={30} height={30} />
              Clynx
            </Link>
            <p className="muted" style={{ marginTop: 12, maxWidth: "34ch" }}>
              Finds underpriced Marketplace listings and tells you what they might resell for. Runs on your own computer.
            </p>
          </div>
          <div>
            <h4>Product</h4>
            <Link to="/features">Features</Link>
            <Link to="/pricing">Pricing</Link>
            <Link to="/download">Download</Link>
          </div>
          <div>
            <h4>Help</h4>
            <Link to="/support">Support and FAQ</Link>
            <Link to="/support#report">Report a bug</Link>
            <Link to="/login">Sign in</Link>
          </div>
          <div>
            <h4>Legal (drafts)</h4>
            <Link to="/legal/privacy">Privacy</Link>
            <Link to="/legal/terms">Terms</Link>
            <Link to="/legal/subscription">Subscriptions</Link>
            <Link to="/legal/refunds">Refunds</Link>
            <Link to="/legal/cookies">Cookies</Link>
          </div>
        </div>
        <p className="legal-note">
          {SITE.name} is independent software. It is not affiliated with, endorsed by or sponsored by Meta, Facebook, eBay, OpenAI or Stripe; those names belong to their owners. Resale values are estimates, not promises
          of profit. The legal pages are drafts that have not been reviewed by a lawyer.
        </p>
      </div>
    </footer>
  );
}

export function SiteLayout() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      <Footer />
    </>
  );
}

/** Only for signed-in visitors. Everything it protects is protected again by the server; this only decides what the page shows. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const loc = useLocation();
  if (user === undefined) return <div className="wrap section"><Loading what="Checking your session" /></div>;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user === undefined) return <div className="wrap section"><Loading what="Checking your session" /></div>;
  if (!user) return <Navigate to="/login" state={{ from: "/console" }} replace />;
  if (user.role !== "admin" && user.role !== "owner") return <Navigate to="/account" replace />;
  return <>{children}</>;
}

/** Owner-only pages. The server refuses everyone else anyway. */
export function RequireOwner({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user === undefined) return <div className="wrap section"><Loading what="Checking your session" /></div>;
  if (!user || user.role !== "owner") return <Navigate to="/console" replace />;
  return <>{children}</>;
}
