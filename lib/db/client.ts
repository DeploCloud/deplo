// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";

import { getPool } from "./pg";
import { schema } from "./schema";

/**
 * The single Drizzle client for the control-plane backend (relational-store PLAN
 * §1 "Where the async data layer lives").
 */
export type DrizzleClient = NodePgDatabase<typeof schema>;

/**
 * A transaction handle yielded by `getDb().transaction(async (tx) => …)`.
 */
export type DbTx = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

const CLIENT_KEY = Symbol.for("deplo.db.client.singleton");
const g = globalThis as unknown as { [CLIENT_KEY]?: DrizzleClient };

/**
 * Test-only override (relational-store PLAN §8 "Engine parameterization", Step 2).
 * Null in every real run, so production never pays for the branch beyond one
 * comparison.
 */
let testOverride: DrizzleClient | null = null;

export function getDb(): DrizzleClient {
  if (testOverride) return testOverride;
  return (g[CLIENT_KEY] ??= drizzle(getPool(), { schema }));
}

/**
 * Test-only: route every `getDb()` at the given client (a pglite
 * `PgliteDatabase<typeof schema>` from `makeTestDb()`). Call in a test `before`;
 * pair with {@link __resetTestDb} in `after`.
 */
export function __setTestDb(db: unknown): void {
  testOverride = db as DrizzleClient;
}

/** Test-only: clear the {@link __setTestDb} override. */
export function __resetTestDb(): void {
  testOverride = null;
}

/**
 * True when a test client is installed.
 */
export function hasTestDb(): boolean {
  return testOverride !== null;
}
