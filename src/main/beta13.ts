// Beta 13 feature switches (config.json "beta13"). Every behaviour change that alters a decision is behind one of these so it can be set to "off" or "shadow" without a
// new build. "shadow" = compute and record (AI Activity decisions), change nothing. Pure, no I/O. Missing / invalid values fall back to the defaults below.
export type Beta13Mode = "off" | "shadow" | "enforce";

export interface Beta13Flags {
  /** The single picture writer's identity gate (text MISMATCH is refused, unverifiable pictures are quarantined). */
  identityGate: Beta13Mode;
  /** The best-match product resolver that replaces first-match fuzzy lookup. "shadow" computes both and records disagreements but returns the old answer. */
  resolver: Beta13Mode;
  /** Structured condition evidence and the defect-specific value adjustment. */
  conditionEvidence: Beta13Mode;
  libraryTree: boolean;
  chatStatus: boolean;
  chatChoices: boolean;
  chatAttachments: boolean;
  replyStyle: boolean;
}

export const BETA13_DEFAULTS: Beta13Flags = {
  identityGate: "enforce",
  resolver: "shadow",
  conditionEvidence: "shadow",
  libraryTree: true,
  chatStatus: true,
  chatChoices: true,
  chatAttachments: true,
  replyStyle: true,
};

const mode = (v: unknown, fallback: Beta13Mode): Beta13Mode => (v === "off" || v === "shadow" || v === "enforce" ? v : fallback);
const flag = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

export function beta13Flags(config: { beta13?: Partial<Record<keyof Beta13Flags, unknown>> } | null | undefined): Beta13Flags {
  const raw = config?.beta13 ?? {};
  return {
    identityGate: mode(raw.identityGate, BETA13_DEFAULTS.identityGate),
    resolver: mode(raw.resolver, BETA13_DEFAULTS.resolver),
    conditionEvidence: mode(raw.conditionEvidence, BETA13_DEFAULTS.conditionEvidence),
    libraryTree: flag(raw.libraryTree, BETA13_DEFAULTS.libraryTree),
    chatStatus: flag(raw.chatStatus, BETA13_DEFAULTS.chatStatus),
    chatChoices: flag(raw.chatChoices, BETA13_DEFAULTS.chatChoices),
    chatAttachments: flag(raw.chatAttachments, BETA13_DEFAULTS.chatAttachments),
    replyStyle: flag(raw.replyStyle, BETA13_DEFAULTS.replyStyle),
  };
}
