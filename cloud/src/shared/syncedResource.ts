import { query } from "../db/client.js";

// Fix 5 (batch 1 cloud fix pass) — shared helpers extracted from
// watches/routes.ts, feedback/routes.ts, and products/routes.ts, which
// each hand-rolled near-identical ownership-check and last-write-wins
// comparison logic.
//
// A FULLY generic upsert helper (one function taking a table name, a
// column-value map, and doing the whole lookup -> compare -> UPDATE/INSERT
// -> return dance) was deliberately NOT extracted: watches (~15 columns),
// feedback (3 columns), and products (~15 different columns) have
// genuinely different column sets, and the only way to make one function
// cover all three is dynamic, string-concatenated SQL column lists — which
// trades a small amount of duplication for a real risk of a typo silently
// writing to (or reading) the wrong column, or a subtly wrong parameter
// order, with no compile-time check catching it. That's a worse trade than
// three explicit, readable, type-checked SQL statements. Each resource's
// INSERT/UPDATE stays in its own routes.ts file.
//
// What WAS safe to extract, and is used by all three:
//   - requireOwnedRow: the fetch-by-id -> 404-if-missing -> 403-if-wrong-user
//     pattern, identical across watches' and products' DELETE routes (and
//     watches' matches routes).
//   - isStaleUpdate: the one-line "is the incoming write older than or
//     tied with what's already stored" comparison every upsert route uses
//     to decide whether to apply a write.

export type OwnershipCheck = { status: "not_found" } | { status: "forbidden" } | { status: "ok" };

// Fetches `table`'s row_id -> user_id and classifies it as not-found,
// forbidden (exists, but owned by a different user), or ok. `table` is
// ALWAYS a fixed literal supplied by the calling route (e.g. "watches"),
// never user input — safe to interpolate directly; there is no parameter
// placeholder for identifiers in the pg driver.
export async function requireOwnedRow(table: "watches" | "user_products", id: string, userId: string): Promise<OwnershipCheck> {
  const existing = await query<{ user_id: string }>(`SELECT user_id FROM ${table} WHERE id = $1`, [id]);
  const row = existing.rows[0];
  if (!row) return { status: "not_found" };
  if (row.user_id !== userId) return { status: "forbidden" };
  return { status: "ok" };
}

// Last-write-wins gate used by every PUT upsert route: an incoming write
// is rejected (not applied) when it's older than, or tied with, what's
// already stored — the caller is expected to reconcile by pulling the
// server's current version back down instead.
export function isStaleUpdate(currentUpdatedAt: number, incomingUpdatedAt: number): boolean {
  return currentUpdatedAt >= incomingUpdatedAt;
}
