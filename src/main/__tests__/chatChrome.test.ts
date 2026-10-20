// Discovery UI step 1 (AUDITOR proposal section 4): ONE set of typing dots placed after the word "Thinking", Stop as an accent button, the Clynx logo instead of the grey "C", and the word "You"
// instead of a "Y" circle. The pieces that can be checked without a screen: the pure status pieces, and the shape of the chat screens' source (no second set of dots, no letter avatars).
import fs from "node:fs";
import path from "node:path";
import { applyStatusEvent, statusParts, WAITING_LABEL, type RequestSteps } from "../../renderer/src/lib/chatStatus.js";
import { check, run, section } from "./_testkit.js";

const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), "src", "renderer", "src", rel), "utf8");

run(async () => {
  section("status pieces: the label comes first so the dots can follow the word");
  let s: RequestSteps = {};
  s = applyStatusEvent(s, { requestId: "r", stepId: "think", kind: "model", label: "Thinking", state: "start", startedAt: 1000 } as never, 1000);
  s = applyStatusEvent(s, { requestId: "r", stepId: "ebay", kind: "tool", label: "Researching eBay", state: "start", startedAt: 4000 } as never, 4000);
  const parts = statusParts(s.r, 9000);
  check("one piece per running step, label and timer apart", parts.length === 2 && parts[0].label === "Thinking" && parts[0].elapsed === "8s" && parts[1].label === "Researching eBay" && parts[1].elapsed === "5s", parts);
  check("nothing running -> no pieces", statusParts(undefined, 1).length === 0 && statusParts([], 1).length === 0);
  check("the waiting label is the word Thinking", WAITING_LABEL === "Thinking");

  const extras = src("components/ChatExtras.tsx");
  const dotsInStatus = (extras.match(/className="typing-dots"/g) ?? []).length;
  check("the status line draws its dots in two places only (a running step, or waiting), never both at once", dotsInStatus === 2 && /parts\.length > 0/.test(extras) && /showWaiting/.test(extras));
  check("the dots come AFTER the label in the running line", /<span>\{p\.label\}<\/span>\s*\{i === 0 && \(\s*<span className="typing-dots"/.test(extras));
  check("Stop is a primary (accent) button with a square icon and the word Stop", /className="primary"[\s\S]{0,400}Stop\s*<\/button>/.test(extras) && !/icon ghost[\s\S]{0,200}Stop/.test(extras));

  check("Stop stays whenever a reply is running, even with plain words streaming and no step (TESTER's gap 2)", /!showWaiting && !onStop\) return null/.test(extras) && /parts\.length === 0 && !showWaiting && stopButton/.test(extras));
  check("the waiting word is announced politely to screen readers", /role="status" aria-live="polite">\{WAITING_LABEL\}/.test(extras));
  check("Clynx's own narration rows are never empty while they wait (TESTER's gap 1), and have no Stop", /entry\.auto && entry\.streaming && !entry\.content && <ChatStatusLine requestId=\{entry\.id\} waiting \/>/.test(src("screens/Activity.tsx")));

  section("no chat draws a second set of dots in the bubble");
  for (const f of ["screens/DiscoveryTab.tsx", "screens/Activity.tsx", "screens/Database.tsx", "components/GlobalAssistantBar.tsx"]) {
    const t = src(f);
    check(`${f}: the empty-reply dots are gone and the status line is told it is waiting`, !/streaming && !(?:msg|entry)\.content && \(\s*<span className="typing-dots"/.test(t) && !/m\.streaming \? \(\s*<span className="typing-dots"/.test(t) && /waiting=\{/.test(t));
  }

  section("the Clynx logo and the word You, everywhere Clynx or the person speaks");
  const avatar = src("components/ChatAvatar.tsx");
  check("one shared avatar uses the Clynx mark image; a glyph is only for narration rows", /clynx-mark\.png/.test(avatar) && /glyph \? glyph :/.test(avatar));
  check("the word You, not a letter", /YouLabel/.test(avatar) && />You<\/div>/.test(avatar));
  for (const f of ["screens/DiscoveryTab.tsx", "screens/Activity.tsx", "screens/Database.tsx"]) {
    const t = src(f);
    check(`${f}: uses the shared avatar and label, no grey letter circle`, /ClynxAvatar/.test(t) && /YouLabel/.test(t) && !/\? "Y" :/.test(t) && !/:\s*"C"\}/.test(t) && !/^\s*C\s*$/m.test(t));
  }
});
