// Phase 10, desktop side: moving from local beta mode to an account (copy, never move), working offline, and ending a sign-in that the server has revoked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudClient, writeSession } from "../cloudClient.js";
import { describeSubscription } from "../../renderer/src/lib/subscriptionText.js";
import { importLocalData, localDataExists, LOCAL_USER_ID } from "../localMigration.js";
import type { BillingStatus, Config } from "../types.js";
import { check, run, section } from "./_testkit.js";

const USER = "11111111-2222-4333-8444-555555555555";

run(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-acct-"));
  const dirs = fs.readdirSync.bind(fs);

  section("copying local beta data into an account");
  {
    const users = path.join(root, "users");
    const local = path.join(users, LOCAL_USER_ID);
    fs.mkdirSync(path.join(local, "browser-profiles", "default"), { recursive: true });
    fs.mkdirSync(path.join(local, "backups"), { recursive: true });
    fs.writeFileSync(path.join(local, "scout.db"), "database bytes");
    fs.writeFileSync(path.join(local, "config.json"), '{"theme":"dark"}');
    fs.writeFileSync(path.join(local, "browser-profiles", "default", "Cookies"), "fb session");
    fs.writeFileSync(path.join(local, "backups", "clynx-20261001-000000.db"), "old backup");
    check("local data is detected", localDataExists(users));
    check("an empty users folder has none", !localDataExists(path.join(root, "nowhere")));

    const r = importLocalData(users, USER, () => 1000);
    check("the copy succeeds", r.copied === true, r);
    check("the account folder has the Database, settings and the Facebook profile", ["scout.db", "config.json", path.join("browser-profiles", "default", "Cookies")].every((f) => fs.existsSync(path.join(users, USER, f))));
    check("the old backups stay with the local data", !fs.existsSync(path.join(users, USER, "backups")) && fs.existsSync(path.join(local, "backups", "clynx-20261001-000000.db")));
    check("a marker records where it came from", fs.existsSync(path.join(users, USER, "imported-from-local.json")));
    check("the ORIGINAL is untouched (copied, not moved)", fs.readFileSync(path.join(local, "scout.db"), "utf-8") === "database bytes" && fs.existsSync(path.join(local, "browser-profiles", "default", "Cookies")));
    check("no temporary folder is left", dirs(users).every((n) => !n.startsWith(".import-")), dirs(users));

    const again = importLocalData(users, USER, () => 2000);
    check("a second import never overwrites an account that already has data", again.copied === false && fs.readFileSync(path.join(users, USER, "scout.db"), "utf-8") === "database bytes", again);

    const other = "99999999-2222-4333-8444-555555555555";
    fs.mkdirSync(path.join(users, other), { recursive: true });
    fs.writeFileSync(path.join(users, other, "config.json"), "account config only");
    const kept = importLocalData(users, other, () => 3000);
    check("a folder with no Database is set aside, not deleted", kept.copied === true && kept.keptPrevious !== null && fs.readFileSync(path.join(kept.keptPrevious as string, "config.json"), "utf-8") === "account config only", kept);

    check("it refuses to copy into the local folder itself, or a hostile id", !importLocalData(users, LOCAL_USER_ID).copied && !importLocalData(users, "../../evil").copied && !importLocalData(users, "x").copied);
    check("with no local data there is nothing to copy", !importLocalData(path.join(root, "empty-users"), USER).copied);
  }

  section("working offline, and a revoked sign-in");
  {
    const sessionPath = path.join(root, "cloud-session.json");
    const config = { cloud: { enabled: true, apiUrl: "http://127.0.0.1:1" } } as unknown as Config;
    writeSession(sessionPath, { deviceId: "d1", refreshToken: "rt-old", userId: USER, email: "me@example.test", apiUrl: "http://127.0.0.1:18999" });
    CloudClient.RESTORE_RETRY_DELAYS_MS = [10, 10];
    CloudClient.OFFLINE_RETRY_MS = 60;
    const realFetch = globalThis.fetch;
    let mode: "down" | "ok" | "revoked" = "down";
    let refreshCalls = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        refreshCalls++;
        if (mode === "down") throw new TypeError("fetch failed");
        if (mode === "revoked") return new Response(JSON.stringify({ error: "Refresh token not recognized" }), { status: 401 });
        void init;
        return new Response(JSON.stringify({ accessToken: "at-new", refreshToken: "rt-new", userId: USER }), { status: 200 });
      }
      if (url.endsWith("/devices/register")) return new Response(JSON.stringify({ id: "d2" }), { status: 201 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const client = new CloudClient(() => config, sessionPath);
      const events: string[] = [];
      client.setSessionListener({ onOnline: () => events.push("online"), onRejected: () => events.push("rejected") });

      const r = await client.restoreSession();
      check("with the server unreachable the session is restored OFFLINE, with the saved account", r.ok === false && r.offline === true && r.userId === USER && r.email === "me@example.test", r);
      check("offline there is no access token, so no cloud call can be made with a stale one", client.isAuthenticated() === false);
      check("the saved sign-in is kept for later", JSON.parse(fs.readFileSync(sessionPath, "utf-8")).refreshToken === "rt-old");
      const before = refreshCalls;
      mode = "ok";
      for (let i = 0; i < 60 && !client.isAuthenticated(); i++) await new Promise((res) => setTimeout(res, 50));
      check("when the connection returns the app signs back in by itself", client.isAuthenticated() === true && refreshCalls > before);
      check("and is told it is online again", events.includes("online"), events);
      check("the rotated refresh token was saved", JSON.parse(fs.readFileSync(sessionPath, "utf-8")).refreshToken === "rt-new");
      client.stopAuthRefresh();

      // a revoked sign-in (computer removed on the website): the server answers 401 -> signed out and told
      writeSession(sessionPath, { deviceId: "d1", refreshToken: "rt-revoked", userId: USER, email: "me@example.test", apiUrl: "http://127.0.0.1:18999" });
      mode = "down";
      const c2 = new CloudClient(() => config, sessionPath);
      const ev2: string[] = [];
      c2.setSessionListener({ onOnline: () => ev2.push("online"), onRejected: () => ev2.push("rejected") });
      await c2.restoreSession();
      mode = "revoked";
      for (let i = 0; i < 60 && !ev2.includes("rejected"); i++) await new Promise((res) => setTimeout(res, 50));
      check("when the server says the sign-in is no longer valid, the app is told and ends it", ev2.includes("rejected") && !ev2.includes("online"), ev2);
      check("the saved sign-in is cleared so it cannot be reused", JSON.parse(fs.readFileSync(sessionPath, "utf-8")).refreshToken === null);
      c2.stopAuthRefresh();

      // a rejected restore at start-up (not offline) is a normal sign-out, not "offline"
      writeSession(sessionPath, { deviceId: "d1", refreshToken: "rt-x", userId: USER, email: "me@example.test", apiUrl: "http://127.0.0.1:18999" });
      const c3 = new CloudClient(() => config, sessionPath);
      const r3 = await c3.restoreSession();
      check("a refused token at start-up is NOT treated as offline", r3.ok === false && !r3.offline, r3);
      c3.stopAuthRefresh();
    } finally {
      globalThis.fetch = realFetch;
      CloudClient.RESTORE_RETRY_DELAYS_MS = [2000, 4000, 8000];
      CloudClient.OFFLINE_RETRY_MS = 60_000;
    }
  }

  section("subscription wording");
  {
    const base: BillingStatus = {
      configured: true, plan: "pro", basePlan: "free",
      entitlements: { maxWatches: null, maxDevices: null, maxSearchItems: null, aiResearchEnabled: true, aiRequestsPerDay: 3000, aiImagesPerDay: 100 },
      subscription: { status: "trialing", phase: "trialing", currentPeriodEnd: null, trialEnd: "2026-10-20T00:00:00Z", cancelAtPeriodEnd: false, graceEndsAt: null },
      canManage: true, usage: { aiRequestsToday: 0, aiImagesToday: 0 }, trialDays: 7,
    };
    check("a trial that will convert says it will be charged", /charged/.test(describeSubscription(base).detail));
    const cancelled = describeSubscription({ ...base, subscription: { ...base.subscription!, cancelAtPeriodEnd: true } });
    check("a trial with cancellation scheduled says it will NOT be charged", /will not be charged/.test(cancelled.detail) && cancelled.tone === "warn", cancelled);
  }

  fs.rmSync(root, { recursive: true, force: true });
});
