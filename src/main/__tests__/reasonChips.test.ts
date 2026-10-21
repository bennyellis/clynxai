import { reasonChips } from "../../renderer/src/lib/reasonChips.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  section("why-chips");
  const vague = reasonChips({ gateReasons: [{ code: "IDENTITY_UNCONFIRMED", severity: "warn", text: "Not sure which model this is yet - missing: whether it is unlocked or locked to a carrier." }], gateFacts: { basis: "sold" } });
  check("an unsettled identity shows 'Vague' with the full sentence on hover", vague.length === 1 && vague[0].label === "Vague" && /unlocked or locked/.test(vague[0].title));
  check("the older 'more specific version' doubt is its own chip", reasonChips({ gateReasons: [{ code: "IDENTITY_UNCONFIRMED", severity: "warn", text: "This looks like a more specific version (2TB) than the product it matched." }] })[0]?.label === "Maybe a more specific version");
  const basis = reasonChips({ gateFacts: { basis: "user" } }).concat(reasonChips({ gateFacts: { basis: "active" } }));
  check("the owner's own price and asking-prices-only are said out loud", basis.map((c) => c.label).join() === "Your price,Asking prices only");
  check("extras counted and thin data", reasonChips({ gateReasons: [{ code: "HIDDEN_GEM", severity: "good", text: "x" }, { code: "WEAK_EVIDENCE", severity: "warn", text: "y" }] }).map((c) => c.id).join() === "extras,thin");
  check("no reasons, no chips, and a record from before the field is fine", reasonChips({}).length === 0 && reasonChips({ gateReasons: null, gateFacts: null }).length === 0);
  check("the same chip is never shown twice", reasonChips({ gateReasons: [{ code: "WEAK_EVIDENCE", severity: "warn", text: "a" }, { code: "RARE_FIND", severity: "warn", text: "b" }] }).length === 1);
});
