import { customType } from "drizzle-orm/pg-core";

import { isoTimestampParser } from "../timestamp-parser";

export const isoTimestamptz = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return "timestamp with time zone";
  },
  fromDriver(value): string {
    return isoTimestampParser(value as string | null) as string;
  },
  toDriver(value: string): string {
    return value;
  },
});
