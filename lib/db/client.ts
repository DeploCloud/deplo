import "server-only";

import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";

import { getPool } from "./pg";
import { schema } from "./schema";

/**
 * The single Drizzle client for the control-plane backend (relational-store
 * PLAN §1 "Where the async data layer lives").
 *
 * It binds to the EXISTING bounded `getPool()` from `pg.ts` — never a second
 * pool — so the relational data layer and the legacy JSONB document store share
 * one connection budget.
 *
 * Timestamp canonicalisation does NOT come from the process-global parser in
 * `pg.ts`: Drizzle's node-postgres session installs a PER-QUERY type-parser
 * override that returns the value unchanged for the timestamp OIDs, so the global
 * `pg.types` parser is bypassed for every timestamp read through THIS client. The
 * `*_at` columns read back as canonical `T…Z` strings because they use the
 * `isoTimestamptz` custom type ([./schema/columns.ts](./schema/columns.ts)), which
 * canonicalises in Drizzle's own codec layer. (The `pg.ts` global parser still
 * serves the legacy raw-query path in `document-store.ts`/`lease.ts`.)
 *
 * Pinned on `globalThis` with the same `Symbol.for` pattern as `lib/store.ts`'s
 * `STORE_KEY` (and `keyed-mutex.ts` / `lease.ts`): in `next dev` the RSC and
 * route-handler layers compile into SEPARATE module registries, so a plain
 * module-level `const db` would exist as two independent clients in one process.
 * Pinning collapses them onto one Drizzle instance over the one shared pool.
 *
 * Access tables through thin per-table queries colocated with their data module
 * (e.g. `lib/data/projects.ts` owns its `projects` queries directly via this
 * client) — not a generic ORM-of-an-ORM wrapper.
 */
export type DrizzleClient = NodePgDatabase<typeof schema>;

/**
 * A transaction handle yielded by `getDb().transaction(async (tx) => …)`.
 *
 * The live data layer's multi-table atomic writes (`createAccountWithTeam`,
 * `updateUserAdmin`, member edits — relational-store PLAN cut-set (b)) thread
 * this `tx` into helpers (e.g. `consumeRegistrationLink`). Typed against the
 * production node-postgres flavour; under `node --test` the same code runs over
 * the pglite client (the query surface is identical — only the driver HKT
 * differs, which the `__setTestDb` widening already bridges).
 */
export type DbTx = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

const CLIENT_KEY = Symbol.for("deplo.db.client.singleton");
const g = globalThis as unknown as { [CLIENT_KEY]?: DrizzleClient };

/**
 * Test-only override (relational-store PLAN §8 "Engine parameterization", Step
 * 2). The data layer calls `getDb()` with no `db` argument, so a `node --test`
 * run needs a seam to point it at the pglite client `makeTestDb()` builds instead
 * of the node-postgres pool (which would require a real Postgres). When set,
 * `getDb()` returns it. Mirrors `lib/backups/lease.ts`'s `__resetLocalLeases()`
 * test hook. Null in every real run, so production never pays for the branch
 * beyond one comparison.
 */
let testOverride: DrizzleClient | null = null;

export function getDb(): DrizzleClient {
  if (testOverride) return testOverride;
  return (g[CLIENT_KEY] ??= drizzle(getPool(), { schema }));
}

/**
 * Test-only: route every `getDb()` at the given client (a pglite
 * `PgliteDatabase<typeof schema>` from `makeTestDb()`). The two Drizzle clients
 * expose the same query surface (`select`/`insert`/`update`/`delete`/
 * `transaction`) over the same `schema`; the structural mismatch is only in the
 * driver HKT, so the harness passes it through this widening seam. Call in a
 * test `before`; pair with {@link __resetTestDb} in `after`.
 */
export function __setTestDb(db: unknown): void {
  testOverride = db as DrizzleClient;
}

/** Test-only: clear the {@link __setTestDb} override. */
export function __resetTestDb(): void {
  testOverride = null;
}
