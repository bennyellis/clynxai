import "dotenv/config";
// A separate .env.test (or DATABASE_URL already pointed at a disposable test
// database) is expected here — this file loads .env.test explicitly so
// running `npm test` never touches the same database `npm run dev` uses.
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.test", override: true });

import { beforeAll } from "vitest";
import { runMigrations } from "../src/db/migrate.js";

beforeAll(async () => {
  await runMigrations();
});
