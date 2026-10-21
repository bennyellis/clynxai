import { QUIET_PUSH_PER_DAY, noSoldPrices, quietPushDecision } from "../quietPush.js";
import { check, run, section } from "./_testkit.js";

const base = { status: "worth_a_look", basis: "active" as string | null, marginAtAskPercent: 80, profitAtAskUsd: 120, reasonCodes: ["WEAK_EVIDENCE"] };
run(async () => {
  section("quiet push for a big, unproven gap (owner decision Q4)");
  check("a large gap with no sold prices is sent, with a not-proven warning", quietPushDecision(base, 0, 20).send && /Not proven/.test(quietPushDecision(base, 0, 20).warning));
  check("the owner's own number and no recorded basis count as no sold prices; sold and blended do not", noSoldPrices("user") && noSoldPrices(null) && noSoldPrices("active") && !noSoldPrices("sold") && !noSoldPrices("blend"));
  check("a real sold basis is not 'unproven', so it is not pushed this way", !quietPushDecision({ ...base, basis: "sold" }, 0, 20).send);
  check("a small gap is not pushed", !quietPushDecision({ ...base, marginAtAskPercent: 30 }, 0, 20).send && !quietPushDecision({ ...base, profitAtAskUsd: 15 }, 0, 20).send);
  check("an unsettled identity is never pushed", !quietPushDecision({ ...base, reasonCodes: ["IDENTITY_UNCONFIRMED"] }, 0, 20).send);
  check("only a worth-a-look", !quietPushDecision({ ...base, status: "pass" }, 0, 20).send);
  check("at most a few a day", quietPushDecision(base, QUIET_PUSH_PER_DAY - 1, 20).send && !quietPushDecision(base, QUIET_PUSH_PER_DAY, 20).send);
  check("a user whose margin bar is high needs a bigger gap", !quietPushDecision({ ...base, marginAtAskPercent: 60 }, 0, 40).send);
});
