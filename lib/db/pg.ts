import "server-only";

import { Pool, types as pgTypes } from "pg";

import {
  isoTimestampParser,
  TIMESTAMP_OID,
  TIMESTAMPTZ_OID,
} from "./timestamp-parser";

/**
 * PostgreSQL connection pool.
 *
 * Postgres is the ONE control-plane backend: `DEPLO_DATABASE_URL` (or the
 * standard `DATABASE_URL`) is REQUIRED for any real run. There is no file-based
 * fallback — the app fails fast at startup if no connection string is set (see
 * the module-load guard below).
 *
 * The sole exception is the `node --test` runner: with no database configured
 * the data-layer tests inject a pglite client (`__setTestDb`) and seed the
 * relational tables directly, so they run without provisioning Postgres. See
 * {@link isTestEnv}.
 */

/**
 * Install the canonical-ISO timestamp parser as a process-global node-postgres
 * type override (relational-store PLAN §1). `pg.types.setTypeParser` is global
 * across every Pool/Client in the process, so a RAW `pool.query(...)` of a
 * `timestamptz`/`timestamp` column reads back as a lexicographically-sortable
 * `T…Z` string.
 *
 * NOTE: this covers the RAW-query path only (`lease.ts`'s `scheduler_lease`
 * INSERT/DELETE). It does NOT cover reads through the Drizzle client: Drizzle
 * installs a per-query parser override that returns the timestamp OIDs unchanged,
 * bypassing this global. The relational `*_at` columns are canonicalised instead
 * by the `isoTimestamptz` custom type ([./schema/columns.ts](./schema/columns.ts)),
 * which reuses this same `isoTimestampParser` at the ORM codec layer — so the two
 * regimes share one helper and can't drift (see `timestamp-parser.ts`).
 */
pgTypes.setTypeParser(TIMESTAMPTZ_OID, isoTimestampParser);
pgTypes.setTypeParser(TIMESTAMP_OID, isoTimestampParser);

export function databaseUrl(): string | undefined {
  return process.env.DEPLO_DATABASE_URL || process.env.DATABASE_URL || undefined;
}

export function isPostgresEnabled(): boolean {
  return Boolean(databaseUrl());
}

/**
 * True when running under `node --test`. The runner spawns each test file in a
 * worker that sets `NODE_TEST_CONTEXT` ("child-v8"/"child"), which production
 * and `next` builds never set. Used to allow the in-memory-only test fallback
 * exclusively in tests, so a missing `DEPLO_DATABASE_URL` is a hard error
 * everywhere else.
 */
export function isTestEnv(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT);
}

// Fail fast at module load: a real run with no database is a misconfiguration,
// not a silent fall-through to ephemeral in-memory data. `pg.ts` is imported
// early on every server entry path (the Drizzle client, the lease, the data
// layer), so this fires at boot — well before `getPool()` would throw lazily on
// the first query. The `node --test` runner is the one exception (it injects a
// pglite client and never configures `DEPLO_DATABASE_URL`).
if (!isPostgresEnabled() && !isTestEnv()) {
  throw new Error(
    "DEPLO_DATABASE_URL is required. Deplo uses PostgreSQL as its only " +
      "control-plane data store; set DEPLO_DATABASE_URL (or DATABASE_URL) to " +
      "a Postgres connection string."
  );
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
