// How sure Clynx is of a fact, and how good a source is. Pure.
//
// A fact about a product is never just "true": it was OBSERVED in a photo, REPORTED by the seller, RESEARCHED on the web, VERIFIED by a source good enough to settle it, INFERRED
// by reasoning, or is UNKNOWN. Nothing is upgraded silently: a seller's claim stays "seller_reported" however many times it is repeated, and only a source of the right quality
// (or two independent ones) can make research "verified".
import { classifySource, type SourceClass } from "./variantEvidence.js";

export type EvidenceKind = "observed" | "seller_reported" | "researched" | "verified" | "inferred" | "owner_asserted" | "unknown";
// owner_asserted: the Clynx owner told it so (a note in its instructions). It is not research: it is labelled as the owner's word, may rule candidates out, and is upgraded to
// "verified" only when a source of official quality is actually read.

/** Best to worst, per the order Clynx trusts sources in. */
export type SourceQuality = "official" | "specialist" | "retailer" | "collector" | "marketplace" | "other";
export const QUALITY_RANK: Record<SourceQuality, number> = { official: 1, specialist: 2, retailer: 3, collector: 4, marketplace: 5, other: 6 };

// Independent, reputable product catalogues and reviewers (not the maker, not a shop).
const SPECIALIST = new Set(["techpowerup", "gsmarena", "rtings", "notebookcheck", "tomshardware", "anandtech", "arstechnica", "theverge", "gamespot", "ign"]);
// Collector and fan documentation: useful for discovering that something exists, not proof of what the maker released.
const COLLECTOR = new Set(["consolevariations", "bulbapedia", "fandom", "wikia", "pricecharting", "reddit", "youtube", "wikipedia"]);

function labelOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".");
    return parts.length >= 2 ? parts[parts.length - 2] : host;
  } catch {
    return "";
  }
}

export function sourceQuality(url: string, productName: string, brandHints: string[] = []): SourceQuality {
  const cls: SourceClass = classifySource(url, productName, brandHints);
  if (cls === "manufacturer") return "official";
  if (cls === "marketplace") return "marketplace";
  const label = labelOf(url);
  if (SPECIALIST.has(label)) return "specialist";
  if (COLLECTOR.has(label) || cls === "reference") return "collector";
  if (cls === "retailer") return "retailer";
  return "other";
}

export interface FactSource {
  url: string;
  quality: SourceQuality;
  /** What the source says, in its own words (a short quote). */
  quote?: string;
  /** The source contradicts the claim rather than supporting it. */
  contradicts?: boolean;
}

/**
 * What a set of sources adds up to. `verified`: an official source supports it and none contradicts it. `researched`: at least two independent non-marketplace sources, or one
 * specialist, agree. A claim that only a marketplace or the seller makes stays `seller_reported`. Any contradiction from a source of equal or better quality makes it `disputed`.
 */
export function evidenceFromSources(sources: FactSource[]): { kind: EvidenceKind; disputed: boolean; best: SourceQuality | null } {
  const supporting = sources.filter((s) => !s.contradicts);
  const against = sources.filter((s) => s.contradicts);
  const best = supporting.length ? supporting.map((s) => s.quality).sort((a, b) => QUALITY_RANK[a] - QUALITY_RANK[b])[0] : null;
  const bestAgainst = against.length ? against.map((s) => s.quality).sort((a, b) => QUALITY_RANK[a] - QUALITY_RANK[b])[0] : null;
  const disputed = !!bestAgainst && (!best || QUALITY_RANK[bestAgainst] <= QUALITY_RANK[best] || supporting.length <= against.length);
  if (!supporting.length) return { kind: "unknown", disputed, best };
  if (best === "official" && !disputed) return { kind: "verified", disputed, best };
  const independent = new Set(supporting.filter((s) => s.quality !== "marketplace").map((s) => labelOf(s.url)));
  if (!disputed && (independent.size >= 2 || best === "specialist")) return { kind: "researched", disputed, best };
  if (supporting.every((s) => s.quality === "marketplace")) return { kind: "seller_reported", disputed, best };
  return { kind: "researched", disputed, best };
}

/** A fact with the state it is in. Callers must carry `kind`; a plain value is never passed around as if it were verified. */
export interface Fact<T = string> {
  value: T;
  kind: EvidenceKind;
  sources?: FactSource[];
}

/** Whether a fact is strong enough to rule a candidate out. Observed and verified facts may; a seller's word, an inference or an unknown may not. */
export const canEliminate = (k: EvidenceKind): boolean => k === "observed" || k === "verified" || k === "researched" || k === "owner_asserted";
