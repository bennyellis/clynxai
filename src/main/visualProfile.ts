// What Clynx SEES, as structured data, and how that is turned into searches and into a way to rule candidates out. Pure: no model, no network.
//
// Pass 1 (general): look at the photos with no name in mind and report object kind, visible brand, colours, shape, controls, artwork. Seller words are NOT given to this pass, so the
// seller's title cannot talk the observer into seeing something.
// Pass 2 (targeted): once candidates are known, ask only the questions that tell them apart ("is there one HOME button below the touchscreen or three?") with fixed answer options.
// A feature the photos do not show is answered "not_visible", which rules nothing out: uncertainty is kept, not forced.
import { canEliminate, type EvidenceKind } from "./evidenceKinds.js";

export interface VisualFeature {
  aspect: string;
  description: string;
  confidence: "high" | "medium" | "low";
}

export interface Observation {
  /** "handheld game console (clamshell)", "smartphone", "graphics card"... as seen, not as titled. */
  objectKind: string;
  brandVisible: string | null;
  colors: string[];
  /** Distinctive printed or moulded artwork, in plain description ("cartoon face with red circles and black-tipped ears"). Never a guessed name. */
  artwork: string[];
  features: VisualFeature[];
  /** Photos that were looked at, and how many showed the product itself. */
  photos: number;
  /** Things that stop a confident reading (glare, one angle, blurry, a case on it). */
  limits: string[];
}

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const list = (v: unknown, n: number, each: number) => (Array.isArray(v) ? v.map((x) => clip(x, each)).filter(Boolean).slice(0, n) : []);

export const OBSERVE_PROMPT = `You are examining photos of a used item for sale. Describe ONLY what you can see. Do not use any seller wording, and do not guess a model name from the shape alone: if you are not sure of a name, describe the features instead.
Report: what kind of object it is; any brand or text actually legible on it; the main colours and finish; distinctive artwork or printed/moulded designs described in plain words (shapes, characters you can describe, patterns) without naming a franchise unless the name is printed on the item; the layout of visible controls, buttons, ports, camera modules, vents, fans, hinges, screens; and anything that limits a confident reading (glare, only one angle, a case, blur).
Answer ONLY with JSON: { "objectKind": string, "brandVisible": string|null, "colors": [string], "artwork": [string], "features": [{ "aspect": string, "description": string, "confidence": "high"|"medium"|"low" }], "limits": [string] }`;

export function parseObservation(raw: unknown, photos: number): Observation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const objectKind = clip(r.objectKind, 80);
  if (!objectKind) return null;
  const features = (Array.isArray(r.features) ? r.features : [])
    .map((f) => (f && typeof f === "object" ? (f as Record<string, unknown>) : null))
    .filter((f): f is Record<string, unknown> => !!f)
    .map((f) => ({ aspect: clip(f.aspect, 40).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), description: clip(f.description, 200), confidence: (f.confidence === "high" || f.confidence === "medium" ? f.confidence : "low") as VisualFeature["confidence"] }))
    .filter((f) => f.aspect && f.description)
    .slice(0, 16);
  return { objectKind, brandVisible: clip(r.brandVisible, 60) || null, colors: list(r.colors, 6, 30), artwork: list(r.artwork, 6, 120), features, photos, limits: list(r.limits, 6, 100) };
}

// ---- searches from what was SEEN ------------------------------------------------------------------------------------------------------------------------------
const SHAPE_WORDS: Array<[RegExp, string]> = [
  [/clamshell|folding|hinge/i, "handheld"],
  [/smartphone|phone/i, "phone"],
  [/graphics card|gpu|video card/i, "graphics card"],
  [/console/i, "console"],
  [/tablet/i, "tablet"],
  [/laptop|notebook/i, "laptop"],
  [/headset|headphones/i, "headset"],
  [/camera/i, "camera"],
];

/** The kind of thing in a form people search for ("handheld", "graphics card"). */
export function searchKind(objectKind: string): string {
  for (const [re, word] of SHAPE_WORDS) if (re.test(objectKind)) return word;
  return objectKind.toLowerCase().replace(/\(.*?\)/g, "").trim().split(" ").slice(0, 3).join(" ");
}

/**
 * Searches built from the observation, the way a person who does not know the name would type them ("nintendo yellow handheld special edition cartoon face"). They use what is
 * visible, never the seller's title, so a wrong title cannot steer the research. `candidates` (family names already suspected) add one narrower search each.
 */
export function observationQueries(obs: Observation, opts: { candidates?: string[]; max?: number } = {}): string[] {
  const kind = searchKind(obs.objectKind);
  const brand = obs.brandVisible ?? "";
  const color = obs.colors[0] ?? "";
  // the main visual idea of each artwork note: up to the first "with/and/that", at most four words ("cartoon face with red circles" -> "cartoon face")
  const art = obs.artwork.map((a) => a.toLowerCase().split(/\b(?:with|and|that|has|in|on)\b/)[0].replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ")).filter(Boolean);
  const out: string[] = [];
  const base = [brand, color, kind].filter(Boolean).join(" ");
  if (art[0]) out.push(`${base} special edition ${art[0]}`);
  if (art[0] || obs.colors.length) out.push(`${brand} ${kind} ${color} limited edition character design`.replace(/\s+/g, " ").trim());
  for (const c of (opts.candidates ?? []).slice(0, 2)) out.push(`${c} ${color} special edition ${art[0] ?? "design"}`.replace(/\s+/g, " ").trim());
  out.push(`${base} models how to tell them apart`.replace(/\s+/g, " ").trim());
  return [...new Set(out.filter((q) => q.split(" ").length >= 3))].slice(0, opts.max ?? 4);
}

// ---- pass 2: the questions that separate candidates ------------------------------------------------------------------------------------------------
export interface Question {
  aspect: string;
  question: string;
  options: Array<{ id: string; describe: string }>;
}

export function targetedPrompt(questions: Question[]): string {
  const lines = questions.map((q, i) => `${i + 1}. [${q.aspect}] ${q.question}\n   Options: ${q.options.map((o) => `"${o.id}" = ${o.describe}`).join("; ")}; "not_visible" = the photos do not show this area clearly.`);
  return `Look at the photos of this used item and answer each question about what is physically visible. Pick exactly one option per question. If the area is hidden, blurry or cut off, answer "not_visible" - never guess.
${lines.join("\n")}
Answer ONLY with JSON: { "answers": [{ "aspect": string, "option": string, "note": string }] }`;
}

export function parseAnswers(raw: unknown, questions: Question[]): Record<string, { option: string; note: string }> {
  const out: Record<string, { option: string; note: string }> = {};
  const answers = raw && typeof raw === "object" && Array.isArray((raw as { answers?: unknown }).answers) ? ((raw as { answers: unknown[] }).answers as Array<Record<string, unknown>>) : [];
  for (const q of questions) {
    const a = answers.find((x) => x && clip(x.aspect, 40) === q.aspect);
    const option = clip(a?.option, 40);
    out[q.aspect] = { option: q.options.some((o) => o.id === option) ? option : "not_visible", note: clip(a?.note, 160) };
  }
  return out;
}

// ---- ruling candidates out -----------------------------------------------------------------------------------------------------------------------------------------
export interface DiscriminatorLike {
  aspect: string;
  kind: EvidenceKind;
  /** candidate id -> the option it would show */
  expected: Record<string, string>;
}

export interface Elimination {
  candidateId: string;
  aspect: string;
  saw: string;
  expected: string;
}

/**
 * Candidates that a photographed, established feature contradicts. Only a discriminator whose evidence may rule things out (canEliminate) does it, and only for an answer
 * that was actually seen: "not_visible" keeps every candidate. Nothing is forced when several stay possible.
 */
export function eliminate(candidateIds: string[], discriminators: DiscriminatorLike[], answers: Record<string, { option: string }>): { remaining: string[]; eliminated: Elimination[] } {
  const eliminated: Elimination[] = [];
  const gone = new Set<string>();
  for (const d of discriminators) {
    const saw = answers[d.aspect]?.option;
    if (!saw || saw === "not_visible" || !canEliminate(d.kind)) continue;
    for (const id of candidateIds) {
      const expected = d.expected[id];
      if (expected && expected !== saw && !gone.has(id)) {
        gone.add(id);
        eliminated.push({ candidateId: id, aspect: d.aspect, saw, expected });
      }
    }
  }
  return { remaining: candidateIds.filter((id) => !gone.has(id)), eliminated };
}
