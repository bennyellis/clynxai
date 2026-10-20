// D1.6: ordinary product look-ups ask OpenAI first too, on a budget of their own: a repeated question is answered from memory, real searches are spread out and only a couple run at once,
// the hourly limit and Save-credits mode still apply, a failed search is never remembered. A fake search and a virtual clock stand in for the network.
import { openAiWebBackend, OPENAI_SEARCH_UNLIMITED, type SearchAnswer } from "../openaiSearch.js";
import { check, run, section } from "./_testkit.js";

const answer = (n: number): SearchAnswer => ({ answer: `answer ${n}`, citations: [{ url: `https://example.com/${n}`, title: `Page ${n}`, snippet: `snippet ${n}` }] });

run(async () => {
  section("repeats cost nothing");
  let calls = 0;
  let t = 1_000_000;
  const slept: number[] = [];
  const b = openAiWebBackend({ enabled: () => true, lowAi: () => false, perHour: 3, now: () => t, cacheMs: 7 * 24 * 3600_000, minGapMs: 1500, maxConcurrent: 2, sleep: async (ms) => void (slept.push(ms), (t += ms)), search: async () => answer(++calls) });
  const a1 = await b.run!("Xbox Series X Galaxy Edition", 5);
  const a2 = await b.run!("  xbox series x  galaxy edition ", 5);
  check("the same question (any case or spacing) is answered from memory", calls === 1 && a1[0].url === a2[0].url, { calls });
  check("and it does not use up the hourly limit", b.skip!() === null);
  const a3 = await b.run!("Xbox Series X Galaxy Edition", 3);
  check("a different result size is a different question", calls === 2 && a3.length === 1, { calls });

  section("a burst is spread out");
  slept.length = 0;
  await b.run!("question two", 5);
  check("a second real search waits for the minimum gap", slept.length === 1 && slept[0] > 0 && slept[0] <= 1500, slept);

  section("the hourly limit and Save-credits mode still apply");
  check("three real searches used the limit of 3", /hourly limit of 3/.test(b.skip!() ?? ""), b.skip!());
  t += 3601_000;
  check("it renews after an hour", b.skip!() === null);
  const cachedAfter = await b.run!("Xbox Series X Galaxy Edition", 5);
  check("a week-old-or-newer answer is still remembered after the hour", cachedAfter.length === 1 && calls === 3, { calls });
  let low = true;
  const lowB = openAiWebBackend({ enabled: () => true, lowAi: () => low, perHour: 5, search: async () => answer(1) });
  check("Save-credits mode declines", /Save OpenAI credits/.test(lowB.skip!() ?? ""));
  low = false;
  check("and allows again when off", lowB.skip!() === null);

  section("a failed search is never remembered, and two at once share one call");
  let fail = true;
  let n = 0;
  const f = openAiWebBackend({ enabled: () => true, lowAi: () => false, perHour: 10, cacheMs: 1e9, search: async () => (n++, fail ? Promise.reject(new Error("boom")) : answer(n)) });
  let threw = false;
  try {
    await f.run!("flaky question", 5);
  } catch {
    threw = true;
  }
  fail = false;
  const ok = await f.run!("flaky question", 5);
  check("the failure threw, and the retry searched again instead of repeating the failure", threw && ok.length === 1 && n === 2, { n, threw });
  let gate!: () => void;
  const hold = new Promise<void>((r) => (gate = r));
  let shared = 0;
  const s = openAiWebBackend({ enabled: () => true, lowAi: () => false, perHour: 10, search: async () => (shared++, await hold, answer(1)) });
  const p1 = s.run!("same question", 5);
  const p2 = s.run!("same question", 5);
  gate();
  await Promise.all([p1, p2]);
  check("two identical questions at the same time make ONE search", shared === 1, { shared });

  section("at most N searches run at once");
  let active = 0;
  let peak = 0;
  const c = openAiWebBackend({ enabled: () => true, lowAi: () => false, perHour: 50, maxConcurrent: 2, search: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active--; return answer(1); } });
  await Promise.all(["q1", "q2", "q3", "q4", "q5"].map((q) => c.run!(q, 5)));
  check("never more than two in flight", peak === 2, { peak });

  section("no hourly limit by default (the owner asked for none); spacing and the cache still apply");
  let tu = 5_000_000;
  const gaps: number[] = [];
  let made = 0;
  const u = openAiWebBackend({ enabled: () => true, lowAi: () => false, perHour: OPENAI_SEARCH_UNLIMITED, now: () => tu, cacheMs: 7 * 24 * 3600_000, minGapMs: 1500, maxConcurrent: 2, sleep: async (ms) => void (gaps.push(ms), (tu += ms)), search: async () => answer(++made) });
  for (let i = 0; i < 60; i++) await u.run!(`distinct question ${i}`, 5);
  check("60 different searches inside one hour are not refused", made === 60 && u.skip!() === null, { made, skip: u.skip!() });
  await u.run!("distinct question 3", 5);
  check("a repeat is still answered from memory", made === 60);
  check("a number in config.json still sets a limit (openaiSearchPerHour: 2)", (() => { const l = openAiWebBackend({ enabled: () => true, lowAi: () => false, perHour: 2, search: async () => answer(1) }); return l.skip!() === null; })());
});
