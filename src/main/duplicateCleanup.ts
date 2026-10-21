// Phase 2.2 of the Beta 30 plan: which existing entries are the same product, decided by the naming rules. This file only PLANS (pure, read-only); Store.mergeEntriesWithUndo does the merge.
//
// Rules (2.3): an entry joins a group only when its name resolves to the same known model or the same folded name as the others - never across a hard attribute (a different size, edition,
// generation, disc / no-disc or colour that matters resolves to a different canonical name), never across categories (a game and a console), never a parent with its own child. Entries that
// merely share words but that the facts know nothing about stay out: the Library's "Needs review" list proposes those and a person decides. The kept entry is the OLDEST one (2.4).
import { namingFacts, resolveName, type NamingFacts } from "./namingEngine.js";
import { nameKey } from "./modelFacts.js";

export interface CleanupEntry {
  id: string;
  name: string;
  category: string | null;
  createdAt: number;
  parentProductId: string | null;
}

export interface CleanupGroup {
  /** The model's one simple name. */
  canonical: string;
  keep: { id: string; name: string };
  /** The entries that fold into the kept one. */
  fold: Array<{ id: string; name: string }>;
  why: string;
}

export interface CleanupPlan {
  groups: CleanupGroup[];
  /** Entries before and after: "N entries become M". */
  before: number;
  after: number;
  /** Groups left alone and why (a category or parent conflict), so the report is honest about what it did not touch. */
  skipped: Array<{ canonical: string; names: string[]; why: string }>;
  /** A fingerprint of exactly this plan: the real run must be given the same one, so it only ever does what was reviewed. */
  fingerprint: string;
}

const hardCategory = (c: string | null): string => (c && c !== "Other" ? c.trim().toLowerCase() : "");

export function planCleanup(entries: ReadonlyArray<CleanupEntry>, facts: NamingFacts = namingFacts()): CleanupPlan {
  const byCanonical = new Map<string, CleanupEntry[]>();
  for (const e of entries) {
    const r = resolveName(e.name, facts);
    // a name nothing is known about is only grouped with an identical one (same words in the same order); anything looser is the Needs review list's job
    const key = r.how === "unchanged" ? `same:${nameKey(e.name)}` : `model:${nameKey(r.canonical)}`;
    byCanonical.set(key, [...(byCanonical.get(key) ?? []), e]);
  }
  const groups: CleanupGroup[] = [];
  const skipped: CleanupPlan["skipped"] = [];
  for (const [key, members] of byCanonical) {
    if (members.length < 2) continue;
    const named = (m: CleanupEntry[]) => (key.startsWith("model:") ? resolveName(m[0].name, facts).canonical : m[0].name);
    // entries are only ever merged within one category (a game and a console are not the same product); entries with no category join the one category when there is only one, else wait
    const byCategory = new Map<string, CleanupEntry[]>();
    for (const m of members) byCategory.set(hardCategory(m.category), [...(byCategory.get(hardCategory(m.category)) ?? []), m]);
    const unplaced = byCategory.get("") ?? [];
    byCategory.delete("");
    if (byCategory.size === 1) byCategory.set([...byCategory.keys()][0], [...[...byCategory.values()][0], ...unplaced]);
    else if (byCategory.size === 0) byCategory.set("", unplaced);
    else skipped.push({ canonical: named(members), names: members.map((m) => m.name), why: "they are filed in different categories, so they were kept apart" });
    for (const same of byCategory.values()) {
      if (same.length < 2) continue;
      const ordered = [...same].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      const canonical = named(ordered);
      const ids = new Set(ordered.map((m) => m.id));
      if (ordered.some((m) => m.parentProductId && ids.has(m.parentProductId))) {
        skipped.push({ canonical, names: ordered.map((m) => m.name), why: "one of them is the other's parent" });
        continue;
      }
      const [keep, ...fold] = ordered;
      groups.push({
        canonical,
        keep: { id: keep.id, name: keep.name },
        fold: fold.map((f) => ({ id: f.id, name: f.name })),
        why: key.startsWith("model:") ? `all of these names mean "${canonical}"` : "the same name",
      });
    }
  }
  groups.sort((a, b) => a.canonical.localeCompare(b.canonical));
  const folded = groups.reduce((n, g) => n + g.fold.length, 0);
  const fingerprint = groups.map((g) => `${g.keep.id}<${g.fold.map((f) => f.id).sort().join(",")}`).join("|");
  return { groups, before: entries.length, after: entries.length - folded, skipped, fingerprint };
}

/** The dry-run report in plain words. */
export function describePlan(plan: CleanupPlan): string {
  if (plan.groups.length === 0) return `Nothing to merge: all ${plan.before} entries are different products.`;
  const lines = [`${plan.before} entries would become ${plan.after}. Nothing has been changed.`];
  for (const g of plan.groups) lines.push(`- Keep "${g.keep.name}" (the oldest) and fold in ${g.fold.map((f) => `"${f.name}"`).join(", ")}: ${g.why}.`);
  for (const s of plan.skipped) lines.push(`- Left alone: ${s.names.map((n) => `"${n}"`).join(", ")} (${s.why}).`);
  return lines.join("\n");
}
