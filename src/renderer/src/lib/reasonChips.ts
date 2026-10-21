// Why-chips on a deal card: small labels for the things a person should know before trusting the number - "Vague" (Clynx is not sure which model it is), "Maybe a more specific version", "Your price"
// (the value is the owner's own word), "Asking prices only", "Extras counted". Each carries the full sentence for its hover text. Pure: the saved verdict in, chips out.
export interface ChipInput {
  gateReasons?: ReadonlyArray<{ code: string; severity: string; text: string }> | null;
  gateFacts?: { basis?: string | null; extrasCountedUsd?: number | null } | null;
}
export interface ReasonChip {
  id: string;
  label: string;
  tone: "warn" | "info" | "good";
  title: string;
}

export function reasonChips(r: ChipInput): ReasonChip[] {
  const out: ReasonChip[] = [];
  for (const reason of r.gateReasons ?? []) {
    if (reason.code === "IDENTITY_UNCONFIRMED") {
      if (/^Not sure which model/.test(reason.text)) out.push({ id: "vague", label: "Vague", tone: "warn", title: reason.text });
      else out.push({ id: "specific", label: "Maybe a more specific version", tone: "warn", title: reason.text });
    }
    if (reason.code === "HIDDEN_GEM") out.push({ id: "extras", label: "Extras counted", tone: "good", title: reason.text });
    if (reason.code === "WEAK_EVIDENCE" || reason.code === "RARE_FIND") out.push({ id: "thin", label: "Thin sales data", tone: "warn", title: reason.text });
  }
  const basis = r.gateFacts?.basis ?? null;
  if (basis === "user") out.push({ id: "yours", label: "Your price", tone: "info", title: "The value behind this is a price you gave, used at its low end, not sold prices." });
  if (basis === "active") out.push({ id: "asking", label: "Asking prices only", tone: "warn", title: "The value comes from what sellers ask right now; nothing has confirmed what it sells for." });
  return out.filter((c, i) => out.findIndex((x) => x.id === c.id) === i);
}
