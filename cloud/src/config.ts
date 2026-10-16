import "dotenv/config";
import { readFileSync } from "node:fs";
import { z } from "zod";

// Fails fast and loudly on startup if a required var is missing — no
// silent defaulting of secrets. See cloud/.env.example for the full list.
const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET must be at least 16 characters"),
  JWT_REFRESH_SECRET: z.string().min(16, "JWT_REFRESH_SECRET must be at least 16 characters"),
  PORT: z.coerce.number().int().positive().default(8787),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  // A single shared key, held ONLY here, so every authenticated desktop user's AI calls proxy through this server (see ../ai/routes.ts) instead of each needing their own key.
  // OPTIONAL: the Owner normally saves the key in the console (stored encrypted, see integrations/). This variable is only a fallback for a server that has never had one saved.
  OPENAI_API_KEY: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  // The only models the AI proxy will forward (comma separated). A request for any other model is refused, so a stolen or abused account cannot run an expensive model on this key.
  AI_ALLOWED_MODELS: z.string().default("gpt-5-mini,gpt-5,gpt-4.1-mini,gpt-4.1,gpt-4o-mini,gpt-4o,gpt-image-1"),
  // OpenAI web search for Clynx's product research (POST /ai/search). OFF until the Owner turns it on: each search carries a per-search provider fee on top of tokens.
  AI_SEARCH_ENABLED: bool,
  AI_SEARCH_MODEL: z.string().default("gpt-4.1-mini"),
  // What one search is counted as when reserving and recording spend (USD). An ESTIMATE: set it from the provider's own price list.
  AI_SEARCH_FEE_USD: z.coerce.number().min(0).max(5).default(0.03),
  AI_SEARCH_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(100).max(4000).default(600),
  // Upper bound the proxy puts on the output tokens one request may ask for.
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(32000),
  // Staged activation: plan limits (watches, devices, AI per day) are only ENFORCED when this is true. Metering is always on.
  ENFORCE_ENTITLEMENTS: bool,
  // Set when the API runs behind a reverse proxy / load balancer, so the client IP used for rate limiting is the real one.
  TRUST_PROXY: bool,
  // Optional bearer token that protects GET /metrics. Without it /metrics is not served.
  METRICS_TOKEN: z.string().min(16).optional(),
  // ---- billing (all optional: without the first three, billing endpoints answer "billing_not_configured" and everyone stays on their base plan)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO_MONTHLY: z.string().optional(),
  STRIPE_PRICE_PRO_YEARLY: z.string().optional(),
  BILLING_SUCCESS_URL: z.string().url().optional(),
  BILLING_CANCEL_URL: z.string().url().optional(),
  BILLING_RETURN_URL: z.string().url().optional(),
  TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  PAST_DUE_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(7),
  // ---- website / customer platform (all optional; the defaults are for local development)
  // The public address of the website (used in emails, cookies and the same-origin check). In production this is the https address.
  PUBLIC_URL: z.string().url().default("http://localhost:8787"),
  // "true" forces the Secure cookie flag, "false" turns it off (local http only); unset: Secure exactly when PUBLIC_URL is https.
  COOKIE_SECURE: z.enum(["true", "false", "1", "0", ""]).optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  // Outgoing email. Without SMTP_URL every email is only recorded in the outbox (visible to tests and, in development, to the developer); nothing is sent.
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default("Clynx <no-reply@clynx.invalid>"),
  SUPPORT_EMAIL: z.string().default("support@clynx.invalid"),
  // The built website (website/dist). Served by this server when the folder exists.
  WEBSITE_DIR: z.string().default("../website/dist"),
  // Where uploaded installers are kept (a local folder; the storage module is the boundary for a later object store).
  RELEASES_DIR: z.string().default("./data/releases"),
  MAX_RELEASE_BYTES: z.coerce.number().int().positive().default(600 * 1024 * 1024),
  // DEVELOPMENT ONLY: a local stand-in for Stripe (simulated hosted checkout and portal). Refused when NODE_ENV=production.
  BILLING_FAKE: bool,
  // Checkout needs a verified email address (staged: off by default so existing accounts keep working).
  REQUIRE_VERIFIED_EMAIL_FOR_BILLING: bool,
  // Text shown on the pricing page for each plan price. Left unset, the website shows a clearly marked placeholder: prices are NOT invented here.
  PLAN_PRICE_PRO_MONTHLY_DISPLAY: z.string().optional(),
  PLAN_PRICE_PRO_YEARLY_DISPLAY: z.string().optional(),
  NODE_ENV: z.string().optional(),
  // ---- running on a home/office network or the internet
  // Extra addresses the website may be opened from (comma separated, each like http://10.0.0.81:8788). PUBLIC_URL is always allowed. Used for the same-origin (CSRF) check only.
  ALLOWED_ORIGINS: z.string().optional(),
  // Shown to desktop apps that test the connection.
  SERVER_NAME: z.string().default("Clynx Cloud"),
  // The PUBLIC half of the update signing key (PEM text, or a path to the PEM file). Without it the server refuses to accept update manifests and serves none.
  UPDATE_PUBLIC_KEY: z.string().optional(),
  UPDATE_PUBLIC_KEY_FILE: z.string().optional(),
  // The oldest desktop version this server still supports (shown to apps; they tell the person to update).
  MIN_CLIENT_VERSION: z.string().optional(),
  // ---- private beta
  // "private": nothing is reachable without signing in, except a short list of endpoints a desktop app needs before it has a session (see access/gate.ts). A visitor gets only a
  // sign-in page. "open" (the default) is the normal behaviour.
  ACCESS_MODE: z.enum(["open", "private"]).default("open"),
  // Who may create an account: "open" (anyone), "invite" (only with a valid invitation code from the Owner/an administrator), "closed" (nobody).
  REGISTRATION: z.enum(["open", "invite", "closed"]).default("open"),
});

function loadPublicKey(text: string | undefined, file: string | undefined): string | null {
  try {
    // (an env file holds the PEM on one line with literal \n sequences)
    if (text && text.includes("BEGIN PUBLIC KEY")) return text.replace(/\\n/g, "\n");
    if (file) return readFileSync(file, "utf-8");
  } catch {
    /* unreadable: treated as not configured */
  }
  return null;
}

function loadConfig() {
  // A variable that is present but blank (as in a freshly copied .env.prod) counts as not set, so optional values can simply be left empty.
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid/missing environment configuration:\n${issues}\n\nSee cloud/.env.example for the required variables.`);
  }
  const d = parsed.data;
  const billingConfigured = !!(d.STRIPE_SECRET_KEY && d.STRIPE_WEBHOOK_SECRET && d.STRIPE_PRICE_PRO_MONTHLY);
  return {
    databaseUrl: d.DATABASE_URL,
    jwtAccessSecret: d.JWT_ACCESS_SECRET,
    jwtRefreshSecret: d.JWT_REFRESH_SECRET,
    port: d.PORT,
    redisUrl: d.REDIS_URL,
    openaiApiKey: d.OPENAI_API_KEY ?? null,
    aiAllowedModels: d.AI_ALLOWED_MODELS.split(",").map((m) => m.trim()).filter(Boolean),
    aiMaxOutputTokens: d.AI_MAX_OUTPUT_TOKENS,
    aiSearchEnabled: d.AI_SEARCH_ENABLED,
    aiSearchModel: d.AI_SEARCH_MODEL,
    aiSearchFeeUsd: d.AI_SEARCH_FEE_USD,
    aiSearchMaxOutputTokens: d.AI_SEARCH_MAX_OUTPUT_TOKENS,
    enforceEntitlements: d.ENFORCE_ENTITLEMENTS,
    trustProxy: d.TRUST_PROXY,
    metricsToken: d.METRICS_TOKEN ?? null,
    accessTokenTtlSeconds: 15 * 60, // 15 minutes
    refreshTokenTtlSeconds: 30 * 24 * 60 * 60, // 30 days
    web: {
      publicUrl: d.PUBLIC_URL.replace(/\/+$/, ""),
      // Whole-site setting: Secure cookies for EVERY request. Unset: only when the site is https and there is no TLS-terminating proxy in front (with a proxy, each request is judged by
      // X-Forwarded-Proto instead, so one server can answer on plain http inside a home network and on https through a tunnel; see web/session.ts).
      secureCookies: d.COOKIE_SECURE === undefined || d.COOKIE_SECURE === "" ? d.PUBLIC_URL.startsWith("https://") && !d.TRUST_PROXY : d.COOKIE_SECURE === "true" || d.COOKIE_SECURE === "1",
      sessionTtlDays: d.SESSION_TTL_DAYS,
      smtpUrl: d.SMTP_URL ?? null,
      mailFrom: d.MAIL_FROM,
      supportEmail: d.SUPPORT_EMAIL,
      websiteDir: d.WEBSITE_DIR,
      releasesDir: d.RELEASES_DIR,
      maxReleaseBytes: d.MAX_RELEASE_BYTES,
      requireVerifiedEmailForBilling: d.REQUIRE_VERIFIED_EMAIL_FOR_BILLING,
      priceDisplay: { proMonthly: d.PLAN_PRICE_PRO_MONTHLY_DISPLAY ?? null, proYearly: d.PLAN_PRICE_PRO_YEARLY_DISPLAY ?? null },
      production: d.NODE_ENV === "production",
      allowedOrigins: [d.PUBLIC_URL, ...(d.ALLOWED_ORIGINS ?? "").split(",")].map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean),
      serverName: d.SERVER_NAME,
      minClientVersion: d.MIN_CLIENT_VERSION ?? null,
      updatePublicKey: loadPublicKey(d.UPDATE_PUBLIC_KEY, d.UPDATE_PUBLIC_KEY_FILE),
      accessPrivate: d.ACCESS_MODE === "private",
      registration: d.REGISTRATION,
    },
    billingFake: d.BILLING_FAKE && d.NODE_ENV !== "production",
    billing: {
      configured: billingConfigured,
      stripeSecretKey: d.STRIPE_SECRET_KEY ?? null,
      stripeWebhookSecret: d.STRIPE_WEBHOOK_SECRET ?? null,
      priceProMonthly: d.STRIPE_PRICE_PRO_MONTHLY ?? null,
      priceProYearly: d.STRIPE_PRICE_PRO_YEARLY ?? null,
      // by default the customer comes back to the website's own subscription page
      successUrl: d.BILLING_SUCCESS_URL ?? `${d.PUBLIC_URL.replace(/\/+$/, "")}/account/billing?checkout=success`,
      cancelUrl: d.BILLING_CANCEL_URL ?? `${d.PUBLIC_URL.replace(/\/+$/, "")}/account/billing?checkout=cancelled`,
      returnUrl: d.BILLING_RETURN_URL ?? `${d.PUBLIC_URL.replace(/\/+$/, "")}/account/billing`,
      trialDays: d.TRIAL_DAYS,
      pastDueGraceDays: d.PAST_DUE_GRACE_DAYS,
    },
  };
}

export const config = loadConfig();
export type CloudConfig = typeof config;
