// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import type { Config } from "drizzle-kit";

/**
 * drizzle-kit config.
 */
export default {
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DEPLO_DATABASE_URL || process.env.DATABASE_URL || "",
  },
} satisfies Config;
