import "server-only";

import { Pool } from "pg";

/**
 * PostgreSQL connection pool.
 *
 * Deplo uses Postgres as the system of record when `DEPLO_DATABASE_URL` (or the
 * standard `DATABASE_URL`) is set. When it is absent the app falls back to the
 * zero-config local JSON store, so development still runs with no database.
 */

export function databaseUrl(): string | undefined {
  return process.env.DEPLO_DATABASE_URL || process.env.DATABASE_URL || undefined;
}

export function isPostgresEnabled(): boolean {
  return Boolean(databaseUrl());
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error(
      "Postgres is not configured. Set DEPLO_DATABASE_URL to enable it."
    );
  }
  pool = new Pool({
    connectionString,
    // Bound the pool so a single control-plane instance never exhausts the
    // server's connection slots.
    max: Number(process.env.DEPLO_DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}
