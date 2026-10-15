// Beta 13 WP6: references are chosen by trust and variety, never by being the newest (audit RI-01).
import { selectReferenceImages } from "../referenceSelection.js";
import { check, run, section } from "./_testkit.js";

type Img = Parameters<typeof selectReferenceImages>[0][number];
const img = (id: string, o: Partial<Img> = {}): Img => ({ id, status: "legacy", kind: "normal", isPrimary: false, sortOrder: 0, createdAt: 1, sourceKind: "listing", sourceTitle: id, ...o });

run(() => {
  section("trust beats recency");
  const pics = [img("newest-unverified", { status: "unverified", createdAt: 9 }), img("newest-set-aside", { status: "needs_review", createdAt: 10 }), img("old-trusted", { status: "trusted", createdAt: 1 }), img("mid-legacy", { createdAt: 5 })];
  const two = selectReferenceImages(pics, 2).map((i) => i.id);
  check("only usable photos are picked, trusted first", two.join() === "old-trusted,mid-legacy", two);
  check("a poor-condition photo is never a reference", selectReferenceImages([img("p", { kind: "poor_condition", status: "trusted" })], 3).length === 0);
  check("nothing usable = nothing picked", selectReferenceImages([img("u", { status: "unverified" }), img("q", { status: "quarantined" })], 3).length === 0);

  section("the person's choice and clean shots");
  check("a photo the person made primary wins", selectReferenceImages([img("a", { status: "trusted" }), img("b", { isPrimary: true, status: "user" })], 1)[0].id === "b");
  check("a person's own photo outranks a verified one", selectReferenceImages([img("t", { status: "trusted" }), img("u", { status: "user" })], 1)[0].id === "u");
  check("a clean stock shot ranks above an equal listing photo", selectReferenceImages([img("l", { status: "trusted" }), img("s", { status: "trusted", sourceKind: "stock" })], 1)[0].id === "s");

  section("variety");
  const same = [img("a1", { status: "trusted", sourceTitle: "same", sourceKind: "ebay" }), img("a2", { status: "trusted", sourceTitle: "same", sourceKind: "ebay" }), img("b1", { status: "trusted", sourceTitle: "other", sourceKind: "listing" })];
  const picked = selectReferenceImages(same, 2).map((i) => i.id);
  check("two picks come from different sources before repeating one", picked.includes("b1") && picked.length === 2, picked);
  check("it fills up from repeats when there is nothing else", selectReferenceImages([img("x", { status: "trusted", sourceTitle: "s" }), img("y", { status: "trusted", sourceTitle: "s" })], 2).length === 2);
});
