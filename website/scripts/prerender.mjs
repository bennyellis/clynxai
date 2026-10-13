// After the build: writes one HTML file per public page with that page's own <title>, description and link-preview tags, so search engines and social previews see the right text
// without running JavaScript. The page content itself is still drawn by the app; this only sets the head. The server serves dist/<route>/index.html when it exists.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const shell = readFileSync(join(dist, "index.html"), "utf8");

const PAGES = {
  "features": ["Features - Clynx", "Marketplace scanning, product identification, estimated resale values, profit calculation, a product Database, Watch alerts and deal discovery - how each part of Clynx works and what its limits are."],
  "pricing": ["Pricing - Clynx", "Clynx plans: a free plan and Clynx Pro with higher limits. Monthly and annual billing, a free trial, and cancel any time. Prices are not final."],
  "download": ["Download Clynx for Windows", "Download the Clynx Windows beta: latest version, SHA-256 checksum, system requirements, installation steps, release notes and known issues."],
  "support": ["Support - Clynx", "Answers to common questions, troubleshooting for installing Clynx and for the scanner, account and billing help, and a form to report a bug or contact support."],
  "legal/privacy": ["Privacy Policy (draft) - Clynx", "Draft privacy policy for Clynx. Not yet reviewed by a lawyer."],
  "legal/terms": ["Terms of Service (draft) - Clynx", "Draft terms of service for Clynx. Not yet reviewed by a lawyer."],
  "legal/subscription": ["Subscription and Cancellation Terms (draft) - Clynx", "Draft subscription and cancellation terms for Clynx. Not yet reviewed by a lawyer."],
  "legal/refunds": ["Refund Policy (draft) - Clynx", "Draft refund policy for Clynx. Not yet decided."],
  "legal/cookies": ["Cookie Policy (draft) - Clynx", "Draft cookie policy for Clynx: one essential sign-in cookie, no advertising or analytics cookies."],
  "login": ["Sign in - Clynx", "Sign in to your Clynx account."],
  "signup": ["Create an account - Clynx", "Create a Clynx account to manage your subscription, devices and downloads."],
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
for (const [route, [title, description]] of Object.entries(PAGES)) {
  const html = shell
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(description)}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(description)}$2`);
  mkdirSync(join(dist, route), { recursive: true });
  writeFileSync(join(dist, route, "index.html"), html);
}
console.log(`prerendered ${Object.keys(PAGES).length} page heads`);
