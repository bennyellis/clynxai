// Beta 13: which of a product's photos stand for "what it looks like". It used to be the NEWEST ones (listProductImages is newest-first and callers took [0] / slice(0,2)),
// so whatever was filed last - the photo least reviewed - became the ground truth for the photo check (audit RI-01). Now: only photos allowed as references
// (trusted / user / legacy, normal kind), a first/primary photo the person chose wins, then photos a person vouched for, then verified ones; clean product shots
// (stock / Wikipedia) rank a little above listing photos; and the picks are varied (a different source each) before any repeats. Pure.
import { REFERENCE_STATUSES, type ProductImage } from "./types.js";

type Pickable = Pick<ProductImage, "id" | "status" | "kind" | "isPrimary" | "sortOrder" | "createdAt" | "sourceKind" | "sourceTitle">;

function rank(i: Pickable): number {
  let r = 0;
  if (i.isPrimary) r += 100;
  r += i.status === "user" ? 30 : i.status === "trusted" ? 20 : 10;
  if (i.sourceKind === "stock" || i.sourceKind === "wikipedia") r += 5;
  return r - i.sortOrder * 0.01 + i.createdAt / 1e15; // recency only breaks ties
}

export function selectReferenceImages<T extends Pickable>(images: T[], count: number): T[] {
  const usable = images.filter((i) => i.kind === "normal" && REFERENCE_STATUSES.has(i.status)).sort((a, b) => rank(b) - rank(a));
  const picked: T[] = [];
  const seen = new Set<string>();
  for (const i of usable) {
    if (picked.length >= count) break;
    const key = `${i.sourceKind ?? ""}|${i.sourceTitle ?? i.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(i);
  }
  for (const i of usable) {
    if (picked.length >= count) break;
    if (!picked.includes(i)) picked.push(i);
  }
  return picked;
}
