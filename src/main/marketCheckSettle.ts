// A market check that ran out of time keeps working in the background (see index.ts's runMarketCheck). What it finds still has to land somewhere:
// the entry that was created for the check used to be deleted the moment the time ran out, so the late answer was filed into a product that no
// longer existed and was lost. Now the entry stays until the late answer decides: real prices keep it (and fill it in), no prices (or a failure)
// remove it, as they would have had the check finished in time.
export interface LateCheckResult {
  estimatedValueUsd: number | null;
  avgSoldPriceUsd: number | null;
}

export function settleLateMarketCheck(args: {
  research: Promise<LateCheckResult>;
  /** Whether the check created the Database entry (an existing entry is never deleted). */
  created: boolean;
  productId: string;
  deleteProduct(id: string): void;
  /** The same follow-up an on-time check does for a new product with prices: fill the entry in. */
  fillIn(): void;
  note?(message: string): void;
}): void {
  args.research
    .then((result) => {
      if (!args.created) return;
      const value = result.estimatedValueUsd ?? result.avgSoldPriceUsd;
      if (value === null) {
        args.deleteProduct(args.productId);
        args.note?.("The late price check found no prices, so nothing was filed.");
      } else {
        args.fillIn();
        args.note?.("The late price check finished and its prices were filed in the Database.");
      }
    })
    .catch(() => {
      if (args.created) args.deleteProduct(args.productId);
    });
}
