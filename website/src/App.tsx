import { lazy, Suspense } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { RequireAdmin, RequireAuth, RequireOwner, SiteLayout } from "./components/Layout";
import { Loading, usePageMeta } from "./components/ui";
import Download from "./pages/Download";
import Features from "./pages/Features";
import Home from "./pages/Home";
import Pricing from "./pages/Pricing";
import Support from "./pages/Support";
import { AccountLayout, BillingPage, DevicesPage, Overview, ProfilePage } from "./pages/account/Account";
import { ConfirmEmailChange, ForgotPassword, Login, ResetPassword, Signup, VerifyEmail } from "./pages/auth/Auth";
import Legal from "./pages/legal/Legal";

// The administration console is a separate chunk: ordinary visitors never download it.
const Console = lazy(() => import("./pages/console/Console").then((m) => ({ default: m.ConsoleLayout })));
const ConsoleOverview = lazy(() => import("./pages/console/Console").then((m) => ({ default: m.ConsoleOverview })));
const ConsoleUsers = lazy(() => import("./pages/console/Console").then((m) => ({ default: m.ConsoleUsers })));
const ConsoleBeta = lazy(() => import("./pages/console/Console").then((m) => ({ default: () => <m.ConsoleUsers betaOnly /> })));
const ConsoleUserDetail = lazy(() => import("./pages/console/Console").then((m) => ({ default: m.ConsoleUserDetail })));
const ConsoleInvites = lazy(() => import("./pages/console/Console").then((m) => ({ default: m.ConsoleInvites })));
const ConsoleReleases = lazy(() => import("./pages/console/Console").then((m) => ({ default: m.ConsoleReleases })));
const ConsoleSupport = lazy(() => import("./pages/console/Console").then((m) => ({ default: m.ConsoleSupport })));
const ConsoleHealth = lazy(() => import("./pages/console/Console").then((m) => ({ default: m.ConsoleHealth })));
const ConsoleIntegrations = lazy(() => import("./pages/console/Integrations").then((m) => ({ default: m.ConsoleIntegrations })));
const ConsoleSpending = lazy(() => import("./pages/console/Integrations").then((m) => ({ default: m.ConsoleSpending })));
const ConsoleAudit = lazy(() => import("./pages/console/Console").then((m) => ({ default: m.ConsoleAudit })));

function NotFound() {
  usePageMeta("Page not found");
  return (
    <div className="wrap section">
      <h1>That page does not exist</h1>
      <p className="muted">It may have moved. Try the <Link to="/">home page</Link>, <Link to="/features">features</Link> or <Link to="/support">support</Link>.</p>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<div className="wrap section"><Loading /></div>}>
      <Routes>
        <Route element={<SiteLayout />}>
          <Route index element={<Home />} />
          <Route path="features" element={<Features />} />
          <Route path="pricing" element={<Pricing />} />
          <Route path="download" element={<Download />} />
          <Route path="support" element={<Support />} />
          <Route path="legal/:doc" element={<Legal />} />
          <Route path="login" element={<Login />} />
          <Route path="signup" element={<Signup />} />
          <Route path="forgot-password" element={<ForgotPassword />} />
          <Route path="reset-password" element={<ResetPassword />} />
          <Route path="verify-email" element={<VerifyEmail />} />
          <Route path="confirm-email-change" element={<ConfirmEmailChange />} />
          <Route path="account" element={<RequireAuth><AccountLayout /></RequireAuth>}>
            <Route index element={<Overview />} />
            <Route path="billing" element={<BillingPage />} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="profile" element={<ProfilePage />} />
          </Route>
          <Route path="console" element={<RequireAdmin><Console /></RequireAdmin>}>
            <Route index element={<ConsoleOverview />} />
            <Route path="users" element={<ConsoleUsers />} />
            <Route path="users/:id" element={<ConsoleUserDetail />} />
            <Route path="beta" element={<ConsoleBeta />} />
            <Route path="releases" element={<ConsoleReleases />} />
            <Route path="invites" element={<ConsoleInvites />} />
            <Route path="support" element={<ConsoleSupport />} />
            <Route path="health" element={<ConsoleHealth />} />
            <Route path="integrations" element={<RequireOwner><ConsoleIntegrations /></RequireOwner>} />
            <Route path="spending" element={<ConsoleSpending />} />
            <Route path="audit" element={<ConsoleAudit />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
