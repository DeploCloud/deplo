import "server-only";

import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { getDb } from "./client";

/**
 * Apply pending Drizzle migrations against the live pool at boot.
 *
 * deplo's schema is journal-driven (lib/db/migrations + meta/_journal.json). The
 * migrator records what it has applied in `drizzle.__drizzle_migrations` and skips
 * those, so this is idempotent and cheap on a hot boot (nothing pending -> a
 * single bookkeeping query). It replays the SAME committed journal the pglite test
 * harness does, so prod boots on the exact DDL the tests run against.
 *
 * Called once from `instrumentation.ts` BEFORE the reconcile + before the app
 * serves requests, because those reads assume the current schema (e.g.
 * `deployments.server_id`, `servers.deploy_concurrency`). A failure here MUST
 * surface (instrumentation re-throws) rather than let the app run on an
 * out-of-date schema. Node runtime only (the migrator needs node-postgres + fs).
 */
let applied = false;

export async function runMigrations(): Promise<void> {
  if (applied) return; // one boot = one apply (register runs once per instance)
  await migrate(getDb(), {
    // The committed migrations live at <repo>/lib/db/migrations. `next start` /
    // `next dev` run from the repo root, so this cwd-relative path resolves — the
    // same resolution the test harness uses. Plain fs reads, no drizzle-kit.
    migrationsFolder: path.join(process.cwd(), "lib", "db", "migrations"),
  });
  applied = true;
}
