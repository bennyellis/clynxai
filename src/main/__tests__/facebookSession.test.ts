// Phase 1, stage 4: an expired or interrupted Facebook session is recognised from the page the scanner is on, reported once, ends the
// cycle instead of searching a login wall, and clears itself when the session works again.
import { classifyFacebookPage, describeSessionProblem, looksLikeHealthyFacebookPage, type PageSnapshot } from "../facebookSession.js";
import { check, run, section } from "./_testkit.js";
import { baseConfig, makeEngine } from "./_fixtures.js";

const snap = (over: Partial<PageSnapshot>): PageSnapshot => ({ url: "https://www.facebook.com/marketplace/richmond/search?query=xbox", title: "Marketplace - Search results | Facebook", hasLoginForm: false, bodyText: "Marketplace Filters Location Richmond, VA Today's picks $200 Xbox Series S", ...over });

// A page that only knows what a snapshot says, and records anything the scanner tries to do on it.
function fakePage(initial: PageSnapshot) {
  let current = initial;
  const calls: string[] = [];
  const page: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "url") return () => current.url;
        if (prop === "isClosed") return () => false;
        if (prop === "evaluate") return async () => ({ title: current.title, hasLoginForm: current.hasLoginForm, bodyText: current.bodyText });
        if (prop === "waitForTimeout") return async () => {};
        if (prop === "goto") return async (u: string) => void calls.push(`goto ${u}`);
        return (...args: unknown[]) => {
          calls.push(String(prop));
          throw new Error(`page.${String(prop)} is not available in this test`);
        };
      },
    }
  );
  return { page, calls, set: (s: PageSnapshot) => (current = s) };
}

run(async () => {
  section("recognising the page");
  {
    check("a normal Marketplace search page is fine", classifyFacebookPage(snap({})) === null);
    check("the login page URL means logged out", classifyFacebookPage(snap({ url: "https://www.facebook.com/login/?next=%2Fmarketplace", title: "Log in to Facebook" })) === "logged-out");
    check("login.php means logged out", classifyFacebookPage(snap({ url: "https://www.facebook.com/login.php?next=x", title: "" })) === "logged-out");
    check("a password box over the Marketplace page is the login wall", classifyFacebookPage(snap({ hasLoginForm: true })) === "logged-out");
    check("a login title alone is enough", classifyFacebookPage(snap({ url: "https://www.facebook.com/", title: "Log into Facebook" })) === "logged-out");
    check("a checkpoint URL is a security check, not a logout", classifyFacebookPage(snap({ url: "https://www.facebook.com/checkpoint/1501092823525282/", title: "Security check required" })) === "checkpoint");
    check("two-step verification is a security check", classifyFacebookPage(snap({ url: "https://www.facebook.com/two_step_verification/authentication/" })) === "checkpoint");
    check("'confirm your identity' on a non-Marketplace page is a security check", classifyFacebookPage(snap({ url: "https://www.facebook.com/", title: "Facebook", bodyText: "Confirm your identity to continue" })) === "checkpoint");
    check("a Marketplace listing that merely mentions a 'security check' is NOT flagged", classifyFacebookPage(snap({ bodyText: "Today's picks $40 Security check camera, enter the code on the box" })) === null);
    check("a page that is not Facebook says nothing", classifyFacebookPage(snap({ url: "about:blank", title: "", bodyText: "" })) === null);
    check("an error page says nothing (a network blip is not a logout)", classifyFacebookPage(snap({ url: "chrome-error://chromewebdata/", title: "facebook.com", bodyText: "This site can't be reached" })) === null);
    check("healthy means a real logged-in Facebook page", looksLikeHealthyFacebookPage(snap({})) && !looksLikeHealthyFacebookPage(snap({ hasLoginForm: true })) && !looksLikeHealthyFacebookPage(snap({ url: "about:blank" })));
  }

  section("the words shown to the user");
  {
    const out = describeSessionProblem("logged-out", "Account 1");
    check("a logout names the account and says what to do", /Account 1/.test(out.title) && /log in/i.test(out.message) && /Open Facebook/.test(out.message), out);
    const cp = describeSessionProblem("checkpoint", "Account 1");
    check("a security check says that and not 'log in again'", /security check/i.test(cp.message) && !/expired/i.test(cp.message), cp);
    check("no jargon or stack traces", !/Playwright|selector|exception|undefined/i.test(out.message + cp.message));
  }

  section("the scan engine: reports once, ends the cycle, recovers by itself");
  {
    const problems: Array<string | null> = [];
    const { engine, logs } = makeEngine({ extra: { onSessionProblem: (p: unknown) => void problems.push(p as string | null) } });
    const fb = fakePage(snap({ url: "https://www.facebook.com/login/?next=%2Fmarketplace", title: "Log in to Facebook", hasLoginForm: true }));
    const e = engine as any;

    const broken1 = await e.guardSession(fb.page, "test");
    check("a login wall is detected", broken1 === true && e.sessionBroken === true);
    check("the account is marked logged out with a plain reason", engine.getStatus().loggedIn === false && /logged .* out|log in again/i.test(engine.getStatus().lastError ?? ""), engine.getStatus());
    check("the owner was told exactly once", problems.length === 1 && problems[0] === "logged-out", problems);
    await e.guardSession(fb.page, "test again");
    await e.guardSession(fb.page, "and again");
    check("repeat sightings do not repeat the report", problems.length === 1, problems);
    check("the log says so once, in words", logs.filter((l) => l.level === "error" && /logged .* out/i.test(l.message)).length === 1, logs.map((l) => l.message));

    fb.set(snap({ url: "https://www.facebook.com/checkpoint/123/", title: "Security check", hasLoginForm: false }));
    await e.guardSession(fb.page, "checkpoint");
    check("a change to a security check is reported as such", problems.length === 2 && problems[1] === "checkpoint", problems);

    fb.set(snap({}));
    e.sessionBroken = false;
    const broken2 = await e.guardSession(fb.page, "after login");
    check("a normal page after the user logs in: no problem", broken2 === false);
    check("the account is logged in again and the error is gone", engine.getStatus().loggedIn === true && engine.getStatus().lastError === null, engine.getStatus());
    check("the owner is told it is fixed (null), once", problems.length === 3 && problems[2] === null, problems);

    fb.set(snap({ url: "about:blank", title: "", bodyText: "" }));
    check("a blank or unreadable page never raises a problem", (await e.guardSession(fb.page, "blank")) === false && problems.length === 3);
    const dead: any = { isClosed: () => true, url: () => "x", evaluate: async () => { throw new Error("closed"); } };
    check("a closed page never raises a problem", (await e.guardSession(dead, "closed")) === false && problems.length === 3);
  }

  section("no flapping: a front page that looks fine while the page the cycle opens is a login wall (found by the integration run)");
  {
    // Marketplace's front page passes the quick login check; the location page is a login wall. Every cycle used to clear the notice
    // (front page ok) and raise it again (wall), repeating the phone push each time.
    const problems: Array<string | null> = [];
    const config = baseConfig({ browseUrls: ["https://www.facebook.com/marketplace/richmond/"] });
    const { engine } = makeEngine({ config, extra: { onSessionProblem: (p: unknown) => void problems.push(p as string | null) } });
    const front = snap({});
    const wall = snap({ url: "https://www.facebook.com/marketplace/richmond/", hasLoginForm: true });
    let current = front;
    const fb: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return undefined; // not a promise (it is returned from async functions)
        if (prop === "url") return () => current.url;
        if (prop === "isClosed") return () => false;
        if (prop === "evaluate") return async () => ({ title: current.title, hasLoginForm: current.hasLoginForm, bodyText: current.bodyText });
        if (prop === "waitForTimeout") return async () => {};
        if (prop === "goto") return async (u: string) => void (current = /facebook\.com\/marketplace\/?$/.test(u) ? front : { ...wall, url: u });
        // locator(...)/getByPlaceholder(...) as used by the quick login check: no login box on the front page
        if (prop === "locator" || prop === "getByPlaceholder") return () => ({ first: () => ({ waitFor: async () => {}, count: async () => 0 }) });
        return () => { throw new Error(`page.${String(prop)} is not available in this test`); };
      },
    });
    (engine as any).ensureBrowser = async () => fb;
    for (let cycle = 0; cycle < 4; cycle++) await (engine as any).runOnce();
    check("four cycles report the problem exactly once and never 'fixed'", problems.length === 1 && problems[0] === "logged-out", problems);
    current = front;
    // now Facebook really works: a cycle whose location page is a normal page clears it
    const okPage = new Proxy(fb, { get(t, prop: string) { if (prop === "goto") return async (u: string) => void (current = snap({ url: u })); return (t as any)[prop]; } });
    (engine as any).ensureBrowser = async () => okPage;
    await (engine as any).runOnce();
    check("a cycle that sees a normal page afterwards clears it, once", problems.length === 2 && problems[1] === null, problems);
  }

  section("a cycle that lands on a login wall stops there instead of searching it");
  {
    const problems: Array<string | null> = [];
    const config = baseConfig({ browseUrls: ["https://www.facebook.com/marketplace/richmond/"], searchItems: [{ item: "Xbox Series S", typicalResaleUsd: 300, matchKeywords: ["xbox"], minPriceUsd: null, maxPriceUsd: null }] });
    const { engine, logs } = makeEngine({ config, extra: { onSessionProblem: (p: unknown) => void problems.push(p as string | null) } });
    const fb = fakePage(snap({ url: "https://www.facebook.com/login/?next=%2Fmarketplace%2Frichmond", title: "Log in to Facebook", hasLoginForm: true }));
    await (engine as any).runCycle(fb.page, config);
    check("the owner is told", problems.length === 1 && problems[0] === "logged-out", problems);
    check("no search or browse was attempted on the login page (only the navigation and the start-of-cycle radius check)", fb.calls.every((c) => c.startsWith("goto") || c === "getByRole"), fb.calls);
    check("the cycle recorded why, not 'found 0 listings'", !logs.some((l) => /found 0 listings/i.test(l.message)) && engine.getStatus().loggedIn === false, logs.map((l) => l.message));
  }
});
