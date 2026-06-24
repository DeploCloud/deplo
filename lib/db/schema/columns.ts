import { customType } from "drizzle-orm/pg-core";

import { isoTimestampParser } from "../timestamp-parser";

/**
 * Shared column helpers for the relational control-plane schema.
 *
 * `isoTimestamptz` — a `timestamp with time zone` column that surfaces a canonical
 * ISO `YYYY-MM-DDTHH:MM:SS.sssZ` STRING in Drizzle's codec layer, and accepts an
 * ISO string on write (exactly what `nowIso()` produces).
 *
 * Why a custom type and not `timestamp(..., { withTimezone: true })`:
 *
 * The Step -1 GATE installed the {@link isoTimestampParser} on the driver's type
 * OID so a raw `db.query()` reads a canonical string. But the relational data
 * layer reads through DRIZZLE, whose own timestamp codec sits ABOVE the driver
 * parser: `mode:"date"` re-wraps the parser's string into a `Date` (losing the
 * string the 15+ lexicographic `createdAt` sorts need), and `mode:"string"`
 * BYPASSES the driver parser entirely and returns the space-separated
 * `'…+00'` form (the very bug the parser exists to kill). Neither Drizzle mode
 * yields the canonical ISO string through the ORM.
 *
 * A `customType` lives in Drizzle's codec layer, so its `fromDriver` is the value
 * the data layer actually receives: it canonicalises to `T…Z` regardless of how
 * the underlying driver rendered the timestamp, identically for node-postgres and
 * pglite (it does not depend on the driver-level OID parser at all — that parser
 * stays for the legacy raw-query path in `document-store.ts`/`lease.ts`). The
 * decode reuses the one {@link isoTimestampParser} so the two regimes can't drift.
 *
 * `toDriver` passes the ISO string straight through (Postgres parses an ISO 8601
 * string into `timestamptz` natively), so writes carry `nowIso()` verbatim.
 */
export const isoTimestamptz = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return "timestamp with time zone";
  },
  fromDriver(value): string {
    // value may already be a canonical string (driver parser ran) or a raw
    // timestamp string; isoTimestampParser is idempotent over both.
    return isoTimestampParser(value as string | null) as string;
  },
  toDriver(value: string): string {
    return value;
  },
});
