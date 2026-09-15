import type { Config } from "drizzle-kit";

export default {
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DEPLO_DATABASE_URL || process.env.DATABASE_URL || "",
  },
} satisfies Config;
