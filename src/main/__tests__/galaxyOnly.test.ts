// The owner's requirement: the Xbox Series X Galaxy Edition is its OWN variant under the Xbox Series X, with photos and prices of ONLY the Galaxy Edition. TESTER's leak list as regression
// tests (real filters, made-up and real-shaped titles): other Xbox generations, parts and boxes, plain consoles and games must not be priced or filed under a Galaxy entry, the plain console
// must not take Galaxy items, and genuine Galaxy listings (including "Limited Edition" wording for the "Special Edition") must still get through. Also proves the Xbox generation guard is alive.
import { judgeCandidateByText, fileableWithoutPicture } from "../photoIdentity.js";
import { classifyComparable, usableForValuation } from "../compIdentity.js";
import { distinguishingTokens } from "../variantIdentity.js";
import { check, run, section } from "./_testkit.js";

const PLAIN = "Xbox Series X";
const CHILDREN = ["Xbox Series X Galaxy Edition", "Xbox Series X 2TB Galaxy Black Special Edition", "Xbox Series X Galaxy Black Edition"];
const requiredFor = (child: string) => distinguishingTokens(child, PLAIN).other.filter((t) => !/^\d+$/.test(t));
const comp = (child: string, title: string) => classifyComparable({ name: child, requiredTerms: requiredFor(child) }, title);
const priced = (child: string, title: string) => usableForValuation(comp(child, title).verdict);
const filed = (child: string, title: string) => {
  const v = judgeCandidateByText(child, title);
  return v.status === "match" || (v.status === "insufficient" && fileableWithoutPicture(v));
};

run(() => {
  section("the Xbox generation guard is alive (an Xbox 360 or Xbox One is not a Series X)");
  for (const child of [PLAIN, ...CHILDREN]) {
    check(`Xbox One Galaxy Edition is not priced for "${child}"`, !priced(child, "Xbox One Galaxy Edition"), comp(child, "Xbox One Galaxy Edition"));
    check(`Xbox 360 Galaxy Edition is not priced for "${child}"`, !priced(child, "Xbox 360 Galaxy Edition"), comp(child, "Xbox 360 Galaxy Edition"));
    check(`a bare "Xbox Galaxy Edition" is not priced for "${child}" (it does not say which Xbox)`, !priced(child, "Xbox Galaxy Edition"), comp(child, "Xbox Galaxy Edition"));
  }
  check("an Xbox 360 is not priced for the plain Series X", !priced(PLAIN, "Xbox 360 Brand New") && !filed(PLAIN, "Xbox 360 Brand New"));
  check("the rejection names the generation", comp(PLAIN, "Xbox 360 Brand New").reasons.some((r) => r.code === "MODEL_NUMBER" && /360/.test(r.text)), comp(PLAIN, "Xbox 360 Brand New"));
  check("a Series X|S title is still a Series X", priced(PLAIN, "Microsoft Xbox Series X|S 1TB Console Black") || comp(PLAIN, "Microsoft Xbox Series X|S 1TB Console Black").verdict !== "rejected");

  section("parts, boxes and broken units after a 'Special Edition' are still not the product");
  for (const child of CHILDREN) {
    for (const t of ["Xbox Series X 2TB Galaxy Black Special Edition For Parts Not Working", "Xbox Series X Galaxy Black Special Edition Disc Drive Not Working", "Xbox Series X Galaxy Black Special Edition Box Only"]) {
      check(`not priced for "${child}": "${t}"`, !priced(child, t), comp(child, t));
    }
  }
  check("the plain console still rejects a broken one", !priced(PLAIN, "Xbox Series X For Parts Not Working"));

  section("the photo gate and the price gate agree: a plain console is not a Galaxy photo");
  for (const child of CHILDREN) {
    for (const t of ["Xbox Series X 1TB Black", "Microsoft Xbox Series X 1TB Console Black", "Xbox Series X Brand New", "Xbox Series X 2TB Black", "Microsoft Xbox Series X 2TB Console Black Brand New", "Xbox Series X Starfield Limited Edition Console"]) {
      check(`not filed under "${child}": "${t}"`, !filed(child, t), judgeCandidateByText(child, t));
      check(`not priced for "${child}": "${t}"`, !priced(child, t), comp(child, t));
    }
  }

  section("games, controllers and look-alikes stay out of every Galaxy entry");
  const OUT = ["Guardians of the Galaxy Xbox Series X Brand New Factory Sealed", "Guardians of the Galaxy - Xbox Series X - Brand New", "Marvel Guardians of the Galaxy Cosmic Deluxe Edition Xbox Series X Complete in Box", "Xbox Wireless Controller Galaxy Black Special Edition", "Galaxy Black Xbox Series X Controller", "Samsung Galaxy S24 Xbox Series X Bundle", "Xbox Series S Galaxy Edition", "Super Mario Galaxy Nintendo Switch"];
  for (const child of CHILDREN) for (const t of OUT) check(`"${child}" takes nothing from: "${t}"`, !priced(child, t) && !filed(child, t), { comp: comp(child, t).verdict, photo: judgeCandidateByText(child, t).status });

  section("the plain console does not take Galaxy Edition items either");
  for (const t of ["Xbox Series X Galaxy Edition", "Xbox Series X Galaxy Black Edition 2TB", "Xbox 2TB Galaxy Black Series X Console", "Xbox Series X 2TB Galaxy Black Special Edition", "Xbox Series X Galaxy Black Limited Edition 2TB Console"]) {
    check(`plain Series X: not priced "${t}"`, !priced(PLAIN, t), comp(PLAIN, t));
    check(`plain Series X: not filed "${t}"`, !filed(PLAIN, t), judgeCandidateByText(PLAIN, t));
  }

  section("genuine Galaxy listings get through (Limited Edition wording is the Special Edition)");
  const OFFICIAL = "Xbox Series X 2TB Galaxy Black Special Edition";
  for (const t of ["Xbox Series X 2TB Galaxy Black Special Edition", "Xbox Series X Galaxy Black Edition 2TB", "Xbox Series X Galaxy Black Limited Edition 2TB Console", "Microsoft Xbox Series X Galaxy Black 2TB Limited Edition Console Brand New", "Xbox Series X 2TB Galaxy Black Special Edition Console Used"]) {
    check(`the official-name entry takes: "${t}"`, priced(OFFICIAL, t), comp(OFFICIAL, t));
  }
  check("the typed entry takes 'Galaxy Black Edition 2TB'", priced("Xbox Series X Galaxy Edition", "Xbox Series X Galaxy Black Edition 2TB"));
  check("Galaxy Black Edition entry takes a Galaxy Black Special Edition listing", priced("Xbox Series X Galaxy Black Edition", "Xbox Series X 2TB Galaxy Black Special Edition"));
});
