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
// Configured exactly once here — every other file should import
// `stealthChromium` from this module rather than importing `chromium`
// directly from "playwright" and calling `.use()` again themselves, since
// playwright-extra's chromium export is a process-wide singleton and
// re-registering the plugin would be redundant at best.
import { chromium as stealthChromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

stealthChromium.use(StealthPlugin());

export { stealthChromium };
