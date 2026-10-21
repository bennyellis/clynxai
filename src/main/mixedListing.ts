// Mixed listings (scanner parity S2): "Xbox Series X with Titanfall 2" is TWO products, the console and the game. This decides, for each extra item a bundle listing names, whether it is a game that
// should get its own entry (filed with the platform's games, linked to the console), an accessory (the add-on pipeline's job) or something else. Pure.
import { kindOfName } from "./productKind.js";

export type ItemRole = "game" | "accessory" | "other";

// Consoles and handhelds whose bundles carry games. The base entry's family or name has to say so before an unfamiliar title is read as a game.
const GAME_PLATFORM = /\b(xbox|playstation|ps\s?[1-5]|nintendo|switch|3ds|2ds|wii|gamecube|sega|genesis|dreamcast|atari|steam deck|game boy|gameboy|psp|vita)\b/i;
const ACCESSORY_WORDS = /\b(controllers?|gamepads?|joy-?cons?|chargers?|charging|cables?|cords?|adapters?|headsets?|headphones?|dock|stand|case|bag|battery|batteries|remote|hdmi|power|ssd|hard drive|memory card|expansion|kinect|camera|microphone|mic|skin|grip|strap|stylus|screen protector|warranty|receipt|box)\b/i;
const NOT_A_GAME = /\b(console|system|bundle|lot|extra|extras|accessor(?:y|ies)|games?\s+only|more|others?|etc)\b/i;

export const isGamePlatform = (baseNameOrFamily: string | null | undefined): boolean => GAME_PLATFORM.test(String(baseNameOrFamily ?? ""));

/** What an extra item named in a listing for `baseName` (the console) is. */
export function itemRole(itemName: string, baseName: string, baseFamily: string | null): ItemRole {
  const n = String(itemName ?? "").replace(/\s+/g, " ").trim();
  if (!n || n.length < 2) return "other";
  if (ACCESSORY_WORDS.test(n)) return "accessory";
  const kind = kindOfName(n);
  if (kind === "accessory") return "accessory";
  if (kind === "game") return "game";
  if (kind === "hardware" && /\b(xbox|playstation|ps\s?[1-5]|switch|series [xs]|wii|3ds)\b/i.test(n)) return "other"; // a second console is not a game
  if (NOT_A_GAME.test(n) || /[+,;]|\band\b/i.test(n)) return "other"; // a list or a vague word, not one title
  if (!isGamePlatform(`${baseFamily ?? ""} ${baseName}`)) return "other";
  const words = n.split(" ");
  return words.length >= 1 && words.length <= 8 && /[A-Za-z]/.test(n) ? "game" : "other";
}

/** The folder a game for this console is filed in: the brand folder, then Games ("Xbox > Games"). Null when the console's family is not known. */
export function gameFamilyPath(baseFamily: string | null | undefined): string | null {
  const segments = String(baseFamily ?? "").split(">").map((x) => x.trim()).filter(Boolean);
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1];
  const brand = segments.length > 1 && /^(consoles?|accessories|games|handhelds?)$/i.test(last) ? segments.slice(0, -1) : segments;
  return `${brand.slice(0, 2).join(" > ")} > Games`;
}

/** At most this many games from one listing become entries (a lot of 40 titles is not 40 entries). */
export const MAX_GAMES_PER_LISTING = 5;
