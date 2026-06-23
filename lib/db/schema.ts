import { pgTable, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";

/**
 * Drizzle schema for the Postgres backend.
 *
 * Two concerns live here:
 *  1. The Better Auth tables (user / session / account / verification). Better
 *     Auth owns these via its Drizzle adapter; the column shape matches its
 *     core schema so `drizzle-kit` can generate the migrations.
 *  2. `deplo_state`  a single-row JSONB document that stores the control-plane
 *     data (projects, deployments, domains, databases, …). Keeping the existing
 *     `DeploData` shape as one document is a deliberate, low-risk way to put all
 *     control-plane data in Postgres without rewriting the data-access layer.
 */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Single-document control-plane state. */
export const deploState = pgTable("deplo_state", {
  id: text("id").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Cross-process mutex for the backup scheduler (Step 6). The JSONB document
 * store can't provide a real lease — concurrent `next start` instances would
 * each fire a due backup. One row per named lease holds the current owner and a
 * heartbeat; a tick claims a lease via an atomic CAS (insert-or-steal-if-stale)
 * before running, so a due backup fires at most once and a crashed owner's stale
 * lease is re-armed. In the test-only in-memory mode (no Postgres) this degrades
 * to an in-process `globalThis` lock.
 */
export const schedulerLease = pgTable("scheduler_lease", {
  /** Lease name, e.g. "backup-scheduler". One row per distinct lease. */
  name: text("name").primaryKey(),
  /** Identifier of the process/instance currently holding the lease. */
  owner: text("owner").notNull(),
  /** Last heartbeat; a lease older than the staleness window is reclaimable. */
  heartbeatAt: timestamp("heartbeat_at").notNull().defaultNow(),
  acquiredAt: timestamp("acquired_at").notNull().defaultNow(),
});

export const schema = {
  user,
  session,
  account,
  verification,
  deploState,
  schedulerLease,
};
