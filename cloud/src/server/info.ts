import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { getEbayCredentials, getOpenAICredentials } from "../integrations/credentials.js";

// What a desktop app learns about a server before signing in ("Test connection"). Nothing here is secret: it says what the server is, which version it runs, and which shared
// services exist (never their keys). It answers without a login so a person can find out that an address is right before typing a password.

let version = "0.0.0";
try {
  version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")).version ?? version;
} catch {
  /* running from a layout without package.json: leave the default */
}

export const API_VERSION = 1;

const configured = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    return (await fn()) !== null;
  } catch {
    return false;
  }
};

export async function serverInfoRoutes(app: FastifyInstance): Promise<void> {
  app.get("/server/info", async (_request, reply) => {
    const [sharedAi, sharedEbay] = await Promise.all([configured(getOpenAICredentials), configured(getEbayCredentials)]);
    reply.header("Cache-Control", "no-store");
    return reply.code(200).send({
      product: "clynx-cloud",
      name: config.web.serverName,
      serverVersion: version,
      apiVersion: API_VERSION,
      minClientVersion: config.web.minClientVersion,
      https: config.web.publicUrl.startsWith("https://"),
      services: { sharedAi, sharedEbay, billing: config.billing.configured ? "stripe" : config.billingFake ? "simulated" : "none", updates: !!config.web.updatePublicKey },
      time: new Date().toISOString(),
    });
  });
}
