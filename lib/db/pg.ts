import "server-only";

import { Pool, types as pgTypes } from "pg";

import {
  isoTimestampParser,
  TIMESTAMP_OID,
  TIMESTAMPTZ_OID,
} from "./timestamp-parser";

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

export function isTestEnv(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT);
}

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
    max: Number(process.env.DEPLO_DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}
