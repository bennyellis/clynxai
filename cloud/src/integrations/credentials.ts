import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/client.js";
import { open, seal, vaultConfigured, VaultError } from "./vault.js";
import { outboundFetch } from "./http.js";

// The company-managed provider credentials. Where each one comes from, in order:
//   1. the vault (saved by the Owner in the console, stored encrypted),
//   2. the server's environment (OPENAI_API_KEY, EBAY_CLIENT_ID / EBAY_CLIENT_SECRET) - only when nothing was ever saved in the vault.
// A credential the Owner REVOKED stays revoked: the environment is not used as a way back in. Secrets leave this module only to the code that calls the provider; the status shown to
// people carries a masked identifier and flags, never a secret.

export type Provider = "openai" | "ebay";
export interface OpenAICredentials { apiKey: string }
export interface EbayCredentials { clientId: string; clientSecret: string; environment: "PRODUCTION" | "SANDBOX"; ruName?: string }

export const openaiSchema = z.object({ apiKey: z.string().trim().regex(/^sk-[A-Za-z0-9_-]{20,300}$/, "That does not look like an OpenAI API key.") });
export const ebaySchema = z.object({
  clientId: z.string().trim().regex(/^[A-Za-z0-9._-]{8,200}$/, "The eBay App ID (client id) looks wrong."),
  clientSecret: z.string().trim().regex(/^[A-Za-z0-9._-]{8,200}$/, "The eBay Cert ID (client secret) looks wrong."),
  environment: z.enum(["PRODUCTION", "SANDBOX"]).default("PRODUCTION"),
  ruName: z.string().trim().max(200).regex(/^[A-Za-z0-9._-]*$/, "The RuName looks wrong.").optional(),
});

export class NotConfiguredError extends Error {
  constructor(public provider: Provider) {
    super(`${provider} is not configured`);
  }
}

interface Row {
  ciphertext: string;
  masked: Record<string, unknown>;
  version: number;
  last_verified_at: Date | null;
  last_verify_ok: boolean | null;
  last_verify_error: string | null;
  updated_at: Date;
  updated_by_email: string | null;
}

async function rowFor(provider: Provider): Promise<Row | null> {
  const r = await query<Row>(
    `SELECT c.ciphertext, c.masked, c.version, c.last_verified_at, c.last_verify_ok, c.last_verify_error, c.updated_at, u.email AS updated_by_email
     FROM integration_credentials c LEFT JOIN users u ON u.id = c.updated_by WHERE c.provider = $1`,
    [provider]
  );
  return r.rows[0] ?? null;
}

const cache = new Map<string, { at: number; value: unknown }>();
const CACHE_MS = 10_000; // short, so a rotation or revocation on one server instance reaches the others within seconds
export function invalidateCredentialCache(): void {
  cache.clear();
}
async function cached<T>(provider: Provider, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  cache.set(provider, { at: Date.now(), value });
  return value;
}

export async function getOpenAICredentials(): Promise<{ creds: OpenAICredentials; source: "vault" | "environment" } | null> {
  return cached("openai", async () => {
    const row = await rowFor("openai");
    if (row) {
      if (!row.ciphertext) return null; // revoked
      return { creds: JSON.parse(open(row.ciphertext)) as OpenAICredentials, source: "vault" as const };
    }
    return config.openaiApiKey ? { creds: { apiKey: config.openaiApiKey }, source: "environment" as const } : null;
  });
}

export async function getEbayCredentials(): Promise<{ creds: EbayCredentials; source: "vault" | "environment" } | null> {
  return cached("ebay", async () => {
    const row = await rowFor("ebay");
    if (row) {
      if (!row.ciphertext) return null;
      return { creds: JSON.parse(open(row.ciphertext)) as EbayCredentials, source: "vault" as const };
    }
    const id = process.env.EBAY_CLIENT_ID?.trim();
    const secret = process.env.EBAY_CLIENT_SECRET?.trim();
    return id && secret ? { creds: { clientId: id, clientSecret: secret, environment: process.env.EBAY_ENV === "SANDBOX" ? ("SANDBOX" as const) : ("PRODUCTION" as const), ruName: process.env.EBAY_RUNAME?.trim() || undefined }, source: "environment" as const } : null;
  });
}

const maskKey = (k: string) => `${k.slice(0, 3)}…${k.slice(-4)}`;
const maskId = (k: string) => `${k.slice(0, 6)}…${k.slice(-4)}`;

async function event(provider: Provider, action: string, userId: string | null, ok = true, detail: string | null = null) {
  await query("INSERT INTO integration_events (provider, action, by_user, ok, detail) VALUES ($1, $2, $3, $4, $5)", [provider, action, userId, ok, detail]);
}

/** Saves or replaces (rotates) a credential. The old value is overwritten, never kept. Returns only the masked view. */
export async function saveCredentials(provider: Provider, payload: OpenAICredentials | EbayCredentials, userId: string): Promise<{ masked: Record<string, unknown>; version: number; rotated: boolean }> {
  if (!vaultConfigured()) throw new VaultError("not_configured", "CREDENTIALS_ENCRYPTION_KEY is not set on the server, so credentials cannot be stored.");
  const masked: Record<string, unknown> =
    provider === "openai"
      ? { key: maskKey((payload as OpenAICredentials).apiKey) }
      : { clientId: maskId((payload as EbayCredentials).clientId), secret: "set", environment: (payload as EbayCredentials).environment, ruName: (payload as EbayCredentials).ruName ? "set" : "not set" };
  const sealed = seal(JSON.stringify(payload));
  const existing = await rowFor(provider);
  const rotated = !!existing && !!existing.ciphertext;
  const r = await query<{ version: number }>(
    `INSERT INTO integration_credentials (provider, ciphertext, key_id, masked, version, updated_by) VALUES ($1, $2, $3, $4, 1, $5)
     ON CONFLICT (provider) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, key_id = EXCLUDED.key_id, masked = EXCLUDED.masked, version = integration_credentials.version + 1,
       last_verified_at = NULL, last_verify_ok = NULL, last_verify_error = NULL, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING version`,
    [provider, sealed.value, sealed.keyId, JSON.stringify(masked), userId]
  );
  invalidateCredentialCache();
  await event(provider, rotated ? "rotate" : "set", userId);
  return { masked, version: r.rows[0].version, rotated };
}

/** Revokes a credential: the ciphertext is erased and the environment is NOT used as a fallback afterwards. */
export async function revokeCredentials(provider: Provider, userId: string): Promise<void> {
  await query(
    `INSERT INTO integration_credentials (provider, ciphertext, key_id, masked, version, updated_by, last_verify_ok, last_verify_error) VALUES ($1, '', '', '{}'::jsonb, 1, $2, false, 'revoked')
     ON CONFLICT (provider) DO UPDATE SET ciphertext = '', key_id = '', masked = '{}'::jsonb, version = integration_credentials.version + 1, last_verify_ok = false, last_verify_error = 'revoked',
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [provider, userId]
  );
  invalidateCredentialCache();
  await event(provider, "revoke", userId);
}

export async function recordVerification(provider: Provider, ok: boolean, error: string | null, userId: string | null): Promise<void> {
  await query("UPDATE integration_credentials SET last_verified_at = CASE WHEN $2 THEN now() ELSE last_verified_at END, last_verify_ok = $2, last_verify_error = $3 WHERE provider = $1", [provider, ok, error]);
  await event(provider, "verify", userId, ok, error);
}

export interface IntegrationStatus {
  provider: Provider;
  state: "connected" | "not_configured" | "revoked" | "error";
  source: "vault" | "environment" | "none";
  masked: Record<string, unknown>;
  version: number | null;
  lastVerifiedAt: Date | null;
  lastVerifyOk: boolean | null;
  lastVerifyError: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** What the Owner's console shows. Never a secret. */
export async function integrationStatus(): Promise<{ vaultConfigured: boolean; integrations: IntegrationStatus[] }> {
  const out: IntegrationStatus[] = [];
  for (const provider of ["openai", "ebay"] as const) {
    const row = await rowFor(provider);
    const env = provider === "openai" ? !!config.openaiApiKey : !!(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
    if (row && row.ciphertext) {
      out.push({ provider, state: row.last_verify_ok === false ? "error" : "connected", source: "vault", masked: row.masked, version: row.version, lastVerifiedAt: row.last_verified_at, lastVerifyOk: row.last_verify_ok, lastVerifyError: row.last_verify_error, updatedAt: row.updated_at, updatedBy: row.updated_by_email });
    } else if (row) {
      out.push({ provider, state: "revoked", source: "none", masked: {}, version: row.version, lastVerifiedAt: row.last_verified_at, lastVerifyOk: false, lastVerifyError: "revoked", updatedAt: row.updated_at, updatedBy: row.updated_by_email });
    } else if (env) {
      out.push({ provider, state: "connected", source: "environment", masked: { note: "set in the server environment" }, version: null, lastVerifiedAt: null, lastVerifyOk: null, lastVerifyError: null, updatedAt: null, updatedBy: null });
    } else {
      out.push({ provider, state: "not_configured", source: "none", masked: {}, version: null, lastVerifiedAt: null, lastVerifyOk: null, lastVerifyError: null, updatedAt: null, updatedBy: null });
    }
  }
  return { vaultConfigured: vaultConfigured(), integrations: out };
}

/** Checks the OpenAI key with a free call (the model list). Records the outcome. */
export async function verifyOpenAI(userId: string | null): Promise<{ ok: boolean; error: string | null }> {
  const c = await getOpenAICredentials().catch((e) => ({ error: e as Error }));
  if (!c || "error" in c) {
    const msg = c && "error" in c ? (c.error instanceof VaultError ? c.error.message : "The stored key could not be read.") : "No OpenAI key is configured.";
    if (c && "error" in c) await recordVerification("openai", false, msg, userId).catch(() => undefined);
    return { ok: false, error: msg };
  }
  let ok = false;
  let error: string | null = null;
  try {
    const res = await outboundFetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${c.creds.apiKey}` }, signal: AbortSignal.timeout(15_000) });
    ok = res.ok;
    if (!ok) error = res.status === 401 ? "OpenAI rejected the key." : `OpenAI answered HTTP ${res.status}.`;
  } catch {
    error = "OpenAI could not be reached.";
  }
  if (c.source === "vault") await recordVerification("openai", ok, error, userId);
  return { ok, error };
}
