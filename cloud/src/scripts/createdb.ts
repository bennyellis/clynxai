// Creates (or, with --reset, recreates) a local PostgreSQL database for previews and end-to-end runs. Local development only.
//   npm run createdb -- clynx_web_preview [--reset]
import pg from "pg";

const name = process.argv[2];
const reset = process.argv.includes("--reset");
if (!name || !/^[a-z][a-z0-9_]{2,40}$/.test(name)) {
  console.error("usage: npm run createdb -- <database_name> [--reset]   (lowercase letters, digits, underscores)");
  process.exit(2);
}
const admin = process.env.ADMIN_DATABASE_URL ?? "postgres://clynx:clynx_dev_password@localhost:5432/postgres";
if (!/localhost|127\.0\.0\.1/.test(admin)) {
  console.error("Refusing to run against a database that is not on this computer.");
  process.exit(2);
}
const client = new pg.Client({ connectionString: admin });
await client.connect();
try {
  if (reset) {
    await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
    await client.query(`DROP DATABASE IF EXISTS ${name}`);
  }
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!exists.rows.length) await client.query(`CREATE DATABASE ${name}`);
  console.log(`database ${name} is ready`);
} finally {
  await client.end();
}
