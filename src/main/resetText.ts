// The words of the Reset Clynx dialog and the one fact the database part needs. No imports, so the screen can use it too.

export const RESET_CONFIRM_WORD = "RESET";

/** Shown in the dialog. Keep these in step with what resetAllData and freshConfig really do (tested). */
export const RESET_ERASES = [
  "Your whole Library: products, reference photos, folders, the Trash and Needs review",
  "Everything Clynx learned: product knowledge, research, photo and deal corrections, the blacklist",
  "Your Feed history and saved listings, your Watches, your Search For list and Recent searches",
  "Your custom instructions and every setting on the Config screen (back to the defaults)",
  "The welcome tour will run again",
] as const;
export const RESET_KEEPS = [
  "Your Clynx sign-in and account",
  "Your OpenAI, eBay and other saved keys",
  "Your Facebook logins, unless you tick the box below",
  "Your safety backups (a fresh one is made first, so this can be undone)",
] as const;

/** Tables that survive a reset: the record of deletes still to be told to Clynx Cloud, and the app's own schema markers. */
export const RESET_KEEPS_TABLES = ["pending_cloud_deletes", "schema_flags"] as const;
