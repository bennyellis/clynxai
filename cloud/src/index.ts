import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { config } from "./config.js";
import { healthRoutes } from "./health/routes.js";
import { authRoutes } from "./auth/routes.js";
import { deviceRoutes } from "./devices/routes.js";
import { watchRoutes } from "./watches/routes.js";
import { listingRoutes } from "./listings/routes.js";
import { feedbackRoutes } from "./feedback/routes.js";
import { productRoutes } from "./products/routes.js";
import { searchPlannerRoutes } from "./searchPlanner/routes.js";
import { entitlementsRoutes } from "./entitlements/routes.js";
import { aiRoutes } from "./ai/routes.js";

export function buildApp() {
  // Fastify's 1MB default body limit is comfortably exceeded by a batch of
  // real scanned listings (full descriptions + image arrays) once an
  // install has accumulated real scan history — observed as a 413 in
  // production use. 10MB covers the current INGEST_BATCH_SIZE (50) with
  // headroom for growth.
  const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });

  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(deviceRoutes);
  app.register(watchRoutes);
  app.register(listingRoutes);
  app.register(feedbackRoutes);
  app.register(productRoutes);
  app.register(searchPlannerRoutes);
  app.register(entitlementsRoutes);
  app.register(aiRoutes);

  return app;
}

async function main() {
  const app = buildApp();
  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only auto-start the server when run directly (not when imported by tests).
// Compares via pathToFileURL rather than manual string concatenation — a
// naive `file://${argv[1]}` template breaks on Windows, where an absolute
// path's drive letter needs a third slash (`file:///C:/...`) that manual
// concatenation omits, so this check silently never matched and the dev
// server never started.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
