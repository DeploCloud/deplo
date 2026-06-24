import "server-only";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

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

const CLIENT_KEY = Symbol.for("deplo.db.client.singleton");
const g = globalThis as unknown as { [CLIENT_KEY]?: DrizzleClient };

export function getDb(): DrizzleClient {
  return (g[CLIENT_KEY] ??= drizzle(getPool(), { schema }));
}
