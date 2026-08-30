// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { Pool, types as pgTypes } from "pg";

import {
  isoTimestampParser,
  TIMESTAMP_OID,
  TIMESTAMPTZ_OID,
} from "./timestamp-parser";

/**
 * PostgreSQL connection pool. There is no file-based fallback - the app fails fast
 * at startup if no connection string is set (see the module-load guard below).
 */

/**
 * Install the canonical-ISO timestamp parser as a process-global node-postgres
 * type override (relational-store PLAN §1).
 */
pgTypes.setTypeParser(TIMESTAMPTZ_OID, isoTimestampParser);
pgTypes.setTypeParser(TIMESTAMP_OID, isoTimestampParser);

export function databaseUrl(): string | undefined {
  return (
    process.env.DEPLO_DATABASE_URL || process.env.DATABASE_URL || undefined
  );
}

export function isPostgresEnabled(): boolean {
  return Boolean(databaseUrl());
}

/**
 * True when running under `node --test`. The runner spawns each test file in a
 * worker that sets `NODE_TEST_CONTEXT` ("child-v8"/"child"), which production and
 * `next` builds never set.
 */
export function isTestEnv(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT);
}

// Fail fast at module load: a real run with no database is a misconfiguration, not
// a silent fall-through to ephemeral in-memory data.
if (!isPostgresEnabled() && !isTestEnv()) {
  throw new Error(
    "DEPLO_DATABASE_URL is required. Deplo uses PostgreSQL as its only " +
      "control-plane data store; set DEPLO_DATABASE_URL (or DATABASE_URL) to " +
      "a Postgres connection string.",
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
        "a Postgres connection string.",
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
