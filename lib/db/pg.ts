import "server-only";

import { Pool } from "pg";

/**
 * PostgreSQL connection pool.
 *
 * Postgres is the ONE control-plane backend: `DEPLO_DATABASE_URL` (or the
 * standard `DATABASE_URL`) is REQUIRED for any real run. There is no file-based
 * fallback — the app fails fast at startup if no connection string is set.
 *
 * The sole exception is the `node --test` runner: with no database configured
 * the store degrades to a pure in-memory document (no persistence, no disk) so
 * the synchronous data-layer tests run without provisioning Postgres. See
 * {@link isTestEnv} and `lib/store.ts`.
 */

export function databaseUrl(): string | undefined {
  return process.env.DEPLO_DATABASE_URL || process.env.DATABASE_URL || undefined;
}

export function isPostgresEnabled(): boolean {
  return Boolean(databaseUrl());
}

/**
 * True when running under `node --test`. The runner spawns each test file in a
 * worker that sets `NODE_TEST_CONTEXT` ("child-v8"/"child"), which production
 * and `next` builds never set. Used to allow the in-memory-only store fallback
 * exclusively in tests, so a missing `DEPLO_DATABASE_URL` is a hard error
 * everywhere else.
 */
export function isTestEnv(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT);
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error(
      "DEPLO_DATABASE_URL is required. Deplo uses PostgreSQL as its only " +
        "control-plane data store; set DEPLO_DATABASE_URL (or DATABASE_URL) to " +
        "a Postgres connection string."
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
