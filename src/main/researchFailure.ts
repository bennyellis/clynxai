// What the person is told when a research run could not happen. The raw error ("Your AI access is paused...", "the web search was blocked or unreachable...") belongs in the log,
// never in a product's description: this turns it into one plain sentence, and says what Clynx does next. Pure.

export function friendlyResearchFailure(message: string): string {
  const m = String(message ?? "");
  if (/incorrect api key|invalid api key|invalid_api_key|\b401\b|unauthori[sz]ed/i.test(m)) {
    return "OpenAI did not accept the API key, so this will not fix itself. Check the key in Settings, then press Research.";
  }
  if (/paused for a while|temporarily_blocked|unusually heavy use|too many ai requests|concurrency|asking the ai too fast/i.test(m)) {
    return "Clynx's AI access is paused for a few minutes. I'll try this one again by myself.";
  }
  if (/allowance|plan limit|budget/i.test(m)) {
    return "The AI allowance for now is used up. I'll try this one again later.";
  }
  if (/credits are used up|insufficient_quota/i.test(m)) {
    return "Your OpenAI credit balance is empty. I'll try this one again once credits are added.";
  }
  if (/blocked or unreachable|search|network|fetch|timed out|timeout|econn|enotfound/i.test(m)) {
    return "The web search was blocked or could not be reached just now. I'll try this one again by myself.";
  }
  return "The research could not finish just now. I'll try this one again by myself.";
}

/** The eBay / WatchCount price check could not run: one plain sentence, and what it means for the price already shown. The raw error is only for the log. */
export function friendlyPriceCheckFailure(message: string): string {
  const m = String(message ?? "");
  if (/launchPersistentContext|browserType|chrome|chromium|playwright|target closed|browser has been closed/i.test(m)) {
    return "The browser Clynx uses to check eBay prices was busy or could not start just now, so the price was not refreshed. What was there before is unchanged; try Research again in a minute.";
  }
  if (/timeout|timed out|econn|enotfound|network|fetch/i.test(m)) {
    return "The eBay price check timed out, so the price was not refreshed. What was there before is unchanged; try Research again later.";
  }
  if (/paused for a while|temporarily_blocked|allowance|plan limit|credits/i.test(m)) {
    return "The eBay price check could not run because Clynx's AI access is paused for now, so the price was not refreshed.";
  }
  return "The eBay price check could not finish just now, so the price was not refreshed. What was there before is unchanged.";
}

/** How many failed tries Clynx makes on its own before it leaves a product alone (the waits are Store.RESEARCH_RETRY_DELAYS_MS). */
export const AUTO_RETRY_ATTEMPTS = 4;

/** The sold-price lookup (a WatchCount tab in a browser) could not be read: a plain note that says what the research falls back to. The raw error stays in the log. */
export function friendlySoldFailure(message: string): string {
  const m = String(message ?? "");
  if (/deadline|took too long/i.test(m)) return "WatchCount took too long to answer, so I'm going by what sellers are asking on eBay right now.";
  if (/launchPersistentContext|browserType|chrome|chromium|playwright|target closed|browser has been closed/i.test(m)) {
    return "The browser I use to read sold prices could not start just now, so I'm going by what sellers are asking on eBay right now.";
  }
  return "I could not read sold prices just now, so I'm going by what sellers are asking on eBay right now.";
}

/**
 * Runs the sold-price lookup but never lets its failure (a browser that will not start, a page that hangs) take the whole price research down with it, and never lets it hang
 * (Beta 28 live test: a Galaxy research sat on "Looking into it" for 15+ minutes behind overlapping browser launches, and a product with 22 accepted asking prices got no price because
 * the sold lookup threw first). Returns the comps, or an empty list plus why.
 */
export async function softSoldLookup<T>(lookup: () => Promise<T[]>, deadlineMs: number): Promise<{ comps: T[]; failure: string | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const comps = await Promise.race([
      lookup(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the sold-price lookup passed its deadline (${Math.round(deadlineMs / 1000)}s)`)), deadlineMs);
      }),
    ]);
    return { comps, failure: null };
  } catch (e) {
    return { comps: [], failure: (e as Error).message ?? "unknown error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** How long the sold-price lookup may take before the research goes on without it. */
export const SOLD_LOOKUP_DEADLINE_MS = 120_000;
