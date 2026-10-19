// What the person is told when a research run could not happen. The raw error ("Your AI access is paused...", "the web search was blocked or unreachable...") belongs in the log,
// never in a product's description: this turns it into one plain sentence, and says what Clynx does next. Pure.

export function friendlyResearchFailure(message: string): string {
  const m = String(message ?? "");
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
