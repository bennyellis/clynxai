// Reads a listing's condition wording the way a person would: "no damage" is not damage, "screen cracked, otherwise works" is. Pure (no I/O).
//
// The old check was a list of bare keywords, so "works perfectly, no damage, not broken" cost a listing 40% of its value and "no dead pixels, no cracks" cost it 75%. This
// version looks at the words around each keyword:
//   - an explicit negation ("no", "not", "without", "never", "nothing", "zero", "free of", "-free", "n't") in the same clause, with only damage words between them
//     (so "No cracks, scratches or damage" is all negated, but "No scratches, screen cracked" is not);
//   - a damage word about an accessory ("the crack is just the tempered glass") is not damage to the item;
//   - wording that only names a possible risk ("sold as is", "untested") is reported as uncertain, and costs value only when something is actually unknown ("as is, untested");
//   - phrases that already contain their own negation ("not working", "does not power on") are damage.
// It returns what it found so a decision can be explained, not just a verdict.

export type ConditionImpact = "none" | "minor" | "major";

export interface ConditionEvidence {
  /** The wording that justified a deduction, with its kind. */
  damage: Array<{ phrase: string; severity: "minor" | "major" }>;
  /** Damage words that were explicitly negated or about an accessory: kept so the reasoning can say they were seen and ignored. */
  ignored: string[];
  /** Wording that names a risk without stating a fault ("sold as is"). */
  uncertain: string[];
}

export interface ConditionAnalysis {
  impact: ConditionImpact;
  evidence: ConditionEvidence;
}

// --- wording that is damage on its own (the phrase carries its own meaning; negation words inside it are part of it)
const SELF_MAJOR: RegExp[] = [
  /\bfor parts\b/i, /\bparts only\b/i, /\bparts or repair\b/i,
  /\b(?:is\s+|are\s+)?not working\b/i, /\bnon[- ]?working\b/i, /\b(?:does|did|do|is)n'?t work\b/i, /\bdoes not work\b/i,
  /\b(?:won'?t|will not|does not|doesn'?t|did not|didn'?t|cannot|can'?t) (?:turn on|power on|power up|boot|charge|start)\b/i,
  /\bno power\b(?!\s*(?:cord|cable|adapt|brick|supply|button|issue|problem|loss|outage|drain))/i,
  /\bdead on arrival\b/i, /\bdefective\b/i, /\bicloud locked\b/i, /\bblacklisted\b/i, /\bneeds? repair/i, /\brepair needed\b/i, /\bbricked\b/i,
];

// --- words that are damage only when not negated (and not about an accessory)
const NEGATABLE: Array<{ re: RegExp; severity: "minor" | "major" }> = [
  { re: /\bdead\b(?!\s*(?:pixels?|spots?|zone|mint|center|quiet|silent|stock|flat|accurate))/i, severity: "major" },
  { re: /\bdead (?:pixels?|spots?)\b/i, severity: "minor" },
  { re: /\bbroken\b/i, severity: "minor" },
  { re: /\bcrack(?:ed|s)?\b/i, severity: "minor" },
  { re: /\bshatter(?:ed)?\b/i, severity: "minor" },
  { re: /\bdamag(?:e|es|ed)\b/i, severity: "minor" },
  { re: /\bdamged\b/i, severity: "minor" },
  { re: /\bmissing (?:charger|remote|controller|cable)\b/i, severity: "minor" },
  { re: /\bneeds? (?:a )?(?:new )?battery\b|\bbattery (?:needs|replacement)\b|\bbattery needs? (?:to be )?replac/i, severity: "minor" },
];

const NEGATORS = /\b(?:no|not|without|never|nothing|none|zero|free of|isn'?t|aren'?t|wasn'?t|weren'?t|hasn'?t|haven'?t|doesn'?t|didn'?t|no signs? of|nor)\b|n't\b/i;
// "crack-free", "damage free", "scratch free"
const FREE_AFTER = /^\s*[- ]?free\b/i;
// words that may sit between a negator and the damage word without ending the negation ("no cracks, scratches or damage")
const LIST_WORDS = new Set(["or", "and", "nor", "any", "major", "minor", "visible", "significant", "serious", "major", "real", "signs", "sign", "of", "the", "a", "an", "scratches", "scratch", "scuffs", "scuff", "dents", "dent", "cracks", "crack", "damage", "damaged", "broken", "dead", "pixels", "pixel", "spots", "chips", "chip", "issues", "issue", "problems", "problem", "defects", "defect", "wear", "water", "stick", "drift", "power", "cracked", "to", "it", "is", "are", "was", "were", "has", "have", "there", "anything", "everything", "anywhere"]);
// damage that is about something other than the item
export const ACCESSORY = /\b(?:tempered glass|screen protector|protector|screen guard|phone case|the case|carrying case|box|packaging)\b/i;

const AS_IS = /\bas[- ]?is\b/i;
const UNTESTED = /\b(?:untested|not tested|haven'?t tested|unable to test|can'?t test|unknown if|no returns?|sold as[- ]is)\b|\bunknown (?:condition|if)\b/i;
const WORKS = /\b(?:works?(?: great| perfectly| fine| well| as (?:it )?should)?|working|tested|fully functional|everything works|function(?:s|al))\b/i;

// A clause ends at sentence punctuation, a newline or a contrast word; a comma does not end it (lists), see LIST_WORDS.
export function clauses(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/[.;!?\n]+|\s(?:but|however|although|though|except|otherwise|yet)\s/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9' -]/g, " ").split(/\s+/).filter(Boolean);
}

/** Is the damage word at `index` in `clause` negated? A negator earlier in the clause counts when only list-like words sit between it and the damage word. */
export function isNegated(clause: string, index: number, matchLen: number): boolean {
  const after = clause.slice(index + matchLen);
  if (FREE_AFTER.test(after)) return true;
  const before = clause.slice(0, index);
  let lastNeg = -1;
  const re = new RegExp(NEGATORS.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(before))) lastNeg = m.index + m[0].length;
  if (lastNeg < 0) return false;
  const between = words(before.slice(lastNeg));
  if (between.length > 8) return false;
  return between.every((w) => LIST_WORDS.has(w));
}

export function analyzeCondition(text: string): ConditionAnalysis {
  const evidence: ConditionEvidence = { damage: [], ignored: [], uncertain: [] };
  const all = String(text ?? "");
  const found = clauses(all);
  const addDamage = (phrase: string, severity: "minor" | "major") => {
    if (!evidence.damage.some((d) => d.phrase === phrase && d.severity === severity)) evidence.damage.push({ phrase, severity });
  };
  for (const clause of found) {
    for (const re of SELF_MAJOR) {
      const m = re.exec(clause);
      if (m) addDamage(m[0], "major");
    }
    for (const { re, severity } of NEGATABLE) {
      const g = new RegExp(re.source, "gi");
      let m: RegExpExecArray | null;
      while ((m = g.exec(clause))) {
        const around = clause.slice(Math.max(0, m.index - 40), m.index + m[0].length + 60);
        if (isNegated(clause, m.index, m[0].length)) {
          evidence.ignored.push(`${clause.slice(Math.max(0, m.index - 12), m.index + m[0].length)}`.trim());
        } else if (ACCESSORY.test(around) && !/\b(?:screen|body|unit|console|phone|device)\b[^,]{0,10}\b(?:cracked|broken|shattered)\b/i.test(around.replace(ACCESSORY, ""))) {
          evidence.ignored.push(`${m[0]} (about an accessory)`);
        } else {
          addDamage(m[0], severity);
        }
      }
    }
  }
  // "as is" alone is a risk, not a fault; with "untested"/"no returns"/"unknown" and nothing saying it works it is a real unknown worth a deduction
  if (AS_IS.test(all) || /\buntested\b|\bnot tested\b/i.test(all)) {
    const phrase = (AS_IS.exec(all) ?? /\buntested\b|\bnot tested\b/i.exec(all))![0];
    const unknownToo = /\buntested\b|\bnot tested\b|\bunknown\b/i.test(all) && !WORKS.test(all.replace(/\bnot tested\b/gi, ""));
    if (unknownToo && evidence.damage.length === 0) addDamage(`${phrase} (untested)`, "minor");
    else if (evidence.damage.length === 0) evidence.uncertain.push(phrase);
  }
  const impact: ConditionImpact = evidence.damage.some((d) => d.severity === "major") ? "major" : evidence.damage.length ? "minor" : "none";
  return { impact, evidence };
}

export function detectConditionImpactText(text: string): ConditionImpact {
  return analyzeCondition(text).impact;
}

/** A short plain-English account of why a condition deduction was (or was not) applied, for the listing's reasoning. */
export function describeCondition(a: ConditionAnalysis): string {
  if (a.impact === "none") return a.evidence.ignored.length ? `Condition wording looked at and not counted as damage (${a.evidence.ignored.slice(0, 2).join("; ")}).` : "";
  return `Condition: the listing's own wording says ${a.evidence.damage.map((d) => `"${d.phrase}"`).join(", ")} (${a.impact === "major" ? "treated as largely unusable" : "treated as a minor flaw"}).`;
}
