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

// node-postgres hands back a Buffer and pglite a Uint8Array; both arrive here as a Buffer.
export const bytea = customType<{
  data: Buffer;
  driverData: Buffer | Uint8Array;
}>({
  dataType() {
    return "bytea";
  },
  fromDriver(value): Buffer {
    return Buffer.from(value);
  },
});
