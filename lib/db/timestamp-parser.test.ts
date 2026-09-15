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

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("isoTimestampParser: null passes through, every shape canonicalises to T…Z", () => {
  assert.equal(isoTimestampParser(null), null);

  const written = nowIso();
  assert.equal(
    isoTimestampParser(written),
    written,
    "an ISO 'T…Z' write is byte-for-byte stable",
  );

  assert.equal(
    isoTimestampParser("2026-06-24 12:34:56.789+00"),
    "2026-06-24T12:34:56.789Z",
  );
  assert.match(isoTimestampParser("2020-01-01 00:00:00+00")!, ISO_RE);
});

test("pg.types: importing lib/db/pg.ts registers the shared parser for both OIDs", async () => {
  await import("./pg");

  for (const oid of [TIMESTAMPTZ_OID, TIMESTAMP_OID]) {
    const parser = pgTypes.getTypeParser(oid) as (v: string | null) => unknown;
    assert.equal(
      parser("2026-06-24 12:34:56.789+00"),
      "2026-06-24T12:34:56.789Z",
      `OID ${oid} must decode via isoTimestampParser`,
    );
    assert.equal(parser(null), null, `OID ${oid} parser passes null through`);
  }
});

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

  assert.equal(
    typeof readBack,
    "string",
    "the parser yields a string, not a Date",
  );
  assert.match(
    readBack!,
    ISO_RE,
    "read-back is canonical 'YYYY-MM-DDTHH:MM:SS.sssZ'",
  );
  assert.equal(
    readBack,
    written,
    "byte-for-byte equal to the original nowIso() write",
  );
});

test("round-trip: mixed-origin timestamps still sort lexicographically", async () => {
  await db.query("insert into stamped values ($1,$2)", [
    "s0",
    "2020-01-01T00:00:00.000Z",
  ]);
  await db.query("insert into stamped values ($1,$2)", [
    "s2",
    "2030-01-01T00:00:00.000Z",
  ]);

  const ordered = await db.query<{ id: string }>(
    "select id from stamped order by created_at asc",
  );
  assert.deepEqual(
    ordered.rows.map((x) => x.id),
    ["s0", "s1", "s2"],
    "lexicographic createdAt ordering holds across mixed-origin timestamps",
  );
});
