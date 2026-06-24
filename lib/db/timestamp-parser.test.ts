import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { PGlite } from "@electric-sql/pglite";
import { types as pgTypes } from "pg";

import {
  isoTimestampParser,
  TIMESTAMP_OID,
  TIMESTAMPTZ_OID,
} from "./timestamp-parser";
import { nowIso } from "../ids";

/**
 * Step 0 round-trip GATE (relational-store PLAN §8 Step 0: "the round-trip test
 * passes"). Proves the ONE shared `isoTimestampParser` makes a `nowIso()` write
 * read back as a canonical, lexicographically-sortable `T…Z` string — in BOTH
 * regimes the plan installs it in:
 *
 *   1. pglite (the test backend) via its `parsers` constructor option, and
 *   2. node-postgres (production) via the process-global `pg.types.setTypeParser`
 *      that `lib/db/pg.ts` installs at module load.
 *
 * The GATE finding (2026-06-24) is the reason this lives in TWO places sharing
 * one helper: pglite returns a `timestamptz` as a JS `Date` and node-postgres
 * returns a space-separated `'…+00'` string — both break the 15+ lexicographic
 * `createdAt` sorts. Validating the same exported function in both regimes is
 * what guarantees they can't drift.
 *
 * Like `pglite-spike.test.ts`, this constructs its own PGlite, so it needs no
 * real Postgres and coexists with the SQL-free in-memory suite.
 */

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/* ------------------------------------------------------------------ */
/* The shared helper in isolation                                      */
/* ------------------------------------------------------------------ */

test("isoTimestampParser: null passes through, every shape canonicalises to T…Z", () => {
  assert.equal(isoTimestampParser(null), null);

  const written = nowIso();
  assert.equal(isoTimestampParser(written), written, "an ISO 'T…Z' write is byte-for-byte stable");

  // node-postgres' native rendering (space separator, '+00', trimmed fraction)
  // is canonicalised back to the sortable 'T…Z' form.
  assert.equal(
    isoTimestampParser("2026-06-24 12:34:56.789+00"),
    "2026-06-24T12:34:56.789Z",
  );
  assert.match(isoTimestampParser("2020-01-01 00:00:00+00")!, ISO_RE);
});

/* ------------------------------------------------------------------ */
/* Regime 1 — node-postgres process-global registration                */
/* ------------------------------------------------------------------ */

test("pg.types: importing lib/db/pg.ts registers the shared parser for both OIDs", async () => {
  // Importing the production module installs the parser at module load.
  await import("./pg");

  for (const oid of [TIMESTAMPTZ_OID, TIMESTAMP_OID]) {
    const parser = pgTypes.getTypeParser(oid) as (v: string | null) => unknown;
    // The registered parser must behave identically to our shared helper — i.e.
    // a space-separated driver rendering comes back canonical 'T…Z'.
    assert.equal(
      parser("2026-06-24 12:34:56.789+00"),
      "2026-06-24T12:34:56.789Z",
      `OID ${oid} must decode via isoTimestampParser`,
    );
    assert.equal(parser(null), null, `OID ${oid} parser passes null through`);
  }
});

/* ------------------------------------------------------------------ */
/* Regime 2 — pglite end-to-end round-trip                              */
/* ------------------------------------------------------------------ */

let db: PGlite;

before(async () => {
  db = new PGlite({
    parsers: {
      [TIMESTAMPTZ_OID]: isoTimestampParser,
      [TIMESTAMP_OID]: isoTimestampParser,
    },
  });
  await db.exec(`
    create table stamped (
      id text primary key,
      created_at timestamptz not null
    );
  `);
});

after(async () => {
  await db.close();
});

test("round-trip: a nowIso() write reads back byte-for-byte canonical T…Z (timestamptz)", async () => {
  const written = nowIso();
  await db.query("insert into stamped values ($1,$2)", ["s1", written]);

  const r = await db.query<{ created_at: string }>(
    "select created_at from stamped where id='s1'",
  );
  const readBack = r.rows[0]?.created_at;

  assert.equal(typeof readBack, "string", "the parser yields a string, not a Date");
  assert.match(readBack!, ISO_RE, "read-back is canonical 'YYYY-MM-DDTHH:MM:SS.sssZ'");
  assert.equal(readBack, written, "byte-for-byte equal to the original nowIso() write");
});

test("round-trip: mixed-origin timestamps still sort lexicographically", async () => {
  // The decisive property for the migration window: legacy-'T' writes and fresh
  // writes interleave, yet ORDER BY is correct because every read is canonical.
  await db.query("insert into stamped values ($1,$2)", ["s0", "2020-01-01T00:00:00.000Z"]);
  await db.query("insert into stamped values ($1,$2)", ["s2", "2030-01-01T00:00:00.000Z"]);

  const ordered = await db.query<{ id: string }>(
    "select id from stamped order by created_at asc",
  );
  assert.deepEqual(
    ordered.rows.map((x) => x.id),
    ["s0", "s1", "s2"],
    "lexicographic createdAt ordering holds across mixed-origin timestamps",
  );
});
