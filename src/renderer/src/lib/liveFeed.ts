// What one tile in the Discovery "Live feed" column shows (AUDITOR proposal section 1, owner-accepted): the same idea as the Dashboard's Live tiles, stacked vertically. A product Clynx is
// researching right now gets the full live tile (photo, the dot, its latest thought); a finished one folds to one compact line so the column stays calm. Pure: the entry, the verdict and the
// clock go in, the words come out. No change to how entries are created, ordered or stored.
import type { DiscoveryEntry } from "../../../main/discovery.js";
import type { FlipLevel } from "../../../main/productVerdict.js";

export type TileTone = "live" | "good" | "info" | "warn" | "bad" | "dim";

export interface LiveTileModel {
  /** The small status chip: Researching / Worth flipping / Decent / Marginal / Not great / Can't judge / Didn't work out. */
  chip: string;
  tone: TileTone;
  /** One status line under the name: the latest thought while researching, else the value and how long ago. */
  line: string;
  researching: boolean;
  /** Finished tiles are one compact line; only a researching tile is the full live tile. */
  compact: boolean;
  /** "3 min ago". */
  ago: string;
}

export function agoText(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

const CHIP: Record<FlipLevel, { text: string; tone: TileTone }> = {
  strong: { text: "Worth flipping", tone: "good" },
  decent: { text: "Decent", tone: "info" },
  thin: { text: "Marginal", tone: "warn" },
  pass: { text: "Not great", tone: "bad" },
  unknown: { text: "Can't judge", tone: "dim" },
};

const money = (n: number) => `$${Math.round(n)}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The latest thing Clynx said about this product, in its own words, for the live tile (a "start" line is the opener and is only used when nothing else was said yet). */
export function latestThought(entry: Pick<DiscoveryEntry, "thoughts">): string | null {
  const said = entry.thoughts.filter((t) => t.text && t.text.trim());
  const last = [...said].reverse().find((t) => t.kind !== "start") ?? said[said.length - 1];
  return last ? clip(last.text.replace(/\s+/g, " ").trim(), 110) : null;
}

export function liveTileModel(entry: Pick<DiscoveryEntry, "status" | "startedAt" | "finishedAt" | "thoughts">, level: FlipLevel | null, valueUsd: number | null, now: number): LiveTileModel {
  const ago = agoText(entry.finishedAt ?? entry.startedAt, now);
  if (entry.status === "researching") {
    return { chip: "Researching", tone: "live", line: latestThought(entry) ?? "Looking into it", researching: true, compact: false, ago };
  }
  if (entry.status === "failed") {
    return { chip: "Didn't work out", tone: "warn", line: ago, researching: false, compact: true, ago };
  }
  const chip = CHIP[level ?? "unknown"];
  return { chip: chip.text, tone: chip.tone, line: valueUsd !== null && valueUsd > 0 ? `Worth about ${money(valueUsd)} · ${ago}` : ago, researching: false, compact: true, ago };
}

/** Researching tiles first (newest first), then the rest in the order they arrived; the column never reshuffles finished tiles while you read them. */
export function orderTiles<T extends { status: string; startedAt: number }>(entries: T[]): T[] {
  const researching = entries.filter((e) => e.status === "researching").sort((a, b) => b.startedAt - a.startedAt);
  const rest = entries.filter((e) => e.status !== "researching");
  return [...researching, ...rest];
}
