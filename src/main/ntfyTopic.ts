// Pure, dependency-free ntfy topic helpers, shared by the main process and the screens (no Node imports here).
// ntfy topics work like an unlisted address: anyone who knows or guesses a topic name can read every alert sent to it.

export type TopicStrength = "empty" | "invalid" | "guessable" | "private";

const COMMON = /^(clynx|clynxai|clynx[-_]?alerts?|alerts?|deals?|test|testing|ntfy|phone|marketplace|flip|flips|resell|reselling|my[-_]?topic|mytopic|topic)\d{0,4}$/i;

/** How safe a topic name is to rely on. Judged on the name only; nothing is sent anywhere. */
export function describeTopicStrength(topic: string): TopicStrength {
  const t = topic.trim();
  if (!t) return "empty";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(t)) return "invalid";
  // Random enough: long, and not just a word. (Unique letters are a cheap proxy for "not a phrase": clynxclynxclynx is long but weak.)
  const unique = new Set(t.toLowerCase()).size;
  if (t.length >= 20 && unique >= 10 && !COMMON.test(t)) return "private";
  return "guessable";
}

export function topicStrengthMessage(strength: TopicStrength): string | null {
  switch (strength) {
    case "empty":
      return "No topic yet, so phone alerts are off.";
    case "invalid":
      return "Topics can only use letters, numbers, dashes and underscores (up to 64 characters).";
    case "guessable":
      return "This topic is short or easy to guess. Anyone who guesses it can read your alerts. A generated private topic is safer; if you switch, subscribe your phone to the new one.";
    case "private":
      return null;
  }
}

/** The address a phone subscribes to, shown to the user ("ntfy.sh/clynx-..."). */
export function subscribeAddress(server: string, topic: string): string {
  return `${server.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/${topic.trim()}`;
}
