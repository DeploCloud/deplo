/**
 * The single source of truth for how Postgres timestamp columns are decoded into
 * JavaScript — shared by the production node-postgres client (`pg.ts`) and the
 * pglite test client so the two regimes can never drift (relational-store PLAN
 * §1, §8 GATE result 2026-06-24).
 *
 * Why this exists at all:
 *
 * 15+ data modules sort `createdAt`/`startedAt` LEXICOGRAPHICALLY (string compare),
 * relying on `nowIso()` = `new Date().toISOString()` producing the canonical ISO
 * form `'2026-06-24T12:34:56.789Z'`. But neither driver returns that by default:
 *
 *   - node-postgres renders a `timestamptz` as the space-separated string
 *     `'2026-06-24 12:34:56.789+00'` (space sorts BEFORE 'T', `+00` instead of `Z`,
 *     fraction trimmed) — so a mix of legacy-'T' and driver-rendered strings
 *     inverts the sort order during the migration window.
 *   - pglite returns a `timestamptz` as a JS `Date` object, which has no string
 *     ordering at all and breaks `.localeCompare`/`<` string sorts outright.
 *
 * Mapping both `timestamptz` (OID 1184) and `timestamp` (OID 1114) through
 * `new Date(v).toISOString()` makes EVERY read return the canonical `T…Z` string,
 * regardless of how the value was written. A write→read round-trip is therefore
 * byte-for-byte stable, and mixed-origin timestamps sort correctly. This was
 * validated end-to-end in the Step -1 pglite spike.
 *
 * NOTE: this module is deliberately NOT `server-only` and has no `pg`/`pglite`
 * import — it is a pure helper so the test harness and the pglite client can
 * import the exact same function the production pool installs.
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
