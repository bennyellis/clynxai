import type { BrowserContext, Page } from "playwright";
import { stealthChromium } from "./stealthBrowser.js";

// Uses your real installed Google Chrome (not Playwright's own bundled
// "Chromium for Testing" build) — you specifically want to be logging into
// things (Facebook, and now eBay too, sharing this same window as a second
// tab) inside actual Chrome rather than a generic automation browser. Falls
// back to the bundled Chromium if Chrome isn't installed, so a missing
// browser degrades gracefully instead of failing outright — with a spoofed
// Chrome user-agent in that fallback case only, since the bundled build
// won't report one truthfully on its own (real Chrome always does, so the
// primary path leaves it alone). Launched via stealthChromium (see
// stealthBrowser.ts) so the common automation fingerprints are patched
// regardless of which channel actually ends up being used.
export async function openPersistentContext(profileDir: string, headless: boolean): Promise<BrowserContext> {
  try {
    const ctx = await stealthChromium.launchPersistentContext(profileDir, {
      headless,
      channel: "chrome",
      viewport: { width: 1280, height: 900 },
    });
    console.log("[browser] Launched via chrome channel.");
    return ctx;
  } catch (err) {
    console.warn(`[browser] chrome channel failed (${(err as Error).message}) — falling back to bundled Chromium.`);
    return stealthChromium.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    });
  }
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  await page.goto("https://www.facebook.com/marketplace/", {
    waitUntil: "domcontentloaded",
  });
  // Same SPA-hydration race as scraper.ts's findSearchMarketplaceBox: an
  // instant page.$() right after domcontentloaded can run before Facebook's
  // React app has mounted EITHER the login form (logged out) or the real
  // Marketplace search UI (logged in) — which used to sometimes read back
  // "logged in" for a session that was actually sitting on a login wall,
  // silently sending every subsequent action (a chat-triggered search
  // included) at that wall instead of a real Marketplace page, with nothing
  // in the Activity log to explain why nothing seemed to happen. Waits for
  // whichever of the two actually shows up first, instead of checking the
  // instant this function is called.
  const loginBox = page.locator('input[name="email"], input[name="pass"]').first();
  const marketplaceUi = page.getByPlaceholder(/search marketplace/i).first();
  await Promise.any([
    loginBox.waitFor({ state: "visible", timeout: 6000 }),
    marketplaceUi.waitFor({ state: "visible", timeout: 6000 }),
  ]).catch(() => {
    // Neither showed up in time (checkpoint, blocked region, slow network) —
    // fall through to the plain instant check below rather than guessing.
  });
  return (await loginBox.count()) === 0;
}

export async function politeDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  await new Promise((resolve) => setTimeout(resolve, ms));
}
