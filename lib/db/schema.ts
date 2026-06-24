/**
 * Aggregated Drizzle schema for the Postgres backend.
 *
 * Split into per-domain modules for navigability (relational-store PLAN §1
 * "Drizzle schema layout"):
 *
 *  - `schema/auth.ts`          — the Better Auth tables (user/session/account/
 *                                verification), owned by Better Auth's Drizzle
 *                                adapter.
 *  - `schema/scheduler.ts`     — `scheduler_lease`, the cross-process backup-
 *                                scheduler mutex (a live table; the legacy
 *                                `deplo_state` JSONB document was dropped in
 *                                PLAN Step 7).
 *  - `schema/control-plane.ts` — the full relational normalization of the former
 *                                JSONB control plane (Step 1). NO JSONB columns;
 *                                every nested object is a 1-to-1 child table and
 *                                every list an ordered child / junction.
 *
 * This file re-exports every table and an aggregated `schema` object, so
 * `drizzle.config.ts` (`schema: "./lib/db/schema.ts"`) and `lib/db/client.ts`
 * need no path change as the schema grows.
 */

export { user, session, account, verification } from "./schema/auth";
export { schedulerLease } from "./schema/scheduler";
export * from "./schema/control-plane";

import { user, session, account, verification } from "./schema/auth";
import { schedulerLease } from "./schema/scheduler";
import * as controlPlane from "./schema/control-plane";

export const schema = {
  user,
  session,
  account,
  verification,
  schedulerLease,
  ...controlPlane,
};
