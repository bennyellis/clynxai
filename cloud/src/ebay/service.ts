import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { query } from "../db/client.js";
import { type EbayCredentials, getEbayCredentials, recordVerification } from "../integrations/credentials.js";
import { outboundFetch } from "../integrations/http.js";
import { open, seal } from "../integrations/vault.js";

// The server-side eBay integration, using the company's application credentials. eBay has two kinds of access and they are kept apart on purpose:
//
//   APPLICATION access (client-credentials grant): an app token that reads PUBLIC data (the Browse API: search and item details). It says nothing about any eBay user. This is what
//   customers' searches use, through this server, so no customer needs an eBay developer account of their own.
//
//   USER access (authorization-code grant): reading or acting on one person's OWN eBay account (for example their inventory) needs THAT person to consent on eBay's own page. The
//   application credentials do NOT grant it. The person's tokens are stored encrypted, refreshed when they expire, and used only for that person.
//
// Not provided, because the application credentials do not allow it: sold-price history (eBay's Marketplace Insights API is restricted to approved partners), and anything on a user's
// account without that user's consent.

export class EbayError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const hostsFor = (env: "PRODUCTION" | "SANDBOX") =>
  env === "SANDBOX"
    ? { api: "https://api.sandbox.ebay.com", auth: "https://auth.sandbox.ebay.com", token: "https://api.sandbox.ebay.com/identity/v1/oauth2/token" }
    : { api: "https://api.ebay.com", auth: "https://auth.ebay.com", token: "https://api.ebay.com/identity/v1/oauth2/token" };

export const DEFAULT_USER_SCOPES = "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly";
const APP_SCOPE = "https://api.ebay.com/oauth/api_scope";
const userScopes = () => (process.env.EBAY_USER_SCOPES ?? DEFAULT_USER_SCOPES).trim();

const basic = (c: EbayCredentials) => `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`;

async function tokenRequest(c: EbayCredentials, form: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string; refresh_token_expires_in?: number }> {
  let res: Response;
  try {
    res = await outboundFetch(hostsFor(c.environment).token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic(c) },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new EbayError(502, "ebay_unreachable", "eBay could not be reached.");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const invalid = data.error === "invalid_grant";
    throw new EbayError(invalid ? 400 : res.status === 401 || res.status === 400 ? 503 : 502, invalid ? "invalid_grant" : "ebay_token_failed", `eBay refused the token request (${String(data.error ?? res.status)}).`);
  }
  if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") throw new EbayError(502, "ebay_token_failed", "eBay returned an unexpected token answer.");
  return data as never;
}

// ---------------------------------------------------------------- application token (shared by everyone, cached until shortly before it expires, one request at a time)
let appToken: { token: string; expiresAt: number; clientId: string } | null = null;
let appTokenInFlight: Promise<string> | null = null;
export const resetEbayTokens = () => {
  appToken = null;
  appTokenInFlight = null;
};

async function creds(): Promise<{ creds: EbayCredentials; source: string }> {
  const c = await getEbayCredentials();
  if (!c) throw new EbayError(503, "ebay_not_configured", "eBay features are not set up on this server yet.");
  return c;
}

export async function getAppToken(): Promise<string> {
  const { creds: c } = await creds();
  if (appToken && appToken.clientId === c.clientId && appToken.expiresAt > Date.now() + 60_000) return appToken.token;
  // eBay limits how often tokens may be minted, so concurrent callers share one request
  appTokenInFlight ??= (async () => {
    try {
      const t = await tokenRequest(c, { grant_type: "client_credentials", scope: APP_SCOPE });
      appToken = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000, clientId: c.clientId };
      return t.access_token;
    } finally {
      appTokenInFlight = null;
    }
  })();
  return appTokenInFlight;
}

/** Checks the stored eBay application credentials by minting an application token (free) and records the result. */
export async function verifyEbay(userId: string | null): Promise<{ ok: boolean; error: string | null }> {
  resetEbayTokens();
  try {
    await getAppToken();
    const c = await getEbayCredentials();
    if (c?.source === "vault") await recordVerification("ebay", true, null, userId);
    return { ok: true, error: null };
  } catch (e) {
    const msg = e instanceof EbayError ? (e.code === "ebay_not_configured" ? "No eBay credentials are configured." : e.message) : "The stored eBay credentials could not be used.";
    const c = await getEbayCredentials().catch(() => null);
    if (c?.source === "vault") await recordVerification("ebay", false, msg, userId);
    return { ok: false, error: msg };
  }
}

const MARKETPLACES = new Set(["EBAY_US", "EBAY_GB", "EBAY_CA", "EBAY_AU", "EBAY_DE"]);

/** A read of PUBLIC eBay data with the application token. */
export async function appGet(path: string, params: URLSearchParams, marketplace = "EBAY_US"): Promise<{ status: number; data: unknown }> {
  const { creds: c } = await creds();
  const host = hostsFor(c.environment).api;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAppToken();
    let res: Response;
    try {
      res = await outboundFetch(`${host}${path}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACES.has(marketplace) ? marketplace : "EBAY_US", Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new EbayError(502, "ebay_unreachable", "eBay could not be reached.");
    }
    if (res.status === 401 && attempt === 0) {
      appToken = null; // the token was revoked or expired early: mint a new one and try once more
      continue;
    }
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  throw new EbayError(502, "ebay_unreachable", "eBay did not accept the request.");
}

// ---------------------------------------------------------------- individual customers' consent
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const sign = (payload: string) => createHmac("sha256", config.jwtRefreshSecret).update(`ebay-oauth-state:${payload}`).digest("base64url");

export function ebayUserFlowAvailable(c: EbayCredentials): boolean {
  return !!c.ruName;
}

/** The eBay consent page address for this customer. The state is bound to the customer, expires, and works once. */
export async function buildConsentUrl(userId: string): Promise<string> {
  const { creds: c } = await creds();
  if (!c.ruName) throw new EbayError(503, "ebay_user_flow_not_configured", "Connecting an eBay account is not set up on this server yet.");
  const nonce = randomBytes(18).toString("base64url");
  const exp = Date.now() + 10 * 60_000;
  await query("INSERT INTO ebay_oauth_states (nonce, user_id, expires_at) VALUES ($1, $2, $3)", [nonce, userId, new Date(exp)]);
  const payload = `${nonce}.${b64(userId)}.${exp}`;
  const url = new URL(`${hostsFor(c.environment).auth}/oauth2/authorize`);
  url.search = new URLSearchParams({ client_id: c.clientId, response_type: "code", redirect_uri: c.ruName, scope: userScopes(), state: `${payload}.${sign(payload)}` }).toString();
  return url.toString();
}

interface StoredTokens { accessToken: string; refreshToken: string }

/** Finishes the consent: checks the state, exchanges the code, stores the tokens encrypted. Returns the customer it was for. */
export async function completeConsent(code: string, state: string): Promise<string> {
  const parts = state.split(".");
  if (parts.length !== 4) throw new EbayError(400, "bad_state", "This connection link is not valid.");
  const payload = parts.slice(0, 3).join(".");
  const given = Buffer.from(parts[3]);
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new EbayError(400, "bad_state", "This connection link is not valid.");
  const used = await query<{ user_id: string }>("UPDATE ebay_oauth_states SET used_at = now() WHERE nonce = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id", [parts[0]]);
  if (!used.rows[0] || b64(used.rows[0].user_id) !== parts[1]) throw new EbayError(400, "bad_state", "This connection link is not valid, was already used, or expired.");
  const userId = used.rows[0].user_id;
  const { creds: c } = await creds();
  if (!c.ruName) throw new EbayError(503, "ebay_user_flow_not_configured", "Connecting an eBay account is not set up on this server yet.");
  const t = await tokenRequest(c, { grant_type: "authorization_code", code, redirect_uri: c.ruName });
  if (!t.refresh_token) throw new EbayError(502, "ebay_token_failed", "eBay did not return a refresh token.");
  await storeTokens(userId, { accessToken: t.access_token, refreshToken: t.refresh_token }, t.expires_in, t.refresh_token_expires_in);
  return userId;
}

async function storeTokens(userId: string, tokens: StoredTokens, expiresIn: number, refreshExpiresIn?: number): Promise<void> {
  const sealed = seal(JSON.stringify(tokens));
  await query(
    `INSERT INTO ebay_user_tokens (user_id, ciphertext, key_id, scopes, access_expires_at, refresh_expires_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, key_id = EXCLUDED.key_id, scopes = EXCLUDED.scopes, access_expires_at = EXCLUDED.access_expires_at,
       refresh_expires_at = COALESCE(EXCLUDED.refresh_expires_at, ebay_user_tokens.refresh_expires_at), updated_at = now()`,
    [userId, sealed.value, sealed.keyId, userScopes(), new Date(Date.now() + expiresIn * 1000), refreshExpiresIn ? new Date(Date.now() + refreshExpiresIn * 1000) : null]
  );
}

export async function connectionStatus(userId: string): Promise<{ connected: boolean; scopes: string | null; connectedAt: Date | null }> {
  const r = await query<{ scopes: string; connected_at: Date }>("SELECT scopes, connected_at FROM ebay_user_tokens WHERE user_id = $1", [userId]);
  return r.rows[0] ? { connected: true, scopes: r.rows[0].scopes, connectedAt: r.rows[0].connected_at } : { connected: false, scopes: null, connectedAt: null };
}

export async function disconnect(userId: string): Promise<boolean> {
  const r = await query("DELETE FROM ebay_user_tokens WHERE user_id = $1", [userId]);
  return (r.rowCount ?? 0) > 0;
}

/** The customer's own access token, refreshed when it is about to expire. A grant eBay no longer honours disconnects the customer. */
export async function userAccessToken(userId: string): Promise<string> {
  const r = await query<{ ciphertext: string; access_expires_at: Date }>("SELECT ciphertext, access_expires_at FROM ebay_user_tokens WHERE user_id = $1", [userId]);
  const row = r.rows[0];
  if (!row) throw new EbayError(409, "ebay_not_connected", "Connect your eBay account first.");
  const tokens = JSON.parse(open(row.ciphertext)) as StoredTokens;
  if (row.access_expires_at.getTime() > Date.now() + 120_000) return tokens.accessToken;
  const { creds: c } = await creds();
  try {
    const t = await tokenRequest(c, { grant_type: "refresh_token", refresh_token: tokens.refreshToken, scope: userScopes() });
    await storeTokens(userId, { accessToken: t.access_token, refreshToken: t.refresh_token ?? tokens.refreshToken }, t.expires_in, t.refresh_token_expires_in);
    return t.access_token;
  } catch (e) {
    if (e instanceof EbayError && e.code === "invalid_grant") {
      await disconnect(userId);
      throw new EbayError(409, "ebay_not_connected", "Your eBay connection expired. Connect your eBay account again.");
    }
    throw e;
  }
}

/** A read of THIS customer's own eBay data with THEIR token. */
export async function userGet(userId: string, path: string, params: URLSearchParams): Promise<{ status: number; data: unknown }> {
  const { creds: c } = await creds();
  const token = await userAccessToken(userId);
  let res: Response;
  try {
    res = await outboundFetch(`${hostsFor(c.environment).api}${path}?${params.toString()}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new EbayError(502, "ebay_unreachable", "eBay could not be reached.");
  }
  return { status: res.status, data: await res.json().catch(() => null) };
}
