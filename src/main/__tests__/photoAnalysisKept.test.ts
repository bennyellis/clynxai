// Database discovery: the photo analysis a listing earned must survive the later re-saves of that listing.
// saveScored used to be INSERT OR REPLACE over a subset of the columns, so the final-qualification save at the end of the pipeline
// silently turned photo_analysis, photo_analysis_checked_at and photo_flaws back to NULL: the Feed showed no photo findings for the very
// listings that had been analyzed, and nothing showed that the photos had ever been looked at.
import { Store } from "../store.js";
import { check, run, section } from "./_testkit.js";
import { scoredListing } from "./_fixtures.js";

run(() => {
  const store = new Store(":memory:");

  section("photo analysis survives a re-save of the listing");
  store.saveScored(scoredListing("Gaming console", 100, { isDeal: false, dealTier: null }, { id: "pa1" }));
  store.updatePhotoAnalysis("pa1", "A black Xbox Series S, controller and cables.", [{ photoNumber: 1, description: "scuffed corner", boundingBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, confidence: "low" }]);
  const analysed = store.getById("pa1");
  check("analysis is stored", analysed?.photoAnalysis === "A black Xbox Series S, controller and cables." && typeof analysed.photoAnalysisCheckedAt === "number", analysed && analysed.photoAnalysis);

  // the pipeline re-saves the listing after photo analysis (green flag / mismatch / final qualification)
  store.saveScored(scoredListing("Gaming console", 100, { isDeal: true }, { id: "pa1" }));
  const after = store.getById("pa1");
  check("the summary is still there after the final save", after?.photoAnalysis === "A black Xbox Series S, controller and cables.", after && after.photoAnalysis);
  check("and so is when it was checked", after?.photoAnalysisCheckedAt === analysed?.photoAnalysisCheckedAt && after?.photoAnalysisCheckedAt !== null, after && after.photoAnalysisCheckedAt);
  check("and the flaws it found", (after?.photoFlaws.length ?? 0) === 1, after && after.photoFlaws);
  check("the new verdict was still saved (the re-save is not ignored)", after?.isDeal === true);

  section("a listing that was never analyzed still reads back as 'not checked'");
  store.saveScored(scoredListing("Other", 50, {}, { id: "pa2" }));
  store.saveScored(scoredListing("Other", 50, {}, { id: "pa2" }));
  const never = store.getById("pa2");
  check("null, not an empty string", never?.photoAnalysis === null && never?.photoAnalysisCheckedAt === null && never.photoFlaws.length === 0, never);
});
