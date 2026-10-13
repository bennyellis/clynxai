// Phase 4 stage 2: the photo-analysis prompt must not tell the model to collapse a product to its generic name (the root cause of the
// Xbox 360 controller being filed as "Xbox Wireless Controller"). The model itself is not called; this pins the wording and the identity pre-check.
import fs from "node:fs";
import path from "node:path";
import { listingHasExtraDetail } from "../productIdentity.js";
import { check, run, section } from "./_testkit.js";

run(() => {
  section("vision prompt wording");
  const src = fs.readFileSync(path.join(process.cwd(), "src", "main", "vision.ts"), "utf8");
  check("no instruction to fall back to the plain base name", !/fall back to the plain base name/i.test(src));
  check("no instruction to use the generic name", !/canonical, generic model name/i.test(src));
  check("generation / model number must be kept in the name, for every kind of product", /keep the details that tell look-alike products apart/.test(src) && /Never shorten a product to a more generic name/.test(src));

  section("the identity second look is asked whenever the title states a code the entry lacks");
  check("one unfamiliar word plus a model number that evidence supports is enough", listingHasExtraDetail("Xbox 360 controller", "Xbox Wireless Controller", ["360"]));
  check("...but a number nothing supports does not trigger the (paid) identity check", !listingHasExtraDetail("Xbox 360 controller", "Xbox Wireless Controller"));
  check("a bare generation word without digits still needs two words (unchanged)", !listingHasExtraDetail("Xbox One controller", "Xbox Wireless Controller"));
  check("an ordinary listing of the entry is still not checked", !listingHasExtraDetail("Used xbox wireless controller works great", "Xbox Wireless Controller"));
});
