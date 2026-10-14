import "./env.js"; // first: points the tests at the disposable database (.env.test), never the development one
// Many tests register accounts from the same IP; the registration limit is exercised on its own in security.test.ts.
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "100000";

import { beforeAll } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { redisConnection } from "../src/queue/connection.js";

beforeAll(async () => {
  await runMigrations();
  // Rate-limit windows, concurrency counters and spending reservations live in Redis and survive between runs (they last up to an hour or a day); every test file starts from a clean slate.
  for (const pattern of ["rl:*", "conc:*", "resv:*"]) for (const k of await redisConnection.keys(pattern)) await redisConnection.del(k);
});
