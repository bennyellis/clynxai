// Windows beta: a new install has no phone-alert topic, and then nothing may be sent to the alert server (the deal's details would otherwise go to its root address).
import { sendDealAlert, sendWatchMatchAlert, sendWorthALookAlert } from "../notify.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const scored = { listing: { url: "https://www.facebook.com/marketplace/item/1/", imageUrls: [], thumbnailUrl: null, title: "PS5", price: 260 }, dealTier: "search" } as never;
    const summary = { title: "t", message: "m", stars: 3 } as never;
    const watch = { id: "w", name: "w", ntfyTopic: null } as never;

    section("no topic: nothing is sent");
    for (const topic of ["", "   "]) {
      const cfg = { ntfy: { server: "https://ntfy.sh", topic } } as never;
      await sendDealAlert(cfg, scored, summary);
      await sendWorthALookAlert(cfg, scored, summary);
      await sendWatchMatchAlert(cfg, watch, scored, { discoveryMode: "passive", discountPercentAtMatch: null, profitUsdAtMatch: null }, null, summary).catch(() => {});
    }
    check("no request was made for any kind of alert", calls.length === 0, calls);

    section("a topic: the alert goes to that topic");
    await sendDealAlert({ ntfy: { server: "https://ntfy.sh", topic: "my-own-topic-1234" } } as never, scored, summary);
    check("exactly one request, to the tester's own topic", calls.length === 1 && calls[0] === "https://ntfy.sh/my-own-topic-1234", calls);
  } finally {
    globalThis.fetch = realFetch;
  }
});
