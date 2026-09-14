import "server-only";

// https://deplo.build/docs/operations/upgrade

import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { getDb } from "./client";
import { getPool } from "./pg";

let applied = false;

const MIGRATION_LOCK_KEY = 0x6465706c6f; // "deplo"

export async function runMigrations(): Promise<void> {
  if (applied) return;
  // Drizzle's migrator takes no cross-instance lock of its own; two instances would both apply the same DDL.
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await migrate(getDb(), {
        migrationsFolder: path.join(process.cwd(), "lib", "db", "migrations"),
      });
      applied = true;
    } finally {
      // An unlock error must never mask a real migrate() failure.
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
        .catch(() => {});
    }
  } finally {
    client.release();
  }
}
