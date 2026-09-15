import "server-only";

import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";

import { getPool } from "./pg";
import { schema } from "./schema";

export type DrizzleClient = NodePgDatabase<typeof schema>;

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

export function __setTestDb(db: unknown): void {
  testOverride = db as DrizzleClient;
}

export function __resetTestDb(): void {
  testOverride = null;
}

export function hasTestDb(): boolean {
  return testOverride !== null;
}
