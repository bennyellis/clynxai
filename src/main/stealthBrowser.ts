// A single shared, stealth-patched Chromium launcher for every browser
// context this app opens (Facebook AND eBay) — playwright-extra augments
// Playwright's own chromium launcher with the puppeteer-extra plugin
// ecosystem, and puppeteer-extra-plugin-stealth patches the common
// JS-visible automation fingerprints (navigator.webdriver, missing Chrome
// internals like chrome.runtime, plugin/mimeType arrays, WebGL vendor
// strings, etc.) that bot-detection scripts commonly check for.
//
// No guarantee against a determined, well-resourced detector like Akamai —
// this is a well-known, actively-contested arms race, and Akamai is one of
// the harder vendors to fool this way — but it's free, low-risk (only
// changes what our own automated browser's JS environment reports, touches
// nothing of the user's), and worth having applied everywhere rather than
// nowhere.
//
// Configured exactly once here — every other file should get the launcher
// from getStealthChromium() rather than importing `chromium` directly from
// "playwright" and calling `.use()` again themselves, since playwright-extra's
// chromium export is a process-wide singleton and re-registering the plugin
// would be redundant at best.
//
// Loaded on first use, not at startup: playwright-extra pulls in all of
// Playwright, about 0.35 s of work on the main thread that used to delay the
// window opening, for something that is only needed once a browser is launched.
type StealthChromium = typeof import("playwright-extra").chromium;
let launcher: Promise<StealthChromium> | null = null;

export function getStealthChromium(): Promise<StealthChromium> {
  launcher ??= (async () => {
    const [extra, stealth] = await Promise.all([import("playwright-extra"), import("puppeteer-extra-plugin-stealth")]);
    // (a CommonJS package: its named exports are also on `default`, whichever way Node exposes them)
    const chromium = extra.chromium ?? (extra as unknown as { default: { chromium: StealthChromium } }).default.chromium;
    const StealthPlugin = ((stealth as { default?: unknown }).default ?? stealth) as () => never;
    chromium.use(StealthPlugin());
    return chromium;
  })().catch((err) => {
    launcher = null; // a failed load can be retried by the next launch
    throw err;
  });
  return launcher;
}
