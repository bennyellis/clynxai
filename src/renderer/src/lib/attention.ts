// Attention dots: a pulsing dot wherever something inside Database needs a person to look - the sidebar icon, the Needs review button, the folders and the entries themselves. A dot stays until the
// item that needs attention is OPENED (clicking a folder or an entry above it does not clear it); resolving the item removes it. Pure helpers here; the hook in useAttention.ts talks to the app.
export interface AttentionItem {
  id: string;
  kind: string;
  productIds: string[];
}
export interface AttentionSummary {
  count: number;
  items: AttentionItem[];
}

/** Only this many dots pulse at once; the rest are steady, so a long list is calm. */
export const MAX_PULSING_DOTS = 6;

export const emptyAttention: AttentionSummary = { count: 0, items: [] };

/** The entries that have something waiting, in a stable order. */
export function attentionProductIds(summary: AttentionSummary): string[] {
  return [...new Set(summary.items.flatMap((i) => i.productIds))];
}

/** How many unopened items touch these entries (a folder's dot is derived from everything below it). */
export function attentionBelow(summary: AttentionSummary, productIds: ReadonlyArray<string>): number {
  const set = new Set(productIds);
  return summary.items.filter((i) => i.productIds.some((p) => set.has(p))).length;
}

/** Whether this dot should pulse: the first few in the stable order do, the rest stay steady. */
export function shouldPulse(summary: AttentionSummary, productIds: ReadonlyArray<string>): boolean {
  const order = attentionProductIds(summary);
  const set = new Set(productIds);
  const first = order.findIndex((p) => set.has(p));
  return first >= 0 && first < MAX_PULSING_DOTS;
}

/** The accessible label: "3 things need your attention" / "1 thing needs your attention". */
export function attentionLabel(count: number): string {
  return count === 1 ? "1 thing needs your attention" : `${count} things need your attention`;
}
