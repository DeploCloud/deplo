export const TIMESTAMPTZ_OID = 1184;
export const TIMESTAMP_OID = 1114;

export const isoTimestampParser = (v: string | null): string | null =>
  v == null ? null : new Date(v).toISOString();
