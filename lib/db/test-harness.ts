import path from "node:path";

import { PGlite, types } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { isoTimestampParser } from "./timestamp-parser";
import { schema } from "./schema";

/**
 * pglite-backed Drizzle test harness (relational-store PLAN §8 / Step -1 GATE).
 *
 * The Step -1 spike proved an in-process Postgres (pglite) can run every feature
 * the relational migration leans on; this is its productionised form. A test that
 * needs the relational tables constructs one isolated in-memory database, applies
 * the REAL generated migrations (not hand-rolled DDL), and tears it down.
 *
 * Why import the production parser/schema/migrations rather than redeclare them:
 *
 *  - `isoTimestampParser` is the SAME choke point `pg.ts` installs on
 *    node-postgres — bound here on pglite's own per-instance `parsers` registry.
 *    This only affects RAW `pg.query(...)` reads (the parity case for the
 *    timestamp round-trip test); reads through DRIZZLE are canonicalised by the
 *    `isoTimestamptz` custom type ([./schema/columns.ts](./schema/columns.ts)),
 *    because the pglite driver — like node-postgres — overrides the timestamp OID
 *    parsers per query. Binding it keeps the raw-query path honest and the two
 *    regimes sharing one helper (no drift).
 *  - `{ schema }` (and its sub-modules) import only drizzle, never `server-only`,
 *    so the harness can pull it in directly under `node --test`. By contrast
 *    `client.ts`/`pg.ts` are `server-only`, so the harness builds its OWN client
 *    instead of calling `getDb()`.
 *  - The migrator replays the committed journal (0000…0004) so the test DB is
 *    built from the exact DDL production runs — the enums, partial-unique indexes,
 *    identity columns, and CHECK constraints — not a CREATE a test author wrote.
 *
 * This module is intentionally NOT named with a `.test.ts` suffix so the
 * `node --test` runner glob does not pick it up as an (empty) test file; it is a
 * helper the real test files import.
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
    // The committed migrations live at <repo>/lib/db/migrations and `npm test`
    // runs the runner from the repo root (package.json), so this cwd-relative
    // path resolves. The migrator does plain fs reads (no DB-URL env), so it
    // works fully offline against pglite.
    migrationsFolder: path.join(process.cwd(), "lib", "db", "migrations"),
  });
  return { db, pg };
}
