// TIMESTAMPTZ_OID and TIMESTAMP_OID are the Postgres timestamp type OIDs.
export const TIMESTAMPTZ_OID = 1184;
export const TIMESTAMP_OID = 1114;

// isoTimestampParser decodes a Postgres timestamp into a canonical ISO string or null.
export const isoTimestampParser = (v: string | null): string | null =>
  v == null ? null : new Date(v).toISOString();
