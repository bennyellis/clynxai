// MUST be the first import of test/setup.ts. ES imports are hoisted and evaluated in order, so this runs before src/config.ts reads the environment: the tests then use the
// DISPOSABLE database named in .env.test and never the development database in .env (an earlier version loaded .env.test after the imports, which silently used the dev database).
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.test", override: true });
if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run the tests: DATABASE_URL (from .env.test) must name a disposable database whose name ends in _test, not " + (process.env.DATABASE_URL ?? "nothing").replace(/\/\/[^@]*@/, "//***@"));
}
if (!/\/[1-9]\d*$/.test(process.env.REDIS_URL ?? "")) {
  throw new Error("Refusing to run the tests: REDIS_URL (from .env.test) must select a non-default Redis database (for example redis://localhost:6379/9) so the tests never share a queue with the running server's worker.");
}
