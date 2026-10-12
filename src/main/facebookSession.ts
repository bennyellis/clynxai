// Recognising an expired or interrupted Facebook session from the page the scanner is looking at. Facebook does not announce it: the
// session simply stops working and the next page shows a login form, a "confirm it's you" check, or nothing useful at all.
// The decision is a pure function of a snapshot (url, title, whether a password box is on the page, the start of its text), so it can be
// tested without a browser; readPageSnapshot() takes the snapshot from a live page WITHOUT navigating anywhere.
import type { Page } from "playwright";

export type SessionProblem = "logged-out" | "checkpoint";

export interface PageSnapshot {
  url: string;
  title: string;
  // A password field is on the page (a logged-in Marketplace page never has one).
  hasLoginForm: boolean;
  bodyText: string;
}

const CHECKPOINT_URL = /facebook\.com\/(checkpoint|two_step_verification|confirmemail|login\/identify|recover\/code|security\/)/i;
const LOGIN_URL = /facebook\.com\/(login(\.php|\/|\?|$)|recover\/initiate)|[?&]next=.*login/i;
const CHECKPOINT_TEXT =
  /confirm your identity|security check|enter the (login )?code|we (?:suspended|disabled|locked)|your account (?:has been|is) (?:temporarily )?(?:locked|disabled|suspended)|verify (?:that )?it'?s you|help us confirm/i;
const LOGIN_TITLE = /^(?:log in|log into facebook|facebook\s*[-–—]\s*log in|log in to facebook)/i;

/** What is wrong with the session this page shows, or null when nothing is (or it cannot be told). */
export function classifyFacebookPage(s: PageSnapshot): SessionProblem | null {
  // Not a Facebook page at all (about:blank, a download, an error page): nothing can be concluded.
  if (!/facebook\.com/i.test(s.url)) return null;
  if (CHECKPOINT_URL.test(s.url)) return "checkpoint";
  // Words on the page only count away from Marketplace itself, where a listing's own title or description could say anything.
  const onMarketplace = /facebook\.com\/marketplace/i.test(s.url);
  if (!onMarketplace && (CHECKPOINT_TEXT.test(s.title) || (!s.hasLoginForm && CHECKPOINT_TEXT.test(s.bodyText.slice(0, 400))))) return "checkpoint";
  if (LOGIN_URL.test(s.url)) return "logged-out";
  // A password box is never on a logged-in Marketplace page; it is how Facebook shows the login wall over a page.
  if (s.hasLoginForm) return "logged-out";
  if (LOGIN_TITLE.test(s.title.trim())) return "logged-out";
  return null;
}

/** True when the snapshot is positively a normal logged-in Facebook page (not merely "no problem found"). */
export function looksLikeHealthyFacebookPage(s: PageSnapshot): boolean {
  return /facebook\.com/i.test(s.url) && classifyFacebookPage(s) === null && !s.hasLoginForm && s.bodyText.trim().length > 0;
}

/** The words shown to the user. `label` is the Facebook account's name in Clynx. */
export function describeSessionProblem(problem: SessionProblem, label: string): { title: string; message: string; short: string } {
  if (problem === "checkpoint") {
    return {
      title: `Facebook wants to verify ${label}`,
      message:
        "Facebook is asking for a security check (a code, a captcha or a \"confirm it's you\" step), so scanning on this account is paused. Click “Open Facebook” and finish the check in that window; scanning resumes by itself.",
      short: `Facebook is asking ${label} for a security check — open Facebook and complete it.`,
    };
  }
  return {
    title: `Facebook logged ${label} out`,
    message:
      "Your Facebook session expired, so scanning on this account is paused and no new listings will arrive until you log in again. Click “Open Facebook”, log in there, and scanning resumes by itself.",
    short: `Facebook logged ${label} out — open Facebook and log in again.`,
  };
}

/** Takes a snapshot of the page the browser is showing right now. Never navigates, never throws (null = could not tell). */
export async function readPageSnapshot(page: Page): Promise<PageSnapshot | null> {
  try {
    if (page.isClosed()) return null;
    const url = page.url();
    const data = await page.evaluate(() => ({
      title: document.title ?? "",
      hasLoginForm: !!document.querySelector('input[name="pass"], input[type="password"]'),
      bodyText: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    }));
    return { url, ...data };
  } catch {
    return null;
  }
}
