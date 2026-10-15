// Beta 13: condition as STRUCTURED evidence instead of three buckets. A defect has a class (what is wrong), an area, a severity (cosmetic / functional / unknown), a source
// (the seller's words, a photo, the user), a confidence and what it was read from. Text and photos are merged so one defect is counted once, a defect the photos show that the
// seller did not mention is FLAGGED (undisclosed), a defect the seller reports is never dropped just because the photos do not show it, and a fault no picture can show (does not
// power on, no signal, locked) comes only from words or the person - a picture never asserts it. Pure (no I/O).
import { ACCESSORY, clauses, isNegated } from "./conditionParser.js";

export type DefectClass =
  | "cracked_screen" | "cracked_back_glass" | "damaged_frame" | "scratches" | "dents" | "broken_display" | "missing_parts" | "damaged_ports"
  | "bent_hardware" | "hinge_damage" | "corrosion" | "broken_housing" | "liquid_damage" | "nonvisual_fault" | "other";
export const DEFECT_CLASSES: DefectClass[] = ["cracked_screen", "cracked_back_glass", "damaged_frame", "scratches", "dents", "broken_display", "missing_parts", "damaged_ports", "bent_hardware", "hinge_damage", "corrosion", "broken_housing", "liquid_damage", "nonvisual_fault", "other"];
/** Classes that a photograph can in principle show; the rest (nonvisual_fault) are never asserted from a picture. */
export const VISIBLE_CLASSES = new Set<DefectClass>(DEFECT_CLASSES.filter((c) => c !== "nonvisual_fault"));

export type Severity = "cosmetic" | "functional" | "unknown";
export type Confidence = "high" | "medium" | "low";
export type EvidenceSource = "text" | "vision" | "user" | "text+vision";

export interface DefectEvidence {
  cls: DefectClass;
  area: string | null;
  severity: Severity;
  source: EvidenceSource;
  confidence: Confidence;
  /** The seller's words that said it, or the photo's description. */
  quote?: string;
  photoRef?: number | null;
}

interface Pattern {
  cls: DefectClass;
  re: RegExp;
  severity: Severity;
  area?: string;
}

// Order matters: the more specific pattern of a pair comes first and the first match for a clause wins for that class family.
const PATTERNS: Pattern[] = [
  { cls: "cracked_back_glass", re: /\b(?:back (?:glass|panel|cover)|rear (?:glass|panel))\b[^.,;]{0,25}\b(?:crack(?:ed|s)?|shatter(?:ed)?|broken|chipped)\b|\b(?:crack(?:ed|s)?|shatter(?:ed)?|broken)\b[^.,;]{0,15}\b(?:back (?:glass|panel|cover)|rear (?:glass|panel))\b/i, severity: "cosmetic", area: "back" },
  { cls: "cracked_screen", re: /\b(?:screen|display|lcd|digitizer|glass)\b[^.,;]{0,25}\b(?:crack(?:ed|s)?|shatter(?:ed)?|smashed|broken)\b|\b(?:crack(?:ed|s)?|shattered|smashed)\b[^.,;]{0,15}\b(?:screen|display)\b|\bcracked\b(?![^.,;]{0,15}\b(?:back|case|housing|frame|corner|lens|body)\b)/i, severity: "functional", area: "screen" },
  { cls: "broken_display", re: /\b(?:dead pixels?|burn-?in|lines on (?:the )?screen|screen (?:flicker\w*|lines|bleed\w*)|display (?:not working|dead|issues?)|backlight (?:bleed|issues?|out))\b/i, severity: "functional", area: "screen" },
  { cls: "liquid_damage", re: /\b(?:water|liquid|moisture|coffee|soda|drink|beer)\s+(?:damage[d]?|exposure)\b|\b(?:spilled|dropped in water|got wet|submerged|flood(?:ed)?)\b/i, severity: "unknown" },
  { cls: "corrosion", re: /\bcorro(?:sion|ded|sive)\b|\brust(?:ed|y)?\b|\bgreen (?:gunk|crust)\b/i, severity: "functional" },
  { cls: "hinge_damage", re: /\bhinges?\b[^.,;]{0,25}\b(?:loose|broken|cracked|snapped|stiff|wobbl\w*|damaged|issues?)\b|\b(?:loose|broken|cracked|snapped|damaged)\b[^.,;]{0,12}\bhinges?\b/i, severity: "functional", area: "hinge" },
  { cls: "damaged_frame", re: /\b(?:frame|bezel|rim|chassis|corner)s?\b[^.,;]{0,15}\b(?:bent|damaged|cracked|dented|warped|chipped)\b|\b(?:chipped|dented|bent)\b[^.,;]{0,10}\b(?:corner|frame|bezel|edge)s?\b/i, severity: "functional", area: "frame" },
  { cls: "bent_hardware", re: /\bbent\b|\bwarped\b|\btwisted\b/i, severity: "functional" },
  { cls: "damaged_ports", re: /\b(?:charging port|usb|hdmi|lightning|port|jack|disc (?:drive|slot)|sd (?:card )?slot)\b[^.,;]{0,25}\b(?:damaged|broken|bent|loose|faulty|dead|not working|doesn'?t work|won'?t)\b|\b(?:damaged|broken|bent|loose|faulty)\b[^.,;]{0,12}\b(?:charging port|usb|hdmi|port|jack)\b/i, severity: "functional", area: "port" },
  { cls: "missing_parts", re: /\bmissing\b[^.,;]{0,20}\b(?:button|buttons|controller|charger|cable|remote|stand|cover|part|parts|screw|screws|battery cover|joy-?con|pen|lid|cap)\b|\bno (?:controller|charger|cable|remote|stand|power cord)\b(?! issues)/i, severity: "functional" },
  { cls: "broken_housing", re: /\b(?:case|housing|shell|body|casing)\b[^.,;]{0,15}\b(?:cracked|broken|damaged|split|chipped)\b|\b(?:cracked|broken|split)\b[^.,;]{0,12}\b(?:case|housing|shell|casing)\b/i, severity: "cosmetic", area: "body" },
  { cls: "dents", re: /\bdent(?:s|ed)?\b|\bdings?\b/i, severity: "cosmetic" },
  { cls: "scratches", re: /\b(?:scratch(?:es|ed)?|scuff(?:s|ed|ing)?|scrapes?|scrapped|marks? (?:on|from) (?:use|wear))\b/i, severity: "cosmetic" },
  { cls: "other", re: /\b(?:fungus|haze|hazy lens|sticky buttons?|buttons? (?:stuck|sticky))\b/i, severity: "functional" },
  { cls: "nonvisual_fault", re: /\bfor parts\b|\bparts only\b|\bparts or repair\b|\b(?:is\s+|are\s+)?not working\b|\bnon[- ]?working\b|\b(?:does|did|do|is)n'?t work\b|\bdoes not work\b|\b(?:won'?t|will not|does not|doesn'?t|did not|didn'?t|cannot|can'?t) (?:turn on|power on|power up|boot|charge|start|read|connect|detect)\b|\bno power\b(?!\s*(?:cord|cable|adapt|brick|supply|button))|\bdead on arrival\b|\bdefective\b|\bfaulty\b|\bicloud locked\b|\bactivation locked\b|\bbricked\b|\bneeds? repair|\bbad (?:motherboard|logic board|board|battery|drive|gpu)\b|\bno (?:signal|video|display|sound)\b|\bblack screen\b|\bboot ?loop\b|\bstick drift\b|\bjoy-?con drift\b|\b\w+ drift(?:ing)?\b|\boverheats?\b/i, severity: "functional" },
];

const SOFTENERS = /\b(?:light|minor|small|few|tiny|hairline|slight|barely|very light|normal|some)\b/i;
const HARDENERS = /\b(?:deep|heavy|bad|major|large|big|severe|many)\b/i;

function areaOf(clause: string, fallback?: string): string | null {
  const m = /\b(screen|display|lens|back|body|frame|corner|hinge|keyboard|port|case|housing|bezel|top|bottom|side)\b/i.exec(clause);
  return (m?.[1]?.toLowerCase() ?? fallback) ?? null;
}

/**
 * Defects the SELLER'S WORDS state. Negation-aware ("no cracks", "crack-free"), accessory-aware ("cracked screen protector"), and conservative about wear: a "light scratch" is
 * recorded (cosmetic, low confidence) so it is visible, but is not a deduction on its own.
 */
export function defectsFromText(text: string): DefectEvidence[] {
  const out: DefectEvidence[] = [];
  const add = (d: DefectEvidence) => {
    if (!out.some((x) => x.cls === d.cls && (x.area ?? "") === (d.area ?? ""))) out.push(d);
  };
  for (const clause of clauses(String(text ?? ""))) {
    let consumedBack = false;
    for (const p of PATTERNS) {
      const g = new RegExp(p.re.source, "gi");
      let m: RegExpExecArray | null;
      while ((m = g.exec(clause))) {
        if (isNegated(clause, m.index, m[0].length)) continue;
        const around = clause.slice(Math.max(0, m.index - 40), m.index + m[0].length + 60);
        if (ACCESSORY.test(around) && !/\b(?:screen|body|unit|console|phone|device)\b[^,]{0,10}\b(?:cracked|broken|shattered)\b/i.test(around.replace(ACCESSORY, ""))) continue;
        if (p.cls === "cracked_screen" && consumedBack) continue; // "back glass cracked" is not also a cracked screen
        if (p.cls === "cracked_back_glass") consumedBack = true;
        let severity = p.severity;
        let confidence: Confidence = "high";
        if (p.cls === "scratches" || p.cls === "dents") {
          const window = clause.slice(Math.max(0, m.index - 25), m.index + m[0].length + 10);
          if (SOFTENERS.test(window) && !HARDENERS.test(window)) confidence = "low";
          else if (HARDENERS.test(window)) severity = "functional";
        }
        add({ cls: p.cls, area: areaOf(clause, p.area), severity, source: "text", confidence, quote: m[0].trim().slice(0, 80) });
      }
    }
  }
  return out;
}

export interface VisionDefectInput {
  class?: string;
  description?: string;
  severity?: string;
  confidence?: string;
  photoNumber?: number;
}

/** What the PHOTOS show, from the vision result. Faults a picture cannot show are dropped here, however the model labelled them. */
export function defectsFromVision(flaws: VisionDefectInput[]): DefectEvidence[] {
  const out: DefectEvidence[] = [];
  for (const f of flaws ?? []) {
    const cls = (DEFECT_CLASSES as string[]).includes(String(f.class)) ? (f.class as DefectClass) : "other";
    if (!VISIBLE_CLASSES.has(cls)) continue; // vision never asserts that something does not power on
    const severity: Severity = f.severity === "cosmetic" || f.severity === "functional" ? f.severity : "unknown";
    const confidence: Confidence = f.confidence === "high" || f.confidence === "low" ? f.confidence : "medium";
    const description = String(f.description ?? "").trim();
    out.push({ cls, area: areaOf(description) , severity, source: "vision", confidence, quote: description.slice(0, 120), photoRef: Number.isInteger(f.photoNumber) ? (f.photoNumber as number) : null });
  }
  return out;
}

export type ConditionFlag = "UNDISCLOSED_DAMAGE" | "SELLER_REPORT_NOT_VISIBLE" | "DAMAGE_UNCERTAIN" | "NO_VISIBLE_DAMAGE_DETECTED";

export interface PhotoCoverage {
  /** What the photos actually showed: "screen", "back", "body"... (unknown = the model did not say). */
  shown: string[] | null;
  /** The model's statement that it looked and saw no damage. */
  noVisibleDamage: boolean;
}

export interface MergedCondition {
  defects: DefectEvidence[];
  flags: Array<{ flag: ConditionFlag; cls?: DefectClass; text: string }>;
  /** Plain statements for the person, in the words the brief asks for. */
  statements: string[];
}

const SAME_AREA = (a: DefectEvidence, b: DefectEvidence) => !a.area || !b.area || a.area === b.area;
// A cosmetic wear mark does not make a deal "undisclosed damage" on its own.
const MATERIAL = (d: DefectEvidence) => d.severity !== "cosmetic" || d.confidence !== "low";

/** One defect, counted once: text and photos that agree confirm each other; a photo-only defect is flagged; a seller-only defect stays as reported. */
export function mergeCondition(text: DefectEvidence[], vision: DefectEvidence[], coverage: PhotoCoverage | null, photoCount: number): MergedCondition {
  const defects: DefectEvidence[] = [];
  const flags: MergedCondition["flags"] = [];
  const usedVision = new Set<DefectEvidence>();
  for (const t of text) {
    const match = vision.find((v) => !usedVision.has(v) && v.cls === t.cls && SAME_AREA(t, v));
    if (match) {
      usedVision.add(match);
      defects.push({ ...t, source: "text+vision", confidence: "high", photoRef: match.photoRef ?? null });
      continue;
    }
    defects.push(t);
    // the seller reports it, the photos clearly cover that area and show nothing: say so, but the seller's report still stands for the price
    if (VISIBLE_CLASSES.has(t.cls) && t.area && coverage?.shown?.includes(t.area) && vision.length === 0 && coverage.noVisibleDamage) {
      flags.push({ flag: "SELLER_REPORT_NOT_VISIBLE", cls: t.cls, text: `The seller reports ${t.cls.replace(/_/g, " ")} (${t.area}); the photos show that area without it. The seller's report is still counted.` });
    }
  }
  for (const v of vision) {
    if (usedVision.has(v)) continue;
    defects.push(v);
    if (MATERIAL(v)) flags.push({ flag: v.confidence === "low" ? "DAMAGE_UNCERTAIN" : "UNDISCLOSED_DAMAGE", cls: v.cls, text: v.confidence === "low" ? `A photo might show ${v.cls.replace(/_/g, " ")} (${v.quote ?? "unclear"}); not sure.` : `The photos show ${v.cls.replace(/_/g, " ")} that the listing does not mention (${v.quote ?? "see photo"}).` });
  }
  const statements: string[] = [];
  const nonvisual = defects.filter((d) => d.cls === "nonvisual_fault");
  if (defects.length === 0) {
    if (coverage?.noVisibleDamage) {
      const where = coverage.shown?.length ? ` (${coverage.shown.join(", ")} shown)` : "";
      const notShown = photoCount > 0 && coverage.shown && !coverage.shown.includes("screen") ? "; the screen side was not shown" : "";
      statements.push(`No visible damage detected in ${photoCount} photo${photoCount === 1 ? "" : "s"}${where}${notShown}. This is not a guarantee: faults that need testing are invisible.`);
      flags.push({ flag: "NO_VISIBLE_DAMAGE_DETECTED", text: statements[0] });
    } else if (photoCount > 0) {
      statements.push("Condition could not be judged from the photos; treat it as unknown.");
      flags.push({ flag: "DAMAGE_UNCERTAIN", text: statements[0] });
    }
  }
  if (nonvisual.length) statements.push("The seller states a fault that can only be checked by testing it.");
  return { defects, flags, statements };
}
