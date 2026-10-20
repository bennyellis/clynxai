// Sold-comps retrieval (AUDITOR_SOLD_COMPS_RESEARCH_2026-10-20, owner-accepted): one provider interface, a local database of what sold, and identity matching that reuses compIdentity. This
// module is STANDALONE: nothing in Clynx's research calls it yet, it never touches the network by itself, and no existing table or code path is changed.
//
// The schema is provider-agnostic on purpose. What eBay's Marketplace Insights returns per sale, and what the API License Agreement allows us to store and for how long, were NOT verified
// (they need the approved account and the agreement); `expiresAt` makes a retention limit a setting, not a rewrite.

export type SoldSource = "marketplace_insights" | "manual_import" | "watchcount";

/** One historical sale, in the shape every provider maps into. Prices are in `currency` (USD unless the source says otherwise). */
export interface SoldComp {
  /** Stable id: `${source}:${sourceListingId}` when the source has one, else a hash of the sale's own fields. */
  id: string;
  source: SoldSource;
  sourceListingId: string | null;
  title: string;
  soldPrice: number;
  currency: string;
  /** When it sold (ms since epoch); null when the source does not say (WatchCount's cards do not). */
  soldAt: number | null;
  condition: string | null;
  shippingCost: number | null;
  quantitySold: number | null;
  buyingOption: string | null;
  gtin: string | null;
  epid: string | null;
  categoryId: string | null;
  imageUrl: string | null;
  /** Only kept when the source's licence allows it. */
  seller: string | null;
  fetchedAt: number;
  /** After this the row is purged (retention limit from the source's licence); null = keep (the owner's own imports). */
  expiresAt: number | null;
  /** The source's own record, kept so a wrong mapping can be audited. */
  raw: unknown;
}

export interface SoldCompsQuery {
  title: string;
  gtin?: string | null;
  epid?: string | null;
  categoryId?: string | null;
  /** Item specifics, e.g. { Storage: "2 TB" }. */
  aspects?: Record<string, string>;
  limit?: number;
}

/**
 * Why a provider returned what it returned. A zero is never silent: "none" means the source answered and had no sales, "blocked" means it did not answer properly (a security-check or limit
 * page, a rate limit), so the zero says nothing about the market (backlog B3).
 */
export type ProviderOutcome =
  | { kind: "ok"; detail?: string }
  | { kind: "none"; detail: string }
  | { kind: "blocked"; detail: string }
  /** The source returned nothing and the page could not be told apart from a hidden block: neither "no sales" nor "blocked" is known. Never cached. */
  | { kind: "unclear"; detail: string }
  | { kind: "disabled"; detail: string }
  | { kind: "not_configured"; detail: string }
  | { kind: "error"; detail: string };

export interface ProviderResult {
  comps: SoldComp[];
  outcome: ProviderOutcome;
}

export interface SoldCompsProvider {
  readonly id: SoldSource;
  readonly label: string;
  /** Data that comes from a third party (shown as such; never presented as eBay's own). */
  readonly thirdParty: boolean;
  /** false for a local table whose contents change between asks (the owner's imports): its answer is never reused from the day's cache. Default true. */
  readonly cacheable?: boolean;
  search(query: SoldCompsQuery): Promise<ProviderResult>;
}

export const DAY_MS = 24 * 3600_000;

/**
 * A GTIN / UPC / EAN compared by its digits without leading zeros (a 12-digit UPC and the same code as a 13-digit EAN are one product). Empty string when the value is not a usable code:
 * placeholders ("N/A", "Does not apply", "0"), all zeros, a length other than 8-14 digits, or a spreadsheet mangling ("889842640816.0", "8.89842640816E+11").
 */
export const normGtin = (g: string | null | undefined): string => {
  const raw = (g ?? "").trim();
  if (!raw || /[eE][+-]?\d/.test(raw) || /\.\d+$/.test(raw)) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 14) return "";
  const stripped = digits.replace(/^0+/, "");
  return stripped;
};

/** An ePID compared without case or surrounding spaces; empty when there is none. */
export const normEpid = (e: string | null | undefined): string => (e ?? "").trim().toUpperCase();
