// Phone-alert (ntfy) setup helpers. ntfy topics work like an unlisted address: anyone who knows or guesses a topic name can read every
// alert sent to it, so a topic must be long and random. Existing topics are never changed automatically (users, and Watches with their own
// topic, already subscribed their phones to them); the user is only told if theirs is easy to guess.
import { randomBytes } from "node:crypto";
export { describeTopicStrength, subscribeAddress, topicStrengthMessage, type TopicStrength } from "./ntfyTopic.js";

// Lowercase letters and digits only: easy to read aloud and type on a phone, valid in a topic name and in a URL.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A new private topic: "clynx-" + 26 random characters (about 134 bits). Rejection sampling avoids the bias a plain modulo would add.
 */
export function generateNtfyTopic(random: (n: number) => Buffer = randomBytes): string {
  const out: string[] = [];
  while (out.length < 26) {
    for (const byte of random(32)) {
      if (byte >= 252) continue; // 252 = 36 * 7, the largest multiple of 36 below 256: values above it would favour the first letters
      out.push(ALPHABET[byte % 36]);
      if (out.length === 26) break;
    }
  }
  return `clynx-${out.join("")}`;
}

export interface TestNotificationResult {
  ok: boolean;
  // Plain words for the user, success or not.
  message: string;
}

/** Turns what a failed ntfy request threw into something a person can act on. */
export function explainNtfyFailure(raw: string): string {
  if (/abort|timed? ?out/i.test(raw)) return "The notification server didn't answer in time. Check your internet connection and try again.";
  if (/fetch failed|enotfound|econnrefused|econnreset|network|getaddrinfo|certificate|ssl/i.test(raw)) return "Clynx couldn't reach the notification server. Check your internet connection, and that the server address is right.";
  const status = /ntfy push failed: (\d{3})/.exec(raw)?.[1];
  if (status === "429") return "The notification server says you've sent too many messages for now. Wait a minute and try again.";
  if (status === "401" || status === "403") return "The notification server refused the message (the topic may be protected or reserved). Try a different topic.";
  if (status === "400" || status === "404") return "The notification server didn't accept this topic name. Use only letters, numbers, dashes and underscores.";
  if (status) return `The notification server answered with an error (${status}). Try again in a moment.`;
  return "The test notification could not be sent. Check the server address and topic, then try again.";
}
