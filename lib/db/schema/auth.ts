import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
} from "drizzle-orm/pg-core";

import { users } from "./control-plane";

/**
 * Better Auth tables (session / account / verification / two_factor).
 *
 * Better Auth owns these via its Drizzle adapter. There is deliberately NO `user`
 * table here: since migration 0055 the control-plane `users` table IS Better Auth's
 * `user` model, remapped with `user: { modelName: "users" }` in
 * [../../auth/better-auth.ts](../../auth/better-auth.ts). That keeps `users.id` the
 * one identity every control-plane FK already points at, instead of standing up a
 * second user table to reconcile (ADR-0014).
 *
 * Timestamps here stay plain `timestamp` to match Better Auth's own column types
 * (and the already-applied baseline migration 0000); they are auth bookkeeping,
 * not the control-plane `*_at` columns that the lexicographic-sort modules read.
 */

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
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
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  idToken: text("id_token"),
  /** The credential provider's password. Since 0055 this is the ONLY stored copy —
   *  `users.password_hash` was dropped. Format is unchanged (`scrypt$salt$hash`),
   *  because Better Auth is configured with deplo's own hash/verify pair. */
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

/**
 * The `twoFactor` plugin's table. `secret` and `backupCodes` are BOTH ciphertext,
 * encrypted by the plugin with the Better Auth secret (which deplo derives from
 * `DEPLO_SECRET`) — never project either into a DTO, exactly like the `*_enc`
 * columns. `failedVerificationCount`/`lockedUntil` are the plugin's own brute-force
 * lockout, which is why nothing in deplo counts TOTP attempts by hand.
 */
export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count")
      .notNull()
      .default(0),
    lockedUntil: timestamp("locked_until"),
  },
  (t) => [
    index("two_factor_user_id_idx").on(t.userId),
    index("two_factor_secret_idx").on(t.secret),
  ],
);
