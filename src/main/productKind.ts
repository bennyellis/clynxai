// What KIND of thing a title or product name is: hardware, a game / software for a platform, or an accessory (pure, leaf module shared by comparable-sale identity,
// reference-photo identity and Search For variants so they cannot disagree).
export type ItemKind = "hardware" | "game" | "accessory";

// Software, discs and media that merely name a platform.
const MEDIA_WORDS = /\b(video ?games?|game ?discs?|games? only|disc only|blu-?ray|dvd|steelbook|digital code|download code|dlc|season pass|cartridge only|game case|cover art|gameplay|soundtrack|strategy guide|art ?book)\b/i;
// A platform used as a badge: "(Xbox Series X)", "- Xbox Series X", "for Xbox Series X", "Xbox Series X|S game".
const PLATFORM = "(?:xbox(?: series [xs](?:\\s*[|/&]\\s*[xs])?| one(?: [xs])?| 360)?|playstation ?[2-5]?|ps ?[2-5]|nintendo (?:switch(?: 2)?|3ds|ds|wii(?: u)?)|switch|steam deck|pc)";
const PLATFORM_BADGE = new RegExp(`\\(\\s*(?:[^)]*\\b)?${PLATFORM}\\b[^)]*\\)|\\s[-–|]\\s*${PLATFORM}\\b\\s*$|\\bfor ${PLATFORM}\\b|\\b${PLATFORM}\\s*(?:game|games|edition game|version)\\b`, "i");
// Words that say the title is the machine itself, which a platform badge on its own cannot override ("PlayStation 5 (PS5) 825GB").
const HARDWARE_NOUNS = /\b(console|system|handheld|\d+(?:\.\d+)?\s?(?:tb|gb)|slim|oled|disc drive|digital edition console|bundle with (?:a )?(?:console)?)\b/i;
const ACCESSORY_TITLE = /\b(controllers?|gamepad|joy-?cons?|case|skin|decal|cover|stand|dock|charger|charging|cable|cord|adapter|headset|headphones|remote|battery|strap|grip|bag|pouch|sleeve|lanyard|tripod|stylus|carrying|protector|mount|cooling fan|hdmi|thumb ?grips?|faceplate|memory card|expansion card|keyboard|mouse|steering wheel|webcam|capture card)\b/i;

// Words that can precede a platform name in a title for the MACHINE itself ("Brand New Sealed Microsoft Xbox Series X").
const FILLER_BEFORE_PLATFORM = new Set("a an the new brand sealed used open box refurbished renewed microsoft sony nintendo apple console system bundle pre owned preowned like mint black white blue red carbon digital disc slim pro oled lite series edition limited special galaxy".split(" "));
const TRAILING_PLATFORM = new RegExp(`^(.+?)\\s+${PLATFORM}(?:\\s+(?:brand new|new|sealed|used|cib|complete|physical|disc|ntsc|us))*\\s*$`, "i");

/** What the TITLE of an image's source says it is, when it says: a game / software for a platform, an accessory, or null (no objection). */
export function mediaSignal(title: string): string | null {
  const t = String(title ?? "");
  const m = MEDIA_WORDS.exec(t);
  if (m) return m[0];
  const b = PLATFORM_BADGE.exec(t);
  if (b && !HARDWARE_NOUNS.test(t)) return b[0].trim();
  // "Call of Duty Black Ops 6 Xbox Series X": other words, then the platform at the very end, none of them describing the machine itself
  const trailing = TRAILING_PLATFORM.exec(t);
  if (trailing && !HARDWARE_NOUNS.test(t)) {
    const before = trailing[1].toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter((w) => w && !FILLER_BEFORE_PLATFORM.has(w) && !/^\d+(?:tb|gb)$/.test(w));
    if (before.length >= 2) return `${before.slice(0, 3).join(" ")} ... (platform at the end)`;
  }
  return null;
}

export function kindOfName(name: string): ItemKind {
  if (mediaSignal(name)) return "game";
  if (accessorySignal(name)) return "accessory";
  return "hardware";
}


/** The part of a title before it starts listing what comes WITH the item ("... with 2 controllers", "+ cable"). */
export function headOf(title: string): string {
  const m = /\b(?:with|includes?|included|including|incl|w\/|plus|and)\b|\+/i.exec(title);
  return m ? title.slice(0, m.index) : title;
}

// Wording that DESCRIBES the machine's own battery or revision, not a battery for sale ("V2 battery", "improved battery life").
const DESCRIPTOR_PHRASES = /\b(?:revised|improved|extended|longer|upgraded|enhanced|new|v\d)\s+battery(?:\s+life)?\b|\bbattery life\b/gi;
/** The title without wording that only describes the machine itself (see above): what accessory scans should read. */
export function stripDescriptors(title: string): string {
  // "(Joy-Con included)": a parenthetical that only says what comes in the box is the extras, not the subject
  return String(title ?? "").replace(DESCRIPTOR_PHRASES, " ").replace(/\([^)]*\b(?:included|includes|incl\.?)\s*\)/gi, " ");
}
// What follows an accessory word when the title is still describing the machine: a capacity or a manufacturer code ("Console Neon Blue Red Joy-Con 32GB HAC-001").
const HARDWARE_TAIL = /\d+\s?(?:tb|gb)\b|\b[a-z]{2,5}-\d{3,5}[a-z]?\b/i;
export function hardwareTail(tail: string): boolean {
  return HARDWARE_TAIL.test(tail);
}

/** The accessory word a title is ABOUT (its head, not its extras), or null. A machine's title that merely lists a bundled controller before its capacity/model code is not about an accessory. */
export function accessorySignal(title: string): string | null {
  const head = headOf(stripDescriptors(title));
  const m = ACCESSORY_TITLE.exec(head);
  if (!m) return null;
  if (hardwareTail(head.slice(m.index + m[0].length)) && !/\b(?:for|compatible|fits|replacement)\b/i.test(head)) return null;
  return m[0];
}
