// Q5: a name the person typed builds its card even in Save-credits mode, on a small allowance, and says so when the allowance is the limit. Fake search only.
import { openAiWebBackend, parseResponses, type SearchAnswer } from "../openaiSearch.js";
import { consumeTypedAllowanceNotice, inTypedNameScope, runAsTypedName, SAVE_CREDITS_NOTE } from "../typedScope.js";
import { check, run, section } from "./_testkit.js";

const answer: SearchAnswer = parseResponses({ output: [{ type: "message", content: [{ type: "output_text", text: "Xbox Series X", annotations: [{ type: "url_citation", url: "https://www.xbox.com/x", title: "Xbox", start_index: 0, end_index: 5 }] }] }], usage: {} }).answer;

run(async () => {
  let calls = 0;
  const backend = openAiWebBackend({ enabled: () => true, lowAi: () => true, perHour: 100, typedLowAiPerHour: 2, search: async () => { calls++; return answer; } });

  section("Save-credits mode");
  check("an ordinary background search is still declined", backend.skip!() === "Save OpenAI credits mode is on" && !inTypedNameScope());
  consumeTypedAllowanceNotice();
  await runAsTypedName(async () => {
    check("a typed name is let through, inside the work it starts", backend.skip!() === null && inTypedNameScope());
    await Promise.resolve();
    check("the marker follows async work", inTypedNameScope());
    await backend.run!("q1", 3);
    await backend.run!("q2", 3);
    check("the small allowance counts typed searches only", calls === 2 && backend.skip!() !== null && /allowed for typed names are used/.test(backend.skip!() ?? ""));
  });
  check("using the allowance up is remembered so the answer can say Save-credits mode is the limit", consumeTypedAllowanceNotice() === true && consumeTypedAllowanceNotice() === false);
  check("outside typed work it stays declined", backend.skip!() === "Save OpenAI credits mode is on");
  check("the note tells the user how to fix it", /Save-credits mode off in Config/.test(SAVE_CREDITS_NOTE));

  section("with Save-credits off nothing changes");
  const off = openAiWebBackend({ enabled: () => true, lowAi: () => false, perHour: 100, typedLowAiPerHour: 2, search: async () => answer });
  check("the normal path is not limited by the typed allowance", off.skip!() === null);
  const none = openAiWebBackend({ enabled: () => true, lowAi: () => true, perHour: 100, search: async () => answer });
  await runAsTypedName(async () => {
    check("without an allowance configured a typed name is still declined", none.skip!() === "Save OpenAI credits mode is on");
  });
});
