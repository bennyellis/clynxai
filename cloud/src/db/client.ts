import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
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
