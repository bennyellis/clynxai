// Phase 2, item 1: the first-run checklist is worked out from the real state, optional integrations are not part of it, existing customers are
// not nagged, and the stored flags survive saving.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildChecklist } from "../../renderer/src/lib/onboarding.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../config.js";
import type { Account, Config, ScrapeStatus } from "../types.js";
import { check, run, section } from "./_testkit.js";

const acct = (over: Partial<Account> = {}): Account => ({ id: "a1", label: "Account 1", enabled: true, locationMode: "country", selectedState: null, selectedCityOrZip: null, ...over } as Account);
const st = (loggedIn: boolean | null): ScrapeStatus => ({ running: false, loggedIn } as ScrapeStatus);
const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, searchItems: [], recentSearches: [], ...over });
const model = (c: Config, accounts: Account[] = [acct()], statusMap: Record<string, ScrapeStatus> = {}) => buildChecklist({ config: c, accounts, statusMap });
const done = (m: ReturnType<typeof model>) => Object.fromEntries(m.steps.map((s) => [s.id, s.done]));

run(() => {
  section("a brand-new install");
  {
    const m = model(cfg());
    check("four steps, none done, checklist visible", m.total === 4 && m.doneCount === 0 && !m.allDone && !m.dismissed, done(m));
    check("in the order: Facebook, location, first product, phone alerts", m.steps.map((s) => s.id).join() === "facebook,location,product,phone");
    check("only phone alerts can be skipped, and the description says it is recommended, not required", m.steps.filter((s) => s.skippable).map((s) => s.id).join() === "phone" && /Recommended/.test(m.steps[3].description));
    check("the Facebook step says the password goes to Facebook, not Clynx", /never into Clynx/.test(m.steps[0].description));
  }

  section("steps tick from the real state");
  {
    check("Facebook: a live login ticks it", done(model(cfg(), [acct()], { a1: st(true) })).facebook === true);
    check("Facebook: logged out or unknown does not", done(model(cfg(), [acct()], { a1: st(false) })).facebook === false && done(model(cfg(), [acct()], { a1: st(null) })).facebook === false);
    check("Facebook: once connected it stays ticked even before the browser is open again", done(model(cfg({ onboarding: { dismissed: false, facebookConnected: true, locationChosen: false, phoneSkipped: false } }))).facebook === true);
    check("location: the nationwide default is not a choice", done(model(cfg())).location === false);
    check("location: a state or a city/ZIP is", done(model(cfg(), [acct({ locationMode: "state", selectedState: "Delaware" })])).location === true && done(model(cfg(), [acct({ locationMode: "city", selectedCityOrZip: "19901" })])).location === true);
    check("location: 'nationwide is fine' counts", done(model(cfg({ onboarding: { dismissed: false, facebookConnected: false, locationChosen: true, phoneSkipped: false } }))).location === true);
    check("location: a state mode with nothing selected yet does not", done(model(cfg(), [acct({ locationMode: "state", selectedState: null })])).location === false);
    check("product: something on the Search For list ticks it", done(model(cfg({ searchItems: [{ item: "PlayStation 5" } as never] }))).product === true);
    check("product: a past search remembered across restarts also counts (the list itself resets each launch)", done(model(cfg({ recentSearches: [{ item: "Xbox", minPriceUsd: null, maxPriceUsd: null } as never] }))).product === true);
    check("phone: no topic = not done", done(model(cfg({ ntfy: { server: "https://ntfy.sh", topic: "" } }))).phone === false);
    check("phone: an existing topic (even an easy one like the one already in use) counts as set up; nothing is replaced", done(model(cfg({ ntfy: { server: "https://ntfy.sh", topic: "clynxai" } }))).phone === true);
    check("phone: skipping counts as done", done(model(cfg({ onboarding: { dismissed: false, facebookConnected: false, locationChosen: false, phoneSkipped: true } }))).phone === true);
    const all = model(cfg({ searchItems: [{ item: "x" } as never], ntfy: { server: "https://ntfy.sh", topic: "clynx-abcdefghijklmnopqrstuvwxyz" } }), [acct({ locationMode: "state", selectedState: "Ohio" })], { a1: st(true) });
    check("everything done: 4 of 4", all.allDone && all.doneCount === 4);
  }

  section("optional integrations are clearly optional and not part of the count");
  {
    const m = model(cfg());
    check("eBay and WatchCount are listed as extras, not steps", m.extras.map((e) => e.id).join() === "ebay,watchcount" && !m.steps.some((s) => /ebay|watchcount/i.test(s.title)));
    check("each says Optional", m.extras.every((e) => /^Optional\./.test(e.description)));
    check("they do not change progress", model(cfg()).total === 4 && model(cfg()).doneCount === 0);
    check("eBay's description tells a Facebook-only user they can ignore it", /works fully on Facebook Marketplace without it/.test(m.extras[0].description));
  }

  section("dismissed state and existing customers");
  {
    check("dismissed is reported", model(cfg({ onboarding: { dismissed: true, facebookConnected: false, locationChosen: false, phoneSkipped: false } })).dismissed === true);
    check("a config without the field behaves as not dismissed in the model", model({ ...cfg(), onboarding: undefined }).dismissed === false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-onboard-"));
    const p = path.join(dir, "config.json");
    check("no config file (new install): the checklist is shown", loadConfig(p).onboarding?.dismissed === false);

    // A config written before the checklist existed: no `onboarding` key at all.
    const legacy = { ...cfg() } as Partial<Config>;
    delete legacy.onboarding;
    fs.writeFileSync(p, JSON.stringify(legacy));
    const upgraded = loadConfig(p);
    check("an existing customer's config (no onboarding field) loads as dismissed, so they are not nagged", upgraded.onboarding?.dismissed === true && upgraded.onboarding.facebookConnected === false);
    check("their other settings are untouched", upgraded.minProfitMarginPercent === DEFAULT_CONFIG.minProfitMarginPercent && upgraded.ntfy.server === DEFAULT_CONFIG.ntfy.server);

    fs.writeFileSync(p, JSON.stringify({ ...legacy, ntfy: { server: "https://ntfy.sh", topic: "my-existing-topic" } }));
    check("an existing ntfy topic survives the upgrade exactly", loadConfig(p).ntfy.topic === "my-existing-topic");

    saveConfig(p, { ...upgraded, onboarding: { dismissed: false, facebookConnected: true, locationChosen: false, phoneSkipped: true } });
    const back = loadConfig(p);
    check("saved flags round-trip", back.onboarding?.dismissed === false && back.onboarding.facebookConnected === true && back.onboarding.phoneSkipped === true && back.onboarding.locationChosen === false);

    fs.writeFileSync(p, JSON.stringify({ ...legacy, onboarding: { dismissed: false } }));
    const partial = loadConfig(p);
    check("a partly saved checklist fills the missing flags with 'not done'", partial.onboarding?.dismissed === false && partial.onboarding.facebookConnected === false && partial.onboarding.phoneSkipped === false);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
