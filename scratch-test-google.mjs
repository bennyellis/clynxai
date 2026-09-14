import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
});
const res = await page.goto("https://www.google.com/search?q=xbox+series+x&udm=2", {
  waitUntil: "domcontentloaded",
  timeout: 20000,
});
console.log("status:", res?.status(), "title:", await page.title());
const text = await page.evaluate(() => document.body.innerText.slice(0, 800));
console.log("body snippet:\n", text);
await browser.close();
