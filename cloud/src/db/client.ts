import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 5000, // a database that cannot be reached fails the request after 5 s instead of waiting forever
  idleTimeoutMillis: 30_000,
  statement_timeout: 60_000,
});

// Postgres closing an IDLE connection (a restart, a backup restore, the host sleeping) is reported as an 'error' event on the pool. Without a listener Node treats it as fatal and the whole API
// (or worker) exits. The pool discards that connection and opens a new one on the next query, so logging it is all that is needed.
pool.on("error", (err) => {
  console.error("[db] an idle database connection was lost (the pool will reconnect):", err.message);
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}

export async function getClient() {
  return pool.connect();
}

export async function closePool(): Promise<void> {
  await pool.end();
}
