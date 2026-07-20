import "server-only";

import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { getDb } from "./client";
import { getPool } from "./pg";

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

/**
 * Advisory-lock key serialising the boot migrator across control-plane instances.
 * `pg_advisory_lock` keys are int8; this is "deplo" in ASCII (0x64 65 70 6c 6f) —
 * an arbitrary but STABLE constant, so every build contends on the same lock.
 * Session-scoped on ONE dedicated pool client below: a plain `pool.query` pair
 * could lock and unlock on two different connections.
 */
const MIGRATION_LOCK_KEY = 0x6465706c6f; // "deplo"

export async function runMigrations(): Promise<void> {
  if (applied) return; // one boot = one apply (register runs once per instance)
  // Drizzle's migrator takes no cross-instance lock of its own, so two instances
  // booting together would BOTH apply the same pending (non-idempotent) DDL and
  // the loser would crash-loop. The session advisory lock serialises them: the
  // second instance blocks here until the first finishes, then finds nothing
  // pending — a plain bookkeeping no-op.
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await migrate(getDb(), {
        // The committed migrations live at <repo>/lib/db/migrations. `next start` /
        // `next dev` run from the repo root, so this cwd-relative path resolves — the
        // same resolution the test harness uses. Plain fs reads, no drizzle-kit.
        migrationsFolder: path.join(process.cwd(), "lib", "db", "migrations"),
      });
      applied = true;
    } finally {
      // Best-effort: a dead connection drops its session lock by itself, and an
      // unlock error must never mask a real migrate() failure.
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
        .catch(() => {});
    }
  } finally {
    client.release();
  }
}
