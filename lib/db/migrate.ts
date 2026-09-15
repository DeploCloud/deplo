import "server-only";

import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { getDb } from "./client";
import { getPool } from "./pg";

let applied = false;

const MIGRATION_LOCK_KEY = 0x6465706c6f;

export async function runMigrations(): Promise<void> {
  if (applied) return;
  const client = await getPool().connect();
  try {
    // Drizzle's migrator takes no lock of its own, so two instances would both apply the same DDL.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await migrate(getDb(), {
        migrationsFolder: path.join(process.cwd(), "lib", "db", "migrations"),
      });
      applied = true;
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
        // Swallowed: an unlock error must never mask a real migrate() failure.
        .catch(() => {});
    }
  } finally {
    client.release();
  }
}
