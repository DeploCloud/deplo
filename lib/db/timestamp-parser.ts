/**
 * The single source of truth for how Postgres timestamp columns are decoded into
 * JavaScript - shared by the production node-postgres client (`pg.ts`) and the
 * pglite test client so the two regimes can never drift (relational-store PLAN §1,
 * §8 GATE result 2026-06-24).
 */

/** Postgres type OIDs for the timestamp family (stable across versions). */
export const TIMESTAMPTZ_OID = 1184;
export const TIMESTAMP_OID = 1114;

/**
 * Decode a Postgres timestamp value to a canonical ISO `YYYY-MM-DDTHH:MM:SS.sssZ`
 * string (or `null`). The choke point both `pg.types.setTypeParser` (node-postgres)
 * and the pglite `parsers` option route OID 1184/1114 through.
 */
export const isoTimestampParser = (v: string | null): string | null =>
  v == null ? null : new Date(v).toISOString();
