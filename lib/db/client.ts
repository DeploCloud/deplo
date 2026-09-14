import "server-only";

import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";

import { getPool } from "./pg";
import { schema } from "./schema";

// DrizzleClient is the single Drizzle client for the control-plane backend.
export type DrizzleClient = NodePgDatabase<typeof schema>;

// DbTx is a transaction handle yielded by getDb().transaction().
export type DbTx = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

const CLIENT_KEY = Symbol.for("deplo.db.client.singleton");
const g = globalThis as unknown as { [CLIENT_KEY]?: DrizzleClient };

let testOverride: DrizzleClient | null = null;

export function getDb(): DrizzleClient {
  if (testOverride) return testOverride;
  return (g[CLIENT_KEY] ??= drizzle(getPool(), { schema }));
}

// __setTestDb routes every getDb() at the given client; pair with __resetTestDb.
export function __setTestDb(db: unknown): void {
  testOverride = db as DrizzleClient;
}

// __resetTestDb clears the __setTestDb override.
export function __resetTestDb(): void {
  testOverride = null;
}

// hasTestDb is true when a test client is installed.
export function hasTestDb(): boolean {
  return testOverride !== null;
}
