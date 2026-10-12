import type { Account, Config, ScrapeStatus } from "../../../main/types.js";
import { describeTopicStrength } from "../../../main/ntfyTopic.js";

// The first-run checklist, worked out from the REAL state wherever the state can be seen (a Facebook login, a search location, a product,
// a phone topic). The few stored flags (Config.onboarding) only remember what cannot be seen: dismissed, skipped, "nationwide is fine".
export type ChecklistStepId = "facebook" | "location" | "product" | "phone";

export interface ChecklistStep {
  id: ChecklistStepId;
  title: string;
  description: string;
  done: boolean;
  // Recommended but can be skipped (phone alerts).
  skippable: boolean;
}

export interface OptionalExtra {
  id: "ebay" | "watchcount";
  title: string;
  description: string;
}

export interface ChecklistModel {
  steps: ChecklistStep[];
  doneCount: number;
  total: number;
  allDone: boolean;
  // Integrations that are NOT part of getting started; shown separately and clearly marked optional.
  extras: OptionalExtra[];
  dismissed: boolean;
}

export const OPTIONAL_EXTRAS: OptionalExtra[] = [
  {
    id: "ebay",
    title: "eBay search and sold-price lookups",
    description: "Optional. Needs eBay developer keys. Clynx works fully on Facebook Marketplace without it; add it later in Config if you also want to scan eBay.",
  },
  {
    id: "watchcount",
    title: "A free WatchCount login",
    description: "Optional. Raises the daily limit for looking up what items really sold for (20 a day without an account, 200 with one). Not needed to get started.",
  },
];

export function buildChecklist(args: { config: Config; accounts: Account[]; statusMap: Record<string, ScrapeStatus> }): ChecklistModel {
  const { config, accounts, statusMap } = args;
  const ob = config.onboarding ?? { dismissed: false, facebookConnected: false, locationChosen: false, phoneSkipped: false };

  const facebookDone = ob.facebookConnected || accounts.some((a) => statusMap[a.id]?.loggedIn === true);
  const locationDone = ob.locationChosen || accounts.some((a) => a.locationMode !== "country" && !!(a.selectedState || a.selectedCityOrZip));
  const productDone = config.searchItems.length > 0 || (config.recentSearches?.length ?? 0) > 0;
  const topicStrength = describeTopicStrength(config.ntfy?.topic ?? "");
  const phoneDone = ob.phoneSkipped || topicStrength === "private" || topicStrength === "guessable";

  const steps: ChecklistStep[] = [
    { id: "facebook", title: "Connect Facebook", description: "Clynx reads Marketplace through a Chrome window that stays logged in to your Facebook. Your password is typed into Facebook itself, never into Clynx.", done: facebookDone, skippable: false },
    { id: "location", title: "Choose where to look", description: "Pick a city or state to search around, or keep the nationwide default.", done: locationDone, skippable: false },
    { id: "product", title: "Add your first product", description: "Tell Clynx what to hunt for (for example “PlayStation 5”). It will find and judge listings for it.", done: productDone, skippable: false },
    { id: "phone", title: "Get deal alerts on your phone", description: "Recommended. A free app on your phone buzzes when Clynx finds a real deal. You can skip this and set it up later in Config.", done: phoneDone, skippable: true },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, total: steps.length, allDone: doneCount === steps.length, extras: OPTIONAL_EXTRAS, dismissed: ob.dismissed };
}
