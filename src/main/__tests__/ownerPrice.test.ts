import { cleanOwnerAnswer, combineWows, compareWithSold, HOW_TO_CHECK_SOLD, ownerValueUsd, pickPricePrompts, soldSearchUrl, type OwnerPrice, type PromptRecord } from "../ownerPrice.js";
import { check, run, section } from "./_testkit.js";

const DAY = 86_400_000;
const mk = (over: Partial<OwnerPrice> = {}): OwnerPrice => ({ productId: "p", lowUsd: 180, highUsd: 220, condition: "used", includes: null, recency: null, buyerTotal: true, setAt: 1_000_000_000_000, replacedAt: null, ...over });
const T0 = 1_000_000_000_000;

run(async () => {
  section("the owner's number as evidence");
  check("deal scoring uses the LOW end of the range", ownerValueUsd(mk(), T0 + DAY) === 180);
  check("it expires after about 90 days", ownerValueUsd(mk(), T0 + 91 * DAY) === null && ownerValueUsd(mk(), T0 + 89 * DAY) === 180);
  check("real sold prices replacing it stop it being used", ownerValueUsd(mk({ replacedAt: T0 + 1 }), T0 + 2) === null);
  check("asking prices that drifted far away make it stale", ownerValueUsd(mk(), T0 + DAY, 400) === null && ownerValueUsd(mk(), T0 + DAY, 90) === null && ownerValueUsd(mk(), T0 + DAY, 230) === 180);
  check("answers are cleaned: one number is a range of one; bad numbers are refused in plain words", (() => { const a = cleanOwnerAnswer({ lowUsd: 200 }); return a.ok && a.highUsd === 200; })() && !cleanOwnerAnswer({ lowUsd: 0 }).ok && !cleanOwnerAnswer({ lowUsd: 300, highUsd: 200 }).ok && !cleanOwnerAnswer({ lowUsd: 5_000_000 }).ok);

  section("the Wow toast");
  const sold = (over = {}) => ({ medianUsd: 245, n: 8, identitySettled: true, likeForLike: true, ...over });
  const p = mk({ lowUsd: 200, highUsd: 200 });
  check("higher: the exact wording", compareWithSold("Xbox Series S", p, sold())?.message === "Wow! The Xbox Series S you thought went for $200 actually goes for $245!");
  check("lower: neutral wording, says the numbers were updated", compareWithSold("Xbox Series S", mk({ lowUsd: 300, highUsd: 300 }), sold({ medianUsd: 240 }))?.message === "Heads up: the Xbox Series S you thought went for $300 actually goes for $240. I've updated your numbers.");
  check("fewer than 5 samples, an unsettled identity or a different condition says nothing", compareWithSold("x", p, sold({ n: 4 })) === null && compareWithSold("x", p, sold({ identitySettled: false })) === null && compareWithSold("x", p, sold({ likeForLike: false })) === null);
  check("a small gap says nothing: under 10% or under $10", compareWithSold("x", p, sold({ medianUsd: 215 })) === null && compareWithSold("x", mk({ lowUsd: 50, highUsd: 50 }), sold({ medianUsd: 56 })) === null);
  check("only a number that was not already replaced", compareWithSold("x", mk({ lowUsd: 200, highUsd: 200, replacedAt: 1 }), sold()) === null);
  check("several are combined into one line", combineWows([{ message: "a" }]) === "a" && /2 prices of yours/.test(combineWows([{ message: "a" }, { message: "b" }])) && combineWows([]) === "");

  section("how often Clynx asks");
  const cands = ["a", "b", "c", "d", "e"].map((productId) => ({ productId }));
  check("at most a few per day", pickPricePrompts(cands, [], T0).length === 3);
  const history: PromptRecord[] = [{ productId: "a", state: "asked", at: T0 - 100 * DAY }, { productId: "b", state: "asked", at: T0 - 10 * DAY }, { productId: "c", state: "never", at: T0 - 200 * DAY }, { productId: "d", state: "later", at: T0 - 2 * DAY }];
  const picked = pickPricePrompts(cands, history, T0).map((c) => c.productId);
  check("not twice within 90 days, never after 'don't ask', 'later' waits a week", picked.join() === "a,e", picked);
  check("the day's allowance counts what was already asked today", pickPricePrompts(cands, [{ productId: "x", state: "asked", at: T0 - 1000 }, { productId: "y", state: "asked", at: T0 - 2000 }, { productId: "z", state: "asked", at: T0 - 3000 }], T0).length === 0);

  section("checking by yourself");
  check("the link opens eBay's sold items for the exact name, nothing automated", soldSearchUrl("Xbox Series S 512GB") === "https://www.ebay.com/sch/i.html?_nkw=Xbox%20Series%20S%20512GB&LH_Sold=1&LH_Complete=1&_sop=13");
  check("the how-to is plain steps", HOW_TO_CHECK_SOLD.length >= 5 && /Sold items/.test(HOW_TO_CHECK_SOLD[1]));
});
