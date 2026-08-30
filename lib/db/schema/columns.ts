import { customType } from "drizzle-orm/pg-core";

import { isoTimestampParser } from "../timestamp-parser";

/**
 * Shared column helpers for the relational control-plane schema. The decode reuses
 * the one {@link isoTimestampParser} so the two regimes can't drift.
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
