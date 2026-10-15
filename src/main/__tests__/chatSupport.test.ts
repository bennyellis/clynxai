// Beta 13 WP8/WP9: the choice protocol, real progress, attachment checks, and reply style are pure and tested without a model or a window.
import { MAX_ATTACHMENTS, MAX_CHOICE_OPTIONS, confirmChoice, sanitizeAttachments, tightenReply, toolStatusLabel, validateChoice, wantsDetail } from "../chatSupport.js";
import { applyStatusEvent, formatElapsed, problemSteps, runningSteps, statusText } from "../../renderer/src/lib/chatStatus.js";
import { attachmentHistoryNote, fitsBudget, scaledSize, sniffImageType } from "../../renderer/src/lib/chatAttachments.js";
import { check, run, section } from "./_testkit.js";

const png = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64");
const jpg = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64");

run(() => {
  section("ask_choice validation");
  let n = 0;
  const id = () => `c${++n}`;
  const ok = validateChoice({ question: "Which one?", options: [{ label: "Series S" }, { label: "Series X" }] }, id);
  check("two options are accepted", ok.ok && ok.choice.options.length === 2);
  check("one option is refused", !validateChoice({ question: "Q", options: [{ label: "Only" }] }, id).ok);
  check("a missing question is refused", !validateChoice({ options: [{ label: "A" }, { label: "B" }] }, id).ok);
  check("duplicates collapse, leaving too few", !validateChoice({ question: "Q", options: [{ label: "A" }, { label: "a" }] }, id).ok);
  const many = Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => ({ label: `opt${i}` }));
  check("more than the maximum is refused", !validateChoice({ question: "Q", options: many }, id).ok);
  const dupIds = validateChoice({ question: "Q", options: [{ id: "x", label: "A" }, { id: "x", label: "B" }] }, id);
  check("clashing option ids are renumbered", dupIds.ok && new Set(dupIds.choice.options.map((o) => o.id)).size === 2);
  const messy = validateChoice({ question: "Q\n\n", options: ["Plain string", { label: "B", kind: "weird" }] }, id);
  check("string options work and unknown kinds become default", messy.ok && messy.choice.options[1].kind === "default");
  const c = confirmChoice("z", "Delete it?");
  check("a confirmation is Confirm + Cancel", c.options.length === 2 && c.options[1].kind === "cancel");

  section("real progress labels");
  check("research names the product", toolStatusLabel("research_product", { product: "Xbox Series X" }) === "Researching Xbox Series X");
  check("unknown tools get a neutral label, never model text", toolStatusLabel("zzz", {}) === "Working");
  check("control characters are stripped from labels", !/[\n\r]/.test(toolStatusLabel("web_research", { query: "a\nb" })));

  section("attachments are re-checked in the main process");
  check("a real png and jpeg pass", sanitizeAttachments([{ dataUri: png, name: "a.png" }, { dataUri: jpg, name: "b.jpg" }]).accepted.length === 2);
  const lie = "data:image/png;base64," + Buffer.from("not a picture at all").toString("base64");
  const r = sanitizeAttachments([{ dataUri: lie, name: "fake.png" }]);
  check("a file whose bytes are not a png is refused, and named", r.accepted.length === 0 && r.rejected[0].name === "fake.png");
  check("an svg data uri is refused", sanitizeAttachments([{ dataUri: "data:image/svg+xml;base64,AAAA", name: "x" }]).accepted.length === 0);
  const five = sanitizeAttachments(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ dataUri: png, name: `p${i}` })));
  check("the fifth photo is refused with a reason", five.accepted.length === MAX_ATTACHMENTS && five.rejected.length === 1);
  check("junk input never throws", sanitizeAttachments(null).accepted.length === 0 && sanitizeAttachments([{} as never]).rejected.length === 1);
  const big = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") + "A".repeat(5_000_000);
  check("photos over the shared budget are refused", sanitizeAttachments([{ dataUri: big, name: "1" }, { dataUri: big, name: "2" }]).accepted.length === 1);

  section("short replies");
  check("a request for depth lifts the cap", wantsDetail("explain why in detail") && !wantsDetail("is it a deal?"));
  check("stock openers are removed", tightenReply("Sure! Added it to Search For.") === "Added it to Search For.");
  check("numbers and warnings are untouched", tightenReply("Sure, max buy is $412.50. Warning: likely scam.") === "Max buy is $412.50. Warning: likely scam.");
  check("a reply that is only an opener is kept", tightenReply("Sure") === "Sure");

  section("status events (renderer reducer, fake clock)");
  let s = applyStatusEvent({}, { requestId: "r", stepId: "a", kind: "tool", label: "Researching X", state: "start", startedAt: 1000 }, 1000);
  check("a started step is running", runningSteps(s.r).length === 1);
  check("elapsed time comes from startedAt", statusText(s.r, 9000) === "Researching X… 8s");
  s = applyStatusEvent(s, { requestId: "r", stepId: "a", kind: "tool", label: "Researching X", state: "end", startedAt: 1000, ok: false }, 4000);
  check("an ended step stops ticking and is flagged when it failed", runningSteps(s.r).length === 0 && problemSteps(s.r).length === 1 && statusText(s.r, 99000) === "");
  s = applyStatusEvent(s, { requestId: "q", stepId: "n", kind: "notice", label: "Pictures dropped", state: "end", startedAt: 1 }, 5);
  check("a notice appears as already done and never as running", runningSteps(s.q).length === 0 && s.q.length === 1);
  check("requests do not leak into each other", s.r.length === 1);
  check("elapsed formatting", formatElapsed(65_000) === "1m 05s" && formatElapsed(-5) === "0s");

  section("attachment helpers (renderer)");
  check("sniffing is by bytes", sniffImageType(new Uint8Array([0xff, 0xd8, 0xff])) === "jpeg" && sniffImageType(new Uint8Array([1, 2, 3, 4])) === null);
  const sz = scaledSize(4000, 2000);
  check("large pictures shrink, keeping proportions", sz.width === 1568 && sz.height === 784);
  check("small pictures are not enlarged", scaledSize(300, 200).width === 300);
  check("the budget refuses what would not fit", !fitsBudget([{ dataUri: "x".repeat(5_900_000), name: "a" }], "y".repeat(200_000)));
  check("history notes name the photos, empty when none", attachmentHistoryNote(["a.png"]).includes("a.png") && attachmentHistoryNote([]) === "");
});
