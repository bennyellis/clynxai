// Beta 12: the listing's own text, and condition wording read in context.
import { check, section, run } from "./_testkit.js";
import { listingOwnText, declaredCondition, detailTextFields, conditionTextOf } from "../listingText.js";
import { analyzeCondition } from "../conditionParser.js";
import { detectConditionImpact } from "../scorer.js";

// The stored page of a real listing (the $200 Xbox in the owner's database), trimmed: the seller's text, then other sellers' cards.
const REAL_PAGE = `This listing is far from your current location.
See listings near me
Xbox series X
$200
Listed about an hour ago in Bronson, MI
Message
Details
Condition
Used - like new
I bought a gaming pc awhile ago so I haven’t used it, everything works I just turned it on, price is firm.

If the post is up it’s available, perfect timing for gta6 or the holidays
Bronson, MI · Location is approximate
Seller information
Seller details
Austin Barnett
Joined Facebook in 2025
Ad
The Greek Gods Yogurt
Related searches
series s
cbox series x
Send seller a message
Send
Today's picks
Cheyenne · 500 mi
$550
PlayStation 5 with two wireless controllers and games bundle 4 new games in the packaging and hdmi
Richmond, VA
$300
Sony PlayStation 5 as is for parts/ 300 obo
Fredericksburg, VA
$180
Apple Watch Series 8, 45mm
Richmond, VA`;

run(() => {
  section("the listing's own text stops where other sellers' cards begin");
  const own = listingOwnText(REAL_PAGE);
  check("a boundary marker is found", own.cut && own.marker !== null, own);
  check("the first marker on the page wins (Related searches precedes Send seller a message here)", own.marker === "Related searches", own.marker);
  check("the seller's own words are kept", /everything works/.test(own.text) && /Used - like new/.test(own.text));
  check("another seller's 'as is for parts' card is NOT part of the listing", !/for parts/i.test(own.text) && !/Sony PlayStation/.test(own.text));
  check("the page itself is untouched", own.pageChars === REAL_PAGE.length);
  check("the declared condition is read", declaredCondition(own.text) === "Used - like new", declaredCondition(own.text));
  const curly = listingOwnText("Seller text only\nToday’s picks\n$1 junk for parts");
  check("a curly apostrophe in Today's picks still cuts", curly.cut && !/junk/.test(curly.text), curly);
  const noMarker = listingOwnText("x".repeat(5000));
  check("with no marker (layout change) only the top of the page is trusted and it is flagged", !noMarker.cut && noMarker.text.length === 1500 && noMarker.marker === null);

  section("the real Xbox page: before = whole page, after = own text");
  check("whole page is read as major damage (the old bug)", analyzeCondition(REAL_PAGE).impact === "major");
  check("own text is not damaged", analyzeCondition(own.text).impact === "none", analyzeCondition(own.text));

  section("every page-text reader uses the listing's own text");
  const f = detailTextFields(REAL_PAGE);
  check("description is the listing's own text", f.description === own.text && !/Sony PlayStation/.test(f.description));
  check("provenance records the cut", f.textProvenance.cut && f.textProvenance.marker === "Related searches" && f.textProvenance.ownChars < f.textProvenance.pageChars);
  check("condition text for the real Xbox has no damage", detectConditionImpact(conditionTextOf({ title: "Xbox series X", description: f.description, textProvenance: f.textProvenance, declaredCondition: f.declaredCondition })) === "none");
  const withNeighbourEbay = detailTextFields("Switch OLED\n$200\nListed 2 hours ago\nSend seller a message\nToday's picks\n$40\nSold on eBay, ships for $5\nDoor dropoff");
  check("another seller's 'eBay' / 'ships for $' card does not reject this listing", !withNeighbourEbay.mentionsEbay && !withNeighbourEbay.hasOfficialShipping, withNeighbourEbay);
  const ownEbay = detailTextFields("Switch OLED\nAlso listed on eBay\nSend seller a message\nToday's picks\n$40 thing");
  check("the seller's own eBay mention still counts", ownEbay.mentionsEbay);
  const ownShips = detailTextFields("Switch OLED\nShips for $13.18\nSend seller a message");
  check("the listing's own Facebook shipping still counts", ownShips.hasOfficialShipping);
  const uncut = detailTextFields("Xbox\n$200\nthis page has no markers at all. for parts");
  check("without markers condition is read from title + declared condition only", detectConditionImpact(conditionTextOf({ title: "Xbox", description: uncut.description, textProvenance: uncut.textProvenance, declaredCondition: uncut.declaredCondition })) === "none" && !uncut.textProvenance.cut);

  section("negation: no damage is not damage");
  const none = [
    "Not broken.",
    "No damage.",
    "No dead pixels.",
    "Screen not cracked.",
    "Nothing is damaged.",
    "No power issues.",
    "No cracks, works perfectly.",
    "No dead pixels or damage.",
    "Works perfectly, no damage, not broken",
    "Nothing is cracked or damaged",
    "no cracks, scratches or damage",
    "Crack-free screen, damage free body",
    "Phone has no water damage",
    "absolutely zero scratches, no damage, no stick drift",
    "iPhone 14 unlocked, screen not cracked",
    "no dead pixels, no cracks",
    "dead mint condition",
    "Sold as is, works great",
    "The crack on the screen is just a tempered glass protector",
  ];
  for (const t of none) check(`none: "${t}"`, detectConditionImpact(t) === "none", analyzeCondition(t));

  section("real damage still counts");
  const minor = [
    "Screen cracked, otherwise works.",
    "Not broken, but battery needs replacement.",
    "No scratches, screen cracked",
    "Cracked back glass",
    "Controller does have some damage ( pictured)",
    "Sold as is, untested.",
    "Has 3 dead pixels",
    "Missing controller",
  ];
  for (const t of minor) check(`minor: "${t}"`, detectConditionImpact(t) === "minor", analyzeCondition(t));
  const major = [
    "For parts, does not power on.",
    "Does not work",
    "Won't turn on",
    "Console is dead",
    "Not working, cracked screen",
    "iCloud locked",
    "no power",
    "Sony PlayStation 5 as is for parts",
  ];
  for (const t of major) check(`major: "${t}"`, detectConditionImpact(t) === "major", analyzeCondition(t));

  section("a risk word alone is uncertain, not a deduction");
  const asIs = analyzeCondition("Sold as is, works great");
  check("'as is' with 'works' is no deduction and is not even uncertain damage", asIs.impact === "none");
  const bare = analyzeCondition("Selling as is");
  check("'as is' alone: no deduction, reported as uncertain", bare.impact === "none" && bare.evidence.uncertain.length === 1, bare);
  check("no power cord is a missing accessory, not a dead console", detectConditionImpact("Console works, no power cord included") === "none");
  check("explanations are kept for what was ignored", analyzeCondition("No damage.").evidence.ignored.length === 1);
});
