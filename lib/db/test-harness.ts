// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";

import { PGlite, types } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { isoTimestampParser } from "./timestamp-parser";
import { schema } from "./schema";

/**
 * pglite-backed Drizzle test harness (relational-store PLAN §8 / Step -1 GATE). -
 * `{ schema }` (and its sub-modules) import only drizzle, never `server-only`, so
 * the harness can pull it in directly under `node --test`.
 */

/** A pglite Drizzle client over the full aggregated schema. */
export type TestDb = PgliteDatabase<typeof schema>;

/**
 * Build a fresh, isolated in-memory Postgres with the canonical-ISO timestamp
 * parser bound and every migration applied. Call in a `before`; `await
 * db.$client.close()` (or close the returned `pg`) in the matching `after`.
 */
export async function makeTestDb(): Promise<{ db: TestDb; pg: PGlite }> {
  const pg = new PGlite({
    parsers: {
      [types.TIMESTAMPTZ]: isoTimestampParser, // OID 1184
      [types.TIMESTAMP]: isoTimestampParser, // OID 1114
    },
  });
  const db = drizzle(pg, { schema });
  await migrate(db, {
    // The committed migrations live at <repo>/lib/db/migrations and `npm test` runs the
    // runner from the repo root (package.json), so this cwd-relative path resolves.
    migrationsFolder: path.join(process.cwd(), "lib", "db", "migrations"),
  });
  return { db, pg };
}
