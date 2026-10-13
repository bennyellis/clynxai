import { describe, expect, it } from "vitest";
import { describeSubscription, formatBytes, formatDate, limitText } from "./format";

const base = { status: "active", phase: "active", currentPeriodEnd: "2030-01-15T12:00:00Z", trialEnd: null, cancelAtPeriodEnd: false, graceEndsAt: null };

describe("formatBytes", () => {
  it("handles missing and tiny values", () => {
    expect(formatBytes(null)).toBe("-");
    expect(formatBytes(0)).toBe("-");
    expect(formatBytes(10)).toBe("1 KB");
  });
  it("uses sensible units", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB");
  });
});

describe("formatDate / limitText", () => {
  it("never shows an invalid date", () => {
    expect(formatDate(null)).toBe("-");
    expect(formatDate("not a date")).toBe("-");
    expect(formatDate("2030-01-15T12:00:00Z")).toMatch(/2030/);
  });
  it("shows null as unlimited", () => {
    expect(limitText(null)).toBe("Unlimited");
    expect(limitText(1500)).toMatch(/1.?500/);
  });
});

describe("describeSubscription", () => {
  it("free plan without a subscription", () => {
    expect(describeSubscription("free", null, null).headline).toBe("Free");
  });
  it("an active subscription says when it renews", () => {
    const d = describeSubscription("pro", base, "month");
    expect(d.headline).toContain("billed monthly");
    expect(d.detail).toContain("Renews");
  });
  it("a trial with cancellation scheduled says the customer will NOT be charged", () => {
    const d = describeSubscription("pro", { ...base, phase: "trialing", trialEnd: "2030-01-08T00:00:00Z", cancelAtPeriodEnd: true }, null);
    expect(d.detail).toContain("NOT be charged");
    expect(d.tone).toBe("warn");
  });
  it("a trial without cancellation says the card will be charged", () => {
    const d = describeSubscription("pro", { ...base, phase: "trialing", trialEnd: "2030-01-08T00:00:00Z" }, null);
    expect(d.detail).toContain("charged then unless you cancel");
  });
  it("cancellation scheduled keeps Pro until the period end", () => {
    const d = describeSubscription("pro", { ...base, phase: "canceling", cancelAtPeriodEnd: true }, "year");
    expect(d.headline).toContain("cancellation scheduled");
    expect(d.detail).toContain("Pro stays until");
  });
  it("payment problems are described plainly, in grace and after it", () => {
    expect(describeSubscription("pro", { ...base, phase: "past_due_grace", graceEndsAt: "2030-02-01T00:00:00Z" }, null).headline).toContain("payment problem");
    expect(describeSubscription("free", { ...base, phase: "past_due_lapsed" }, null).headline).toContain("Pro ended");
  });
  it("an unknown phase does not crash", () => {
    expect(describeSubscription("free", { ...base, phase: "something_new" }, null).tone).toBe("plain");
  });
});
