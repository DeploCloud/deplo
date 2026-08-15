import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
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

/**
 * The `@better-auth/passkey` plugin's table — one WebAuthn credential per row.
 *
 * `publicKey` and `credentialID` are LIBRARY-OWNED and never belong in a DTO.
 * Neither is a secret the way `two_factor.secret` is (a public key is public by
 * construction, and the credential id is what the browser sends in the clear),
 * but both are the credential's identity: shipping them to a client hands an
 * attacker the exact material to correlate one person's device across every
 * account it protects. `PasskeyDTO` in lib/data/passkeys.ts carries `id`, `name`
 * and `createdAt`, and that is the whole list.
 *
 * `name` is nullable because the plugin writes `undefined` when the client sent
 * no label; deplo always sends one, but the column has to allow the shape.
 *
 * ponytail: `counter` is `integer` (2^31) while WebAuthn defines a uint32. It
 * matches what the Drizzle adapter hands over (a JS `number`) and the ceiling is
 * unreachable in practice — most authenticators report 0 forever and never
 * increment. Widen to `bigint` only if a real device ever gets close.
 */
export const passkey = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // UNIQUE, not merely indexed as the plugin's own schema declares it: the
    // authentication path resolves a credential with `findOne({credentialID})`,
    // so a duplicate would make WHICH account a passkey signs in depend on row
    // order. The database is the right place to make that impossible.
    credentialID: text("credential_id").notNull().unique(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at"),
    aaguid: text("aaguid"),
  },
  (t) => [index("passkey_user_id_idx").on(t.userId)],
);

/**
 * The `@better-auth/oauth-provider` plugin's four tables — deplo as an OAuth 2.1
 * authorization server, so claude.ai and ChatGPT can connect to `/api/mcp` (they
 * cannot be handed a bearer token by hand the way a terminal agent can).
 *
 * These are LIBRARY-OWNED, like the four above: the plugin writes and reads every
 * row, and the JS property names below are its field names verbatim — the Drizzle
 * adapter resolves a model field by looking up `schema[modelName][field]`, so
 * renaming one here breaks the adapter, not just a query. Only the SQL column
 * names are ours.
 *
 * Two deliberate exemptions from `AGENTS.md` → "Persistence", both forced and both
 * scoped to these four tables:
 *
 *  - **`text[]` instead of a junction table.** The adapter sets
 *    `supportsArrays: true` for Postgres and hands Drizzle a raw JS array, so a
 *    normalized child table cannot be written by it at all.
 *  - **One `jsonb` column** (`oauth_client.metadata`), for the same reason
 *    (`supportsJSON: true`). It holds RFC 7591 registration metadata deplo never
 *    reads, queries or indexes.
 *
 * Neither is control-plane state. Nothing outside the plugin writes these tables,
 * and the rule they bend stays in force everywhere else.
 *
 * Access and refresh tokens are stored **hashed with deplo's own `sha256Hex`**
 * (wired through `storeTokens` in [../../auth/better-auth.ts]) — the same digest
 * `api_tokens.token_hash` uses. A row here is never a usable credential.
 */
export const oauthClient = pgTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    /** Null for public clients, which is every client that self-registers: an
     *  unauthenticated RFC 7591 registration is forced to
     *  `token_endpoint_auth_method: "none"` by the plugin. */
    clientSecret: text("client_secret"),
    disabled: boolean("disabled").default(false),
    /** Never set by deplo. A consent screen that mints a credential is the
     *  security decision; there is nothing to skip. */
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
    /** Attacker-chosen, free text: a client may register itself as anything.
     *  Show the registered redirect origin next to it, never this alone. */
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    public: boolean("public"),
    type: text("type"),
    requirePKCE: boolean("require_pkce"),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (t) => [index("oauth_client_user_id_idx").on(t.userId)],
);

/** An opaque refresh token, issued only for the `offline_access` scope. */
export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at"),
    revoked: timestamp("revoked"),
    authTime: timestamp("auth_time"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauth_refresh_token_client_id_idx").on(t.clientId),
    index("oauth_refresh_token_session_id_idx").on(t.sessionId),
    index("oauth_refresh_token_user_id_idx").on(t.userId),
  ],
);

/**
 * An opaque access token. This is the credential an AI client actually presents
 * to `/api/mcp`; `lib/data/tokens.ts` resolves it to the `api_tokens` row the
 * consent screen minted, and every gate from there is the one a `deplo_` token
 * already goes through.
 */
export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauth_access_token_client_id_idx").on(t.clientId),
    index("oauth_access_token_session_id_idx").on(t.sessionId),
    index("oauth_access_token_user_id_idx").on(t.userId),
    index("oauth_access_token_refresh_id_idx").on(t.refreshId),
  ],
);

/** What a user has agreed to give a client. Deleting it stops the next refresh;
 *  deleting the minted `api_tokens` row stops the next request. */
export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (t) => [
    index("oauth_consent_client_id_idx").on(t.clientId),
    index("oauth_consent_user_id_idx").on(t.userId),
  ],
);
