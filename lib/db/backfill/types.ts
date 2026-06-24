import type { ExtractTablesWithRelations } from "drizzle-orm";
import type {
  PgDatabase,
  PgQueryResultHKT,
  PgTransaction,
} from "drizzle-orm/pg-core";

import type { schema } from "../schema";

/**
 * The backfill engine's database handle.
 *
 * The same engine runs against TWO concrete Drizzle clients: the production
 * node-postgres client (`NodePgDatabase`, from `lib/db/client.ts`) and the pglite
 * test client (`PgliteDatabase`, from `lib/db/test-harness.ts`). Both extend the
 * dialect-agnostic `PgDatabase` base over the SAME aggregated `schema`, so typing
 * the `db` param against the base lets one engine serve both regimes — every
 * backfill function takes a `db` param rather than calling `getDb()` internally
 * (relational-store PLAN §8 "Engine parameterization"; the document-store /
 * lease hardcoded-`getPool()` pattern is the anti-pattern this avoids).
 */
export type BackfillDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * A transaction handle over the same schema, passed to the per-cut-set copy. The
 * third generic must be `ExtractTablesWithRelations<typeof schema>` (the same
 * value `db.transaction`'s callback yields over a two-arg `PgDatabase`), so a
 * cut-set copy receives the tx WITHOUT an `as unknown` cast that would disable
 * type-checking at the boundary.
 */
export type BackfillTx = PgTransaction<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
