import { customType } from "drizzle-orm/pg-core";

import { isoTimestampParser } from "../timestamp-parser";

// isoTimestamptz decodes through the one isoTimestampParser so the two regimes can't drift.
export const isoTimestamptz = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return "timestamp with time zone";
  },
  fromDriver(value): string {
    // value may already be canonical (driver parser ran) or raw; isoTimestampParser is idempotent over both.
    return isoTimestampParser(value as string | null) as string;
  },
  toDriver(value: string): string {
    return value;
  },
});
