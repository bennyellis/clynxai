// The scan pipeline contract: stages in a fixed order, and every reason code the engine records belongs to a named stage.
import fs from "node:fs";
import path from "node:path";
import { CODE_STAGE, PIPELINE, stageOf } from "../scanPipeline.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  section("the stages");
  check("eight stages in order 1..8, the Beta 31 ones reserved and not built", PIPELINE.map((s) => s.order).join() === "1,2,3,4,5,6,7,8" && PIPELINE.filter((s) => s.release === "beta31").every((s) => !s.built) && PIPELINE.filter((s) => s.release === "beta31").map((s) => s.id).join() === "distance_zone,age_gate,shipping_headroom");
  check("the skip rules come first and the alert last", PIPELINE[0].id === "skip_rules" && PIPELINE[7].id === "alert");
  section("reason codes");
  const src = fs.readFileSync(path.join(process.cwd(), "src/main/scrapeEngine.ts"), "utf8");
  const used = [...new Set([...src.matchAll(/code: "([A-Z_]+)"/g)].map((m) => m[1]))];
  check("every code the engine records is assigned to a stage", used.length > 5 && used.every((c) => stageOf(c) !== null), used.filter((c) => stageOf(c) === null));
  check("no stage mapping points at a stage that does not exist", Object.values(CODE_STAGE).every((id) => PIPELINE.some((s) => s.id === id)));
});
