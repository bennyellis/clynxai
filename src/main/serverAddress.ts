// The Clynx server address a person types ("Advanced > Server address"), and "Test connection". Pure functions with an injectable fetch so every branch is tested without a network.
//
// Rules, in plain words:
//   * An address on the internet must be https (encrypted). Plain http is accepted only for this computer or a network you control (a private address like 10.x / 192.168.x / 172.16-31.x,
//     a .local / .lan name, or a single-word computer name). That keeps a password from ever travelling unencrypted across the internet.
//   * Anything after the host (a path, ?query, #fragment) is ignored and credentials in the address are refused.
export type ServerAddressResult = { ok: true; url: string; kind: "loopback" | "local-network" | "internet"; secure: boolean; warnings: string[] } | { ok: false; error: string };

const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./];

export function classifyHost(host: string): "loopback" | "local-network" | "internet" {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || /^127\./.test(h) || h.endsWith(".localhost")) return "loopback";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return PRIVATE_V4.some((r) => r.test(h)) ? "local-network" : "internet";
  if (h.includes(":")) return /^(fc|fd|fe80)/.test(h) ? "local-network" : "internet"; // IPv6: unique-local / link-local
  if (!h.includes(".")) return "local-network"; // a single-word computer name such as "ben"
  if (/\.(local|lan|home|internal|home\.arpa)$/.test(h)) return "local-network";
  return "internet";
}

export function normalizeServerUrl(input: unknown): ServerAddressResult {
  if (typeof input !== "string") return { ok: false, error: "Enter the server address." };
  let text = input.trim();
  if (!text) return { ok: false, error: "Enter the server address." };
  if (text.length > 300) return { ok: false, error: "That address is too long." };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // no scheme typed: a network-local name or address is assumed to be http (the usual home setup), anything else https
    const host = text.split(/[/?#:]/)[0];
    text = (classifyHost(host) === "internet" ? "https://" : "http://") + text;
  }
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: "That does not look like an address. Example: http://192.168.1.20:8788" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "Use an http:// or https:// address." };
  if (u.username || u.password) return { ok: false, error: "Do not put a user name or password in the address." };
  if (!u.hostname) return { ok: false, error: "The address has no computer name." };
  const kind = classifyHost(u.hostname);
  const secure = u.protocol === "https:";
  if (!secure && kind === "internet") {
    return { ok: false, error: "This address is on the internet, so it must start with https:// (encrypted). Clynx never sends a password over plain http across the internet." };
  }
  const warnings: string[] = [];
  if (!secure && kind === "local-network") warnings.push("This connection is not encrypted. That is fine on your own home or office network, but do not use it on public Wi-Fi.");
  if (kind === "loopback") warnings.push("localhost means THIS computer. To use a server running on another computer, enter that computer's network address.");
  return { ok: true, url: u.origin, kind, secure, warnings };
}

// ---- turning a network failure into a sentence a person can act on ----------------------------------------------------------------------------------------------
export function describeFetchFailure(err: unknown, url: string): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? (e as { code?: string })?.code ?? "";
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if (e?.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return `${host} did not answer in time. Check that the server computer is on and Clynx Cloud is running, that both computers are on the same network (not a guest network), and that the address is right.`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `The name ${host} is not known on this network. Use the server's numeric address (like 192.168.1.20) instead.`;
  if (code === "ECONNREFUSED") return `${host} refused the connection. The computer is reachable but Clynx Cloud is not running on that port, or the port number is wrong.`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `There is no route to ${host}. Check that this computer is on the same network as the server.`;
  if (code === "ECONNRESET") return `The connection to ${host} was cut off. Try again; if it keeps happening the server or a firewall is closing it.`;
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL/i.test(code) || /certificate|self.signed/i.test(e?.message ?? "")) {
    return `${host} presented a security certificate this computer does not trust. Clynx will not connect to it. (Ask the person who runs the server for an address with a valid certificate.)`;
  }
  return `Could not reach ${host} (${code || e?.message || "unknown error"}).`;
}

// ---- Test connection ------------------------------------------------------------------------------------------------------------------------------------------
export const SUPPORTED_API_VERSION = 1;

export interface ServerTestOk {
  ok: true;
  url: string;
  name: string;
  serverVersion: string | null;
  apiVersion: number | null;
  latencyMs: number;
  secure: boolean;
  kind: "loopback" | "local-network" | "internet";
  services: { sharedAi: boolean; sharedEbay: boolean; billing: string; updates: boolean };
  /** "private": the server shows strangers only a sign-in page. registration: who may create an account. */
  access: "open" | "private";
  registration: "open" | "invite" | "closed";
  warnings: string[];
  /** The server is too old to describe itself (it answered /health only). */
  legacy: boolean;
}
export type ServerTestResult = ServerTestOk | { ok: false; error: string; stage: "address" | "network" | "not-clynx" | "version" };

export function compareVersionsLoose(a: string, b: string): number {
  const pa = (a.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  const pb = (b.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export async function testServer(input: string, opts: { clientVersion: string; fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number }): Promise<ServerTestResult> {
  const addr = normalizeServerUrl(input);
  if (!addr.ok) return { ok: false, error: addr.error, stage: "address" };
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const get = async (path: string): Promise<Response> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8000);
    try {
      return await doFetch(`${addr.url}${path}`, { signal: ctl.signal, redirect: "error", headers: { Accept: "application/json" } });
    } finally {
      clearTimeout(timer);
    }
  };
  const started = now();
  let res: Response;
  try {
    res = await get("/server/info");
  } catch (err) {
    return { ok: false, error: describeFetchFailure(err, addr.url), stage: "network" };
  }
  const latencyMs = now() - started;
  const base = { url: addr.url, latencyMs, secure: addr.secure, kind: addr.kind, warnings: [...addr.warnings] };
  const noServices = { sharedAi: false, sharedEbay: false, billing: "none", updates: false };

  if (res.status === 404) {
    // a Clynx server from before this check existed answers /health but not /server/info
    try {
      const h = await get("/health");
      const body = (await h.json().catch(() => null)) as { status?: string } | null;
      if (h.ok && body && body.status === "ok") return { ok: true, name: "Clynx Cloud", serverVersion: null, apiVersion: null, services: noServices, access: "open", registration: "open", legacy: true, ...base };
    } catch {
      /* fall through */
    }
    return { ok: false, error: "Something answered at that address, but it is not a Clynx server.", stage: "not-clynx" };
  }
  if (!res.ok) return { ok: false, error: `The server answered with an error (${res.status}). Try again in a moment.`, stage: "network" };
  const info = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!info || info.product !== "clynx-cloud") return { ok: false, error: "Something answered at that address, but it is not a Clynx server.", stage: "not-clynx" };

  const apiVersion = typeof info.apiVersion === "number" ? info.apiVersion : null;
  if (apiVersion !== null && apiVersion > SUPPORTED_API_VERSION) {
    return { ok: false, error: "This server is newer than this copy of Clynx understands. Update Clynx (Config > Account > Updates, or install the latest version) and try again.", stage: "version" };
  }
  if (typeof info.minClientVersion === "string" && info.minClientVersion && compareVersionsLoose(opts.clientVersion, info.minClientVersion) < 0) {
    return { ok: false, error: `This server needs Clynx ${info.minClientVersion} or newer (you have ${opts.clientVersion}). Install the latest version first.`, stage: "version" };
  }
  const s = (info.services ?? {}) as Record<string, any>;
  return {
    ok: true,
    name: typeof info.name === "string" ? info.name.slice(0, 80) : "Clynx Cloud",
    serverVersion: typeof info.serverVersion === "string" ? info.serverVersion.slice(0, 40) : null,
    apiVersion,
    services: { sharedAi: s.sharedAi === true, sharedEbay: s.sharedEbay === true, billing: typeof s.billing === "string" ? s.billing : "none", updates: s.updates === true },
    access: info.access === "private" ? "private" : "open",
    registration: info.registration === "invite" || info.registration === "closed" ? info.registration : "open",
    legacy: false,
    ...base,
  };
}
