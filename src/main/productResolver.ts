// Beta 13: which Database entry is this name? The old rule (Store.findMatchingProduct: the FIRST entry, newest first, whose words are all contained in the name) let a generic
// "Xbox Series" entry absorb a Series S, and let "Metroid Dread (Nintendo Switch)" or "Nintendo Switch Dock" resolve to the Nintendo Switch console. This ranks EVERY entry by how
// completely it is the thing named, refuses a different kind of thing (game / accessory / hardware), a contradicting model / tier / capacity / colour / edition / drive / design,
// and answers "resolved" only for a unique best; a tie, or a best that is only a more GENERAL entry than the name states, is "unresolved" (and says why). Pure.
import { classifyComparable } from "./compIdentity.js";
import { modelLetters } from "./compFilter.js";
import { kindOfName } from "./productKind.js";
import { extractVariantAttributes, identityTokens } from "./variantIdentity.js";
import { isColorWord } from "./colors.js";

export interface ResolveCandidate {
  id: string;
  name: string;
}

export interface RankedCandidate {
  candidate: ResolveCandidate;
  score: number;
  /** null = usable; otherwise why this entry is not the thing named. */
  excluded: string | null;
  /** The entry is only a more general version of the name (it lacks a model letter / edition the name states). */
  moreGeneral: boolean;
}

export interface ResolveResult {
  status: "resolved" | "unresolved" | "none";
  best: ResolveCandidate | null;
  /** When unresolved because only a more general entry exists: that entry (a parent suggestion, never an attachment). */
  parentSuggestion: ResolveCandidate | null;
  ranked: RankedCandidate[];
  why: string;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const nonColorTokens = (s: string) => identityTokens(s).filter((t) => !isColorWord(t));

function lacksIdentityDetail(subject: string, candidateName: string): boolean {
  const mine = modelLetters(subject);
  const theirs = modelLetters(candidateName);
  for (const [word, letters] of mine) {
    const there = theirs.get(word);
    if (!there || ![...letters].some((l) => there.has(l))) return true;
  }
  const edition = extractVariantAttributes(subject).editionTerms;
  const candEdition = extractVariantAttributes(candidateName).editionTerms;
  return edition.some((e) => !candEdition.includes(e));
}

export function resolveProduct(subject: string, candidates: ResolveCandidate[]): ResolveResult {
  const wanted = squash(subject);
  const ranked: RankedCandidate[] = [];
  if (!wanted) return { status: "none", best: null, parentSuggestion: null, ranked, why: "no name" };
  const subjectKind = kindOfName(subject);
  const subjectTokens = new Set(nonColorTokens(subject));

  for (const candidate of candidates) {
    if (squash(candidate.name) === wanted) {
      ranked.push({ candidate, score: 1000, excluded: null, moreGeneral: false });
      continue;
    }
    const exclude = (reason: string) => ranked.push({ candidate, score: 0, excluded: reason, moreGeneral: false });
    const candTokens = nonColorTokens(candidate.name);
    if (candTokens.length < 2) { exclude("too short to be a safe match"); continue; }
    if (kindOfName(candidate.name) !== subjectKind) { exclude(`a different kind of thing (${kindOfName(candidate.name)} vs ${subjectKind})`); continue; }
    if (!candTokens.every((t) => subjectTokens.has(t))) { exclude("the entry names things the name does not (more specific or different)"); continue; }
    const j = classifyComparable({ name: candidate.name }, subject);
    if (j.verdict === "rejected") { exclude(`contradicted: ${j.reasons[0]?.text ?? j.reasons[0]?.code}`); continue; }
    if (j.verdict === "uncertain") { exclude(`not confirmed: ${j.reasons[0]?.text ?? j.reasons[0]?.code}`); continue; }
    let score = candTokens.length;
    const a = extractVariantAttributes(candidate.name);
    const b = extractVariantAttributes(subject);
    if (a.colors.length && a.colors.some((c) => b.colors.includes(c))) score += 2;
    if (a.capacities.length && a.capacities.some((c) => b.capacities.includes(c))) score += 2;
    if (a.editionTerms.length && a.editionTerms.every((e) => b.editionTerms.includes(e))) score += 2;
    ranked.push({ candidate, score, excluded: null, moreGeneral: lacksIdentityDetail(subject, candidate.name) });
  }

  const usable = ranked.filter((r) => !r.excluded).sort((x, y) => y.score - x.score);
  if (!usable.length) return { status: "none", best: null, parentSuggestion: null, ranked, why: "no entry is this thing" };
  const [top, second] = usable;
  if (second && second.score === top.score) return { status: "unresolved", best: null, parentSuggestion: null, ranked, why: `"${top.candidate.name}" and "${second.candidate.name}" fit equally well` };
  if (top.moreGeneral) return { status: "unresolved", best: null, parentSuggestion: top.candidate, ranked, why: `only the more general entry "${top.candidate.name}" exists; the name states a model or edition it does not` };
  return { status: "resolved", best: top.candidate, parentSuggestion: null, ranked, why: top.score >= 1000 ? "exact name" : "best match" };
}
