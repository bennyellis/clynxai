// The scanner asked for Augusta, Maine and Facebook showed Augusta, Georgia; asked for Montpelier or Salem and the page still read the account's own
// default city. The check has to compare city AND state, and a place that is definitely somewhere else must be recognized as such.
import { DEFAULT_BROWSE_URLS } from "../config.js";
import { checkArrivedLocation, parseLocationLabel } from "../locationCheck.js";
import { describeLocationUrl } from "../scrapeEngine.js";
import { US_STATE_ABBREVIATIONS } from "../usStates.js";
import { check, run, section } from "./_testkit.js";

run(() => {
  section("the log's own cases");
  check("Augusta, ME vs Augusta, Georgia is a mismatch (the reported bug)", checkArrivedLocation("Augusta, ME", "Augusta, Georgia") === "mismatch");
  check("Augusta, ME vs Augusta, Maine matches", checkArrivedLocation("Augusta, ME", "Augusta, Maine") === "match");
  check("Montpelier, VT while the page still says Richmond, Virginia", checkArrivedLocation("Montpelier, VT", "Richmond, Virginia") === "mismatch");
  check("Salem, OR while the page still says Richmond, Virginia", checkArrivedLocation("Salem, OR", "Richmond, Virginia") === "mismatch");
  check("Austin, TX vs Austin, Texas", checkArrivedLocation("Austin, TX", "Austin, Texas") === "match");
  check("Raleigh, NC vs Raleigh, North Carolina", checkArrivedLocation("Raleigh, NC", "Raleigh, North Carolina") === "match");
  check("Salt Lake City, UT vs Salt Lake City, Utah", checkArrivedLocation("Salt Lake City, UT", "Salt Lake City, Utah") === "match");
  check("Little Rock, AR vs Little Rock, Arkansas", checkArrivedLocation("Little Rock, AR", "Little Rock, Arkansas") === "match");

  section("same name, different state");
  check("Springfield, IL vs Springfield, Missouri", checkArrivedLocation("Springfield, IL", "Springfield, Missouri") === "mismatch");
  check("Jackson, MS vs Jackson, Wyoming", checkArrivedLocation("Jackson, MS", "Jackson, Wyoming") === "mismatch");
  check("Columbus, OH vs Columbus, Georgia", checkArrivedLocation("Columbus, OH", "Columbus, Georgia") === "mismatch");

  section("spelling and case variants of the same place still match");
  check("Saint Paul, MN vs St. Paul, Minnesota", checkArrivedLocation("Saint Paul, MN", "St. Paul, Minnesota") === "match");
  check("case and spacing", checkArrivedLocation("little rock, ar", "LITTLE ROCK, ARKANSAS") === "match");
  check("a full state name on both sides", checkArrivedLocation("Augusta, Maine", "Augusta, ME") === "match");

  section("not enough to tell: the lenient behavior is kept");
  check("no label on the page", checkArrivedLocation("Augusta, ME", null) === "unknown");
  check("an opaque slug (no state) against a different city is unknown, not a skip", checkArrivedLocation("montpelier", "Richmond, Virginia") === "unknown");
  check("an opaque slug against its own city matches", checkArrivedLocation("denver", "Denver, Colorado") === "match");
  check("a label with no state against a matching city", checkArrivedLocation("Boise, ID", "Boise") === "match");

  section("parsing");
  check("abbreviation", JSON.stringify(parseLocationLabel("Augusta, ME")) === JSON.stringify({ city: "augusta", state: "ME" }));
  check("full name", parseLocationLabel("Augusta, Georgia").state === "GA");
  check("no comma", parseLocationLabel("denver").state === null);

  section("every nationwide stand-in location agrees with itself and disagrees with a wrong state");
  {
    const byAbbr = Object.fromEntries(Object.entries(US_STATE_ABBREVIATIONS).map(([full, abbr]) => [abbr, full]));
    let checked = 0;
    const bad: string[] = [];
    for (const url of DEFAULT_BROWSE_URLS) {
      const label = describeLocationUrl(url);
      const m = /^(.*), ([A-Z]{2})$/.exec(label);
      if (!m) {
        bad.push(`${url} -> ${label}`);
        continue;
      }
      checked++;
      const right = checkArrivedLocation(label, `${m[1]}, ${byAbbr[m[2]] ?? m[2]}`);
      const otherState = m[2] === "GA" ? "Texas" : "Georgia";
      const wrong = checkArrivedLocation(label, `${m[1]}, ${otherState}`);
      if (right !== "match" || wrong !== "mismatch") bad.push(`${label}: right=${right} wrong=${wrong}`);
    }
    check(`all ${DEFAULT_BROWSE_URLS.length} labelled with a state and consistent`, bad.length === 0 && checked === DEFAULT_BROWSE_URLS.length, bad);
  }
});
