import type { Config } from "drizzle-kit";

/**
 * drizzle-kit config. Generate and apply the Postgres schema (Better Auth
 * tables + the control-plane state table) with:
 *
 *   bunx drizzle-kit push          # apply schema directly (dev)
 *   bunx drizzle-kit generate      # emit SQL migrations
 *   bunx drizzle-kit migrate       # run migrations (prod)
 *
 * Requires DEPLO_DATABASE_URL (or DATABASE_URL) to be set.
 */
export default {
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DEPLO_DATABASE_URL || process.env.DATABASE_URL || "",
  },
} satisfies Config;
