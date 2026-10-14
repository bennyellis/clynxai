import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/index.js";
import { closePool } from "../src/db/client.js";
import { asWeb, makeOwner, signup, webLogin, type WebUser } from "./helpers/web.js";
import { computeSearchDemand } from "../src/searchPlanner/aggregate.js";

// Clynx Cloud Phase 7 — Search Planner foundation tests. Two parts:
// unit tests for computeSearchDemand in isolation (no DB), and an
// integration test through the real HTTP routes against Postgres,
// reusing watches.test.ts's registration/upsert pattern.

describe("computeSearchDemand (unit, no DB)", () => {
  it("normalizes case/whitespace and groups matching phrases together", () => {
    const groups = computeSearchDemand([
      { id: "a", phrase: "Xbox Series X" },
      { id: "b", phrase: "xbox series x" },
      { id: "c", phrase: "  Xbox   Series X  " },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].phraseNormalized).toBe("xbox series x");
    expect(groups[0].watchCount).toBe(3);
    expect(groups[0].sampleWatchIds).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });

  it("keeps distinct phrases as distinct groups, sorted by watchCount descending", () => {
    const groups = computeSearchDemand([
      { id: "a", phrase: "ps5" },
      { id: "b", phrase: "ps5" },
      { id: "c", phrase: "nintendo switch" },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].phraseNormalized).toBe("ps5");
    expect(groups[0].watchCount).toBe(2);
    expect(groups[1].phraseNormalized).toBe("nintendo switch");
    expect(groups[1].watchCount).toBe(1);
  });

  it("returns an empty array for empty input", () => {
    expect(computeSearchDemand([])).toEqual([]);
  });
});

describe("search planner routes (integration)", () => {
  let app: FastifyInstance;
  let owner: WebUser;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
    // the planner reads every customer's Watches: since Phase 12 only the Owner (website session) may use it
    const o = await signup(app);
    await makeOwner(o.id);
    owner = await webLogin(app, o.email);
  });

  afterAll(async () => {
    await app?.close();
    await closePool();
  });

  function uniqueEmail(): string {
    return `search-planner-test-${randomUUID()}@example.com`;
  }

  async function registerUser(): Promise<{ accessToken: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: uniqueEmail(), password: "correct-horse-battery" },
    });
    return res.json();
  }

  function baseWatch(overrides: Record<string, unknown> = {}) {
    return {
      name: "Watch",
      searchPhrase: "ps5",
      matchKeywords: ["ps5"],
      linkedProductId: null,
      minPriceUsd: null,
      maxPriceUsd: null,
      minProfitUsd: null,
      minDiscountPercent: null,
      maxListingAgeMinutes: null,
      locationMode: "city",
      selectedState: null,
      selectedCityOrZip: "90210",
      searchRadiusMiles: 25,
      resolvedLocationUrl: null,
      resolvedLocationLabel: null,
      resolvedLocationCheckedAt: null,
      enabled: true,
      listingsSeenCount: 0,
      matchCount: 0,
      lastCheckedAt: null,
      lastActiveCheckAt: null,
      nextCheckAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  async function createWatch(accessToken: string, searchPhrase: string) {
    const localId = randomUUID();
    const res = await app.inject({
      method: "PUT",
      url: `/watches/${localId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseWatch({ searchPhrase }),
    });
    expect(res.statusCode).toBe(201);
    return res.json().watch.id as string;
  }

  it("aggregates search demand across multiple users' watches and serves the latest snapshot", async () => {
    // Distinct, uniquely-suffixed phrases per test run so this test's
    // groups are isolated from any other data that may exist in the
    // shared watches table across test runs.
    const suffix = randomUUID().slice(0, 8);
    const xbox = `Xbox Series X ${suffix}`;
    const xboxVariant = `  xbox   series x ${suffix}  `;
    const switchPhrase = `Nintendo Switch ${suffix}`;

    const userA = await registerUser();
    const userB = await registerUser();

    // Two users both watching (a normalized-equal) "Xbox Series X" phrase,
    // plus one distinct "Nintendo Switch" watch — across users, not just
    // within one.
    await createWatch(userA.accessToken, xbox);
    await createWatch(userB.accessToken, xboxVariant);
    await createWatch(userA.accessToken, switchPhrase);

    const aggregateRes = await app.inject({
      method: "POST",
      url: "/search-planner/aggregate",
      headers: asWeb(owner),
    });
    expect(aggregateRes.statusCode).toBe(200);
    const aggregateBody = aggregateRes.json();
    expect(aggregateBody.computedAt).toBeTruthy();

    const xboxNormalized = `xbox series x ${suffix}`;
    const switchNormalized = `nintendo switch ${suffix}`.toLowerCase();

    const xboxGroup = aggregateBody.groups.find((g: any) => g.phraseNormalized === xboxNormalized);
    const switchGroup = aggregateBody.groups.find((g: any) => g.phraseNormalized === switchNormalized);
    expect(xboxGroup).toBeTruthy();
    expect(xboxGroup.watchCount).toBe(2);
    expect(switchGroup).toBeTruthy();
    expect(switchGroup.watchCount).toBe(1);

    const demandRes = await app.inject({
      method: "GET",
      url: "/search-planner/demand",
      headers: asWeb(owner),
    });
    expect(demandRes.statusCode).toBe(200);
    const demandBody = demandRes.json();

    const demandXbox = demandBody.demand.find((d: any) => d.phraseNormalized === xboxNormalized);
    const demandSwitch = demandBody.demand.find((d: any) => d.phraseNormalized === switchNormalized);
    expect(demandXbox).toBeTruthy();
    expect(demandXbox.watchCount).toBe(2);
    expect(demandSwitch).toBeTruthy();
    expect(demandSwitch.watchCount).toBe(1);

    // Latest snapshot batch is sorted by watch_count descending.
    const xboxIndex = demandBody.demand.findIndex((d: any) => d.phraseNormalized === xboxNormalized);
    const switchIndex = demandBody.demand.findIndex((d: any) => d.phraseNormalized === switchNormalized);
    expect(xboxIndex).toBeLessThan(switchIndex);
  });

  it("requires auth on both routes", async () => {
    const aggregateRes = await app.inject({ method: "POST", url: "/search-planner/aggregate" });
    expect(aggregateRes.statusCode).toBe(401);

    const demandRes = await app.inject({ method: "GET", url: "/search-planner/demand" });
    expect(demandRes.statusCode).toBe(401);
  });
});
