// A beta tester has every plan limit lifted but is not an administrator or the Owner. Pure: no database needed.
import { describe, it, expect } from "vitest";
import { getEntitlementsForPlan, getOwnerEntitlements, higherPlan, isPlan, tierForPlan } from "../src/entitlements/plans.js";

describe("tester plan", () => {
  it("is a plan", () => {
    expect(isPlan("tester")).toBe(true);
    expect(isPlan("admin")).toBe(false);
    expect(isPlan("owner")).toBe(false);
  });
  it("lifts every plan limit", () => {
    const e = getEntitlementsForPlan("tester");
    expect(e).toEqual({ maxWatches: null, maxDevices: null, maxSearchItems: null, aiResearchEnabled: true, aiRequestsPerDay: null, aiImagesPerDay: null });
    expect(e).toEqual(getOwnerEntitlements());
  });
  it("is better than Pro and Free, so a subscription can never lower it", () => {
    expect(higherPlan("free", "tester")).toBe("tester");
    expect(higherPlan("tester", "pro")).toBe("tester");
    expect(higherPlan("tester", "free")).toBe("tester");
  });
  it("does not change the other plans", () => {
    expect(getEntitlementsForPlan("free").aiRequestsPerDay).toBe(150);
    expect(getEntitlementsForPlan("pro").aiRequestsPerDay).toBe(3000);
  });
  it("shares the Owner's safety tier, and an owner stays an owner", () => {
    expect(tierForPlan(false, "tester")).toBe("tester");
    expect(tierForPlan(true, "free")).toBe("owner");
    expect(tierForPlan(false, "pro")).toBe("pro");
    expect(tierForPlan(false, "free")).toBe("free");
  });
  it("returns a copy, so callers cannot change the shared definition", () => {
    const a = getEntitlementsForPlan("tester");
    a.maxWatches = 1;
    expect(getEntitlementsForPlan("tester").maxWatches).toBeNull();
  });
});
