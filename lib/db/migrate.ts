// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// https://deplo.build/docs/operations/upgrade

import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { getDb } from "./client";
import { getPool } from "./pg";

/**
 * Apply pending Drizzle migrations against the live pool at boot. A failure here
 * MUST surface (instrumentation re-throws) rather than let the app run on an
 * out-of-date schema.
 */
let applied = false;

/**
 * Advisory-lock key serialising the boot migrator across control-plane instances.
 */
const MIGRATION_LOCK_KEY = 0x6465706c6f; // "deplo"

export async function runMigrations(): Promise<void> {
  if (applied) return; // one boot = one apply (register runs once per instance)
  // Drizzle's migrator takes no cross-instance lock of its own, so two instances
  // booting together would BOTH apply the same pending (non-idempotent) DDL and the
  // loser would crash-loop.
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await migrate(getDb(), {
        // The committed migrations live at <repo>/lib/db/migrations. `next start` /
        // `next dev` run from the repo root, so this cwd-relative path resolves - the
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
