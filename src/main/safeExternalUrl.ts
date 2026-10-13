// The only URLs the app ever hands to the operating system's browser on a server's say-so (billing checkout / portal pages): https, or plain http only for a
// local development server. Anything else (file:, javascript:, custom protocols, malformed text) is refused.
export function safeExternalUrl(url: unknown): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return { ok: false, error: "The server returned an invalid address." };
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return { ok: false, error: "The server returned an address that is not secure." };
  if (u.username || u.password) return { ok: false, error: "The server returned an address that is not valid." };
  return { ok: true, url: u.toString() };
}
