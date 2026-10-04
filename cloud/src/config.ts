import "dotenv/config";
import { z } from "zod";

// Fails fast and loudly on startup if a required var is missing — no
// silent defaulting of secrets. See cloud/.env.example for the full list.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET must be at least 16 characters"),
  JWT_REFRESH_SECRET: z.string().min(16, "JWT_REFRESH_SECRET must be at least 16 characters"),
  PORT: z.coerce.number().int().positive().default(8787),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  // Per explicit instruction — a single shared key, held ONLY here, so every
  // authenticated desktop user's AI calls proxy through this server (see
  // ../ai/routes.ts) instead of each needing their own key on their own
  // machine. No per-user usage cap yet (entitlements exist but aren't
  // enforced here) — accepted for now, flagged as a near-term follow-up.
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid/missing environment configuration:\n${issues}\n\nSee cloud/.env.example for the required variables.`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    jwtAccessSecret: parsed.data.JWT_ACCESS_SECRET,
    jwtRefreshSecret: parsed.data.JWT_REFRESH_SECRET,
    port: parsed.data.PORT,
    redisUrl: parsed.data.REDIS_URL,
    openaiApiKey: parsed.data.OPENAI_API_KEY,
    accessTokenTtlSeconds: 15 * 60, // 15 minutes
    refreshTokenTtlSeconds: 30 * 24 * 60 * 60, // 30 days
  };
}

export const config = loadConfig();
export type CloudConfig = typeof config;
