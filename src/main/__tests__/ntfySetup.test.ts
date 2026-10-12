// Phase 2, item 3: phone-alert setup. A high-entropy private topic, an honest strength check, and a test notification that reports plainly
// whether it went out. Existing topics are never touched here.
import { generateNtfyTopic, explainNtfyFailure } from "../ntfySetup.js";
import { describeTopicStrength, subscribeAddress, topicStrengthMessage } from "../ntfyTopic.js";
import { sendTestNotification } from "../notify.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  section("generated topics are long, random, and valid");
  {
    const topics = Array.from({ length: 2000 }, () => generateNtfyTopic());
    check("shape: clynx- plus 26 lowercase letters/digits (well under ntfy's 64 limit)", topics.every((t) => /^clynx-[a-z0-9]{26}$/.test(t)), topics[0]);
    check("2,000 topics, all different", new Set(topics).size === 2000);
    check("every generated topic passes the strength check as private", topics.every((t) => describeTopicStrength(t) === "private"));
    const counts = new Map<string, number>();
    for (const t of topics) for (const ch of t.slice(6)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const total = 2000 * 26, expected = total / 36;
    const worst = Math.max(...[...counts.values()].map((c) => Math.abs(c - expected) / expected));
    check("all 36 characters appear, evenly (no character off by more than 10% of its expected count)", counts.size === 36 && worst < 0.1, { distinct: counts.size, worst });
    // Rejection sampling: bytes 252-255 would favour the first 4 letters if used. A source that only emits such bytes must still terminate.
    let calls = 0;
    const biased = (n: number) => (calls++ < 3 ? Buffer.alloc(n, 255) : Buffer.alloc(n, 7));
    const t = generateNtfyTopic(biased);
    check("bytes that would bias the alphabet are skipped (255s ignored, then 7 -> 'h' x26)", t === "clynx-" + "h".repeat(26), t);
    check("about 134 bits of entropy: 36^26 > 2^134", Math.log2(36) * 26 > 134);
  }

  section("strength check: honest, based on the name only");
  {
    check("empty", describeTopicStrength("") === "empty" && describeTopicStrength("   ") === "empty");
    check("the common easy topics are guessable (including 'clynxai')", ["clynxai", "clynx", "alerts", "deals", "test", "mytopic", "clynx-alerts", "deals2024"].every((t) => describeTopicStrength(t) === "guessable"));
    check("short names are guessable", describeTopicStrength("sam-xbox") === "guessable");
    check("long but repetitive is guessable", describeTopicStrength("abababababababababababab") === "guessable");
    check("characters ntfy does not allow are invalid", ["a/b", "has space", "a?b", "../x", "emoji😀", "a".repeat(65)].every((t) => describeTopicStrength(t) === "invalid"));
    check("a user's own long random topic is accepted as private", describeTopicStrength("k3x9q2m7v1z8w4n6p0r5t2y7") === "private");
    check("messages: private has none, guessable explains the risk, invalid explains the rule", topicStrengthMessage("private") === null && /guess/i.test(topicStrengthMessage("guessable")!) && /letters, numbers/.test(topicStrengthMessage("invalid")!));
    check("the address shown to the phone drops the scheme and slashes", subscribeAddress("https://ntfy.sh/", " clynx-abc ") === "ntfy.sh/clynx-abc");
  }

  section("Send test notification");
  {
    const real = globalThis.fetch;
    const sent: Array<{ url: string; method?: string; headers: Record<string, string> }> = [];
    const stub = (impl: (url: string) => Response | Promise<Response>) => {
      sent.length = 0;
      globalThis.fetch = (async (url: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
        sent.push({ url: String(url), method: init?.method, headers: init?.headers ?? {} });
        return impl(String(url));
      }) as typeof fetch;
    };
    try {
      stub(() => new Response("ok", { status: 200 }));
      const ok = await sendTestNotification({ ntfy: { server: "https://ntfy.sh", topic: "clynx-abcdefghijklmnopqrstuvwxyz" } });
      check("success: says it was sent and what to check if nothing arrives", ok.ok && /sent/i.test(ok.message) && /subscribed to exactly this topic/.test(ok.message), ok);
      check("it posts exactly once, to server/topic, labelled as a test, with no deal data", sent.length === 1 && sent[0].url === "https://ntfy.sh/clynx-abcdefghijklmnopqrstuvwxyz" && sent[0].method === "POST" && /Clynx test notification/.test(sent[0].headers.Title) && !("Click" in sent[0].headers), sent);
      check("the server's trailing slash is handled", (stub(() => new Response("ok")), (await sendTestNotification({ ntfy: { server: "https://ntfy.sh/", topic: "abc" } })).ok && sent[0].url === "https://ntfy.sh/abc"));

      stub(() => new Response("ok"));
      const noTopic = await sendTestNotification({ ntfy: { server: "https://ntfy.sh", topic: "  " } });
      check("no topic: nothing is sent, and it says what to do", !noTopic.ok && sent.length === 0 && /Generate private topic/.test(noTopic.message), noTopic);
      const badTopic = await sendTestNotification({ ntfy: { server: "https://ntfy.sh", topic: "a/b?x=1" } });
      check("a topic that could change the request address is refused before anything is sent", !badTopic.ok && sent.length === 0, badTopic);
      for (const server of ["", "javascript:alert(1)", "ftp://ntfy.sh", "https://", "ntfy.sh", "https://evil.com/path?x"]) {
        const r = await sendTestNotification({ ntfy: { server, topic: "abc" } });
        check(`bad server "${server}" is refused with an example, nothing sent`, !r.ok && /https:\/\/ntfy\.sh/.test(r.message) && sent.length === 0, r);
      }
      check("a server on a local address with a port is accepted (self-hosted ntfy)", (stub(() => new Response("ok")), (await sendTestNotification({ ntfy: { server: "http://192.168.1.20:8080", topic: "abc" } })).ok));

      stub(() => new Response("rate limited", { status: 429 }));
      const limited = await sendTestNotification({ ntfy: { server: "https://ntfy.sh", topic: "abc" } });
      check("429: 'too many messages, wait a minute'", !limited.ok && /too many/i.test(limited.message), limited);
      stub(() => new Response("forbidden", { status: 403 }));
      check("403: topic refused, try a different one", /different topic/i.test((await sendTestNotification({ ntfy: { server: "https://ntfy.sh", topic: "abc" } })).message));
      stub(() => new Response("nope", { status: 500 }));
      check("500: server error with the status, try later", /500/.test((await sendTestNotification({ ntfy: { server: "https://ntfy.sh", topic: "abc" } })).message));
      stub(() => { throw new TypeError("fetch failed"); });
      const offline = await sendTestNotification({ ntfy: { server: "https://ntfy.sh", topic: "abc" } });
      check("no connection: 'couldn't reach the notification server', no raw error text", !offline.ok && /couldn't reach/i.test(offline.message) && !/TypeError|fetch failed/.test(offline.message), offline);
      stub(() => { throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" }); });
      check("timeout: says the server didn't answer in time", /in time/.test((await sendTestNotification({ ntfy: { server: "https://ntfy.sh", topic: "abc" } })).message));
      check("explainNtfyFailure never leaks a stack or the topic", !/at .*\(|clynx-/.test(explainNtfyFailure("ntfy push failed: 404 not found at x (y.js:1:1)")));
    } finally {
      globalThis.fetch = real;
    }
  }
});
