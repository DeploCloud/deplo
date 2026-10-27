import "server-only";

import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PgDialect, type PgSession } from "drizzle-orm/pg-core";

import { getDb } from "./client";
import { getPool } from "./pg";
import { REQUIRED_STOP } from "../version";
import {
  neverMigrated,
  passEveryStopSql,
  readPassedStops,
  refusalReason,
  stopPassed,
  UPDATE_REFUSED,
  UpdateRefusedError,
  type RawQuery,
} from "./update-stops";

let applied = false;

const MIGRATION_LOCK_KEY = 0x6465706c6f;

// After a reboot Docker starts the panel beside Postgres, not after it: a database still coming up is a wait.
const NOT_UP_YET = new Set([
  "57P03",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
]);

export async function connectWhenReady<T>(
  connect: () => Promise<T>,
  { attempts = 60, delayMs = 1000 } = {},
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await connect();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (i >= attempts || !code || !NOT_UP_YET.has(code)) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** drizzle's migrate(), plus statements that commit in the same transaction as a pending last migration. */
export async function applyMigrations(
  db: { _: { session: unknown } },
  migrationsFolder: string,
  alsoRun: string[] = [],
): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  migrations.at(-1)?.sql.push(...alsoRun);
  // drizzle's migrate() hands over any database's session; only this signature is typed narrower.
  const session = db._.session as PgSession;
  await new PgDialect().migrate(migrations, session, { migrationsFolder });
}

export interface BootStops {
  requiredStop?: string | null;
  log?: (line: string) => void;
}

// ADR-0041: a fresh install has passed every update stop, and that is only visible before the first migration.
export async function migrateOnBoot(
  query: RawQuery,
  migrateAll: (alsoRun: string[]) => Promise<void>,
  { requiredStop = REQUIRED_STOP, log = console.error }: BootStops = {},
): Promise<void> {
  const fresh = await neverMigrated(query);
  // Read on the previous release's schema, before any DDL: refusing leaves the database as it was.
  if (
    !fresh &&
    requiredStop &&
    !stopPassed(requiredStop, await readPassedStops(query))
  ) {
    const reason = refusalReason(requiredStop);
    log(UPDATE_REFUSED + reason);
    throw new UpdateRefusedError(reason);
  }
  // With the migrations, not after them: a first boot that dies in between must still read as fresh.
  await migrateAll(fresh ? passEveryStopSql(requiredStop) : []);
}

export async function runMigrations(): Promise<void> {
  if (applied) return;
  const client = await connectWhenReady(() => getPool().connect());
  try {
    // Drizzle's migrator takes no lock of its own, so two instances would both apply the same DDL.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await migrateOnBoot(
        (text, params) => client.query(text, params),
        (alsoRun) =>
          applyMigrations(
            getDb(),
            path.join(process.cwd(), "lib", "db", "migrations"),
            alsoRun,
          ),
      );
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
