// Stage 1 regression tests: the listing-age parser, the three-state age assessment, the Watch rescue rule, and the Watch
// age window. Reproduces audit defects D1 (parser fails open), D2 (missing age = fresh) and the rule behind D3.
import { assessListingAge, decideAgeGate, effectiveWatchMaxHours, estimateListingAgeHours, isListingTooOld } from "../listingAge.js";
import { evaluateWatchConditions } from "../watchMatching.js";
import { check, run, section } from "./_testkit.js";
import { makeWatch } from "./_fixtures.js";

run(() => {
  section("D1: Facebook phrasings the old parser could not read");
  const cases: Array<[string, number]> = [
    ["a day ago", 24],
    ["a week ago", 168],
    ["a month ago", 720],
    ["about an hour ago", 1],
    ["about 3 hours ago", 3],
    ["an hour ago", 1],
    ["over a year ago", 8760],
    ["almost a week ago", 168],
    ["a few hours ago", 3],
    ["a couple of days ago", 48],
    ["two weeks ago", 336],
    ["Listed a week ago", 168],
  ];
  for (const [text, hours] of cases) check(`"${text}" reads as ${hours}h`, estimateListingAgeHours(text) === hours, estimateListingAgeHours(text));
  check(`the digit forms still read: "5 hours ago" 5h, "1 day ago" 24h, "4 days ago" 96h, "2 months ago" 1440h`,
    estimateListingAgeHours("5 hours ago") === 5 && estimateListingAgeHours("1 day ago") === 24 && estimateListingAgeHours("4 days ago") === 96 && estimateListingAgeHours("2 months ago") === 1440);
  check(`"just now", "today" and "yesterday" still read`, estimateListingAgeHours("just now") === 0 && estimateListingAgeHours("today") === 1 && estimateListingAgeHours("yesterday") === 30);
  check("minutes read as fractions of an hour", Math.abs((estimateListingAgeHours("15 minutes ago") ?? 0) - 0.25) < 1e-9);
  check("nonsense is still not guessed at", estimateListingAgeHours("whenever") === null && estimateListingAgeHours("") === null && estimateListingAgeHours("soon") === null);

  section("D1: those phrases are now stale under the default 24h window");
  for (const text of ["a day ago", "a week ago", "a month ago", "over a year ago", "4 days ago", "2 months ago", "yesterday"]) {
    check(`"${text}" is too old at 24h`, isListingTooOld(text, 24) === true);
  }
  for (const text of ["about an hour ago", "5 hours ago", "just now", "22 hours ago", "a few hours ago"]) {
    check(`"${text}" is still fresh at 24h`, isListingTooOld(text, 24) === false);
  }
  check("with no window configured nothing is too old", isListingTooOld("a month ago", null) === false);

  section("D2: a missing or unreadable age is UNKNOWN, never fresh");
  for (const text of [null, undefined, "", "   ", "sometime", "whenever"]) {
    const a = assessListingAge(text as string | null | undefined, 24);
    check(`${JSON.stringify(text)} -> unknown`, a.state === "unknown" && a.hours === null, a);
  }
  check("a known young age is fresh, a known old one stale", assessListingAge("3 hours ago", 24).state === "fresh" && assessListingAge("a week ago", 24).state === "stale");
  check("unknown stays unknown even with no window (it can never be a verified deal)", assessListingAge(null, null).state === "unknown");
  check("with no window a known age is fresh", assessListingAge("a month ago", null).state === "fresh");
  check("the boundary is stale (24h window, 24h old)", assessListingAge("1 day ago", 24).state === "stale");

  section("D3: which Watches may rescue a stale listing");
  const noWindow = { maxListingAgeMinutes: null };
  const week = { maxListingAgeMinutes: 7 * 24 * 60 };
  const hour = { maxListingAgeMinutes: 60 };
  let g = decideAgeGate("3 weeks ago", 24, [noWindow]);
  check("a Watch with NO age window cannot rescue a stale listing (it used the general window)", g.stale && g.skip && !g.watchOnly, g);
  g = decideAgeGate("4 days ago", 24, [noWindow, week]);
  check("a Watch whose own window covers it can: kept for the Watch only", g.stale && !g.skip && g.watchOnly, g);
  g = decideAgeGate("3 weeks ago", 24, [week]);
  check("but not past that Watch's own window", g.skip && !g.watchOnly, g);
  g = decideAgeGate("a week ago", 24, [hour, week]);
  check("an unparseable-before 'a week ago' is covered by a 7-day window? (168h is not under 168h)", g.skip, g);
  g = decideAgeGate("2 hours ago", 24, [noWindow]);
  check("a fresh listing passes the gate untouched", !g.stale && !g.skip && !g.watchOnly);
  g = decideAgeGate(null, 24, [week]);
  check("an unknown age is not skipped by the gate (it stays visible), and is not stale", !g.stale && !g.skip && g.assessment.state === "unknown");
  check("no watches, stale: skipped", decideAgeGate("5 days ago", 24).skip === true);
  check("the window that applies to a Watch is its own, else the general one", effectiveWatchMaxHours(week, 24) === 168 && effectiveWatchMaxHours(noWindow, 24) === 24 && effectiveWatchMaxHours(noWindow, null) === null);

  section("D3: Watch conditions enforce the age window (reproduces R2 / the 3-months-old Watch alert)");
  const w = makeWatch({ maxListingAgeMinutes: null });
  const old = estimateListingAgeHours("3 months ago");
  check("a no-condition Watch no longer matches a 3-month-old listing when the general window is 24h",
    evaluateWatchConditions(w, 400, 300, old, { netPercent: 84, defaultMaxAgeHours: 24 }).satisfied === false);
  check("it still matches a fresh one", evaluateWatchConditions(w, 250, 300, 2, { netPercent: 84, defaultMaxAgeHours: 24 }).satisfied === true);
  check("with no general window configured, the old behavior stands (any age)", evaluateWatchConditions(w, 250, 300, old, { netPercent: 84, defaultMaxAgeHours: null }).satisfied === true);
  check("an unknown age passes a Watch that has no age condition of its own (delivered as 'age unknown', never as a deal)",
    evaluateWatchConditions(w, 250, 300, null, { netPercent: 84, defaultMaxAgeHours: 24 }).satisfied === true);
  const own = makeWatch({ maxListingAgeMinutes: 120 });
  check("a Watch's own window still wins over the general one", evaluateWatchConditions(own, 250, 300, 3, { netPercent: 84, defaultMaxAgeHours: 24 }).satisfied === false && evaluateWatchConditions(own, 250, 300, 1, { netPercent: 84, defaultMaxAgeHours: 24 }).satisfied === true);
  check("and a Watch with its own window still fails closed on an unknown age", evaluateWatchConditions(own, 250, 300, null, { netPercent: 84, defaultMaxAgeHours: 24 }).satisfied === false);
});
