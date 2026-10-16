// Beta 13 chat support, all pure: the typed choice protocol, real progress labels, attachment validation, and the short-reply style. Nothing here talks to a model or a window.

// ---- structured choices (the ask_choice tool) --------------------------------------------------------------------------------------------------------------
export interface ChatChoiceOption {
  id: string;
  label: string;
  detail?: string;
  kind?: "default" | "destructive" | "cancel";
}
export interface ChatChoice {
  id: string;
  question: string;
  options: ChatChoiceOption[];
  /** Free text always stays available; this is only whether several options may be picked together. */
  multi: boolean;
}
export const MAX_CHOICE_OPTIONS = 6;

const cleanLine = (v: unknown, max: number): string => String(v ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Validates what the model passed to ask_choice. Returns the choice to show, or why it cannot be shown (the model is told, so it can fall back to a plain question). */
export function validateChoice(args: Record<string, unknown>, newId: () => string): { ok: true; choice: ChatChoice } | { ok: false; error: string } {
  const question = cleanLine(args.question, 200);
  const raw = Array.isArray(args.options) ? args.options : [];
  const seen = new Set<string>();
  const options: ChatChoiceOption[] = [];
  for (const o of raw.slice(0, MAX_CHOICE_OPTIONS + 3)) {
    const r = (o && typeof o === "object" ? o : { label: o }) as Record<string, unknown>;
    const label = cleanLine(r.label, 40);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const detail = cleanLine(r.detail, 120);
    options.push({ id: cleanLine(r.id, 30) || `o${options.length + 1}`, label, ...(detail ? { detail } : {}), kind: r.kind === "destructive" || r.kind === "cancel" ? r.kind : "default" });
  }
  if (!question) return { ok: false, error: "ask_choice needs a question." };
  if (options.length < 2) return { ok: false, error: "ask_choice needs at least two different options; ask in plain words instead." };
  if (options.length > MAX_CHOICE_OPTIONS) return { ok: false, error: `ask_choice takes at most ${MAX_CHOICE_OPTIONS} options; narrow it down.` };
  const ids = new Set(options.map((o) => o.id));
  if (ids.size !== options.length) options.forEach((o, i) => (o.id = `o${i + 1}`));
  return { ok: true, choice: { id: newId(), question, options, multi: args.multi === true } };
}

/** Confirm / Cancel for something consequential (the Library asks this way; the token that authorises it never reaches the model). */
export function confirmChoice(id: string, question: string, confirmLabel = "Do it"): ChatChoice {
  return { id, question: cleanLine(question, 200), multi: false, options: [{ id: "confirm", label: cleanLine(confirmLabel, 40), kind: "default" }, { id: "cancel", label: "Cancel", kind: "cancel" }] };
}

// ---- real progress (ai:chatStatus) ------------------------------------------------------------------------------------------------------------------------
export interface ChatStatusEvent {
  requestId: string;
  stepId: string;
  kind: "model" | "tool" | "notice";
  label: string;
  state: "start" | "update" | "end";
  /** Epoch ms the step really started: the screen ticks the elapsed time itself, so no per-second events are sent. */
  startedAt: number;
  ok?: boolean;
  detail?: string;
}

const str = (v: unknown, max = 40): string => cleanLine(v, max);
/** What the person sees while a tool runs. Code-authored from the tool and its arguments - never model text, never reasoning. */
export function toolStatusLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "research_product": return str(args.product) ? `Researching ${str(args.product)}` : "Researching the product";
    case "web_research": return str(args.query) ? `Searching the web for ${str(args.query)}` : "Searching the web";
    case "find_products": return "Looking through your Library";
    case "check_model_name": return str(args.name) ? `Checking whether ${str(args.name)} is a real model` : "Checking a model name";
    case "research_variants": return str(args.product) ? `Researching versions of ${str(args.product)}` : "Researching product versions";
    case "add_reference_photos": return str(args.product) ? `Finding photos for ${str(args.product)}` : "Finding reference photos";
    case "add_search_item": return str(args.item) ? `Adding ${str(args.item)} to Search For` : "Adding to Search For";
    case "remove_search_item": return "Removing from Search For";
    case "add_custom_instruction": return "Saving your instruction";
    case "add_product_watch_note": return "Saving a watch note";
    case "add_blacklist_term": case "remove_blacklist_term": return "Updating the Blacklist";
    case "set_general_deal_detection": return "Changing deal detection";
    case "update_config": return "Changing a setting";
    case "start_scanner": return "Starting the scanner";
    case "stop_scanner": return "Stopping the scanner";
    case "clear_feed": return "Clearing the Feed";
    case "create_watch": case "pause_watch": case "resume_watch": case "delete_watch": case "list_watch_matches": return "Working on your Watch";
    case "library_op": return "Updating your Library";
    case "library_list": return "Reading your Library";
    case "ask_choice": return "Asking you";
    default: return "Working";
  }
}

// ---- attachments -------------------------------------------------------------------------------------------------------------------------------------------
export const MAX_ATTACHMENTS = 4;
/** Hard ceiling for all pictures in one request: the Clynx Cloud body limit is 10 MiB and the text of the conversation travels with them. */
export const MAX_ATTACHMENT_TOTAL_CHARS = 9_000_000;
const DATA_URI = /^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$/;

export interface AttachmentIn {
  dataUri: string;
  name: string;
}
export interface AttachmentCheck {
  accepted: AttachmentIn[];
  rejected: Array<{ name: string; reason: string }>;
}

/** The main process never trusts the window: count, type (by the data URI AND by the picture's own first bytes) and total size are checked again, and every refusal is named. */
export function sanitizeAttachments(list: AttachmentIn[] | undefined | null): AttachmentCheck {
  const accepted: AttachmentIn[] = [];
  const rejected: AttachmentCheck["rejected"] = [];
  let total = 0;
  for (const a of Array.isArray(list) ? list : []) {
    const name = cleanLine(a?.name, 60) || "photo";
    const m = typeof a?.dataUri === "string" ? DATA_URI.exec(a.dataUri) : null;
    if (!m) { rejected.push({ name, reason: "not a png, jpeg, webp or gif picture" }); continue; }
    if (!magicMatches(m[1], m[2])) { rejected.push({ name, reason: "the file is not really that kind of picture" }); continue; }
    if (accepted.length >= MAX_ATTACHMENTS) { rejected.push({ name, reason: `only ${MAX_ATTACHMENTS} photos fit in one message` }); continue; }
    if (total + a.dataUri.length > MAX_ATTACHMENT_TOTAL_CHARS) { rejected.push({ name, reason: "the photos together are too large to send" }); continue; }
    total += a.dataUri.length;
    accepted.push({ dataUri: a.dataUri, name });
  }
  return { accepted, rejected };
}

function magicMatches(kind: string, b64: string): boolean {
  let head: Buffer;
  try {
    head = Buffer.from(b64.slice(0, 24), "base64");
  } catch {
    return false;
  }
  if (kind === "png") return head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  if (kind === "jpeg" || kind === "jpg") return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (kind === "gif") return head.length >= 4 && head.toString("ascii", 0, 3) === "GIF";
  if (kind === "webp") return head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP";
  return false;
}

// ---- short answers -----------------------------------------------------------------------------------------------------------------------------------------
/** Placed LAST in every system prompt so it outranks the longer-winded guidance above it. Money figures and safety warnings are explicitly exempt. */
export const REPLY_STYLE = `REPLY STYLE (overrides any longer-form guidance above): answer in 1-3 short sentences. Lead with the answer or the result. Do not restate the request, do not repeat what a tool already reported to the user, do not add reassurance or a recap, and do not offer extra help unless it changes what they should do next. Never drop: prices, profit, margin or max-buy numbers; scam or safety warnings; anything irreversible. A list only for three or more things being compared. If a tool failed, say what failed and the next step in one sentence.`;

const DETAIL_REQUEST = /\b(in detail|detailed|explain (?:fully|why|how)|go deeper|step[- ]by[- ]step|long(?:er)? answer|more detail|elaborate|walk me through|break (?:it )?down)\b/i;
/** The person asked for depth: the short style and the token cap step aside for that message. */
export function wantsDetail(message: string): boolean {
  return DETAIL_REQUEST.test(String(message ?? ""));
}

const OPENER = /^\s*(?:sure|certainly|absolutely|of course|got it|great question|no problem|okay|ok|alright|understood)[\s!,.\-–—:]+/i;
/** Removes stock openers and runs of blank lines from a finished reply; never touches numbers, warnings or the substance. */
export function tightenReply(text: string): string {
  let t = String(text ?? "").replace(/\n{3,}/g, "\n\n").trim();
  for (let i = 0; i < 2; i++) {
    const next = t.replace(OPENER, "");
    if (next === t || !next.trim()) break;
    t = next.charAt(0).toUpperCase() + next.slice(1);
  }
  return t;
}

export const CHAT_TOKENS_SHORT = 450;
export const CHAT_TOKENS_LONG = 900;
