// "Reset Clynx": return this user's Clynx on this computer to a freshly installed state, without touching the sign-in. What is erased and what is kept is spelled out in ONE place
// (RESET_ERASES / RESET_KEEPS) and shown to the person before they confirm. Pure: the file and database work is done by the caller (index.ts) and Store.resetAllData.
import { DEFAULT_CONFIG } from "./config.js";
import type { Config } from "./types.js";

export { RESET_CONFIRM_WORD, RESET_ERASES, RESET_KEEPS } from "./resetText.js";

/** The Config after a reset: the defaults, keeping only the connection to Clynx Cloud (and, unless asked, the Facebook accounts and their logins). */
export function freshConfig(current: Config, opts: { keepFacebook: boolean }): Config {
  const base: Config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (current.cloud) base.cloud = { ...current.cloud };
  // owner/test switches are not learned data: they stay (a reset must not turn OpenAI search off)
  if (current.beta13) base.beta13 = { ...current.beta13 };
  if (current.openaiSearchPerHour != null) base.openaiSearchPerHour = current.openaiSearchPerHour;
  if (opts.keepFacebook && current.accounts?.length) {
    // the same accounts and locations, so their saved logins (browser profiles) still belong to them
    base.accounts = JSON.parse(JSON.stringify(current.accounts));
  }
  delete base.onboarding; // the welcome tour runs again
  return base;
}
