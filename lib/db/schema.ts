/**
 * Aggregated Drizzle schema for the Postgres backend.
 *
 * Split into per-domain modules for navigability (relational-store PLAN §1
 * "Drizzle schema layout"):
 *
 *  - `schema/auth.ts`          — the Better Auth tables (user/session/account/
 *                                verification), owned by Better Auth's Drizzle
 *                                adapter.
 *  - `schema/legacy.ts`        — `deplo_state` (the single-row JSONB control-plane
 *                                document) + `scheduler_lease` (the backup-
 *                                scheduler mutex). Rollback artifacts kept through
 *                                the migration.
 *  - `schema/control-plane.ts` — the full relational normalization of `DeploData`
 *                                (Step 1). NO JSONB columns; every nested object
 *                                is a 1-to-1 child table and every list an ordered
 *                                child / junction.
 *
 * This file re-exports every table and an aggregated `schema` object, so
 * `drizzle.config.ts` (`schema: "./lib/db/schema.ts"`) and `lib/db/client.ts`
 * need no path change as the schema grows.
 */

export { user, session, account, verification } from "./schema/auth";
export { deploState, schedulerLease } from "./schema/legacy";
export * from "./schema/control-plane";

import { user, session, account, verification } from "./schema/auth";
import { deploState, schedulerLease } from "./schema/legacy";
import * as controlPlane from "./schema/control-plane";

export const schema = {
  user,
  session,
  account,
  verification,
  deploState,
  schedulerLease,
  ...controlPlane,
};
